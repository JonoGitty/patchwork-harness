/**
 * ADR-0018 intent lanes: the cascade (intent head, then the LLM router only
 * when the head is unsure, then planned), every failure falling back to the
 * planned lane, and - through oneShot with scripted providers - that the
 * direct lane really makes no planner or critic call while the planned lane
 * still does, with every call (planner, critic, router) on the ledger.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-intent-home-"));
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-intent";
process.env.OPENAI_API_KEY ??= "sk-test-intent";
process.env.GEMINI_API_KEY ??= "AIza-test-intent";
process.env.PATCHWORK_HARNESS_AVAILABILITY_PROBE = "off";

const calls = { planner: 0, critic: 0, executor: 0, router: 0 };
let routerReply = '{"label": "direct", "confidence": 0.95}';
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
      if (all.includes("You route requests given to an AI coding agent")) {
        calls.router++;
        r = text(routerReply);
      } else if (all.includes("You are the planner inside Patchwork Harness")) {
        calls.planner++;
        r = text(
          JSON.stringify({
            goal: "make a.txt",
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
        calls.critic++;
        r = text(JSON.stringify({ verdict: "approve", suggestions: [] }));
      } else if (last?.role === "tool") {
        r = text("done");
      } else {
        calls.executor++;
        r = {
          content: [
            { type: "tool_use", id: "w-a", name: "write", input: { path: "a.txt", content: "x" } },
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

const { headDecision, routeIntent, directPlan, DIRECT_TOOL_TURNS } = await import(
  "../src/core/intent.js"
);
const { oneShot } = await import("../src/core/orchestrator.js");
const { NoOpJsonReporter } = await import("../src/util/json_reporter.js");

const head = { backend: "kev" as const, url: "http://127.0.0.1:1", model: "intent-head" };
const reply = (probabilities: Record<string, number>) =>
  (async () =>
    new Response(
      JSON.stringify({
        model: "intent-head-test",
        answers: {
          lane: {
            type: "choice",
            choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]?.[0],
            probabilities,
            confidence: Math.max(...Object.values(probabilities)),
          },
        },
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
const boom = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;
/** A scripted LLM router that counts its calls. */
const llm = (textReply: string, fail = false) => {
  const seen = { n: 0 };
  const complete = async () => {
    seen.n++;
    if (fail) throw new Error("rate limited");
    return {
      content: [{ type: "text" as const, text: textReply }],
      usage: { input_tokens: 300, output_tokens: 20 },
      cost_usd: 0.0002,
      stop_reason: "end_turn" as const,
      duration_ms: 5,
    };
  };
  return { seen, complete };
};
const SURE_FAST = { answer: 0.05, direct: 0.8, planned: 0.1, unclear: 0.05 };
const SURE_PLANNED = { answer: 0.02, direct: 0.1, planned: 0.8, unclear: 0.08 };
const UNSURE = { answer: 0.05, direct: 0.45, planned: 0.4, unclear: 0.1 };

describe("headDecision: the head's rule", () => {
  it("direct at or above hi, planned below lo, ask the LLM in between", () => {
    expect(headDecision(SURE_FAST, 0.6, 0.4).decision).toBe("direct");
    expect(headDecision(SURE_PLANNED, 0.6, 0.4).decision).toBe("planned");
    expect(headDecision(UNSURE, 0.6, 0.4).decision).toBe("ask");
    expect(headDecision({ answer: 0.3, direct: 0.3, planned: 0.4 }, 0.6, 0.4).decision).toBe(
      "direct",
    );
  });
  it("unclear is never a fast vote, however confident", () => {
    expect(headDecision({ direct: 0.05, unclear: 0.95 }, 0.6, 0.4).decision).toBe("planned");
  });
  it("treats missing or non-finite probabilities as 0", () => {
    expect(headDecision({ direct: Number.NaN, planned: 0.2 }, 0.6, 0.4).decision).toBe("planned");
    expect(headDecision({}, 0.6, 0.4).p_fast).toBe(0);
  });
});

describe("routeIntent: the cascade", () => {
  it("a confident head decides alone - the LLM is never called either way", async () => {
    for (const [probs, lane] of [
      [SURE_FAST, "direct"],
      [SURE_PLANNED, "planned"],
    ] as const) {
      const l = llm('{"label": "planned", "confidence": 1}');
      const r = await routeIntent("fix the typo", {
        head,
        fetchImpl: reply(probs),
        llmModel: "gpt-6-luna",
        complete: l.complete,
      });
      expect(r).toMatchObject({ lane, stage: "head" });
      expect(l.seen.n).toBe(0);
    }
  });
  it("an unsure head asks the LLM; only a CONFIDENT fast answer takes the direct lane", async () => {
    const yes = llm('{"label": "direct", "confidence": 0.95}');
    const r1 = await routeIntent("x", {
      head,
      fetchImpl: reply(UNSURE),
      llmModel: "gpt-6-luna",
      complete: yes.complete,
    });
    expect(r1).toMatchObject({
      lane: "direct",
      stage: "llm",
      llm_label: "direct",
      llm_confidence: 0.95,
    });
    expect(yes.seen.n).toBe(1);

    const weak = llm('{"label": "direct", "confidence": 0.7}');
    const r2 = await routeIntent("x", {
      head,
      fetchImpl: reply(UNSURE),
      llmModel: "gpt-6-luna",
      complete: weak.complete,
    });
    expect(r2).toMatchObject({ lane: "planned", stage: "llm" });

    const no = llm('{"label": "unclear", "confidence": 0.99}');
    const r3 = await routeIntent("x", {
      head,
      fetchImpl: reply(UNSURE),
      llmModel: "gpt-6-luna",
      complete: no.complete,
    });
    expect(r3).toMatchObject({ lane: "planned", stage: "llm" });
  });
  it("a head that is down hands the goal to the LLM", async () => {
    const yes = llm('{"label": "answer", "confidence": 0.93}');
    const r = await routeIntent("x", {
      head,
      fetchImpl: boom,
      llmModel: "gpt-6-luna",
      complete: yes.complete,
    });
    expect(r).toMatchObject({ lane: "direct", stage: "llm" });
    expect(r.reason).toMatch(/head failed/);
  });
  it("every failure is planned: no head and no LLM, LLM error, LLM prose", async () => {
    expect(await routeIntent("x", { head: null, llmModel: null })).toMatchObject({
      lane: "planned",
      stage: "none",
    });
    const err = llm("", true);
    expect(
      await routeIntent("x", {
        head,
        fetchImpl: reply(UNSURE),
        llmModel: "m",
        complete: err.complete,
      }),
    ).toMatchObject({ lane: "planned", stage: "none" });
    const prose = llm("It depends on the repo.");
    expect(
      await routeIntent("x", { head: null, llmModel: "m", complete: prose.complete }),
    ).toMatchObject({ lane: "planned", stage: "none" });
  });
  it("reports the LLM's spend when it is asked, and nothing when the head decides", async () => {
    const spent: number[] = [];
    const l = llm('{"label": "direct", "confidence": 0.95}');
    await routeIntent("x", {
      head,
      fetchImpl: reply(UNSURE),
      llmModel: "m",
      complete: l.complete,
      onUsage: (u) => spent.push(u.cost_usd),
    });
    await routeIntent("x", {
      head,
      fetchImpl: reply(SURE_FAST),
      llmModel: "m",
      complete: l.complete,
      onUsage: (u) => spent.push(u.cost_usd),
    });
    expect(spent).toEqual([0.0002]);
  });
});

describe("directPlan", () => {
  it("is one step on the given executor that carries the whole goal", () => {
    const p = directPlan("add a README", { id: "claude-opus-5-5", provider: "anthropic" });
    expect(p.steps).toHaveLength(1);
    expect(p.steps[0]).toMatchObject({
      model: "claude-opus-5-5",
      provider: "anthropic",
      max_tool_turns: DIRECT_TOOL_TURNS,
    });
    expect(p.steps[0]?.description).toContain("add a README");
  });
});

describe("oneShot lanes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(process.env, "PATCHWORK_HARNESS_INTENT_URL");
  });
  const base = (cwd: string) => ({
    goal: "make a.txt",
    cwd,
    permission_mode: "auto" as const,
    budget_usd: 1,
    budget_mode: "balanced" as const,
    yes: true,
    reporter: new NoOpJsonReporter(),
    worldViewEnabled: false,
    lessonsEnabled: false,
  });

  it("planned (the default) still calls the planner and the critic", async () => {
    Object.assign(calls, { planner: 0, critic: 0, executor: 0 });
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-intent-p-"));
    const { state } = await oneShot(base(cwd));
    expect(calls.planner).toBeGreaterThan(0);
    expect(calls.critic).toBeGreaterThan(0);
    expect(state.lane).toBeUndefined();
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
    // planner + critic spend is on the ledger (it was silently left out until 29 Sept);
    // every scripted call costs $0.001 and the executor makes 2 (tool call, then "done")
    expect(state.total_cost_usd).toBeCloseTo(0.001 * (calls.planner + calls.critic + 2), 6);
  }, 60_000);

  it("direct makes NO planner or critic call and does the work in one step", async () => {
    Object.assign(calls, { planner: 0, critic: 0, executor: 0 });
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-intent-d-"));
    const { state } = await oneShot({ ...base(cwd), lane: "direct" });
    expect(calls.planner).toBe(0);
    expect(calls.critic).toBe(0);
    expect(calls.executor).toBeGreaterThan(0);
    expect(state.plan?.steps).toHaveLength(1);
    expect(state.results[0]?.step.title).toBe("Do the task (direct lane)");
    expect(state.lane).toMatchObject({ lane: "direct", mode: "direct" });
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
    expect(state.status).toBe("completed");
    expect(state.total_cost_usd).toBeCloseTo(0.002, 6);
  }, 60_000);

  it("--lane-model puts the direct step on the chosen model", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-intent-m-"));
    const { state } = await oneShot({ ...base(cwd), lane: "direct", laneModel: "gpt-6-sol" });
    expect(state.plan?.steps[0]).toMatchObject({ model: "gpt-6-sol", provider: "openai" });
  }, 60_000);

  it("auto: a sure head routes with no LLM call; an unsure head asks the router, on the ledger", async () => {
    process.env.PATCHWORK_HARNESS_INTENT_URL = "http://127.0.0.1:1";
    vi.stubGlobal("fetch", reply(SURE_FAST));
    Object.assign(calls, { planner: 0, critic: 0, executor: 0, router: 0 });
    const a = await oneShot({
      ...base(mkdtempSync(join(tmpdir(), "patchwork-harness-intent-a1-"))),
      lane: "auto",
    });
    expect(a.state.lane).toMatchObject({ lane: "direct", mode: "auto", stage: "head" });
    expect(calls.planner).toBe(0);
    expect(calls.router).toBe(0);

    vi.stubGlobal("fetch", reply(UNSURE));
    routerReply = '{"label": "direct", "confidence": 0.95}';
    Object.assign(calls, { planner: 0, critic: 0, executor: 0, router: 0 });
    const b = await oneShot({
      ...base(mkdtempSync(join(tmpdir(), "patchwork-harness-intent-a2-"))),
      lane: "auto",
    });
    expect(b.state.lane).toMatchObject({ lane: "direct", stage: "llm", llm_label: "direct" });
    expect(calls.router).toBe(1);
    // router + 2 executor calls, $0.001 each
    expect(b.state.total_cost_usd).toBeCloseTo(0.003, 6);

    vi.stubGlobal("fetch", reply(SURE_PLANNED));
    Object.assign(calls, { planner: 0, critic: 0, executor: 0, router: 0 });
    const c = await oneShot({
      ...base(mkdtempSync(join(tmpdir(), "patchwork-harness-intent-a3-"))),
      lane: "auto",
    });
    expect(c.state.lane).toMatchObject({ lane: "planned", stage: "head" });
    expect(calls.planner).toBeGreaterThan(0);
    expect(calls.router).toBe(0);
  }, 60_000);
});
