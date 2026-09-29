/**
 * ADR-0013 Phase 2 — harvest real MISSED atoms for classifier calibration.
 *
 * Walks every Claude Code transcript (Windows + WSL), runs L4.5 on each
 * session's final answer, and sends the MISSED atoms to the configured
 * classifier with EXACTLY the request triage() would send. Writes:
 *
 *   items.jsonl        — every atom with the classifier's p (for scoring)
 *   items-blind.jsonl  — the same atoms WITHOUT p (for blind labelling)
 *
 * Output goes under ~/.patchwork-harness/calibration/<date>/ — never into the repo:
 * it holds verbatim transcript excerpts.
 *
 *   PATCHWORK_HARNESS_CLASSIFIER_URL=http://127.0.0.1:8009 npx tsx scripts/calibrate_classifier.ts
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { askSystemOne, classifierConfig } from "../src/classifier/systemone.js";
import { adaptClaudeTranscript, claudeProjectDirs } from "../src/verifier/claude_adapter.js";
import { verify } from "../src/verifier/grounding.js";
import { STATE_CHARS, buildTriageRequest } from "../src/verifier/triage.js";

const cfg = classifierConfig();
if (!cfg) {
  console.error("no classifier configured (PATCHWORK_HARNESS_CLASSIFIER_URL or TYPESAFE_API_KEY)");
  process.exit(3);
}
const outDir =
  process.env.PATCHWORK_HARNESS_CALIBRATION_OUT ??
  join(homedir(), ".patchwork-harness", "calibration", new Date().toISOString().slice(0, 10));
mkdirSync(outDir, { recursive: true });

const ACTIVE_MS = 10 * 60_000; // skip sessions still being written
// L4.5's taint check is quadratic; a handful of marathon sessions would take
// hours. Skip them whole rather than truncate: cutting early tool_calls would
// un-taint later lines and let model-authored text reach the classifier.
const MAX_EVIDENCE = 2000;
const items: Array<Record<string, unknown>> = [];
const seen = new Set<string>();
const stats = {
  transcripts: 0,
  tooBig: 0,
  answered: 0,
  withMissed: 0,
  atoms: 0,
  dupes: 0,
  errors: 0,
};

/** Top-level sessions AND subagent/workflow transcripts (each ends in a report). */
function* transcripts(dir: string): Generator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* transcripts(p);
    else if (e.name.endsWith(".jsonl") && e.name !== "journal.jsonl") yield p;
  }
}

for (const path of claudeProjectDirs().flatMap((d) => [...transcripts(d)])) {
  const t = {
    path,
    project: path.includes("subagents") ? "subagent" : "session",
    session: basename(path, ".jsonl"),
  };
  try {
    if (Date.now() - statSync(path).mtimeMs < ACTIVE_MS) continue;
  } catch {
    continue;
  }
  stats.transcripts++;
  let adapted: ReturnType<typeof adaptClaudeTranscript>;
  try {
    adapted = adaptClaudeTranscript(readFileSync(path, "utf8"));
  } catch {
    stats.errors++;
    continue;
  }
  if (!adapted.answer.trim() || adapted.stats.toolResults === 0) continue;
  if (adapted.evidence.length > MAX_EVIDENCE) {
    stats.tooBig++;
    continue;
  }
  stats.answered++;
  const report = verify(adapted.answer, adapted.evidence);
  if (report.missed === 0) continue;
  stats.withMissed++;
  const req = buildTriageRequest(
    adapted.answer,
    adapted.evidence,
    report,
    STATE_CHARS[cfg.backend],
  );
  let answers: Awaited<ReturnType<typeof askSystemOne>>["answers"];
  try {
    answers = (await askSystemOne(cfg, req.state, req.questions, { timeoutMs: 60_000 })).answers;
  } catch (err) {
    stats.errors++;
    console.error(`${t.session}: ${err instanceof Error ? err.message : err}`);
    continue;
  }
  for (const [i, a] of req.missed.entries()) {
    const key = createHash("sha1")
      .update(`${a.value}\u0000${req.state.tool_outputs.join("\n")}`)
      .digest("hex");
    if (seen.has(key)) {
      stats.dupes++;
      continue;
    }
    seen.add(key);
    const ans = answers[`atom_${i}`];
    items.push({
      id: `${t.session}-${i}`,
      project: t.project,
      session: t.session,
      kind: a.kind,
      why_missed: a.note ?? "",
      claim: a.value,
      sentence: req.sentences[i],
      tool_outputs: req.state.tool_outputs,
      p: ans?.type === "noul" ? ans.noul : null,
    });
    stats.atoms++;
  }
  process.stderr.write(`\r${stats.transcripts} transcripts · ${stats.atoms} atoms`);
}

const jsonl = (rows: Array<Record<string, unknown>>) =>
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
writeFileSync(join(outDir, "items.jsonl"), jsonl(items));
writeFileSync(join(outDir, "items-blind.jsonl"), jsonl(items.map(({ p, ...rest }) => rest)));
writeFileSync(
  join(outDir, "harvest.json"),
  JSON.stringify({ backend: cfg.backend, model: cfg.model, stats }, null, 2),
);
console.error(`\n${JSON.stringify(stats)}\n→ ${outDir}`);
