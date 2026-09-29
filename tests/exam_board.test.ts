import { describe, expect, it } from "vitest";
import type { TestEvent } from "../src/testing/test_events.js";
import { buildExamBoard } from "../src/verifier/exam_board.js";

const CORPUS = [
  { id: "fab-001", title: "fabricated" },
  { id: "ok-001", title: "grounded" },
  { id: "mis-001", title: "misattribution" },
];
const task = (id: string, state: "pass" | "fail" | "skip" | "run"): TestEvent => ({
  type: "task",
  run_id: "r1",
  timestamp: "t",
  file: "tests/verifier-exam.test.ts",
  name: `${id} — some title`,
  suite: ["L4.5 grounding-verifier exam (ADR-0011)"],
  state,
});
const runEnd: TestEvent = {
  type: "run_end",
  run_id: "r1",
  timestamp: "t",
  passed: 0,
  failed: 0,
  skipped: 0,
  todo: 0,
  duration_ms: 1,
  interrupted: false,
};

describe("buildExamBoard — GREEN is earned, never assumed", () => {
  it("GREEN only when every case passes AND the run completed", () => {
    const b = buildExamBoard(
      [task("fab-001", "pass"), task("ok-001", "pass"), task("mis-001", "pass"), runEnd],
      CORPUS,
    );
    expect(b.overall).toBe("GREEN");
    expect(b.counts).toEqual({ pass: 3, fail: 0, skip: 0, running: 0, missing: 0 });
  });

  it("one FAIL makes the board NOT_GREEN", () => {
    const b = buildExamBoard(
      [task("fab-001", "pass"), task("ok-001", "fail"), task("mis-001", "pass"), runEnd],
      CORPUS,
    );
    expect(b.overall).toBe("NOT_GREEN");
    expect(b.counts.fail).toBe(1);
  });

  it("an absent case is MISSING and the board is UNVERIFIABLE — never green", () => {
    const b = buildExamBoard([task("fab-001", "pass"), task("ok-001", "pass"), runEnd], CORPUS);
    expect(b.cases.find((c) => c.id === "mis-001")?.state).toBe("MISSING");
    expect(b.overall).toBe("UNVERIFIABLE");
  });

  it("all passing but run NOT complete is UNVERIFIABLE (crash mid-run)", () => {
    const b = buildExamBoard(
      [task("fab-001", "pass"), task("ok-001", "pass"), task("mis-001", "pass")],
      CORPUS,
    );
    expect(b.overall).toBe("UNVERIFIABLE");
    expect(b.runComplete).toBe(false);
  });

  it("skipped cases are UNVERIFIABLE — a skipped exam is never a passed exam", () => {
    const b = buildExamBoard(
      [task("fab-001", "skip"), task("ok-001", "skip"), task("mis-001", "skip"), runEnd],
      CORPUS,
    );
    expect(b.overall).toBe("UNVERIFIABLE");
    expect(b.counts.skip).toBe(3);
  });

  it("non-exam files never leak onto the board", () => {
    const stray: TestEvent = {
      ...task("fab-001", "fail"),
      file: "tests/other.test.ts",
    } as TestEvent;
    const b = buildExamBoard([stray, runEnd], CORPUS);
    expect(b.counts.fail).toBe(0);
    expect(b.counts.missing).toBe(3);
  });
});
