/**
 * /api/tests/* routes against fixture logs — via app.request(), no server.
 * The fixtures are RED and CRASHED runs: routes that can only report green
 * are defects, so we feed them failure and incompleteness first.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const tmp = mkdtempSync(join(tmpdir(), "webtests-"));
process.env.PATCHWORK_HARNESS_TEST_LOG_DIR = tmp; // BEFORE the app import graph loads paths
const { app } = await import("../src/web/app.js");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.PATCHWORK_HARNESS_TEST_LOG_DIR;
});

const line = (o: object) => `${JSON.stringify(o)}\n`;
const EXAM_FILE = "tests/verifier-exam.test.ts";

function writeLog(events: object[]): void {
  writeFileSync(join(tmp, "latest.jsonl"), events.map((e) => line(e)).join(""));
}

describe("/api/tests routes (red fixtures first)", () => {
  it("a FAILING exam run reports NOT_GREEN with the fail counted", async () => {
    writeLog([
      { type: "run_start", run_id: "r1", timestamp: "t" },
      {
        type: "task",
        run_id: "r1",
        timestamp: "t",
        file: EXAM_FILE,
        name: "fab-001 — fabricated currency amount",
        suite: [],
        state: "fail",
        error: "expected UNGROUNDED",
      },
      {
        type: "run_end",
        run_id: "r1",
        timestamp: "t",
        passed: 0,
        failed: 1,
        skipped: 0,
        todo: 0,
        duration_ms: 5,
        interrupted: false,
      },
    ]);
    const res = await app.request("/api/tests/exam");
    expect(res.status).toBe(200);
    const board = await res.json();
    expect(board.overall).toBe("NOT_GREEN");
    expect(board.counts.fail).toBe(1);
    expect(board.counts.missing).toBeGreaterThan(0); // 20 other cases absent — SHOWN, not hidden
  });

  it("a CRASHED run (no run_end) is UNVERIFIABLE, never green", async () => {
    writeLog([
      { type: "run_start", run_id: "r2", timestamp: "t" },
      {
        type: "task",
        run_id: "r2",
        timestamp: "t",
        file: EXAM_FILE,
        name: "fab-001 — fabricated currency amount",
        suite: [],
        state: "pass",
      },
    ]);
    const board = await (await app.request("/api/tests/exam")).json();
    expect(board.overall).toBe("UNVERIFIABLE");
    expect(board.runComplete).toBe(false);
  });

  it("/api/tests/latest summarises the wall and reports runComplete honestly", async () => {
    writeLog([
      { type: "run_start", run_id: "r3", timestamp: "t" },
      {
        type: "task",
        run_id: "r3",
        timestamp: "t",
        file: "tests/a.test.ts",
        name: "t1",
        suite: [],
        state: "fail",
        error: "boom",
      },
    ]);
    const j = await (await app.request("/api/tests/latest")).json();
    expect(j.runComplete).toBe(false);
    expect(j.summary.totals.failed).toBe(1);
  });

  it("run endpoint rejects a malicious filter", async () => {
    const res = await app.request("/api/tests/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter: "x; rm -rf /" }),
    });
    expect(res.status).toBe(400);
  });
});
