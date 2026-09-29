/**
 * Vitest custom reporter (ADR-0012): mirrors every run to NDJSON on disk
 * so the web wall, `patchwork-harness test --live` and the cockpit can tail it.
 *
 *   ~/.patchwork-harness/tests/latest.jsonl   — truncated at run_start, then appended
 *   ~/.patchwork-harness/tests/runs/<id>.jsonl — per-run archive
 *
 * PATCHWORK_HARNESS_TEST_LOG_DIR overrides the directory (the reporter's own tests
 * use it; from WSL remember WSLENV=PATCHWORK_HARNESS_TEST_LOG_DIR/p).
 *
 * HARD RULE: a reporter failure must NEVER fail the suite — every write
 * is individually try/caught. The reporter is an observer, not a gate.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { File, Reporter, Task, TaskResultPack, Vitest } from "vitest";
import type { TestEvent, TestState } from "./test_events.js";

function testsDir(): string {
  return process.env.PATCHWORK_HARNESS_TEST_LOG_DIR || join(homedir(), ".patchwork-harness", "tests");
}

function newRunId(): string {
  // time-sortable, dependency-free (ulid lives in src/util but keep this
  // module importable by vitest.config.ts without the app's import graph)
  return `run_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Pure: map a finished/updated vitest task to our event, or null. */
export function taskToEvent(task: Task, runId: string): TestEvent | null {
  if (task.type !== "test") return null;
  const file = task.file?.name ?? "unknown";
  const suite: string[] = [];
  let p = task.suite;
  while (p && p.name) {
    suite.unshift(p.name);
    p = p.suite;
  }
  const r = task.result;
  let state: TestState;
  if (task.mode === "skip") state = "skip";
  else if (task.mode === "todo") state = "todo";
  else if (!r || r.state === "run") state = "run";
  else if (r.state === "pass") state = "pass";
  else if (r.state === "fail") state = "fail";
  else if (r.state === "skip" || r.state === "todo") state = r.state;
  else return null;
  const err = r?.errors?.[0];
  return {
    type: "task",
    run_id: runId,
    timestamp: new Date().toISOString(),
    file,
    name: task.name,
    suite,
    state,
    duration_ms: r?.duration,
    error: err ? String(err.message ?? err).slice(0, 500) : undefined,
  };
}

function collectTests(files: File[]): Task[] {
  const out: Task[] = [];
  const walk = (t: Task): void => {
    if (t.type === "test") out.push(t);
    if ("tasks" in t) for (const child of (t as { tasks: Task[] }).tasks) walk(child);
  };
  for (const f of files) walk(f as unknown as Task);
  return out;
}

export class NdjsonFileReporter implements Reporter {
  private ctx!: Vitest;
  private runId = newRunId();
  private latest = "";
  private archive = "";
  private emitted = new Map<string, string>(); // task.id -> last state written

  private write(e: TestEvent): void {
    const line = `${JSON.stringify(e)}\n`;
    try {
      appendFileSync(this.latest, line);
    } catch {
      /* never fail the suite */
    }
    try {
      appendFileSync(this.archive, line);
    } catch {
      /* never fail the suite */
    }
  }

  onInit(ctx: Vitest): void {
    this.ctx = ctx;
    this.runId = newRunId();
    const dir = testsDir();
    this.latest = join(dir, "latest.jsonl");
    this.archive = join(dir, "runs", `${this.runId}.jsonl`);
    try {
      mkdirSync(join(dir, "runs"), { recursive: true });
      writeFileSync(this.latest, ""); // truncate: a new run resets the wall
    } catch {
      /* observer only */
    }
    this.write({
      type: "run_start",
      run_id: this.runId,
      timestamp: new Date().toISOString(),
    });
  }

  onCollected(files?: File[]): void {
    if (!files) return;
    const tests = collectTests(files);
    this.write({
      type: "collected",
      run_id: this.runId,
      timestamp: new Date().toISOString(),
      files: [...new Set(files.map((f) => f.name))],
      total: tests.length,
    });
  }

  onTaskUpdate(packs: TaskResultPack[]): void {
    for (const [id] of packs) {
      const task = this.ctx.state.idMap.get(id);
      if (!task) continue;
      const e = taskToEvent(task, this.runId);
      if (!e || e.type !== "task") continue;
      const key = `${e.file}::${e.name}`;
      if (this.emitted.get(key) === e.state) continue; // dedupe repeats
      this.emitted.set(key, e.state);
      this.write(e);
    }
  }

  onFinished(files?: File[], errors?: unknown[]): void {
    const tests = files ? collectTests(files) : [];
    // final sweep: make sure every terminal state got written
    for (const t of tests) {
      const e = taskToEvent(t, this.runId);
      if (!e || e.type !== "task" || e.state === "run") continue;
      const key = `${e.file}::${e.name}`;
      if (this.emitted.get(key) === e.state) continue;
      this.emitted.set(key, e.state);
      this.write(e);
    }
    const done = tests.filter((t) => t.result);
    this.write({
      type: "run_end",
      run_id: this.runId,
      timestamp: new Date().toISOString(),
      passed: done.filter((t) => t.result?.state === "pass").length,
      failed: done.filter((t) => t.result?.state === "fail").length,
      skipped: tests.filter((t) => t.mode === "skip" || t.result?.state === "skip").length,
      todo: tests.filter((t) => t.mode === "todo").length,
      duration_ms: 0,
      interrupted: Boolean(errors && errors.length > 0),
    });
  }
}
