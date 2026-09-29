import { describe, expect, it } from "vitest";
import { loadModelCapabilities, loadModels } from "../src/config.js";
import {
  LocalProvider,
  isNoToolSupportError,
  localBaseUrl,
  parseOllamaTags,
} from "../src/providers/local.js";
import { getProvider } from "../src/providers/registry.js";

describe("local provider (Ollama)", () => {
  it("is registered", () => {
    const p = getProvider("local");
    expect(p.name).toBe("local");
    expect(p.defaultModel).toBeTruthy();
  });

  it("defaults to the local Ollama URL and respects overrides", () => {
    const prev = { url: process.env.PATCHWORK_HARNESS_LOCAL_URL, host: process.env.OLLAMA_HOST };
    // biome-ignore lint/performance/noDelete: assigning undefined to process.env coerces to the string "undefined"
    delete process.env.PATCHWORK_HARNESS_LOCAL_URL;
    // biome-ignore lint/performance/noDelete: same
    delete process.env.OLLAMA_HOST;
    expect(localBaseUrl()).toBe("http://127.0.0.1:11434/v1");
    process.env.PATCHWORK_HARNESS_LOCAL_URL = "http://10.0.0.5:11434";
    expect(localBaseUrl()).toBe("http://10.0.0.5:11434/v1");
    process.env.PATCHWORK_HARNESS_LOCAL_URL = "http://10.0.0.5:11434/v1/";
    expect(localBaseUrl()).toBe("http://10.0.0.5:11434/v1");
    if (prev.url) process.env.PATCHWORK_HARNESS_LOCAL_URL = prev.url;
    // biome-ignore lint/performance/noDelete: process.env semantics
    else delete process.env.PATCHWORK_HARNESS_LOCAL_URL;
    if (prev.host) process.env.OLLAMA_HOST = prev.host;
  });

  it("recognises Ollama's no-tool-support error", () => {
    expect(
      isNoToolSupportError(
        new Error("registry.ollama.ai/library/gemma3:12b does not support tools"),
      ),
    ).toBe(true);
    expect(isNoToolSupportError(new Error("connection refused"))).toBe(false);
  });

  it("PATCHWORK_HARNESS_LOCAL_FORCE=1 short-circuits the availability probe", () => {
    const prev = process.env.PATCHWORK_HARNESS_LOCAL_FORCE;
    process.env.PATCHWORK_HARNESS_LOCAL_FORCE = "1";
    expect(new LocalProvider().available()).toBe(true);
    if (prev) process.env.PATCHWORK_HARNESS_LOCAL_FORCE = prev;
    // biome-ignore lint/performance/noDelete: process.env semantics
    else delete process.env.PATCHWORK_HARNESS_LOCAL_FORCE;
  });

  it("local models are registered at $0 in models.yml", () => {
    const cfg = loadModels();
    const locals = cfg.models.filter((m) => m.provider === "local");
    expect(locals.length).toBeGreaterThanOrEqual(2);
    for (const m of locals) {
      expect(m.cost_per_m_in).toBe(0);
      expect(m.cost_per_m_out).toBe(0);
    }
  });

  it("capability corpus has local-tier entries and a writing domain", () => {
    const cfg = loadModelCapabilities();
    const locals = cfg.models.filter((m) => m.tier === "local");
    expect(locals.map((m) => m.id)).toContain("gemma3:12b");
    expect(cfg.domain_routing.writing).toBeDefined();
    expect(cfg.domain_routing.writing.preferred_tier).toBe("local");
  });
});

describe("parseOllamaTags (what the live server can actually run)", () => {
  it("lists each model with and without the implicit :latest tag", () => {
    const set = parseOllamaTags(
      JSON.stringify({ models: [{ name: "gemma3:12b" }, { name: "mistral-nemo:latest" }] }),
    );
    expect(set && [...set].sort()).toEqual(["gemma3:12b", "mistral-nemo", "mistral-nemo:latest"]);
  });
  it("says unknown (null) for a body that is not a tags listing, never 'nothing installed'", () => {
    expect(parseOllamaTags("<html>proxy error</html>")).toBeNull();
    expect(parseOllamaTags(JSON.stringify({ error: "x" }))).toBeNull();
  });
});
