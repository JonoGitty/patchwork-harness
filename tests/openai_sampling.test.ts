import { describe, expect, it } from "vitest";
import { openaiSamplingAllowed, usesResponsesApi } from "../src/providers/openai.js";

// Measured against the live API on 28 Sept 2026 with temperature 0.2
// (gpt-6.1-sol on 2 Oct 2026).
describe("openaiSamplingAllowed", () => {
  it("drops temperature for the models that reject it", () => {
    for (const m of [
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.5",
      "o4-mini",
      "o3-pro",
    ])
      expect(openaiSamplingAllowed(m), m).toBe(false);
  });
  it("keeps it for the models that accept it", () => {
    for (const m of ["gpt-5.4-mini", "gpt-4.1"]) expect(openaiSamplingAllowed(m), m).toBe(true);
  });
});

// Measured 28 Sept 2026 (gpt-6.1-sol 2 Oct): chat completions reject function tools for these.
describe("usesResponsesApi", () => {
  it("sends tool-bearing GPT-6 / GPT-5.6 requests to the Responses API", () => {
    for (const m of [
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
    ]) {
      expect(usesResponsesApi(m, true), m).toBe(true);
      expect(usesResponsesApi(m, false), `${m} without tools`).toBe(false);
    }
  });
  it("leaves models that accept tools on chat alone, and keeps the -pro line on Responses", () => {
    for (const m of ["gpt-5.5", "gpt-5.4-mini", "o4-mini"])
      expect(usesResponsesApi(m, true), m).toBe(false);
    expect(usesResponsesApi("gpt-5.5-pro")).toBe(true);
  });
});
