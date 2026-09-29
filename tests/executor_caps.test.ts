import { describe, expect, it } from "vitest";
import {
  TOOL_RESULT_CAP_DEFAULT,
  TOOL_RESULT_CAP_READ,
  capToolResult,
} from "../src/core/executor.js";

describe("executor tool-result caps", () => {
  it("leaves small results untouched", () => {
    const s = capToolResult("read", { path: "a", content: "hello", truncated: false });
    expect(s).toBe(JSON.stringify({ path: "a", content: "hello", truncated: false }));
  });

  it("gives read a 60k budget and tells the model the exact offset to continue from", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${"y".repeat(30)}`);
    const result = {
      path: "big",
      content: lines.join("\n"),
      truncated: false,
      total_lines: 3000,
      start_line: 1,
      end_line: 3000,
    };
    const s = capToolResult("read", result);
    expect(s.length).toBeGreaterThan(TOOL_RESULT_CAP_READ);
    expect(s.length).toBeLessThan(TOOL_RESULT_CAP_READ + 400);
    expect(s).toContain(`showing ${TOOL_RESULT_CAP_READ} of`);
    const m = s.match(/offset=(\d+)/);
    expect(m).not.toBeNull();
    const offset = Number(m![1]);
    // the offset must point just past the last line actually shown
    const shownLines = (s.slice(0, TOOL_RESULT_CAP_READ).match(/\\n/g) ?? []).length;
    expect(offset).toBe(1 + shownLines);
    expect(offset).toBeGreaterThan(1000);
    expect(s).toMatch(/never report code you have not seen as absent/);
  });

  it("respects the page's start_line when computing the next offset", () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `l${i} ${"z".repeat(40)}`);
    const s = capToolResult("read", { content: lines.join("\n"), start_line: 500 });
    const offset = Number(s.match(/offset=(\d+)/)![1]);
    expect(offset).toBeGreaterThan(500);
  });

  it("keeps 8k for other tools and gives grep-specific advice", () => {
    const matches = Array.from({ length: 400 }, (_, i) => ({
      file: `src/f${i}.ts`,
      line: i,
      text: "x".repeat(60),
    }));
    const s = capToolResult("grep", { matches, truncated: false });
    expect(s.length).toBeLessThan(TOOL_RESULT_CAP_DEFAULT + 400);
    expect(s).toContain(`showing ${TOOL_RESULT_CAP_DEFAULT} of`);
    expect(s).toMatch(/max_matches/);
    const b = capToolResult("bash", { stdout: "q".repeat(20000) });
    expect(b).toContain(`showing ${TOOL_RESULT_CAP_DEFAULT} of`);
  });
});
