import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * Integration: spawn a REAL vitest over the mini-suite fixture (which
 * contains a deliberately FAILING test) and assert the NDJSON log records
 * the failure. A reporter that can only write green is a defect.
 */
import { execa } from "execa";
import { afterAll, describe, expect, it } from "vitest";
import { parseTestLog, summarize } from "../src/testing/test_events.js";
import { PROJECT_ROOT } from "../src/util/paths.js";

const tmp = mkdtempSync(join(tmpdir(), "ndjson-rep-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("NdjsonFileReporter (integration, real vitest child)", () => {
  it("records pass, FAIL and skip with a run_end, and counts reconcile", async () => {
    const fixtureRoot = join(PROJECT_ROOT, "tests", "fixtures", "mini-suite");
    const r = await execa(
      process.execPath,
      [join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs"), "run", "--root", fixtureRoot],
      {
        env: { ...process.env, PATCHWORK_HARNESS_TEST_LOG_DIR: tmp },
        reject: false, // the fixture FAILS by design — that is the point
        timeout: 120_000,
      },
    );
    expect(r.exitCode).not.toBe(0); // the failing test must fail the child

    const raw = readFileSync(join(tmp, "latest.jsonl"), "utf8");
    const { events, runComplete } = parseTestLog(raw.split("\n"));
    expect(runComplete).toBe(true);
    const s = summarize(events);
    expect(s.totals.passed).toBe(1);
    expect(s.totals.failed).toBe(1); // THE assertion: red is recorded as red
    expect(s.totals.skipped).toBe(1);
    const fail = events.find((e) => e.type === "task" && e.state === "fail");
    expect(fail && "error" in fail && fail.error).toBeTruthy();
  }, 150_000);
});
