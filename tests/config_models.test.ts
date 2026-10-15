import { describe, expect, it } from "vitest";
import { Price, loadModelCapabilities, loadModels, roleList } from "../src/config.js";
import { geminiCost, geminiMaxOutputTokens } from "../src/providers/gemini.js";
import { openaiCost } from "../src/providers/openai.js";
import { priceForModel } from "../src/providers/pricing.js";

describe("config/models.yml (refreshed 2026-10-15)", () => {
  const cfg = loadModels();
  const by = (id: string) => cfg.models.find((m) => m.id === id);

  it("parses `unknown` prices to null and keeps verified prices numeric", () => {
    // No catalogued model is unknown-priced since the 15 Oct refresh dropped
    // the gpt-6 / gpt-6-pro placeholders, so check the schema directly.
    expect(Price.parse("unknown")).toBeNull();
    expect(Price.parse(2.5)).toBe(2.5);
    expect(by("gpt-6-astra")?.cost_per_m_in).toBe(10);
    expect(by("claude-opus-5-5")?.cost_per_m_out).toBe(20);
  });

  it("marks reachability honestly: mythos unverified, the rest verified with a date", () => {
    expect(by("claude-mythos-5-1")?.availability).toBe("unverified");
    for (const id of [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "claude-fable-5-1",
      "claude-opus-5-5",
      "gemini-3.8-flash",
      "grok-4.7",
    ]) {
      expect(by(id)?.availability).toBe("verified");
      expect(by(id)?.verified_on).toBe("2026-09-28");
    }
    expect(by("gemini-4-argon")).toMatchObject({ availability: "verified", verified_on: "2026-10-15" });
  });

  it("drops superseded and never-reachable ids (15 Oct refresh)", () => {
    for (const id of [
      "gpt-6",
      "gpt-6-pro",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
      "gpt-5.6-sol",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.4-mini",
      "o4-mini",
      "o3-pro",
      "gemini-3.7-flash",
      "grok-4.6",
    ])
      expect(by(id), id).toBeUndefined();
  });

  it("has a reason-bearing role per job, including the new security_reviewer list", () => {
    expect(cfg.defaults.planner).toBe("gpt-6-luna");
    expect(cfg.defaults.planner_fallback).toBe("claude-haiku-5-5");
    expect(cfg.defaults.executor).toBe("claude-opus-5-5");
    expect(cfg.defaults.bulk_executor).toBe("claude-sonnet-5-5");
    expect(cfg.defaults.critic).toBe("gemini-3.8-flash");
    expect(roleList(cfg.defaults.security_reviewer)).toContain("gpt-6-astra");
    expect(roleList("one")).toEqual(["one"]);
    expect(roleList(undefined)).toEqual([]);
  });

  it("every default role and every reviewer id exists in the catalog", () => {
    const ids = new Set(cfg.models.map((m) => m.id));
    for (const id of [
      cfg.defaults.planner,
      cfg.defaults.planner_fallback!,
      cfg.defaults.executor,
      cfg.defaults.bulk_executor!,
      cfg.defaults.critic!,
      ...roleList(cfg.defaults.security_reviewer),
    ]) {
      expect(ids.has(id), id).toBe(true);
    }
  });

  it("every catalog model has a capability profile and vice versa", () => {
    const caps = loadModelCapabilities();
    const capIds = new Set(caps.models.map((m) => m.id));
    for (const m of cfg.models) expect(capIds.has(m.id), `capabilities missing ${m.id}`).toBe(true);
    const ids = new Set(cfg.models.map((m) => m.id));
    for (const c of caps.models) expect(ids.has(c.id), `catalog missing ${c.id}`).toBe(true);
    for (const [domain, r] of Object.entries(caps.domain_routing)) {
      for (const id of [...(r.preferred_models ?? []), ...r.cheap_fallback])
        expect(ids.has(id), `${domain} routes to unknown ${id}`).toBe(true);
    }
  });

  it("prices by longest catalog prefix so snapshots inherit their family price", () => {
    expect(priceForModel("claude-opus-5-5-20260922")).toEqual({ in: 4, out: 20 });
    expect(priceForModel("gemini-3.8-flash-001")).toEqual({ in: 0.75, out: 3.75 });
    expect(priceForModel("totally-unknown")).toBeNull();
  });

  it("an explicitly named dropped id still prices from the adapter's fallback table", () => {
    expect(priceForModel("o3-pro")).toBeNull(); // not in the catalog any more...
    expect(openaiCost("o3-pro", 1_000_000, 0)).toBeCloseTo(20); // ...but the adapter still knows it
    expect(openaiCost("gpt-5.5", 0, 1_000_000)).toBeCloseTo(30);
  });

  it("gemini-4-argon: catalog price now, the published step from 1 Dec 2026, clamped output (15 Oct)", () => {
    expect(priceForModel("gemini-4-argon")).toEqual({ in: 2, out: 10 });
    const before = new Date("2026-11-30T23:59:59Z");
    const after = new Date("2026-12-01T00:00:00Z");
    expect(geminiCost("gemini-4-argon", 1_000_000, 1_000_000, before)).toBeCloseTo(12);
    expect(geminiCost("gemini-4-argon", 1_000_000, 1_000_000, after)).toBeCloseTo(24);
    // 3.8 Flash's promo ends on 1 Jan 2027
    expect(geminiCost("gemini-3.8-flash", 1_000_000, 0, new Date("2026-12-31T12:00:00Z"))).toBeCloseTo(0.75);
    expect(geminiCost("gemini-3.8-flash", 1_000_000, 0, new Date("2027-01-01T00:00:00Z"))).toBeCloseTo(1.5);
    // Argon's output cap is 32,768: answer budget + thinking headroom is clamped to it
    expect(geminiMaxOutputTokens("gemini-4-argon", 16_384)).toBe(32_768);
    expect(geminiMaxOutputTokens("gemini-4-argon", 30_000)).toBe(32_768);
    expect(geminiMaxOutputTokens("gemini-3.8-flash", 16_000)).toBe(32_384);
    expect(geminiMaxOutputTokens("gemini-2.5-flash", 4096)).toBe(4096); // no thinking headroom
  });

  it("prices each new model as itself, not as its prefix (28 Sept refresh)", () => {
    // Before the refresh, claude-opus-5-5 fell through to claude-opus-5's
    // $5/$25, and gpt-6-sol matched the `unknown`-priced gpt-6 entry, so its
    // spend would never have reached the bedrock.
    expect(priceForModel("claude-opus-5-5")).toEqual({ in: 4, out: 20 });
    expect(priceForModel("gpt-6-sol")).toEqual({ in: 2, out: 10 });
    expect(priceForModel("gpt-6-luna")).toEqual({ in: 0.1, out: 0.5 });
    expect(priceForModel("grok-4.7")).toEqual({ in: 2, out: 6 });
    expect(priceForModel("claude-sonnet-5-5")).toEqual({ in: 2, out: 10 });
  });

  it("claude-haiku-5-5 and claude-sonnet-5-5 are verified and priced as themselves (8 Oct)", () => {
    // No catalog id prefixes "claude-haiku-5-5", so before it was listed its
    // calls would have gone on the ledger at $0.
    for (const id of ["claude-haiku-5-5", "claude-sonnet-5-5"])
      expect(by(id)).toMatchObject({ availability: "verified", verified_on: "2026-10-08" });
    expect(priceForModel("claude-haiku-5-5")).toEqual({ in: 0.1, out: 0.5 });
  });

  it("gpt-6.1-sol is priced as itself, not as the unknown-priced gpt-6 (2 Oct)", () => {
    // Before it was catalogued, "gpt-6.1-sol" matched the `gpt-6` entry by
    // prefix, which has no price, so every call went on the ledger at $0.
    expect(by("gpt-6.1-sol")).toMatchObject({
      availability: "verified",
      verified_on: "2026-10-02",
    });
    expect(priceForModel("gpt-6.1-sol")).toEqual({ in: 2, out: 10 });
    expect(openaiCost("gpt-6.1-sol", 100_000, 100_000)).toBeCloseTo(0.1 * 2 + 0.1 * 10);
    expect(openaiCost("gpt-6.1-sol", 300_000, 100_000)).toBeCloseTo(0.3 * 4 + 0.1 * 15);
  });
});
