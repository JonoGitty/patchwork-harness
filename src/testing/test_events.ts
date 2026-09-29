/**
 * The NDJSON test-log contract (ADR-0012) — ONE feed consumed by the web
 * wall, `patchwork-harness test --live`, the cockpit strip and the exam board.
 *
 * Pure types + pure parsers: everything here is unit-testable without
 * vitest running.
 */

export type TestState = "pass" | "fail" | "skip" | "todo" | "run";

export type TestEvent =
  | { type: "run_start"; run_id: string; timestamp: string }
  | {
      type: "collected";
      run_id: string;
      timestamp: string;
      files: string[];
      total: number;
    }
  | {
      type: "task";
      run_id: string;
      timestamp: string;
      file: string;
      name: string;
      suite: string[];
      state: TestState;
      duration_ms?: number;
      error?: string;
    }
  | {
      type: "run_end";
      run_id: string;
      timestamp: string;
      passed: number;
      failed: number;
      skipped: number;
      todo: number;
      duration_ms: number;
      interrupted: boolean;
    };

export interface FileRollup {
  file: string;
  tests: Array<{ name: string; state: TestState; duration_ms?: number; error?: string }>;
  passed: number;
  failed: number;
  skipped: number;
  running: number;
}

export interface WallSummary {
  runId: string | null;
  files: FileRollup[];
  totals: { passed: number; failed: number; skipped: number; todo: number; running: number };
  runComplete: boolean;
  interrupted: boolean;
}

/** Tolerant NDJSON parse: malformed lines are skipped, never fatal. */
export function parseTestLog(lines: string[]): { events: TestEvent[]; runComplete: boolean } {
  const events: TestEvent[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as TestEvent;
      if (e && typeof e === "object" && "type" in e) events.push(e);
    } catch {
      /* skip */
    }
  }
  const runComplete = events.some((e) => e.type === "run_end");
  return { events, runComplete };
}

/**
 * Roll events up into the wall shape. Later task events for the same
 * (file, name) supersede earlier ones — vitest emits run → pass/fail.
 */
export function summarize(events: TestEvent[]): WallSummary {
  const byFile = new Map<string, Map<string, FileRollup["tests"][number]>>();
  let runId: string | null = null;
  let runComplete = false;
  let interrupted = false;
  for (const e of events) {
    if (e.type === "run_start") {
      runId = e.run_id;
      byFile.clear(); // a new run resets the wall
      runComplete = false;
      interrupted = false;
    } else if (e.type === "task") {
      let f = byFile.get(e.file);
      if (!f) {
        f = new Map();
        byFile.set(e.file, f);
      }
      f.set(e.name, {
        name: e.name,
        state: e.state,
        duration_ms: e.duration_ms,
        error: e.error,
      });
    } else if (e.type === "run_end") {
      runComplete = true;
      interrupted = e.interrupted;
    }
  }
  const files: FileRollup[] = [];
  const totals = { passed: 0, failed: 0, skipped: 0, todo: 0, running: 0 };
  for (const [file, tests] of [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const list = [...tests.values()];
    const roll: FileRollup = {
      file,
      tests: list,
      passed: list.filter((t) => t.state === "pass").length,
      failed: list.filter((t) => t.state === "fail").length,
      skipped: list.filter((t) => t.state === "skip" || t.state === "todo").length,
      running: list.filter((t) => t.state === "run").length,
    };
    files.push(roll);
    totals.passed += roll.passed;
    totals.failed += roll.failed;
    totals.running += roll.running;
    for (const t of list) {
      if (t.state === "skip") totals.skipped++;
      if (t.state === "todo") totals.todo++;
    }
  }
  return { runId, files, totals, runComplete, interrupted };
}
