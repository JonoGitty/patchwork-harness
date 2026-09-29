import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-l5cal-home-"));
const { loadPlanted, scoreCalibration } = await import("../src/eval/review_calibration.js");
const { PROJECT_ROOT } = await import("../src/util/paths.js");

describe("L5 calibration (planted solutions)", () => {
  it("loads one good and two bad cases per starter task, with the right expectation", () => {
    const cases = loadPlanted(join(PROJECT_ROOT, "evals", "starter"));
    expect(cases).toHaveLength(12);
    for (const c of cases) expect(c.expected).toBe(c.name === "good" ? "complete" : "incomplete");
    expect(cases.filter((c) => c.expected === "incomplete")).toHaveLength(8);
  });

  it("scores catches, false alarms and unparsed per model", () => {
    const row = (model: string, expected: "complete" | "incomplete", verdict: string) => ({
      task: "t",
      case: "c",
      expected,
      verdict: verdict as "complete",
      correct: verdict === expected,
      model,
      cost_usd: 0.01,
      concerns: [],
      ungrounded: 0,
    });
    const [s] = scoreCalibration([
      row("m", "incomplete", "incomplete"), // caught
      row("m", "incomplete", "complete"), // missed
      row("m", "complete", "complete"), // good passed
      row("m", "complete", "incomplete"), // false alarm
      row("m", "incomplete", "unparsed"),
    ]);
    expect(s).toMatchObject({
      model: "m",
      caught: 1,
      bad: 3,
      passed_good: 1,
      good: 2,
      unparsed: 1,
    });
    expect(s?.accuracy).toBeCloseTo(2 / 5, 9);
    expect(s?.cost_usd).toBeCloseTo(0.05, 9);
  });
});
