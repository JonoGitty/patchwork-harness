/** ADR-0016 L5 reviewer: independent vendor, read-only, rubric, grounded. */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-review-home-"));
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-review";
process.env.GEMINI_API_KEY ??= "AIza-test-review";
process.env.OPENAI_API_KEY ??= "sk-test-review";

const offered: string[][] = [];
const script: Array<{ content: Array<Record<string, unknown>> }> = [];
vi.mock("../src/providers/registry.js", () => {
  const mk = (name: string) => ({
    name,
    defaultModel: "x",
    available: () => true,
    complete: async (req: { tools?: Array<{ name: string }> }) => {
      offered.push((req.tools ?? []).map((t) => t.name));
      const t = script.shift();
      if (!t) throw new Error("script exhausted");
      return {
        content: t.content,
        usage: { input_tokens: 10, output_tokens: 5 },
        cost_usd: 0.001,
        stop_reason: t.content.some((c) => c.type === "tool_use") ? "tool_use" : "end_turn",
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

const {
  parseVerdict,
  pickReviewer,
  reviewDescription,
  reviewRepairDescription,
  runReview,
  REVIEW_TOOLS,
} = await import("../src/core/reviewer.js");
const { AuditEmitter } = await import("../src/audit.js");
type SessionState = import("../src/core/types.js").SessionState;

const state = (over: Partial<SessionState> = {}): SessionState => ({
  sessionId: "s",
  cwd: ".",
  goal: "g",
  results: [
    {
      step: {
        title: "write it",
        description: "d",
        provider: "anthropic",
        model: "claude-opus-5-5",
        max_tool_turns: 3,
        reason: "r",
      },
      status: "completed",
      output_summary: "Done, all good.",
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      duration_ms: 0,
      tool_calls: 1,
    },
  ],
  total_cost_usd: 0,
  budget: { bedrock_usd: 5, session_usd: 1, mode: "balanced" },
  permission_mode: "auto",
  status: "completed",
  started_at: "",
  ...over,
});

describe("parseVerdict", () => {
  const ok = {
    verdict: "complete",
    goal_met: true,
    tests_passed: null,
    destructive: false,
    scope_ok: true,
    concerns: [],
  };
  it("reads the last fenced JSON block, or bare JSON after prose", () => {
    expect(parseVerdict(`notes\n\`\`\`json\n${JSON.stringify(ok)}\n\`\`\``)?.verdict).toBe(
      "complete",
    );
    expect(parseVerdict(`I checked everything. ${JSON.stringify(ok)}`)?.goal_met).toBe(true);
  });
  it("returns null for prose, and coerces a bad severity rather than dropping the concern", () => {
    expect(parseVerdict("looks fine to me")).toBeNull();
    const v = parseVerdict(
      JSON.stringify({
        ...ok,
        verdict: "incomplete",
        concerns: [{ severity: "urgent", issue: "x", evidence: "y" }],
      }),
    );
    expect(v?.concerns[0]?.severity).toBe("medium");
  });
});

describe("pickReviewer", () => {
  const all = async () => "reachable";
  it("picks the first reviewer from a vendor that did none of the work", async () => {
    expect((await pickReviewer(new Set(["anthropic"]), undefined, all))?.id).toBe("gpt-6-sol");
    expect((await pickReviewer(new Set(["openai"]), undefined, all))?.id).toBe("claude-sonnet-5");
    expect((await pickReviewer(new Set(["anthropic", "openai"]), undefined, all))?.id).toBe(
      "gemini-3.1-pro-preview",
    );
  });
  it("honours an explicit model and rejects an unknown one", async () => {
    expect((await pickReviewer(new Set(["anthropic"]), "gpt-6-astra", all))?.id).toBe(
      "gpt-6-astra",
    );
    await expect(pickReviewer(new Set(), "gpt-99", all)).rejects.toThrow(/not in config/);
  });
});

describe("reviewDescription", () => {
  it("states the gate truthfully and forbids guessing tests when none ran", () => {
    expect(reviewDescription("g", state(), "(diff)")).toContain("tests_passed must be null");
    const withGate = reviewDescription(
      "g",
      state({
        verification: {
          cmd: "npm test",
          passed: false,
          exit_code: 1,
          attempts: 3,
          tail: "2 failed",
        },
      }),
      "(diff)",
    );
    expect(withGate).toContain("`npm test`: FAILED (exit 1) after 3 attempt(s)");
    expect(withGate).toContain("No evidence, no concern.");
  });
});

describe("runReview (read-only, rubric enforced)", () => {
  it("offers only read/grep/glob, refuses a write, and downgrades an inconsistent 'complete'", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-review-"));
    const sessionId = `review-${Date.now()}`;
    script.push(
      {
        content: [
          {
            type: "tool_use",
            id: "w1",
            name: "write",
            input: { path: "hacked.txt", content: "x" },
          },
        ],
      },
      {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              verdict: "complete",
              goal_met: false,
              tests_passed: null,
              destructive: false,
              scope_ok: true,
              concerns: [],
            }),
          },
        ],
      },
    );
    const rv = await runReview({
      goal: "g",
      cwd,
      sessionId,
      audit: new AuditEmitter(sessionId, cwd, "review-test"),
      budget: { bedrock_usd: 5, session_usd: 1, mode: "balanced", spent_usd: 0 },
      state: state(),
      mode: "auto",
      unattended: true,
    });
    expect(offered[0]?.sort()).toEqual([...REVIEW_TOOLS].sort());
    expect(existsSync(join(cwd, "hacked.txt"))).toBe(false);
    expect(rv?.provider).toBe("openai"); // the work was anthropic's
    expect(rv?.verdict).toBe("incomplete"); // "complete" with goal_met false is not allowed
  }, 60_000);
});

describe("reviewRepairDescription (--review-fix)", () => {
  it("hands the executor the reviewer's cited concerns and forbids gaming the tests", () => {
    const d = reviewRepairDescription("fix paginate", {
      verdict: "incomplete",
      goal_met: false,
      tests_passed: true,
      destructive: false,
      scope_ok: true,
      concerns: [
        {
          severity: "high",
          issue: "page 0 returns items",
          evidence: "paginate(xs, 0, 2) -> ['b','c']",
        },
      ],
      follow_up: "return [] for page < 1",
      model: "gpt-6-sol",
      provider: "openai",
      cost_usd: 0,
    });
    expect(d).toContain("judged the work INCOMPLETE");
    expect(d).toContain("[high] page 0 returns items");
    expect(d).toContain("evidence: paginate(xs, 0, 2)");
    expect(d).toContain("return [] for page < 1");
    expect(d).toContain("Do NOT edit, weaken or delete tests");
  });
});
