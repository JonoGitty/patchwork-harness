import { describe, expect, it } from "vitest";
import {
  assertWithinBedrock,
  BedrockBreachError,
  bedrockHeadroom,
  getModeProfile,
  loadBudgetConfig,
  sessionHeadroom,
  snapshot,
  withinSessionAllowance,
  type BudgetState,
} from "../src/core/budget.js";

const baseState = (overrides: Partial<BudgetState> = {}): BudgetState => ({
  bedrock_usd: 10,
  session_usd: 1,
  mode: "balanced",
  spent_usd: 0,
  ...overrides,
});

describe("budget config", () => {
  it("loads defaults", () => {
    const cfg = loadBudgetConfig();
    expect(cfg.defaults.bedrock_usd).toBeGreaterThan(0);
    expect(cfg.defaults.monthly_cap_usd).toBeGreaterThan(cfg.defaults.bedrock_usd);
    expect(["budget", "balanced", "unlimited"]).toContain(cfg.defaults.mode);
  });

  it("has all three mode profiles", () => {
    expect(getModeProfile("budget")).toBeDefined();
    expect(getModeProfile("balanced")).toBeDefined();
    expect(getModeProfile("unlimited")).toBeDefined();
  });

  it("unlimited mode allows arbitrary overrun within bedrock", () => {
    const profile = getModeProfile("unlimited");
    expect(profile.soft_overrun_pct).toBeGreaterThan(100);
  });

  it("budget mode forbids overrun", () => {
    const profile = getModeProfile("budget");
    expect(profile.soft_overrun_pct).toBe(0);
  });
});

describe("bedrock enforcement", () => {
  it("does not throw within bedrock", () => {
    const s = baseState({ spent_usd: 5 });
    expect(() => assertWithinBedrock(s, 1)).not.toThrow();
  });

  it("throws BedrockBreachError when about to exceed", () => {
    const s = baseState({ spent_usd: 9.5 });
    expect(() => assertWithinBedrock(s, 1)).toThrow(BedrockBreachError);
  });

  it("throws when already exceeded with no additional", () => {
    const s = baseState({ spent_usd: 11 });
    expect(() => assertWithinBedrock(s, 0)).toThrow(BedrockBreachError);
  });
});

describe("session allowance by mode", () => {
  it("budget mode rejects any overrun", () => {
    const s = baseState({ mode: "budget", session_usd: 1, spent_usd: 1.01 });
    expect(withinSessionAllowance(s)).toBe(false);
  });

  it("balanced mode allows ~25% overrun (flagships cost more)", () => {
    const s = baseState({ mode: "balanced", session_usd: 1, spent_usd: 1.20 });
    expect(withinSessionAllowance(s)).toBe(true);
    const s2 = baseState({ mode: "balanced", session_usd: 1, spent_usd: 1.30 });
    expect(withinSessionAllowance(s2)).toBe(false);
  });

  it("unlimited mode allows huge overrun within bedrock", () => {
    const s = baseState({ mode: "unlimited", session_usd: 1, spent_usd: 5 });
    expect(withinSessionAllowance(s)).toBe(true);
  });
});

describe("snapshot reporting", () => {
  it("computes percent_used and headrooms", () => {
    const s = baseState({ spent_usd: 0.5 });
    const snap = snapshot(s);
    expect(snap.percent_used).toBe(50);
    expect(snap.headroom_usd).toBeCloseTo(0.5);
    expect(snap.bedrock_headroom_usd).toBeCloseTo(9.5);
  });

  it("handles zero session_usd safely", () => {
    const s = baseState({ session_usd: 0, spent_usd: 0 });
    expect(snapshot(s).percent_used).toBe(0);
  });

  it("sessionHeadroom and bedrockHeadroom can go negative", () => {
    const s = baseState({ spent_usd: 1.5 });
    expect(sessionHeadroom(s)).toBeCloseTo(-0.5);
    expect(bedrockHeadroom(s)).toBeCloseTo(8.5);
  });
});
