import { describe, expect, it } from "vitest";
import type { Message } from "../src/providers/base.js";
import { fromGeminiParts, geminiCost, toGeminiContents } from "../src/providers/gemini.js";

describe("Gemini 3.x thought signatures", () => {
  it("captures thoughtSignature from response parts onto our content blocks", () => {
    const content = fromGeminiParts([
      { text: "", thoughtSignature: "sigTEXT" },
      { functionCall: { name: "read", args: { path: "a.ts" } }, thoughtSignature: "sigCALL" },
      { thought: true, text: "internal reasoning summary" },
    ]);
    expect(content).toHaveLength(2);
    expect(content[0]).toMatchObject({ type: "text", text: "", thought_signature: "sigTEXT" });
    expect(content[1]).toMatchObject({
      type: "tool_use",
      name: "read",
      thought_signature: "sigCALL",
    });
  });

  it("echoes every signature back on the same part in the follow-up request", () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "read a.ts" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "", thought_signature: "sigTEXT" },
          {
            type: "tool_use",
            id: "call_1",
            name: "read",
            input: { path: "a.ts" },
            thought_signature: "sigCALL",
          },
          { type: "tool_use", id: "call_2", name: "grep", input: { pattern: "x" } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: '{"content":"..."}' },
          { type: "tool_result", tool_use_id: "call_2", content: "boom", is_error: true },
        ],
      },
    ];
    const contents = toGeminiContents(history);
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "user"]);
    const model = contents[1]!;
    expect(model.parts[0]).toEqual({ text: "", thoughtSignature: "sigTEXT" });
    expect(model.parts[1]).toEqual({
      functionCall: { name: "read", args: { path: "a.ts" } },
      thoughtSignature: "sigCALL",
    });
    expect(model.parts[2]).toEqual({ functionCall: { name: "grep", args: { pattern: "x" } } });
    // all responses to the parallel batch in ONE user turn, matched by NAME not our id
    const responses = contents[2]!;
    expect(responses.parts).toHaveLength(2);
    expect(responses.parts[0].functionResponse.name).toBe("read");
    expect(responses.parts[0].functionResponse.response).toEqual({ content: '{"content":"..."}' });
    expect(responses.parts[1].functionResponse.name).toBe("grep");
    expect(responses.parts[1].functionResponse.response).toEqual({ error: "boom" });
    expect(JSON.stringify(contents)).not.toContain("call_1");
  });

  it("drops an empty text part that carries no signature (the API rejects it)", () => {
    const contents = toGeminiContents([
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool_use", id: "c", name: "read", input: {} },
        ],
      },
    ]);
    expect(contents[0]!.parts).toHaveLength(1);
    expect(contents[0]!.parts[0].functionCall.name).toBe("read");
  });
});

describe("Gemini pricing", () => {
  it("prices 3.8 Flash from the catalog and applies the >200k tier to 3.1 Pro", () => {
    expect(geminiCost("gemini-3.8-flash", 1_000_000, 0)).toBeCloseTo(0.75, 6);
    expect(geminiCost("gemini-3.1-pro-preview", 100_000, 0)).toBeCloseTo(0.2, 6);
    expect(geminiCost("gemini-3.1-pro-preview", 300_000, 0)).toBeCloseTo(1.2, 6);
    expect(geminiCost("gemini-never-heard-of", 1000, 1000)).toBeUndefined();
  });
});
