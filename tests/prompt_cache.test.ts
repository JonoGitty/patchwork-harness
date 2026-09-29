/**
 * Prompt caching + cache-aware cost (28 Sept 2026). Measured before the fix:
 * the live budget line sat inside the cached system block, so every paid
 * turn re-wrote ~4.3k tokens and read none; and `input_tokens` (which
 * EXCLUDES cache writes/reads) was the only input priced, so the bedrock
 * never saw them. After: turn 2+ read 4,211 tokens from cache, ~87% cheaper.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-cache-home-"));
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-cache";

const seen: Array<{ system?: string; systemDynamic?: string }> = [];
const replies = [
  {
    content: [{ type: "tool_use", id: "t1", name: "glob", input: { pattern: "*.md" } }],
    stop_reason: "tool_use",
  },
  { content: [{ type: "text", text: "done" }], stop_reason: "end_turn" },
];
vi.mock("../src/providers/registry.js", () => {
  const mk = (name: string) => ({
    name,
    defaultModel: "x",
    available: () => true,
    complete: async (req: { system?: string; systemDynamic?: string }) => {
      seen.push({ system: req.system, systemDynamic: req.systemDynamic });
      const r = replies.shift();
      if (!r) throw new Error("script exhausted");
      return {
        ...r,
        usage: { input_tokens: 10, output_tokens: 5 },
        cost_usd: 0.0123,
        duration_ms: 1,
      };
    },
    stream: async function* () {
      throw new Error("not implemented");
    },
  });
  const providers = new Map(
    ["anthropic", "openai", "gemini", "xai", "perplexity", "local"].map((n) => [n, mk(n)]),
  );
  return { providers: () => providers, getProvider: (n: string) => providers.get(n) };
});

const { anthropicCost, cacheReadMultiplier, totalInput, withConversationCache } = await import(
  "../src/providers/anthropic.js"
);
const { systemText } = await import("../src/providers/base.js");

describe("cache-aware Anthropic cost", () => {
  it("prices cache writes at 1.25x and reads at the model's multiplier", () => {
    const u = {
      input_tokens: 78,
      output_tokens: 10,
      cache_creation_input_tokens: 4292,
      cache_read_input_tokens: 0,
    };
    // opus-5-5 is $4/$20
    expect(anthropicCost("claude-opus-5-5", u)).toBeCloseTo(
      (78 * 4 + 4292 * 4 * 1.25 + 10 * 20) / 1e6,
      10,
    );
    const hit = {
      input_tokens: 78,
      output_tokens: 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 4292,
    };
    expect(anthropicCost("claude-opus-5-5", hit)).toBeCloseTo(
      (78 * 4 + 4292 * 4 * 0.05 + 10 * 20) / 1e6,
      10,
    );
    expect(totalInput(u)).toBe(4370);
  });
  it("knows the per-model cache-hit prices", () => {
    expect(cacheReadMultiplier("claude-fable-5-1")).toBe(0.025);
    expect(cacheReadMultiplier("claude-opus-5-5")).toBe(0.05);
    expect(cacheReadMultiplier("claude-sonnet-5")).toBe(0.1);
  });
});

describe("conversation cache breakpoint", () => {
  it("marks only the newest message's last cacheable block", () => {
    const msgs = [
      { role: "user" as const, content: [{ type: "text" as const, text: "a" }] },
      { role: "user" as const, content: [{ type: "text" as const, text: "b" }] },
    ];
    const out = withConversationCache(msgs);
    expect(JSON.stringify(out[0])).not.toContain("cache_control");
    expect(out[1]?.content).toEqual([
      { type: "text", text: "b", cache_control: { type: "ephemeral" } },
    ]);
    expect(JSON.stringify(msgs)).not.toContain("cache_control"); // input untouched
  });
  it("leaves thinking-tailed messages alone (they cannot carry cache_control)", () => {
    const msgs = [
      {
        role: "assistant" as const,
        content: [{ type: "thinking", thinking: "x", signature: "s" } as never],
      },
    ];
    expect(withConversationCache(msgs)).toBe(msgs);
  });
});

describe("the executor keeps live spend out of the cached prompt", () => {
  it("sends an identical system block every turn and the budget as systemDynamic", async () => {
    const { runStep } = await import("../src/core/executor.js");
    const { AuditEmitter } = await import("../src/audit.js");
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-cache-"));
    const sessionId = `test-cache-${Date.now()}`;
    await runStep({
      step: {
        title: "s",
        description: "d",
        provider: "anthropic",
        model: "claude-sonnet-5",
        max_tool_turns: 3,
        reason: "r",
      },
      cwd,
      sessionId,
      audit: new AuditEmitter(sessionId, cwd, "cache-test"),
      budget: { bedrock_usd: 5, session_usd: 1, mode: "balanced", spent_usd: 0 },
      mode: "auto",
      systemContext: "ctx",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]?.system).toBe(seen[1]?.system); // cacheable: byte-identical
    expect(seen[0]?.system).not.toContain("Budget: spent");
    expect(seen[0]?.systemDynamic).toContain("spent $0.0000");
    expect(seen[1]?.systemDynamic).toContain("spent $0.0123"); // live spend still reaches the model
  }, 60_000);
  it("systemText appends the dynamic part for the single-string adapters", () => {
    expect(systemText({ system: "S", systemDynamic: "D" })).toBe("S\n\nD");
    expect(systemText({ system: "S" })).toBe("S");
    expect(systemText({ systemDynamic: "D" })).toBe("D");
  });
});
