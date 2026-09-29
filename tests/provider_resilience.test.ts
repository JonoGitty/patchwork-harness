/**
 * 28 Sept 2026: a non-404 provider error (an OpenAI 400) used to throw out of
 * runStep and kill the whole run with no session_end. Now it falls back to a
 * same-tier model, and failing that ends the STEP cleanly.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-resil-home-"));
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-resil";
process.env.OPENAI_API_KEY ??= "sk-test-resil";
process.env.GEMINI_API_KEY ??= "AIza-test-resil";

const calls: string[] = [];
const failing = new Set<string>();
let brokeProvider = "";
vi.mock("../src/providers/registry.js", () => {
  const mk = (name: string) => ({
    name,
    defaultModel: "x",
    available: () => true,
    complete: async (req: { model: string }) => {
      calls.push(req.model);
      if (name === brokeProvider)
        throw Object.assign(
          new Error("400 Your credit balance is too low to access the Anthropic API."),
          { status: 400 },
        );
      if (failing.has(req.model) || failing.has("*"))
        throw Object.assign(
          new Error("400 Function tools with reasoning_effort are not supported"),
          { status: 400 },
        );
      return {
        content: [{ type: "text", text: "done" }],
        usage: { input_tokens: 1, output_tokens: 1 },
        cost_usd: 0,
        stop_reason: "end_turn",
        duration_ms: 1,
      };
    },
    // biome-ignore lint/correctness/useYield: the mock never streams; the executor falls back to complete()
    stream: async function* () {
      throw new Error("not implemented");
    },
  });
  const providers = new Map(
    ["anthropic", "openai", "gemini", "xai", "perplexity", "local"].map((n) => [n, mk(n)]),
  );
  return { providers: () => providers, getProvider: (n: string) => providers.get(n) };
});

const { runStep } = await import("../src/core/executor.js");
const { AuditEmitter } = await import("../src/audit.js");
const run = (model: string, provider: "openai" | "anthropic" = "openai") => {
  const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-resil-"));
  const sessionId = `resil-${Date.now()}-${Math.random()}`;
  return runStep({
    step: { title: "s", description: "d", provider, model, max_tool_turns: 2, reason: "r" },
    cwd,
    sessionId,
    audit: new AuditEmitter(sessionId, cwd, "resil"),
    budget: { bedrock_usd: 5, session_usd: 1, mode: "balanced", spent_usd: 0 },
    mode: "auto",
    systemContext: "",
  });
};

describe("provider errors", () => {
  it("fall back to a same-tier model instead of killing the run", async () => {
    calls.length = 0;
    failing.clear();
    failing.add("gpt-6-luna");
    const r = await run("gpt-6-luna");
    expect(r.status).toBe("completed");
    expect(r.step.model).not.toBe("gpt-6-luna"); // records the model that actually ran
    expect(calls[0]).toBe("gpt-6-luna");
  }, 60_000);
  it("fail the step cleanly (no throw) when every fallback errors too", async () => {
    calls.length = 0;
    failing.clear();
    failing.add("*");
    const r = await run("gpt-6-sol");
    expect(r.status).toBe("failed");
    expect(r.error).toContain("provider error");
    expect(calls.length).toBe(3); // the model + two fallbacks
  }, 60_000);
  it("leave the whole provider on an account-wide error (no credit), not just the model", async () => {
    calls.length = 0;
    failing.clear();
    brokeProvider = "anthropic";
    const r = await run("claude-opus-5-5", "anthropic");
    brokeProvider = "";
    expect(r.status).toBe("completed");
    expect(r.step.provider).not.toBe("anthropic");
    expect(calls).toHaveLength(2); // the failing call, then straight to another vendor
  }, 60_000);
});
