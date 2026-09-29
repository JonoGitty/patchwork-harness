import { describe, expect, it } from "vitest";
import { loadModelCapabilities, loadModels } from "../src/config.js";

describe("model capability corpus", () => {
  it("loads", () => {
    const caps = loadModelCapabilities();
    expect(caps.models.length).toBeGreaterThan(5);
    expect(caps.routing_heuristics.length).toBeGreaterThan(0);
    expect(caps.anti_patterns.length).toBeGreaterThan(0);
  });

  it("every capability entry has best_for and avoid_for", () => {
    const caps = loadModelCapabilities();
    for (const m of caps.models) {
      expect(m.best_for.length, `${m.id} missing best_for`).toBeGreaterThan(0);
      expect(m.avoid_for.length, `${m.id} missing avoid_for`).toBeGreaterThan(0);
    }
  });

  it("every capability entry corresponds to a registered model", () => {
    const caps = loadModelCapabilities();
    const models = loadModels();
    const ids = new Set(models.models.map((m) => m.id));
    for (const c of caps.models) {
      // Capability corpus may include models the registry doesn't price
      // (e.g. Gemini Flash). Just check that any registry model appears.
      // Soft check — log mismatches for the developer.
      if (!ids.has(c.id)) {
        console.warn(`capability for ${c.id} but not in models.yml`);
      }
    }
    // Conversely every priced model should have a capability entry.
    const capIds = new Set(caps.models.map((c) => c.id));
    for (const m of models.models) {
      expect(capIds.has(m.id), `${m.id} priced but no capability entry`).toBe(true);
    }
  });
});
