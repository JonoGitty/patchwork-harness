import { describe, expect, it } from "vitest";
import { fromAnthropicContent, samplingAllowed, toAnthropicMessages } from "../src/providers/anthropic.js";
import type { Message } from "../src/providers/base.js";

describe("Anthropic thinking blocks (Opus 5 / Fable: on by default, display omitted)", () => {
  const raw = [
    { type: "thinking", thinking: "", signature: "CAQSqHsKEAgRGAI4AUII…" },
    { type: "text", text: "## 1. THREAT MODEL\nprose" },
    { type: "tool_use", id: "toolu_1", name: "read", input: { path: "a.py" } },
  ];

  it("never stringifies a thinking block into the answer text", () => {
    const content = fromAnthropicContent(raw as never);
    expect(content).toHaveLength(3);
    expect(content[0]).toMatchObject({ type: "text", text: "" });
    expect((content[0] as { provider_block?: unknown }).provider_block).toEqual(raw[0]);
    expect(content[1]).toEqual({ type: "text", text: "## 1. THREAT MODEL\nprose" });
    expect(content[2]).toMatchObject({ type: "tool_use", id: "toolu_1", name: "read" });
    const prose = content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    expect(prose).not.toContain("signature");
  });

  it("echoes the thinking block back VERBATIM on the next turn and drops empty text", () => {
    const history: Message[] = [
      { role: "user", content: [{ type: "text", text: "read a.py" }] },
      { role: "assistant", content: fromAnthropicContent(raw as never) },
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{}" }] },
    ];
    const msgs = toAnthropicMessages(history);
    expect(msgs).toHaveLength(3);
    const assistant = msgs[1]!;
    expect(assistant.role).toBe("assistant");
    const blocks = assistant.content as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text", "tool_use"]);
    expect(blocks[0]).toEqual(raw[0]);
    expect(blocks.some((b) => b.type === "text" && (b as { text: string }).text === "")).toBe(false);
    expect(msgs[2]!.role).toBe("user");
  });

  it("knows which models reject temperature", () => {
    for (const m of ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-fable-5-1", "claude-mythos-5-1", "claude-opus-4-8", "claude-opus-4-7"]) {
      expect(samplingAllowed(m), m).toBe(false);
    }
    for (const m of ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-opus-4-6"]) expect(samplingAllowed(m), m).toBe(true);
  });
});
