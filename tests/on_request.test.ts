import { describe, expect, it, vi } from "vitest";

// On-request models must never be reached through any fallbackModelFor path,
// even when the config is arranged so one would be found first.
const state = vi.hoisted(() => ({
  cfg: { models: [] as unknown[], defaults: {} as Record<string, string> },
  tiers: [] as Array<{ id: string; tier: string }>,
}));
const model = (id: string, provider: string, on_request = false) => ({
  id,
  provider,
  context_window: 100000,
  cost_per_m_in: 1,
  cost_per_m_out: 1,
  strengths: [],
  availability: "verified",
  on_request,
});
vi.mock("../src/config.js", () => ({
  loadModels: () => state.cfg,
  loadModelCapabilities: () => ({ models: state.tiers, domain_routing: {} }),
  roleList: (v: unknown) => (Array.isArray(v) ? v : v ? [v] : []),
}));
vi.mock("../src/providers/registry.js", () => {
  const p = { available: () => true };
  return { providers: () => new Map(), getProvider: () => p };
});

const { fallbackModelFor } = await import("../src/providers/availability.js");

describe("on_request models and every fallbackModelFor path", () => {
  it("executor default: skips an on-request executor and widens to another tier instead", async () => {
    state.cfg = { models: [model("old-haiku", "anthropic", true), model("flag", "openai")], defaults: { executor: "old-haiku" } };
    state.tiers = [
      { id: "old-haiku", tier: "cheap_fast" },
      { id: "flag", tier: "flagship" },
    ];
    expect((await fallbackModelFor("some-unknown-model"))?.id).toBe("flag");
  });

  it("nearest tier: skips an on-request model in the first tier searched", async () => {
    // unknown id -> default tier order flagship, workhorse, ...: the on-request
    // model is the only flagship, so without the guard it would be picked first
    state.cfg = { models: [model("old-flag", "anthropic", true), model("work", "openai")], defaults: { executor: "absent" } };
    state.tiers = [
      { id: "old-flag", tier: "flagship" },
      { id: "work", tier: "workhorse" },
    ];
    expect((await fallbackModelFor("some-unknown-model"))?.id).toBe("work");
  });
});
