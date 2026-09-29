import { describe, expect, it } from "vitest";
import { fromResponsesOutput, openaiCost, usesResponsesApi } from "../src/providers/openai.js";
import { priceForModel } from "../src/providers/pricing.js";

describe("OpenAI: Responses-API routing for the -pro line", () => {
  it("routes pro models to the Responses API and everything else to chat", () => {
    expect(usesResponsesApi("gpt-5.5-pro")).toBe(true);
    expect(usesResponsesApi("gpt-5.4-pro-2026-03-05")).toBe(true);
    expect(usesResponsesApi("o3-pro")).toBe(true);
    expect(usesResponsesApi("gpt-6-pro")).toBe(true); // catalog says api: responses
    expect(usesResponsesApi("gpt-6-astra")).toBe(false);
    expect(usesResponsesApi("gpt-5.6-sol")).toBe(false);
    expect(usesResponsesApi("o4-mini")).toBe(false);
  });

  it("parses Responses output items into content blocks", () => {
    const out = fromResponsesOutput({
      status: "completed",
      output: [
        { type: "reasoning", summary: [] },
        {
          type: "message",
          content: [
            { type: "output_text", text: "hello " },
            { type: "output_text", text: "world" },
          ],
        },
        { type: "function_call", call_id: "call_9", name: "read", arguments: '{"path":"a"}' },
      ],
    });
    expect(out.content).toEqual([
      { type: "text", text: "hello world" },
      { type: "tool_use", id: "call_9", name: "read", input: { path: "a" } },
    ]);
    expect(out.stop_reason).toBe("tool_use");
    const cut = fromResponsesOutput({
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [],
    });
    expect(cut.stop_reason).toBe("max_tokens");
  });
});

describe("OpenAI pricing", () => {
  it("uses the catalog with longest-prefix matching and the 272k long-context tier", () => {
    expect(priceForModel("gpt-5.6-sol")).toEqual({ in: 4, out: 20 });
    expect(priceForModel("gpt-5.6-sol-2026-08-01")).toEqual({ in: 4, out: 20 });
    expect(openaiCost("gpt-6-astra", 100_000, 0)).toBeCloseTo(1.0, 6); // short-context tier $10/M
    expect(openaiCost("gpt-6-astra", 300_000, 1_000_000)).toBeCloseTo(6 + 75, 6); // >272k: $20/$75
    expect(openaiCost("gpt-5.6-luna", 100_000, 100_000)).toBeCloseTo(0.14, 6);
  });

  it("returns no price for models whose price is unknown in the catalog", () => {
    expect(priceForModel("gpt-6")).toBeNull();
    expect(priceForModel("gpt-6-pro")).toBeNull();
    expect(openaiCost("gpt-6-pro", 1000, 1000)).toBeUndefined();
  });
});
