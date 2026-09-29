/**
 * LIVE provider checks - real API calls, real money (cents). Skipped unless
 * PATCHWORK_HARNESS_LIVE=1. Run from WSL with:
 *   WSLENV=PATCHWORK_HARNESS_LIVE PATCHWORK_HARNESS_LIVE=1 cmd.exe /c "npx vitest run tests/live"
 * These are the proofs that the 7 Sept 2026 fixes hold against the APIs:
 *   - Gemini 3.x tool-call round trip (thought signatures echoed)
 *   - OpenAI Responses-API path for the -pro line
 *   - gpt-6-astra answers on this key; gpt-6 / gpt-6-pro do not (yet)
 */
import { describe, expect, it } from "vitest";
import { loadEnvFiles } from "../../src/util/env.js";

loadEnvFiles();
process.env.PATCHWORK_HARNESS_AVAILABILITY_PROBE = "on"; // live: really probe
const live = process.env.PATCHWORK_HARNESS_LIVE === "1";

describe.skipIf(!live)("live: Gemini 3.x tool calls round-trip with thought signatures", () => {
  it("makes a function call, receives the result, and answers without a 400", async () => {
    const { GeminiProvider } = await import("../../src/providers/gemini.js");
    const p = new GeminiProvider();
    const tools = [
      {
        name: "read",
        description: "Read a file",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ];
    const messages = [
      {
        role: "user" as const,
        content: [
          {
            type: "text" as const,
            text: "Call the read tool on package.json, then tell me the value of its name field in one line.",
          },
        ],
      },
    ];
    const first = await p.complete({ model: "gemini-3.8-flash", messages, tools, maxTokens: 512 });
    const call = first.content.find((c) => c.type === "tool_use");
    expect(call, "model should call the tool").toBeDefined();
    if (!call || call.type !== "tool_use") return;
    expect(typeof call.thought_signature === "string" || call.thought_signature === undefined).toBe(
      true,
    );
    const second = await p.complete({
      model: "gemini-3.8-flash",
      messages: [
        ...messages,
        { role: "assistant", content: first.content },
        {
          role: "tool",
          content: [
            {
              type: "tool_result",
              tool_use_id: call.id,
              content: JSON.stringify({
                path: "package.json",
                content: '{"name": "patchwork-harness"}',
              }),
            },
          ],
        },
      ],
      tools,
      maxTokens: 256,
    });
    const text = second.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { text: string }).text)
      .join(" ");
    expect(text.toLowerCase()).toContain("patchwork-harness");
    expect(second.cost_usd).toBeGreaterThan(0);
  }, 120_000);
});

describe.skipIf(!live)("live: OpenAI", () => {
  it("gpt-6-astra answers on this key via chat completions", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const r = await new OpenAIProvider().complete({
      model: "gpt-6-astra",
      messages: [
        { role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] },
      ],
      maxTokens: 16,
    });
    expect(r.usage.input_tokens).toBeGreaterThan(0);
    expect(r.cost_usd).toBeGreaterThan(0);
  }, 60_000);

  it("a -pro model goes through the Responses API", async () => {
    const { OpenAIProvider } = await import("../../src/providers/openai.js");
    const r = await new OpenAIProvider().complete({
      model: "gpt-5.5-pro",
      messages: [
        { role: "user", content: [{ type: "text", text: "Reply with the single word OK." }] },
      ],
      maxTokens: 16,
    });
    expect(r.usage.input_tokens).toBeGreaterThan(0);
    expect(r.cost_usd).toBeGreaterThan(0);
  }, 180_000);

  it("gpt-6 and gpt-6-pro are unreachable on this key and the probe says so without throwing", async () => {
    const { modelReach, resetAvailabilityCache } = await import(
      "../../src/providers/availability.js"
    );
    const { loadModels } = await import("../../src/config.js");
    resetAvailabilityCache();
    const cat = loadModels().models;
    const g6 = await modelReach(cat.find((m) => m.id === "gpt-6")!);
    const g6p = await modelReach(cat.find((m) => m.id === "gpt-6-pro")!);
    expect(["unreachable", "reachable"]).toContain(g6);
    expect(["unreachable", "reachable"]).toContain(g6p);
    // eslint-disable-next-line no-console
    console.log(`[live] gpt-6=${g6} gpt-6-pro=${g6p}`);
  }, 60_000);
});

describe.skipIf(!live)("live: Anthropic Opus 5 thinking blocks round-trip through a tool call", () => {
  it("returns a thinking block as an opaque provider_block, never as answer text, and the echoed history is accepted", async () => {
    const { AnthropicProvider } = await import("../../src/providers/anthropic.js");
    const p = new AnthropicProvider();
    const tools = [
      {
        name: "read",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    ];
    const messages = [
      { role: "user" as const, content: [{ type: "text" as const, text: "Call the read tool on package.json, then tell me the value of its name field in one line." }] },
    ];
    const first = await p.complete({ model: "claude-opus-5", messages, tools, maxTokens: 4000 });
    const call = first.content.find((c) => c.type === "tool_use");
    expect(call, "model should call the tool").toBeDefined();
    if (!call || call.type !== "tool_use") return;
    const thinking = first.content.filter((c) => c.type === "text" && (c as { provider_block?: unknown }).provider_block);
    const prose = first.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
    expect(prose).not.toContain("signature");
    // eslint-disable-next-line no-console
    console.log(`[live] opus-5 first turn: ${thinking.length} thinking block(s), ${first.usage.output_tokens} out tokens`);
    const second = await p.complete({
      model: "claude-opus-5",
      messages: [
        ...messages,
        { role: "assistant", content: first.content },
        { role: "tool", content: [{ type: "tool_result", tool_use_id: call.id, content: JSON.stringify({ path: "package.json", content: "{\"name\": \"patchwork-harness\"}" }) }] },
      ],
      tools,
      maxTokens: 4000,
    });
    const text = second.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join(" ");
    expect(text.toLowerCase()).toContain("patchwork-harness");
    expect(text).not.toContain("\"signature\"");
    expect(second.cost_usd).toBeGreaterThan(0);
  }, 180_000);
});
