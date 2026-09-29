import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the on-disk cache: paths.ts reads HOME at import time.
process.env.HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-avail-home-"));
process.env.PATCHWORK_HARNESS_AVAILABILITY_PROBE = "on"; // this file tests the probe itself (mocked providers, tmp HOME)
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-availability";
process.env.OPENAI_API_KEY ??= "sk-test-availability";
process.env.GEMINI_API_KEY ??= "AIza-test-availability";

const calls: string[] = [];
// what the mocked local provider reports as installed (null = unknown)
let localInstalled: Set<string> | null = null;
const behaviour = new Map<string, "ok" | "404" | "401">();

vi.mock("../src/providers/registry.js", () => {
  const mk = (name: string) => ({
    name,
    defaultModel: "x",
    available: () => true,
    complete: async (req: { model: string }) => {
      calls.push(req.model);
      const b = behaviour.get(req.model) ?? "ok";
      if (b === "404")
        throw Object.assign(
          new Error(`The model \`${req.model}\` does not exist or you do not have access to it.`),
          { status: 404 },
        );
      if (b === "401") throw Object.assign(new Error("invalid x-api-key"), { status: 401 });
      return {
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        duration_ms: 1,
      };
    },
    stream: async function* () {
      throw new Error("not implemented");
    },
  });
  const providers = new Map<
    string,
    ReturnType<typeof mk> & { installedModels?: () => Set<string> | null }
  >(["anthropic", "openai", "gemini", "xai", "perplexity", "local"].map((n) => [n, mk(n)]));
  providers.get("local")!.installedModels = () => localInstalled;
  return { providers: () => providers, getProvider: (n: string) => providers.get(n) };
});

const mod = await import("../src/providers/availability.js");
const { loadModels } = await import("../src/config.js");

const catalog = loadModels().models;
const byId = (id: string) => catalog.find((m) => m.id === id)!;

beforeEach(() => {
  calls.length = 0;
  behaviour.clear();
  mod.resetAvailabilityCache({ wipe: true }); // each test starts with an empty disk cache too
  localInstalled = null;
});

describe("runtime model availability", () => {
  it("trusts verified models without a probe", async () => {
    expect(await mod.modelReach(byId("claude-opus-5"))).toBe("reachable");
    expect(calls).toEqual([]);
  });

  it("probes an unverified model once, records a 404 as unreachable-on-key, and caches it", async () => {
    behaviour.set("gpt-6", "404");
    expect(await mod.modelReach(byId("gpt-6"))).toBe("unreachable");
    expect(await mod.modelReach(byId("gpt-6"))).toBe("unreachable");
    expect(calls).toEqual(["gpt-6"]);
    // a fresh in-memory state still finds the disk cache
    mod.resetAvailabilityCache();
    expect(await mod.modelReach(byId("gpt-6"))).toBe("unreachable");
    expect(calls).toEqual(["gpt-6"]);
  });

  it("routes to an unverified model the moment the key can reach it", async () => {
    behaviour.set("gpt-6-pro", "ok");
    behaviour.set("gpt-6", "404");
    behaviour.set("claude-mythos-5-1", "404");
    const picked = await mod.pickReachable(
      [
        "gpt-6-pro",
        "gpt-6",
        "claude-mythos-5-1",
        "gpt-6-astra",
        "claude-fable-5-1",
        "gemini-3.1-pro-preview",
      ],
      { max: 3 },
    );
    expect(picked.map((m) => m.id)).toEqual([
      "gpt-6-pro",
      "claude-fable-5-1",
      "gemini-3.1-pro-preview",
    ]);
  });

  it("skips unverified models silently until then (one reachable per provider)", async () => {
    behaviour.set("gpt-6-pro", "404");
    behaviour.set("gpt-6", "404");
    behaviour.set("claude-mythos-5-1", "404");
    const picked = await mod.pickReachable(
      [
        "gpt-6-pro",
        "gpt-6",
        "claude-mythos-5-1",
        "gpt-6-astra",
        "claude-fable-5-1",
        "gemini-3.1-pro-preview",
        "gpt-5.6-sol",
      ],
      { max: 3 },
    );
    expect(picked.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "openai/gpt-6-astra",
      "anthropic/claude-fable-5-1",
      "gemini/gemini-3.1-pro-preview",
    ]);
  });

  it("treats a non-404 failure as unknown (skipped this session, not cached long)", async () => {
    behaviour.set("gpt-6", "401");
    expect(await mod.modelReach(byId("gpt-6"))).toBe("unknown");
    const { reachable, skipped } = await mod.reachableModels([
      byId("gpt-6"),
      byId("claude-opus-5"),
    ]);
    expect(reachable.map((m) => m.id)).toEqual(["claude-opus-5"]);
    expect(skipped).toEqual([{ id: "gpt-6", status: "unknown" }]);
  });

  it("finds a same-tier fallback, same provider first, and honours mid-run unreachability", async () => {
    const alt = await mod.fallbackModelFor("gpt-6");
    expect(alt?.id).toBe("gpt-6-astra"); // same provider, same tier (flagship)
    mod.markUnreachable("gpt-6-astra", "404 mid-run");
    const alt2 = await mod.fallbackModelFor("gpt-6", ["gpt-6-astra"]);
    expect(alt2?.provider).toBe("openai");
    expect(alt2?.id).not.toBe("gpt-6-astra");
    expect(await mod.modelReach(byId("gpt-6-astra"))).toBe("unreachable");
  });

  it("recognises the shapes of model-not-found errors", () => {
    expect(
      mod.isModelNotFoundError(
        new Error("The model `gpt-6` does not exist or you do not have access to it."),
      ),
    ).toBe(true);
    expect(
      mod.isModelNotFoundError(
        new Error(
          "models/gemini-9 is not found for API version v1beta, or is not supported for generateContent",
        ),
      ),
    ).toBe(true);
    expect(
      mod.isModelNotFoundError(
        Object.assign(new Error("not_found_error: model: claude-mythos-5-1"), { status: 404 }),
      ),
    ).toBe(true);
    expect(mod.isModelNotFoundError(new Error("Your credit balance is too low"))).toBe(false);
    expect(mod.isModelNotFoundError(new Error("rate limit exceeded"))).toBe(false);
  });
});

describe("local models: the server answering is not the model being there", () => {
  it("hides a catalogued local model the live Ollama does not list", async () => {
    localInstalled = new Set(["qwen3.8-essay", "qwen3.8-essay:latest"]); // another app's server, 28 Sept
    expect(await mod.modelReach(byId("gemma3:12b"))).toBe("unreachable");
    const { reachable } = await mod.reachableModels([byId("gemma3:12b"), byId("claude-opus-5-5")]);
    expect(reachable.map((m) => m.id)).toEqual(["claude-opus-5-5"]);
  });
  it("keeps it when listed, and trusts it as before when the listing is unknown", async () => {
    localInstalled = new Set(["gemma3:12b"]);
    expect(await mod.modelReach(byId("gemma3:12b"))).toBe("reachable");
    localInstalled = null;
    expect(await mod.modelReach(byId("gemma3:12b"))).toBe("reachable");
  });
});
