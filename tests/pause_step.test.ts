import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditEmitter } from "../src/audit.js";
import { runStep } from "../src/core/executor.js";
import type { Step } from "../src/core/types.js";
import type { HumanChannel } from "../src/permissions/human.js";

function pauseStep(): Step {
  return {
    title: "Choose the storage backend",
    description: "Should the cache live in SQLite or plain JSON files?",
    provider: "anthropic",
    model: "claude-haiku-4-5",
    max_tool_turns: 1,
    reason: "design decision the agent must not make alone",
    pause_for_human: true,
  };
}

function stubChannel(answer: string | null): HumanChannel {
  return {
    interactive: answer != null,
    askYesNo: (_q, def) => Promise.resolve(def),
    askText: () => Promise.resolve(answer),
    close: () => {},
  };
}

function runPause(human: HumanChannel | undefined) {
  const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-pause-"));
  const sessionId = `test-pause-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  return runStep({
    step: pauseStep(),
    cwd,
    sessionId,
    audit: new AuditEmitter(sessionId, cwd, "pause-test"),
    budget: { bedrock_usd: 1, session_usd: 1, mode: "balanced", spent_usd: 0 },
    mode: "default",
    systemContext: "",
    human,
  });
}

describe("pause_for_human steps", () => {
  it("completes with the human's answer and makes no provider call", async () => {
    const result = await runPause(stubChannel("SQLite — it already ships with the spine"));
    expect(result.status).toBe("completed");
    expect(result.output_summary).toContain("SQLite");
    expect(result.cost_usd).toBe(0);
    expect(result.tokens_in).toBe(0);
    expect(result.tool_calls).toBe(0);
  });

  it("fails cleanly when nobody answers", async () => {
    const result = await runPause(stubChannel(null));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("no answer");
    expect(result.cost_usd).toBe(0);
  });

  it("fails cleanly with no channel at all (legacy callers)", async () => {
    const result = await runPause(undefined);
    expect(result.status).toBe("failed");
  });

  it("returns denied when the human aborts", async () => {
    const result = await runPause(stubChannel("abort"));
    expect(result.status).toBe("denied");
    expect(result.error).toContain("aborted by human");
  });
});
