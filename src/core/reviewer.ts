/**
 * L5 reviewer - ADR-0016 (ADR-0008's Layer 5; research shortlist #4).
 *
 * After the plan (and any --verify-cmd gate) a model from a DIFFERENT
 * vendor than the one that did the work reviews the finished state:
 *   - read-only: it gets read / grep / glob and nothing that writes
 *   - it sees the goal, the plan's outputs, the gate result, and the real
 *     diff of the working tree (recorded on the audit trail as tool output)
 *   - it answers a fixed rubric as JSON; every concern must cite evidence
 *   - the review itself goes through L4.5: a concern citing text that no
 *     tool output contains is flagged, so the reviewer cannot invent
 *     problems any more than the executor can invent successes
 * Flag-only by default; --review-strict makes a non-"complete" verdict fail
 * the command.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { AuditEmitter } from "../audit.js";
import { type ModelInfo, loadModels, roleList } from "../config.js";
import type { HumanChannel } from "../permissions/human.js";
import { modelReach } from "../providers/availability.js";
import type { JsonReporter } from "../util/json_reporter.js";
import { EVENTS_DIR } from "../util/paths.js";
import { verify } from "../verifier/grounding.js";
import { evidenceFromAuditEvents, parseAuditJsonl } from "../verifier/session_adapter.js";
import type { BudgetState } from "./budget.js";
import { runStep } from "./executor.js";
import { checkpoint, refPrefix } from "./harness.js";
import type { SessionState, Step } from "./types.js";

export const REVIEW_TOOLS = ["read", "grep", "glob"];
const DIFF_CAP = 15_000;

const Concern = z.object({
  severity: z.enum(["high", "medium", "low"]).catch("medium"),
  issue: z.string(),
  evidence: z.string().default(""),
});
const VerdictSchema = z.object({
  verdict: z.enum(["complete", "incomplete"]),
  goal_met: z.boolean().nullable().catch(null),
  tests_passed: z.boolean().nullable().catch(null),
  destructive: z.boolean().nullable().catch(null),
  scope_ok: z.boolean().nullable().catch(null),
  concerns: z.array(Concern).catch([]).default([]),
  follow_up: z.string().nullable().optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export interface ReviewResult {
  verdict: "complete" | "incomplete" | "unparsed";
  goal_met: boolean | null;
  tests_passed: boolean | null;
  destructive: boolean | null;
  scope_ok: boolean | null;
  concerns: Array<{ severity: "high" | "medium" | "low"; issue: string; evidence: string }>;
  follow_up?: string | null;
  model: string;
  provider: string;
  cost_usd: number;
  /** L4.5 over the reviewer's cited evidence. */
  grounding?: { verified: number; ungrounded: number; missed: number; ungrounded_values: string[] };
  raw?: string;
}

/** The reviewer's JSON: the last fenced block that validates, else the outermost braces. */
export function parseVerdict(text: string): Verdict | null {
  const tries: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) if (m[1]) tries.unshift(m[1]);
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      const v = VerdictSchema.safeParse(JSON.parse(t));
      if (v.success) return v.data;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

/**
 * First reachable model in the `reviewer` role (falling back to
 * `security_reviewer`) whose vendor did none of the work. An explicit
 * `--review <model>` wins. If every reachable reviewer shares a vendor with
 * the work, the first reachable one is used rather than none.
 */
export async function pickReviewer(
  workProviders: Set<string>,
  override?: string,
  reach: (m: ModelInfo) => Promise<string> = modelReach,
): Promise<ModelInfo | null> {
  const cfg = loadModels();
  if (override && override !== "auto") {
    const m = cfg.models.find((x) => x.id === override);
    if (!m) throw new Error(`--review: ${override} is not in config/models.yml`);
    return (await reach(m)) === "reachable" ? m : null;
  }
  const ids = roleList(cfg.defaults.reviewer).length
    ? roleList(cfg.defaults.reviewer)
    : roleList(cfg.defaults.security_reviewer);
  let first: ModelInfo | null = null;
  for (const id of ids) {
    const m = cfg.models.find((x) => x.id === id);
    if (!m || (await reach(m)) !== "reachable") continue;
    first ??= m;
    if (!workProviders.has(m.provider)) return m;
  }
  return first;
}

/**
 * The real change set: a snapshot of the tree now (tracked + untracked)
 * diffed against the run's first checkpoint, or HEAD without one. Leaves one
 * ref, refs/patchwork-harness/<session>/review; the user's index/HEAD are untouched.
 */
export async function gatherChanges(cwd: string, sessionId: string): Promise<string> {
  const git = (args: string[]) => execa("git", args, { cwd, reject: false });
  if ((await git(["rev-parse", "--show-toplevel"])).exitCode !== 0)
    return "(not a git repository: no diff available - inspect the files with read/grep/glob)";
  const first = await git(["rev-parse", "--verify", "-q", `${refPrefix(sessionId)}step-1`]);
  const head = await git(["rev-parse", "--verify", "-q", "HEAD"]);
  const base =
    first.exitCode === 0 ? first.stdout.trim() : head.exitCode === 0 ? head.stdout.trim() : "";
  const now = await checkpoint(cwd, sessionId, "review");
  if (!now) return "(could not snapshot the working tree for a diff)";
  if (!base) {
    const files = await git(["ls-tree", "-r", "--name-only", now]);
    return `(no base commit: every file is new)\n${files.stdout}`;
  }
  const stat = (await git(["diff", "--stat", base, now])).stdout;
  const diff = (await git(["diff", base, now])).stdout;
  const body =
    diff.length > DIFF_CAP
      ? `${diff.slice(0, DIFF_CAP)}\n…[diff truncated: ${diff.length} chars - read the files for the rest]`
      : diff;
  return `${stat.trim() || "(no changes)"}\n\n${body}`;
}

export function reviewDescription(goal: string, state: SessionState, changes: string): string {
  const steps = state.results
    .map(
      (r, i) =>
        `${i + 1}. ${r.step.title} [${r.step.provider}/${r.step.model}] ${r.status}: ${r.output_summary.slice(0, 300)}`,
    )
    .join("\n");
  const v = state.verification;
  const gate = v
    ? `Test gate \`${v.cmd}\`: ${v.passed ? "PASSED" : "FAILED"} (exit ${v.exit_code}) after ${v.attempts} attempt(s). Output tail:\n${v.tail.slice(-1500)}`
    : "No test gate ran (no --verify-cmd was given). tests_passed must be null.";
  return `You are the L5 REVIEWER. Another AI did this work; you did not. Review it independently and skeptically.
You can read, grep and glob the working directory. You cannot change anything.

GOAL:
${goal}

WHAT THE STEPS REPORTED (claims, not proof):
${steps || "(no steps)"}

${gate}

THE ACTUAL CHANGES (git diff of the working tree since the run began):
${changes}

Answer this rubric:
1. goal_met - does the final state actually achieve the goal? Check the files, not the step claims.
2. tests_passed - true/false from the test gate above; null if no gate ran. Never guess.
3. destructive - did the work delete or overwrite anything the goal did not need?
4. scope_ok - is every change needed for the goal (no unrelated edits)?
Every concern MUST cite evidence: an exact quote from a file you read, from the diff above, or from the test output, in "evidence". No evidence, no concern.
verdict is "complete" only if goal_met is true, tests_passed is not false, and destructive is false.

Finish with ONLY this JSON as your last message, nothing after it:
{"verdict":"complete|incomplete","goal_met":true,"tests_passed":null,"destructive":false,"scope_ok":true,"concerns":[{"severity":"high|medium|low","issue":"...","evidence":"exact quote"}],"follow_up":"one concrete next step, or null"}`;
}

/** L4.5 over the reviewer's cited evidence, against this session's audit trail. */
export function groundReview(v: Verdict, sessionId: string): ReviewResult["grounding"] | undefined {
  if (!v.concerns.length) return undefined;
  try {
    const events = parseAuditJsonl(readFileSync(join(EVENTS_DIR, `${sessionId}.jsonl`), "utf8"));
    const evidence = evidenceFromAuditEvents(events).evidence;
    const text = v.concerns
      .filter((c) => c.evidence)
      .map((c) => `"${c.evidence}"`)
      .join("\n");
    if (!text) return undefined;
    const r = verify(text, evidence);
    return {
      verified: r.verified,
      ungrounded: r.ungrounded,
      missed: r.missed,
      ungrounded_values: r.atoms
        .filter((a) => a.verdict === "UNGROUNDED")
        .map((a) => a.value)
        .slice(0, 10),
    };
  } catch {
    return undefined;
  }
}

export async function runReview(opts: {
  goal: string;
  cwd: string;
  sessionId: string;
  audit: AuditEmitter;
  budget: BudgetState;
  state: SessionState;
  mode: "auto" | "default" | "cautious";
  reporter?: JsonReporter;
  human?: HumanChannel;
  unattended: boolean;
  model?: string;
}): Promise<ReviewResult | null> {
  const workProviders = new Set<string>(
    opts.state.results.filter((r) => !r.step.pause_for_human).map((r) => r.step.provider),
  );
  const m = await pickReviewer(workProviders, opts.model);
  if (!m) return null;
  const changes = await gatherChanges(opts.cwd, opts.sessionId);
  // the diff is real git output: record it as a tool result so L4.5 can
  // ground a concern that quotes it (no model-authored input, no taint)
  opts.audit.emit({
    action: "tool_use_start",
    risk: { level: "low", flags: [] },
    target: { tool: "bash", harness: "review_diff" },
  });
  const diffOut = JSON.stringify({ stdout: changes }).slice(0, 16000);
  opts.audit.emit({
    action: "tool_use_end",
    status: "completed",
    target: { tool: "bash", harness: "review_diff" },
    content: diffOut,
    provenance: { output: diffOut },
  });
  const step: Step = {
    title: "L5 review",
    description: reviewDescription(opts.goal, opts.state, changes),
    provider: m.provider as Step["provider"],
    model: m.id,
    max_tool_turns: 8,
    reason: `L5 reviewer: ${m.provider} reviews work done by ${[...workProviders].join("+") || "nobody"}`,
  };
  const r = await runStep({
    step,
    cwd: opts.cwd,
    sessionId: opts.sessionId,
    audit: opts.audit,
    budget: opts.budget,
    mode: opts.mode,
    systemContext: "",
    reporter: opts.reporter,
    human: opts.human,
    unattended: opts.unattended,
    toolAllow: REVIEW_TOOLS,
  });
  const base = { model: r.step.model, provider: r.step.provider, cost_usd: r.cost_usd };
  const v = parseVerdict(r.output_summary);
  if (!v)
    return {
      ...base,
      verdict: "unparsed",
      goal_met: null,
      tests_passed: null,
      destructive: null,
      scope_ok: null,
      concerns: [],
      raw: r.output_summary.slice(0, 1500),
    };
  // the rubric's own rule, enforced: "complete" needs goal_met, no failed gate, nothing destructive
  const consistent =
    v.verdict === "complete" &&
    (v.goal_met !== true || v.tests_passed === false || v.destructive === true)
      ? "incomplete"
      : v.verdict;
  return { ...base, ...v, verdict: consistent, grounding: groundReview(v, opts.sessionId) };
}

/** The repair instruction built from an INCOMPLETE L5 verdict (--review-fix). */
export function reviewRepairDescription(goal: string, rv: ReviewResult): string {
  const concerns = rv.concerns
    .map(
      (c, i) =>
        `${i + 1}. [${c.severity}] ${c.issue}${c.evidence ? `\n   evidence: ${c.evidence}` : ""}`,
    )
    .join("\n");
  return [
    `The goal was: ${goal}`,
    `An independent reviewer (${rv.provider}/${rv.model}) judged the work INCOMPLETE:`,
    concerns || "(no specific concerns given)",
    rv.follow_up ? `Its suggested next step: ${rv.follow_up}` : "",
    "Fix the real problems in the code. Do NOT edit, weaken or delete tests or checks to make them pass. If a concern is wrong, leave that code as it is and say why, citing the file and line.",
  ]
    .filter(Boolean)
    .join("\n");
}
