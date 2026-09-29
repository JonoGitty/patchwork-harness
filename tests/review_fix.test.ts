/**
 * --review-fix end to end through oneShot, with scripted providers: the L5
 * reviewer finds a gap, one repair step fixes it, the gate re-runs, and the
 * second review passes. (Live runs were blocked on 29 Sept 2026: the
 * Anthropic key ran out of credit.)
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

process.env.HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-rfix-home-"));
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-rfix";
process.env.OPENAI_API_KEY ??= "sk-test-rfix";
process.env.GEMINI_API_KEY ??= "AIza-test-rfix";
process.env.PATCHWORK_HARNESS_AVAILABILITY_PROBE = "off";

let reviews = 0;
const text = (t: string) => ({ content: [{ type: "text", text: t }], stop_reason: "end_turn" });
vi.mock("../src/providers/registry.js", () => {
  const mk = (name: string) => ({
    name,
    defaultModel: "x",
    available: () => true,
    complete: async (req: {
      system?: string;
      messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
    }) => {
      const all = `${req.system ?? ""}\n${req.messages.map((m) => m.content.map((c) => c.text ?? "").join("")).join("\n")}`;
      const last = req.messages[req.messages.length - 1];
      let r: { content: Array<Record<string, unknown>>; stop_reason: string };
      if (all.includes("You are the planner inside Patchwork Harness")) {
        r = text(
          JSON.stringify({
            goal: "make a.txt and b.txt",
            reasoning: "one step",
            steps: [
              {
                title: "Write a.txt",
                description: "Create a.txt",
                provider: "anthropic",
                model: "claude-opus-5-5",
                max_tool_turns: 3,
                reason: "test",
              },
            ],
          }),
        );
      } else if (all.includes("You are reviewing a plan another AI just produced")) {
        r = text(JSON.stringify({ verdict: "approve", suggestions: [] }));
      } else if (all.includes("You are the L5 REVIEWER")) {
        reviews++;
        r = text(
          JSON.stringify(
            reviews === 1
              ? {
                  verdict: "incomplete",
                  goal_met: false,
                  tests_passed: true,
                  destructive: false,
                  scope_ok: true,
                  concerns: [
                    { severity: "high", issue: "b.txt was never created", evidence: "a.txt" },
                  ],
                  follow_up: "create b.txt",
                }
              : {
                  verdict: "complete",
                  goal_met: true,
                  tests_passed: true,
                  destructive: false,
                  scope_ok: true,
                  concerns: [],
                },
          ),
        );
      } else if (last?.role === "tool") {
        r = text("done");
      } else {
        // an executor step: write the file its description asks for
        const file = all.includes("judged the work INCOMPLETE") ? "b.txt" : "a.txt";
        r = {
          content: [
            {
              type: "tool_use",
              id: `w-${file}`,
              name: "write",
              input: { path: file, content: "x" },
            },
          ],
          stop_reason: "tool_use",
        };
      }
      return {
        ...r,
        usage: { input_tokens: 10, output_tokens: 5 },
        cost_usd: 0.001,
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

const { oneShot } = await import("../src/core/orchestrator.js");
const { NoOpJsonReporter } = await import("../src/util/json_reporter.js");

describe("--review-fix", () => {
  it("turns an INCOMPLETE L5 verdict into a repair, a re-gate and a passing re-review", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-rfix-"));
    const { state } = await oneShot({
      goal: "make a.txt and b.txt",
      cwd,
      permission_mode: "auto",
      budget_usd: 1,
      budget_mode: "balanced",
      yes: true,
      reporter: new NoOpJsonReporter(),
      worldViewEnabled: false,
      lessonsEnabled: false,
      harness: { verifyCmd: "test -f a.txt", attempts: 1, review: true, reviewFix: true },
    });
    expect(reviews).toBe(2);
    expect(state.results.map((r) => r.step.title)).toContain("Repair from L5 review");
    expect(existsSync(join(cwd, "b.txt"))).toBe(true);
    expect(state.review?.verdict).toBe("complete");
    expect(state.verification).toMatchObject({ passed: true, attempts: 2 });
    expect(state.status).toBe("completed");
  }, 120_000);
});
