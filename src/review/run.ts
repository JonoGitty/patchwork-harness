/**
 * `patchwork-harness review` - adversarial security review fanned out to 2-3 models
 * from DIFFERENT providers in parallel, merged + de-duplicated, and ALWAYS
 * passed through the L4.5 grounding verifier so absence claims are flagged
 * as unverifiable rather than trusted.
 *
 * Output: docs/reviews/security/<date>-<slug>/
 *   PROMPT.md          the exact prompt (system + user, incl. the material)
 *   <model>.md         each raw reply with a cost header
 *   findings.json      merged findings + per-reviewer stats + verifier reports
 *   SUMMARY.md         merged, de-duplicated findings table + verifier verdicts
 * Everything is also on the audit trail (~/.patchwork-harness/events/<session>.jsonl)
 * so `patchwork-harness verify session <id>` can re-check it later.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AuditEmitter } from "../audit.js";
import { type ModelInfo, loadModels, roleList } from "../config.js";
import { pickReachable } from "../providers/availability.js";
import type { CompletionResponse } from "../providers/base.js";
import { getProvider } from "../providers/registry.js";
import { newSessionId } from "../util/ulid.js";
import { type Report, verify } from "../verifier/grounding.js";
import { renderReport } from "../verifier/render.js";
import { type Collected, collectDiff, collectPaths } from "./collect.js";
import {
  type MergedFinding,
  type ParsedReply,
  findingStatus,
  mergeFindings,
  parseReply,
  stripFindingsJson,
} from "./merge.js";
import { buildReviewPrompt } from "./prompt.js";

export interface ReviewOptions {
  cwd: string;
  paths?: string[];
  /** true = working tree vs HEAD; string = commit range. */
  diff?: string | true;
  context?: string;
  slug?: string;
  models?: string[];
  maxModels?: number;
  /** Abort before any call if the estimate exceeds this. */
  budgetUsd?: number;
  maxTokens?: number;
  outDir?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
}

export interface ReviewerResult {
  model: string;
  provider: string;
  text: string;
  parsed: ParsedReply;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  error?: string;
  verifier: Report | null;
}

export interface ReviewResult {
  sessionId: string;
  outDir: string;
  models: ModelInfo[];
  collected: Collected;
  reviewers: ReviewerResult[];
  merged: MergedFinding[];
  total_cost_usd: number;
  estimate_usd: number;
  dryRun: boolean;
}

const CALL_TIMEOUT_MS = 15 * 60 * 1000;

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "review"
  );
}

/**
 * Pre-flight estimate. Input: ~3 chars/token (the 4.7+ Claude tokenizer is
 * the densest); output: half the cap per model - thinking is billed as
 * output on Opus 5 / Fable / Gemini 3.x, so a reviewer can legitimately
 * spend most of its cap. The 7 Sept 2026 run estimated $0.81 (3.5 chars,
 * 0.5 x 6k) and cost $1.10; the summary always reports actual vs estimate.
 */
export function estimateUsd(models: ModelInfo[], promptChars: number, maxTokens: number): number {
  const tokensIn = Math.ceil(promptChars / 3);
  let total = 0;
  for (const m of models) {
    if (m.cost_per_m_in === null || m.cost_per_m_out === null) continue;
    total += (tokensIn * m.cost_per_m_in + maxTokens * 0.5 * m.cost_per_m_out) / 1_000_000;
  }
  return total;
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (t) clearTimeout(t);
  }
}

export async function selectReviewers(opts: { models?: string[]; maxModels?: number }): Promise<
  ModelInfo[]
> {
  const cfg = loadModels();
  const max = opts.maxModels ?? 3;
  if (opts.models?.length) {
    const wanted = opts.models;
    const unknown = wanted.filter((id) => !cfg.models.some((m) => m.id === id));
    if (unknown.length)
      throw new Error(`unknown model id(s): ${unknown.join(", ")} (see config/models.yml)`);
    return pickReachable(wanted, { max: wanted.length, distinctProviders: false });
  }
  return pickReachable(roleList(cfg.defaults.security_reviewer), { max, distinctProviders: true });
}

/** Verifier evidence = the material itself, one tool_result per file. The
 *  header line carries the path (exactly as the reviewers saw it), so a
 *  reply that cites a real file verifies and an invented path does not. */
export function evidenceFromMaterial(c: Collected): Array<Record<string, unknown>> {
  const ev: Array<Record<string, unknown>> = c.files.map((f) => ({
    event_id: `file:${f.path}`,
    type: "tool_result",
    tool: "read",
    output: `FILE: ${f.path}\n${f.content}`,
  }));
  if (c.diff) ev.push({ event_id: "diff", type: "tool_result", tool: "git_diff", output: c.diff });
  return ev;
}

export async function runReview(opts: ReviewOptions): Promise<ReviewResult> {
  const log = opts.log ?? (() => {});
  const cwd = resolve(opts.cwd);
  const maxTokens = opts.maxTokens ?? 12_000;

  // 1. material
  const collected =
    opts.diff !== undefined
      ? await collectDiff(cwd, opts.diff === true ? undefined : opts.diff)
      : await collectPaths(cwd, opts.paths?.length ? opts.paths : ["."]);
  if (!collected.files.length && !collected.diff) {
    throw new Error("nothing to review: no readable files matched (and no diff)");
  }
  log(
    `material: ${collected.files.length} file(s), ${collected.totalChars} chars` +
      (collected.skipped.length ? `, ${collected.skipped.length} skipped` : "") +
      (collected.diff ? " (+ diff)" : ""),
  );

  // 2. reviewers
  const models = await selectReviewers(opts);
  if (models.length === 0) throw new Error("no reachable reviewer model (check keys: patchwork-harness keys)");
  if (models.length < 2)
    log(
      "warning: only ONE reviewer is reachable - a single-model review has no independent agreement",
    );
  log(`reviewers: ${models.map((m) => `${m.provider}/${m.id}`).join(", ")}`);

  // 3. prompt + estimate
  const { system, user } = buildReviewPrompt(opts.context ?? "", collected);
  const estimate = estimateUsd(models, system.length + user.length, maxTokens);
  const budget = opts.budgetUsd ?? 1.0;
  log(`estimate: ~$${estimate.toFixed(3)} (budget $${budget.toFixed(2)})`);
  if (estimate > budget) {
    throw new Error(
      `estimated spend $${estimate.toFixed(3)} exceeds --budget $${budget.toFixed(2)}: narrow the paths, drop a model (--models), or raise the budget`,
    );
  }

  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(
    opts.slug ??
      (opts.diff !== undefined
        ? `diff-${opts.diff === true ? "worktree" : String(opts.diff)}`
        : (opts.paths ?? ["."]).join("-")),
  );
  const outDir = resolve(
    opts.outDir ?? join(cwd, "docs", "reviews", "security"),
    `${date}-${slug}`,
  );
  const sessionId = newSessionId();

  if (opts.dryRun) {
    return {
      sessionId,
      outDir,
      models,
      collected,
      reviewers: [],
      merged: [],
      total_cost_usd: 0,
      estimate_usd: estimate,
      dryRun: true,
    };
  }

  // 4. audit trail: the material is what the reviewers "read"
  const audit = new AuditEmitter(sessionId, cwd, "review");
  audit.emit({
    action: "session_start",
    target: { kind: "review", slug, files: collected.files.length },
  });
  for (const f of collected.files) {
    audit.emit({
      action: "tool_use_start",
      target: { tool: "read", path: f.path },
      provenance: { input: JSON.stringify({ path: f.path }) },
    });
    audit.emit({
      action: "tool_use_end",
      status: "completed",
      target: { tool: "read", path: f.path },
      content: f.content,
      provenance: { output: f.content.slice(0, 16000) },
    });
  }

  // 5. fan out in parallel
  const evidence = evidenceFromMaterial(collected);
  const results = await Promise.all(
    models.map(async (m): Promise<ReviewerResult> => {
      const provider = getProvider(m.provider);
      audit.emit({
        action: "provider_call",
        target: { provider: m.provider, model: m.id, kind: "review" },
      });
      const t0 = performance.now();
      try {
        const resp: CompletionResponse = await withTimeout(
          provider.complete({
            model: m.id,
            system,
            messages: [{ role: "user", content: [{ type: "text", text: user }] }],
            maxTokens,
          }),
          CALL_TIMEOUT_MS,
          `${m.id} review`,
        );
        const text = resp.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        audit.emit({
          action: "provider_response",
          target: { provider: m.provider, model: m.id, stop_reason: resp.stop_reason },
          content: text,
          provenance: {
            cost_usd: resp.cost_usd,
            tokens_in: resp.usage.input_tokens,
            tokens_out: resp.usage.output_tokens,
            duration_ms: resp.duration_ms,
          },
        });
        if (resp.error || !text.trim()) {
          // cost is real even when the answer is not: keep it on the books
          const why =
            resp.error ??
            `empty reply (stop_reason=${resp.stop_reason}, ${resp.usage.output_tokens} output tokens billed)`;
          audit.emit({
            action: "provider_response",
            status: "failed",
            target: { provider: m.provider, model: m.id },
            provenance: { error: why, cost_usd: resp.cost_usd },
          });
          log(`${m.id}: FAILED - ${why.slice(0, 200)}`);
          return {
            model: m.id,
            provider: m.provider,
            text,
            parsed: { findings: [], right: [], parse_error: why },
            cost_usd: resp.cost_usd ?? 0,
            tokens_in: resp.usage.input_tokens,
            tokens_out: resp.usage.output_tokens,
            duration_ms: resp.duration_ms,
            error: why,
            verifier: null,
          };
        }
        const parsed = parseReply(text);
        log(
          `${m.id}: ${resp.usage.input_tokens} in / ${resp.usage.output_tokens} out, $${(resp.cost_usd ?? 0).toFixed(4)}, ${parsed.findings.length} finding(s)${parsed.parse_error ? ` (${parsed.parse_error})` : ""}`,
        );
        return {
          model: m.id,
          provider: m.provider,
          text,
          parsed,
          cost_usd: resp.cost_usd ?? 0,
          tokens_in: resp.usage.input_tokens,
          tokens_out: resp.usage.output_tokens,
          duration_ms: resp.duration_ms,
          // ground the PROSE, not the reviewer's own findings JSON
          verifier: verify(stripFindingsJson(text), evidence),
        };
      } catch (e) {
        const error = (e as Error).message;
        audit.emit({
          action: "provider_response",
          status: "failed",
          target: { provider: m.provider, model: m.id },
          provenance: { error },
        });
        log(`${m.id}: FAILED - ${error.slice(0, 200)}`);
        return {
          model: m.id,
          provider: m.provider,
          text: "",
          parsed: { findings: [], right: [], parse_error: error },
          cost_usd: 0,
          tokens_in: 0,
          tokens_out: 0,
          duration_ms: Math.round(performance.now() - t0),
          error,
          verifier: null,
        };
      }
    }),
  );

  // 6. merge
  const merged = mergeFindings(
    results
      .filter((r) => !r.error)
      .map((r) => ({ model: r.model, provider: r.provider, findings: r.parsed.findings })),
    { files: collected.files, diff: collected.diff },
  );
  const total = results.reduce((s, r) => s + r.cost_usd, 0);
  audit.emit({
    action: "session_end",
    status: results.some((r) => !r.error) ? "completed" : "failed",
    provenance: {
      total_cost_usd: total,
      findings: merged.length,
      reviewers: results.map((r) => r.model),
    },
  });

  // 7. write
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "PROMPT.md"),
    `# Review prompt\n\n## system\n\n${system}\n\n## user\n\n${user}\n`,
  );
  for (const r of results) {
    const head = `# ${r.model} (${r.provider}) — security review ${date}\n\n> Cost: $${r.cost_usd.toFixed(5)} · ${r.tokens_in} in / ${r.tokens_out} out · ${r.duration_ms}ms${r.error ? ` · ERROR: ${r.error}` : ""}\n\n---\n\n`;
    const tail = r.verifier
      ? `\n\n---\n\n## L4.5 verifier (this reply vs the material)\n\n\`\`\`\n${renderReport(r.verifier, { color: false })}\n\`\`\`\n`
      : "";
    writeFileSync(
      join(outDir, `${r.model.replace(/[^\w.-]+/g, "_")}.md`),
      head + (r.text || "(no reply)") + tail,
    );
  }
  writeFileSync(
    join(outDir, "findings.json"),
    JSON.stringify(
      {
        session: sessionId,
        date,
        cwd,
        material: {
          source: collected.source,
          files: collected.files.map((f) => ({
            path: f.path,
            lines: f.lines,
            truncated: f.truncated,
          })),
          skipped: collected.skipped,
        },
        reviewers: results.map((r) => ({
          model: r.model,
          provider: r.provider,
          cost_usd: r.cost_usd,
          tokens_in: r.tokens_in,
          tokens_out: r.tokens_out,
          duration_ms: r.duration_ms,
          error: r.error,
          parse_error: r.parsed.parse_error,
          right: r.parsed.right,
          fix_first: r.parsed.fix_first,
          verifier: r.verifier,
        })),
        merged,
        total_cost_usd: total,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(outDir, "SUMMARY.md"),
    renderSummary({ date, slug, sessionId, cwd, collected, results, merged, total }),
  );

  return {
    sessionId,
    outDir,
    models,
    collected,
    reviewers: results,
    merged,
    total_cost_usd: total,
    estimate_usd: estimate,
    dryRun: false,
  };
}

function renderSummary(a: {
  date: string;
  slug: string;
  sessionId: string;
  cwd: string;
  collected: Collected;
  results: ReviewerResult[];
  merged: MergedFinding[];
  total: number;
}): string {
  const L: string[] = [];
  L.push(`# Security review — ${a.slug} — ${a.date}`);
  L.push("");
  L.push(`Session \`${a.sessionId}\` · cwd \`${a.cwd}\` · total spend **$${a.total.toFixed(4)}**`);
  L.push("");
  L.push("## Who reviewed");
  L.push("");
  L.push("| model | provider | in / out tokens | cost | findings | status |");
  L.push("|---|---|---|---|---|---|");
  for (const r of a.results) {
    L.push(
      `| ${r.model} | ${r.provider} | ${r.tokens_in} / ${r.tokens_out} | $${r.cost_usd.toFixed(4)} | ${r.parsed.findings.length} | ${r.error ? `FAILED: ${r.error.slice(0, 80)}` : r.parsed.parse_error ? `reply ok, ${r.parsed.parse_error}` : "ok"} |`,
    );
  }
  L.push("");
  L.push("## Material");
  L.push("");
  for (const f of a.collected.files)
    L.push(`- \`${f.path}\` (${f.lines} lines${f.truncated ? ", TRUNCATED" : ""})`);
  if (a.collected.diff)
    L.push(
      `- diff (${a.collected.diff.length} chars${a.collected.diffTruncated ? ", TRUNCATED" : ""})`,
    );
  for (const s of a.collected.skipped) L.push(`- NOT SHOWN: \`${s.path}\` — ${s.reason}`);
  L.push("");
  L.push("## Merged findings (de-duplicated across reviewers)");
  L.push("");
  L.push(
    "Status is deterministic: `evidence found` = the reviewer's quoted code is verbatim in the material; `ABSENCE CLAIM` = the claim is that something is missing, which a review of a slice cannot prove — verify by hand before acting; `NOT in material` = the quote does not appear in what was reviewed, treat as suspect.",
  );
  L.push("");
  L.push("| # | sev | category | location | finding | found by | status |");
  L.push("|---|---|---|---|---|---|---|");
  for (const m of a.merged) {
    L.push(
      `| ${m.key} | ${m.severity} | ${m.category} | \`${m.location.replace(/\|/g, "\\|")}\` | ${m.title.replace(/\|/g, "\\|")} | ${m.found_by.join(", ")} (${m.agreement}) | ${findingStatus(m)} |`,
    );
  }
  if (!a.merged.length) L.push("| — | — | — | — | (no structured findings parsed) | — | — |");
  L.push("");
  L.push("### Detail");
  L.push("");
  for (const m of a.merged) {
    L.push(`#### ${m.key} · ${m.severity} · ${m.title}`);
    L.push("");
    for (const c of m.claims) {
      L.push(
        `- **${c.model}** (confidence ${c.confidence.toFixed(2)}, evidence ${c.evidence_status}): ${c.claim}`,
      );
      if (c.evidence.trim())
        L.push(
          `  - evidence: \`${c.evidence.replace(/\s+/g, " ").slice(0, 200).replace(/`/g, "'")}\``,
        );
      if (c.fix.trim()) L.push(`  - fix: ${c.fix.slice(0, 300)}`);
    }
    L.push("");
  }
  L.push("## What the reviewers say is RIGHT");
  L.push("");
  for (const r of a.results) for (const line of r.parsed.right) L.push(`- (${r.model}) ${line}`);
  L.push("");
  L.push("## Fix first — and the argument against");
  L.push("");
  for (const r of a.results) {
    if (!r.parsed.fix_first) continue;
    L.push(`- **${r.model}** → ${r.parsed.fix_first.id}: ${r.parsed.fix_first.why}`);
    if (r.parsed.fix_first.against) L.push(`  - against: ${r.parsed.fix_first.against}`);
  }
  L.push("");
  L.push("## L4.5 verifier — each reply against the material");
  L.push("");
  L.push(
    "The verifier grounds the checkable atoms of a reply (paths, identifiers, quoted strings, numbers) against the material. UNGROUNDED atoms are names/figures the reply uses that do not occur in the code shown; that is where invented code lives. Absence claims are structurally unverifiable and are flagged in the table above instead.",
  );
  L.push("");
  for (const r of a.results) {
    if (!r.verifier) continue;
    L.push(`### ${r.model}`);
    L.push("");
    L.push("```");
    L.push(renderReport(r.verifier, { color: false }));
    L.push("```");
    L.push("");
  }
  L.push(
    "_Raw replies are beside this file. Nothing has been changed in response to this review._",
  );
  L.push("");
  return L.join("\n");
}
