/**
 * The verifier exam board (ADR-0012) — turns the NDJSON test log into the
 * 21-tile view of the L4.5 exam.
 *
 * THE BOARD'S OWN LAW mirrors ADR-0011: **GREEN only when every corpus
 * case is present, passing, and the run completed.** Any FAIL is
 * NOT_GREEN. Any SKIP, MISSING case or incomplete run is UNVERIFIABLE —
 * a skipped exam is never a passed exam, and a board that cannot show
 * red or missing is a defect.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TestEvent } from "../testing/test_events.js";

export type CaseState = "PASS" | "FAIL" | "SKIP" | "RUNNING" | "MISSING";

export interface ExamBoard {
  cases: Array<{
    id: string;
    title: string;
    state: CaseState;
    duration_ms?: number;
    error?: string;
  }>;
  overall: "GREEN" | "NOT_GREEN" | "UNVERIFIABLE";
  counts: { pass: number; fail: number; skip: number; running: number; missing: number };
  runComplete: boolean;
}

/** Corpus ids + titles straight from the corpus files — the answer key. */
export function corpusCases(corpusDir: string): Array<{ id: string; title: string }> {
  return readdirSync(corpusDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      const c = JSON.parse(readFileSync(join(corpusDir, f), "utf8"));
      return { id: String(c.id), title: String(c.title ?? c.id) };
    });
}

const EXAM_FILE = /verifier-exam\.test\.ts$/;
const CASE_NAME = /^([a-z][a-z0-9-]*-\d{3}) — /;

export function buildExamBoard(
  events: TestEvent[],
  corpus: Array<{ id: string; title: string }>,
): ExamBoard {
  const seen = new Map<string, { state: CaseState; duration_ms?: number; error?: string }>();
  let runComplete = false;
  for (const e of events) {
    if (e.type === "run_end") runComplete = true;
    if (e.type === "run_start") {
      runComplete = false;
      seen.clear();
    }
    if (e.type !== "task") continue;
    if (!EXAM_FILE.test(e.file)) continue;
    const m = CASE_NAME.exec(e.name);
    if (!m?.[1]) continue;
    const state: CaseState =
      e.state === "pass"
        ? "PASS"
        : e.state === "fail"
          ? "FAIL"
          : e.state === "run"
            ? "RUNNING"
            : "SKIP";
    seen.set(m[1], { state, duration_ms: e.duration_ms, error: e.error });
  }
  const cases = corpus.map(({ id, title }) => {
    const s = seen.get(id);
    return { id, title, state: (s?.state ?? "MISSING") as CaseState, ...s };
  });
  const counts = {
    pass: cases.filter((c) => c.state === "PASS").length,
    fail: cases.filter((c) => c.state === "FAIL").length,
    skip: cases.filter((c) => c.state === "SKIP").length,
    running: cases.filter((c) => c.state === "RUNNING").length,
    missing: cases.filter((c) => c.state === "MISSING").length,
  };
  let overall: ExamBoard["overall"];
  if (counts.fail > 0) overall = "NOT_GREEN";
  else if (!runComplete || counts.skip > 0 || counts.missing > 0 || counts.running > 0)
    overall = "UNVERIFIABLE";
  else if (counts.pass === cases.length && cases.length > 0) overall = "GREEN";
  else overall = "UNVERIFIABLE";
  return { cases, overall, counts, runComplete };
}
