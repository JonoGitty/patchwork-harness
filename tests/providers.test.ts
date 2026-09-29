import { describe, expect, it } from "vitest";
import { providers, getProvider } from "../src/providers/registry.js";

describe("provider registry", () => {
  it("has all four providers", () => {
    const all = providers();
    expect(all.has("anthropic")).toBe(true);
    expect(all.has("openai")).toBe(true);
    expect(all.has("gemini")).toBe(true);
    expect(all.has("xai")).toBe(true);
  });

  it("each provider has a default model", () => {
    for (const name of ["anthropic", "openai", "gemini", "xai"] as const) {
      const p = getProvider(name);
      expect(p.defaultModel).toBeTruthy();
    }
  });

  it("availability reflects env vars", () => {
    const anth = getProvider("anthropic");
    expect(anth.available()).toBe(!!process.env.ANTHROPIC_API_KEY);
    const xai = getProvider("xai");
    expect(xai.available()).toBe(!!process.env.XAI_API_KEY);
  });

  it("unknown provider throws", () => {
    expect(() => getProvider("foo" as any)).toThrow();
  });
});
