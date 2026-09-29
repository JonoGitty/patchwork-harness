import { describe, expect, it } from "vitest";
import { type TestEvent, parseTestLog, summarize } from "../src/testing/test_events.js";

const ev = (e: Partial<TestEvent> & { type: TestEvent["type"] }): string =>
  JSON.stringify({ run_id: "r1", timestamp: "2026-09-01T00:00:00Z", ...e });

describe("parseTestLog", () => {
  it("skips malformed lines and reports runComplete honestly", () => {
    const { events, runComplete } = parseTestLog([
      ev({ type: "run_start" }),
      "{{{not json",
      ev({ type: "task", file: "a.test.ts", name: "t1", suite: [], state: "pass" } as never),
    ]);
    expect(events).toHaveLength(2);
    expect(runComplete).toBe(false); // no run_end => NOT complete
  });
});

describe("summarize", () => {
  it("later states supersede run, all-fail input renders all-fail", () => {
    const lines = [
      ev({ type: "run_start" }),
      ev({ type: "task", file: "a.test.ts", name: "t1", suite: [], state: "run" } as never),
      ev({ type: "task", file: "a.test.ts", name: "t1", suite: [], state: "fail" } as never),
      ev({ type: "task", file: "a.test.ts", name: "t2", suite: [], state: "fail" } as never),
      ev({
        type: "run_end",
        passed: 0,
        failed: 2,
        skipped: 0,
        todo: 0,
        duration_ms: 5,
        interrupted: false,
      } as never),
    ];
    const s = summarize(parseTestLog(lines).events);
    expect(s.totals.failed).toBe(2);
    expect(s.totals.passed).toBe(0);
    expect(s.runComplete).toBe(true);
    expect(s.files[0]?.failed).toBe(2);
  });

  it("a new run_start resets the wall", () => {
    const lines = [
      ev({ type: "run_start", run_id: "r1" } as never),
      ev({ type: "task", file: "a.test.ts", name: "t1", suite: [], state: "fail" } as never),
      ev({ type: "run_start", run_id: "r2" } as never),
      ev({ type: "task", file: "a.test.ts", name: "t1", suite: [], state: "pass" } as never),
    ];
    const s = summarize(parseTestLog(lines).events);
    expect(s.runId).toBe("r2");
    expect(s.totals.failed).toBe(0);
    expect(s.totals.passed).toBe(1);
    expect(s.runComplete).toBe(false);
  });
});
