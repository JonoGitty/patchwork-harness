/** ADR-0017 `patchwork-harness eval`: suites, configs, scoring - no API calls (fake bin). */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

process.env.HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-eval-home-"));
const {
  estimateUsd,
  fillFlags,
  loadSuite,
  parseConfig,
  readRun,
  runSuite,
  runTask,
  summarise,
  tokenize,
} = await import("../src/eval/runner.js");
const { PROJECT_ROOT } = await import("../src/util/paths.js");

const STARTER = join(PROJECT_ROOT, "evals", "starter");

describe("suite + configs", () => {
  it("loads the starter suite", () => {
    const tasks = loadSuite(STARTER);
    expect(tasks.map((t) => t.id)).toEqual(["csv-sum", "duration", "paginate", "slugify"]);
    for (const t of tasks) {
      expect(t.check).toBe("node check.js");
      expect(t.verify).toBe("node test.js");
    }
  });
  it("tokenises quoted flags and expands presets / {verify}", () => {
    expect(tokenize(`--verify-cmd "npm test -- --ci" --attempts 3`)).toEqual([
      "--verify-cmd",
      "npm test -- --ci",
      "--attempts",
      "3",
    ]);
    expect(parseConfig("gate").flags).toContain("{verify}");
    expect(parseConfig("mine=--review gpt-6-sol")).toEqual({
      name: "mine",
      flags: ["--review", "gpt-6-sol"],
    });
    expect(() => parseConfig("nope")).toThrow(/unknown eval config/);
    expect(parseConfig("gate+review+fix").flags).toEqual([
      "--verify-cmd",
      "{verify}",
      "--attempts",
      "3",
      "--review",
      "--review-fix",
    ]);
    const [task] = loadSuite(STARTER);
    expect(fillFlags(parseConfig("gate").flags, task!)).toEqual([
      "--verify-cmd",
      "node test.js",
      "--attempts",
      "3",
    ]);
  });
  it("refuses a suite whose worst case exceeds --max-usd", async () => {
    const tasks = loadSuite(STARTER);
    expect(estimateUsd(tasks, [parseConfig("baseline"), parseConfig("gate")], 2)).toBeCloseTo(
      4 * 0.3 * 2 * 2,
      6,
    );
    await expect(runSuite(STARTER, [parseConfig("baseline")], { maxUsd: 0.5 })).rejects.toThrow(
      /exceeds --max-usd/,
    );
  });
});

describe("scoring", () => {
  it("reads status, cost, gate and L5 verdict from a run's NDJSON", () => {
    const nd = [
      '{"type":"session_start","session_id":"ses_1","data":{}}',
      '{"type":"harness","session_id":"ses_1","data":{"kind":"verify","passed":false}}',
      '{"type":"harness","session_id":"ses_1","data":{"kind":"verify","passed":true}}',
      '{"type":"harness","session_id":"ses_1","data":{"kind":"review","verdict":"complete"}}',
      '{"type":"session_end","session_id":"ses_1","data":{"status":"completed","total_cost_usd":0.12}}',
    ].join("\n");
    expect(readRun(nd)).toEqual({
      session_id: "ses_1",
      status: "completed",
      cost_usd: 0.12,
      gate_passed: true,
      review_verdict: "complete",
    });
  });
  it("summarises pass rate, cost and L5 agreement with the hidden check", () => {
    const row = (config: string, pass: boolean, cost: number, review?: string) => ({
      task: "t",
      config,
      trial: 1,
      pass,
      status: "completed",
      cost_usd: cost,
      duration_ms: 2000,
      check_tail: "",
      review_verdict: review,
    });
    const s = summarise([
      row("a", true, 0.1, "complete"),
      row("a", false, 0.3, "complete"), // reviewer wrongly passed it
      row("a", false, 0.2, "incomplete"),
      row("b", true, 0.05),
    ]);
    expect(s[0]).toMatchObject({
      config: "a",
      passed: 1,
      runs: 3,
      review_agreement: { agreed: 2, of: 3 },
    });
    expect(s[0]?.mean_cost_usd).toBeCloseTo(0.2, 9);
    expect(s[1]).toMatchObject({ config: "b", passed: 1, runs: 1 });
    expect(s[1]?.review_agreement).toBeUndefined();
  });
});

describe("runTask end to end (fake patchwork-harness)", () => {
  const fake = (body: string) => {
    const f = join(mkdtempSync(join(tmpdir(), "patchwork-harness-fakebin-")), "fake.mjs");
    writeFileSync(
      f,
      `import { writeFileSync } from "node:fs"; import { join } from "node:path";
const cwd = process.argv[process.argv.indexOf("--cwd") + 1];
${body}
console.log(JSON.stringify({ type: "session_start", session_id: "ses_fake", data: {} }));
console.log(JSON.stringify({ type: "session_end", session_id: "ses_fake", data: { status: "completed", total_cost_usd: 0.01 } }));`,
    );
    return f;
  };
  const paginate = loadSuite(STARTER).find((t) => t.id === "paginate")!;

  it("scores a correct fix as PASS via the hidden check", async () => {
    const bin = fake(
      `writeFileSync(join(cwd, "paginate.js"), "module.exports = (xs, p, n) => p < 1 ? [] : xs.slice((p - 1) * n, (p - 1) * n + n);\\n");`,
    );
    const r = await runTask(paginate, parseConfig("baseline"), 1, { bin });
    expect(r).toMatchObject({
      task: "paginate",
      pass: true,
      status: "completed",
      cost_usd: 0.01,
      session_id: "ses_fake",
    });
    expect(r.check_tail).toContain("hidden check passed");
  }, 60_000);

  it("scores an agent that only fixed the visible case as FAIL", async () => {
    // passes test.js (page 1) but not the hidden edge cases (page 0 / past the end)
    const bin = fake(
      `writeFileSync(join(cwd, "paginate.js"), "module.exports = (xs, p, n) => xs.slice((p - 1) * n, (p - 1) * n + n);\\n");`,
    );
    const r = await runTask(paginate, parseConfig("baseline"), 1, { bin });
    expect(r.pass).toBe(false);
  }, 60_000);
});
