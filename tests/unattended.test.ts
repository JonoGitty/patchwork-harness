import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-unatt-home-"));
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-unattended";
process.env.OPENAI_API_KEY ??= "sk-test-unattended";

type Turn = { content: Array<Record<string, unknown>> } | { throw: string };
const script: Turn[] = [];
const seen: Array<{ model: string; lastToolResult?: string }> = [];

vi.mock("../src/providers/registry.js", () => {
  const mk = (name: string) => ({
    name,
    defaultModel: "x",
    available: () => true,
    complete: async (req: {
      model: string;
      messages: Array<{ role: string; content: Array<{ type: string; content?: string }> }>;
    }) => {
      const last = req.messages[req.messages.length - 1];
      seen.push({
        model: req.model,
        lastToolResult: last?.role === "tool" ? last.content[0]?.content : undefined,
      });
      const t = script.shift();
      if (!t) throw new Error("script exhausted");
      if ("throw" in t) throw Object.assign(new Error(t.throw), { status: 404 });
      return {
        content: t.content,
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: t.content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn",
        duration_ms: 1,
      };
    },
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
const { resetAvailabilityCache } = await import("../src/providers/availability.js");
type Step = import("../src/core/types.js").Step;
type HumanChannel = import("../src/permissions/human.js").HumanChannel;

function hangingChannel(): HumanChannel & { asked: number } {
  const ch = {
    asked: 0,
    interactive: true,
    askYesNo: () => {
      ch.asked++;
      return new Promise<boolean>(() => {});
    }, // would hang forever
    askText: () => {
      ch.asked++;
      return new Promise<string | null>(() => {});
    },
    close: () => {},
  };
  return ch;
}

function run(step: Step, human: HumanChannel, mode: "auto" | "default" = "auto") {
  const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-unatt-"));
  const sessionId = `test-unatt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const audit = new AuditEmitter(sessionId, cwd, "unattended-test");
  return {
    audit,
    result: runStep({
      step,
      cwd,
      sessionId,
      audit,
      budget: { bedrock_usd: 5, session_usd: 5, mode: "balanced", spent_usd: 0 },
      mode,
      systemContext: "",
      human,
    }),
  };
}

beforeEach(() => {
  script.length = 0;
  seen.length = 0;
  resetAvailabilityCache();
});

describe("unattended runs never wait on a human", () => {
  it("skips a pause_for_human step with an audit event instead of hanging", async () => {
    const human = hangingChannel();
    const { result } = run(
      {
        title: "Choose backend",
        description: "SQLite or JSON files?",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        max_tool_turns: 1,
        reason: "r",
        pause_for_human: true,
      },
      human,
    );
    const r = await result;
    expect(r.status).toBe("completed");
    expect(r.output_summary).toMatch(/SKIPPED \(unattended run/);
    expect(r.output_summary).toContain("SQLite or JSON files?");
    expect(human.asked).toBe(0);
    expect(r.cost_usd).toBe(0);
  });

  it("still asks when attended (default mode)", async () => {
    const answered: HumanChannel = {
      interactive: true,
      askYesNo: async () => true,
      askText: async () => "SQLite",
      close: () => {},
    };
    const { result } = run(
      {
        title: "Choose backend",
        description: "SQLite or JSON files?",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        max_tool_turns: 1,
        reason: "r",
        pause_for_human: true,
      },
      answered,
      "default",
    );
    expect((await result).output_summary).toBe("Human decision: SQLite");
  });

  it("denies a prompt-class permission immediately and tells the model why", async () => {
    script.push({
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "bash",
          input: { command: "curl https://example.com" },
        },
      ],
    });
    script.push({ content: [{ type: "text", text: "done without it" }] });
    const human = hangingChannel();
    const { result } = run(
      {
        title: "Fetch",
        description: "fetch the page",
        provider: "anthropic",
        model: "claude-sonnet-5",
        max_tool_turns: 3,
        reason: "r",
      },
      human,
    );
    const r = await result;
    expect(r.status).toBe("completed");
    expect(human.asked).toBe(0);
    expect(seen[1]?.lastToolResult).toMatch(
      /^DENIED \(unattended run - no human to ask: bash command not on allowlist\)/,
    );
    expect(seen[1]?.lastToolResult).toMatch(/Take another route/);
  });

  it("falls back to a same-tier model when the planned model is unreachable mid-run", async () => {
    script.push({ throw: "The model `gpt-6` does not exist or you do not have access to it." });
    script.push({ content: [{ type: "text", text: "reviewed" }] });
    const { result, audit } = run(
      {
        title: "Review",
        description: "review it",
        provider: "openai",
        model: "gpt-6",
        max_tool_turns: 2,
        reason: "r",
      },
      hangingChannel(),
    );
    const r = await result;
    expect(r.status).toBe("completed");
    expect(r.output_summary).toBe("reviewed");
    expect(seen.map((s) => s.model)).toEqual(["gpt-6", "gpt-6-astra"]);
    expect(r.step.model).toBe("gpt-6-astra");
    const { readFileSync } = await import("node:fs");
    const events = readFileSync(audit.pathOnDisk, "utf8");
    expect(events).toContain('"action":"route_decision"');
    expect(events).toContain("openai/gpt-6-astra");
  });
});
