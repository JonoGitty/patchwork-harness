import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CompletionResponse } from "../src/providers/base.js";
import type { Plan } from "../src/core/types.js";

/**
 * The critic pass is exercised through the planner's public plan() API
 * by mocking the registry's anthropic provider. We verify:
 *  - approve path returns the draft as-is, no second call needed
 *  - revise path triggers a re-plan with critic feedback in the prompt
 *  - the iteration cap holds (max 1 revision)
 */

function fakeResponse(jsonBody: unknown): CompletionResponse {
  return {
    content: [{ type: "text", text: JSON.stringify(jsonBody) }],
    usage: { input_tokens: 100, output_tokens: 50 },
    cost_usd: 0.001,
    stop_reason: "end_turn",
    duration_ms: 10,
  };
}

const VALID_PLAN = {
  goal: "do x",
  reasoning: "decompose into one step",
  steps: [
    {
      title: "Step 1",
      description: "do the thing",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      max_tool_turns: 5,
      reason: "default coding pick",
    },
  ],
};

const REVISED_PLAN = {
  ...VALID_PLAN,
  reasoning: "revised after critic feedback",
};

beforeEach(() => {
  vi.resetModules();
  process.env.ANTHROPIC_API_KEY = "test-key-not-used";
  // the planner now checks live model availability first; a mocked provider
  // must not be probed (it would count as plan/critic calls and could write
  // "reachable" for the real key) - 7 Sept 2026
  process.env.PATCHWORK_HARNESS_AVAILABILITY_PROBE = "off";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("critic pass", () => {
  it("approve verdict skips revision (1 plan call + 1 critic call)", async () => {
    const completeMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(VALID_PLAN)) // initial plan
      .mockResolvedValueOnce(fakeResponse({ verdict: "approve", suggestions: [] })); // critic

    vi.doMock("../src/providers/registry.js", () => ({
      getProvider: () => ({
        name: "anthropic",
        available: () => true,
        defaultModel: "claude-sonnet-4-6",
        complete: completeMock,
      }),
    }));

    const { plan } = await import("../src/core/planner.js");
    const result = await plan("do x", {
      budget: { bedrock_usd: 50, session_usd: 1, mode: "balanced", spent_usd: 0 },
      criticEnabled: true,
    }) as Plan & { critique?: { verdict: string; revised: boolean } };

    expect(completeMock).toHaveBeenCalledTimes(2); // 1 plan + 1 critic
    expect(result.critique?.verdict).toBe("approve");
    expect(result.critique?.revised).toBe(false);
    expect(result.reasoning).toBe(VALID_PLAN.reasoning);
  });

  it("revise verdict triggers a re-plan (2 plan calls + 1 critic call)", async () => {
    const completeMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(VALID_PLAN)) // initial plan
      .mockResolvedValueOnce(
        fakeResponse({
          verdict: "revise",
          suggestions: ["use a flagship for the security step"],
        }),
      ) // critic
      .mockResolvedValueOnce(fakeResponse(REVISED_PLAN)); // revised plan

    vi.doMock("../src/providers/registry.js", () => ({
      getProvider: () => ({
        name: "anthropic",
        available: () => true,
        defaultModel: "claude-sonnet-4-6",
        complete: completeMock,
      }),
    }));

    const { plan } = await import("../src/core/planner.js");
    const result = await plan("do x", {
      budget: { bedrock_usd: 50, session_usd: 1, mode: "balanced", spent_usd: 0 },
      criticEnabled: true,
    }) as Plan & { critique?: { verdict: string; revised: boolean; suggestions: string[] } };

    expect(completeMock).toHaveBeenCalledTimes(3); // initial + critic + revised
    expect(result.critique?.verdict).toBe("revise");
    expect(result.critique?.revised).toBe(true);
    expect(result.critique?.suggestions[0]).toContain("flagship");
    expect(result.reasoning).toBe(REVISED_PLAN.reasoning);
  });

  it("never re-revises after the second draft (cap holds)", async () => {
    // Simulate a critic that would say "revise" again; planner must not call it twice
    const completeMock = vi
      .fn()
      .mockResolvedValueOnce(fakeResponse(VALID_PLAN)) // initial
      .mockResolvedValueOnce(fakeResponse({ verdict: "revise", suggestions: ["x"] })) // critic 1
      .mockResolvedValueOnce(fakeResponse(REVISED_PLAN)); // revised — no further critic call

    vi.doMock("../src/providers/registry.js", () => ({
      getProvider: () => ({
        name: "anthropic",
        available: () => true,
        defaultModel: "claude-sonnet-4-6",
        complete: completeMock,
      }),
    }));

    const { plan } = await import("../src/core/planner.js");
    await plan("do x", {
      budget: { bedrock_usd: 50, session_usd: 1, mode: "balanced", spent_usd: 0 },
      criticEnabled: true,
    });
    expect(completeMock).toHaveBeenCalledTimes(3); // initial + 1 critic + 1 revise. No second critic.
  });

  it("criticEnabled=false skips the pass entirely (1 plan call only)", async () => {
    const completeMock = vi.fn().mockResolvedValueOnce(fakeResponse(VALID_PLAN));

    vi.doMock("../src/providers/registry.js", () => ({
      getProvider: () => ({
        name: "anthropic",
        available: () => true,
        defaultModel: "claude-sonnet-4-6",
        complete: completeMock,
      }),
    }));

    const { plan } = await import("../src/core/planner.js");
    const result = await plan("do x", {
      budget: { bedrock_usd: 50, session_usd: 1, mode: "balanced", spent_usd: 0 },
      criticEnabled: false,
    }) as Plan & { critique?: unknown };

    expect(completeMock).toHaveBeenCalledTimes(1);
    expect(result.critique).toBeUndefined();
  });
});
