import { describe, expect, it } from "vitest";
import { loadModelCapabilities, loadModels, roleList } from "../src/config.js";
import { priceForModel } from "../src/providers/pricing.js";

describe("config/models.yml (refreshed 2026-09-28)", () => {
  const cfg = loadModels();
  const by = (id: string) => cfg.models.find((m) => m.id === id);

  it("parses `unknown` prices to null and keeps verified prices numeric", () => {
    expect(by("gpt-6")?.cost_per_m_in).toBeNull();
    expect(by("gpt-6-pro")?.cost_per_m_out).toBeNull();
    expect(by("gpt-6-astra")?.cost_per_m_in).toBe(10);
    expect(by("claude-opus-5")?.cost_per_m_out).toBe(25);
  });

  it("marks reachability honestly: gpt-6 / gpt-6-pro / mythos unverified, the rest verified with a date", () => {
    for (const id of ["gpt-6", "gpt-6-pro", "claude-mythos-5-1", "claude-sonnet-5-5"])
      expect(by(id)?.availability).toBe("unverified");
    for (const id of [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-opus-5",
      "gemini-3.8-flash",
      "grok-4.7",
      "grok-4.6",
    ]) {
      expect(by(id)?.availability).toBe("verified");
      expect(by(id)?.verified_on).toBe("2026-09-28");
    }
  });

  it("has a reason-bearing role per job, including the new security_reviewer list", () => {
    expect(cfg.defaults.planner).toBe("gpt-6-luna");
    expect(cfg.defaults.planner_fallback).toBe("claude-haiku-4-5");
    expect(cfg.defaults.executor).toBe("claude-opus-5-5");
    expect(cfg.defaults.bulk_executor).toBe("claude-sonnet-5");
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
    expect(priceForModel("claude-opus-5")).toEqual({ in: 5, out: 25 });
    expect(priceForModel("gemini-3.8-flash-001")).toEqual({ in: 0.75, out: 3.75 });
    expect(priceForModel("totally-unknown")).toBeNull();
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
});
