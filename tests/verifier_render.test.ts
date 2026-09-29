import { describe, expect, it } from "vitest";
import { verify } from "../src/verifier/grounding.js";
import type { Report } from "../src/verifier/grounding.js";
import { renderReport, reportExitCode } from "../src/verifier/render.js";

describe("reportExitCode — all five overalls", () => {
  const mk = (overall: Report["overall"]): Report => ({
    atoms: [],
    verified: 0,
    ungrounded: 0,
    missed: 0,
    coverage: 0,
    overall,
  });
  it("maps the full table", () => {
    expect(reportExitCode(mk("GREEN"))).toBe(0);
    expect(reportExitCode(mk("GREEN_WITH_MISSED"))).toBe(0);
    expect(reportExitCode(mk("NOT_GREEN"))).toBe(1);
    expect(reportExitCode(mk("UNVERIFIABLE"))).toBe(2);
    expect(reportExitCode(mk("INVALID"))).toBe(3);
  });
});

describe("renderReport — fed a RED report, must render the red", () => {
  it("shows the ungrounded atom, its glyph, and all three counts", () => {
    const report = verify("The account spent £398.19 this week.", [
      { event_id: "e1", type: "tool_result", tool: "bash", output: "spend=527.22" },
    ]);
    const text = renderReport(report, { color: false });
    expect(text).toContain("✗ UNGROUNDED");
    expect(text).toContain("£398.19");
    expect(text).toContain("NOT_GREEN");
    expect(text).toMatch(/0 verified · 1 ungrounded · 0 missed/);
  });
});
