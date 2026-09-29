import { describe, expect, it } from "vitest";
import { loadModels } from "../src/config.js";
import { enforceReachable } from "../src/core/planner.js";
import type { Step } from "../src/core/types.js";

// 28 Sept 2026: Haiku and Sonnet planned private writing onto gemma3:12b /
// qwen3:8b while the running Ollama did not have them loaded.
const cat = loadModels().models;
const m = (id: string) => cat.find((x) => x.id === id)!;
const step = (model: string, provider: Step["provider"], extra: Partial<Step> = {}): Step => ({
  title: "t",
  description: "d",
  provider,
  model,
  max_tool_turns: 3,
  reason: "r",
  ...extra,
});
const reachable = [m("claude-haiku-4-5"), m("claude-opus-5-5"), m("gpt-6-sol")];
const never = async () => null;

describe("enforceReachable (the planner may only use models it was offered)", () => {
  it("leaves reachable picks and pause steps alone", async () => {
    const steps = [
      step("claude-opus-5-5", "anthropic"),
      step("gemma3:12b", "local", { pause_for_human: true }),
    ];
    expect(await enforceReachable(steps, reachable, never)).toEqual(steps);
  });
  it("moves a hidden local pick to the writing cheap_fallback, never a flagship, and says so", async () => {
    const [out] = await enforceReachable([step("gemma3:12b", "local")], reachable, never);
    expect(out?.model).toBe("claude-haiku-4-5");
    expect(out?.provider).toBe("anthropic");
    expect(out?.reason).toContain("planner picked gemma3:12b, not available this session");
  });
  it("uses the same-tier fallback for any other unavailable or invented id", async () => {
    const [out] = await enforceReachable([step("gpt-9-imaginary", "openai")], reachable, async () =>
      m("gpt-6-sol"),
    );
    expect(out?.model).toBe("gpt-6-sol");
  });
  it("never swaps to a fallback that is itself unreachable", async () => {
    const [out] = await enforceReachable([step("gpt-9-imaginary", "openai")], reachable, async () =>
      m("gpt-6-astra"),
    );
    expect(reachable.map((r) => r.id)).toContain(out?.model);
  });
});
