/**
 * ADR-0022 `patchwork-harness continue`: the rules that decide how a stopped run is
 * picked up (src/core/continue.ts), and - through oneShot with a scripted
 * provider - that a resumed run re-runs only the unfinished steps with no new
 * planning, that a step out of tool turns is flagged and followed up, and
 * that the session is on disk mid-run so a killed run can be continued.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-continue-home-"));
process.env.HOME = HOME;
process.env.ANTHROPIC_API_KEY ??= "sk-ant-test-continue";
process.env.OPENAI_API_KEY ??= "sk-test-continue";
process.env.GEMINI_API_KEY ??= "AIza-test-continue";
process.env.PATCHWORK_HARNESS_AVAILABILITY_PROBE = "off";

const script = {
  planner: 0,
  failB: false,
  /** What the session file said while step 2 was running. */
  midRun: null as null | { status: string; results: number },
  prompts: [] as string[],
  steps: ["Write a.txt", "Write b.txt", "Write c.txt"],
  turns: 3,
};
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
      const sys = req.system ?? "";
      const all = `${sys}\n${req.messages.map((m) => m.content.map((c) => c.text ?? "").join("")).join("\n")}`;
      const last = req.messages[req.messages.length - 1];
      const usage = {
        usage: { input_tokens: 10, output_tokens: 5 },
        cost_usd: 0.001,
        duration_ms: 1,
      };
      if (all.includes("You are the planner inside Patchwork Harness")) {
        script.planner++;
        const steps = script.steps.map((title) => ({
          title,
          description: `Do: ${title}`,
          provider: "anthropic",
          model: "claude-opus-5-5",
          max_tool_turns: script.turns,
          reason: "test",
        }));
        return { ...text(JSON.stringify({ goal: "g", reasoning: "r", steps })), ...usage };
      }
      if (all.includes("You are reviewing a plan another AI just produced"))
        return { ...text(JSON.stringify({ verdict: "approve", suggestions: [] })), ...usage };
      const title = /You handle ONE step of a larger plan: "([^"]+)"/.exec(sys)?.[1] ?? "";
      if (last?.role !== "tool") script.prompts.push(sys);
      if (title === "Write b.txt") {
        const dir = join(HOME, ".patchwork-harness", "sessions");
        const file = existsSync(dir)
          ? readdirSync(dir).find((f) => f.endsWith(".json"))
          : undefined;
        if (file && !script.midRun) {
          const s = JSON.parse(readFileSync(join(dir, file), "utf8"));
          script.midRun = { status: s.status, results: s.results.length };
        }
        if (script.failB) throw new Error("provider exploded");
      }
      // "Slow step" never says it is done: it keeps calling tools until the cap.
      if (last?.role === "tool" && title !== "Slow step")
        return { ...text(`did ${title}`), ...usage };
      const file =
        title === "Do the task (direct lane)"
          ? "follow.txt"
          : `${/Write (\w+)\.txt/.exec(title)?.[1] ?? "slow"}.txt`;
      return {
        content: [
          {
            type: "tool_use",
            id: `w-${Math.random()}`,
            name: "write",
            input: { path: file, content: title },
          },
        ],
        stop_reason: "tool_use",
        ...usage,
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
  ContinueError,
  findSession,
  isContinuable,
  leftovers,
  planContinuation,
  priorContext,
  processAlive,
} = await import("../src/core/continue.js");
const { oneShot } = await import("../src/core/orchestrator.js");
const { NoOpJsonReporter } = await import("../src/util/json_reporter.js");
type SessionState = import("../src/core/types.js").SessionState;

const step = (title: string) => ({
  title,
  description: `Do: ${title}`,
  provider: "anthropic" as const,
  model: "claude-opus-5-5",
  max_tool_turns: 3,
  reason: "t",
});
const result = (
  title: string,
  status: "completed" | "failed" | "denied" | "bedrock_aborted",
  extra = {},
) => ({
  step: step(title),
  status,
  output_summary: `did ${title}`,
  cost_usd: 0.01,
  tokens_in: 1,
  tokens_out: 1,
  duration_ms: 1,
  tool_calls: 1,
  ...extra,
});
const session = (over: Partial<SessionState>): SessionState => ({
  sessionId: "ses_parent",
  cwd: "/work",
  goal: "make three files",
  plan: {
    goal: "make three files",
    reasoning: "r",
    steps: [step("A"), step("B"), step("C")],
    estimated_cost_usd: 0,
  },
  results: [],
  total_cost_usd: 0.02,
  budget: { bedrock_usd: 5, session_usd: 1, mode: "balanced" },
  permission_mode: "auto",
  status: "completed",
  started_at: "2026-10-03T10:00:00.000Z",
  ...over,
});
const dead = () => false;

describe("planContinuation: how a stopped run is picked up", () => {
  it("a failed step: resume the plan from that step, telling it why, without touching the parent", () => {
    const parent = session({
      status: "failed",
      results: [result("A", "completed"), result("B", "failed", { error: "provider exploded" })],
    });
    const c = planContinuation(parent, undefined, dead);
    if (c.kind !== "resume") throw new Error(c.kind);
    expect(c.at).toBe(2);
    expect(c.steps.map((s) => s.title)).toEqual(["B", "C"]);
    expect(c.steps[0]?.description).toContain("CONTINUING AN EARLIER RUN");
    expect(c.steps[0]?.description).toContain("this step failed: provider exploded");
    expect(c.steps[1]?.description).toBe("Do: C");
    expect(parent.plan?.steps[1]?.description).toBe("Do: B"); // parent untouched
    expect(c.context).toContain("1. A [completed]: did A");
  });

  it("a killed run (in progress, dead pid) resumes; a live one is refused", () => {
    const parent = session({
      status: "in_progress",
      pid: 4242,
      results: [result("A", "completed")],
    });
    const c = planContinuation(parent, undefined, dead);
    expect(c).toMatchObject({ kind: "resume", at: 2 });
    expect(c.why).toMatch(/interrupted/);
    expect(() => planContinuation(parent, undefined, () => true)).toThrow(
      /still running \(pid 4242\)/,
    );
  });

  it("a step that ran out of tool turns is unfinished: a killed run resumes AT it, with more turns", () => {
    // seen live on 3 Oct: the planner gave a step 2 turns, the model spent both looking around
    const parent = session({
      status: "in_progress",
      pid: 4242,
      results: [result("A", "completed", { turn_cap: true, output_summary: "" })],
    });
    const c = planContinuation(parent, undefined, dead);
    if (c.kind !== "resume") throw new Error(c.kind);
    expect(c.at).toBe(1);
    expect(c.steps.map((s) => s.title)).toEqual(["A", "B", "C"]);
    expect(c.why).toMatch(/used all 3 of its tool turns without finishing/);
    expect(c.steps[0]?.max_tool_turns).toBe(8);
    expect(c.steps[1]?.max_tool_turns).toBe(3);
    expect(parent.plan?.steps[0]?.max_tool_turns).toBe(3);
  });

  it("a user instruction rides along on a resume", () => {
    const c = planContinuation(session({ status: "denied", results: [] }), "use tabs", dead);
    expect(c.kind).toBe("resume");
    if (c.kind === "resume")
      expect(c.steps[0]?.description).toContain("Note from the user: use tabs");
  });

  it("a dry run (a plan, no results) resumes from step 1, which executes it", () => {
    const c = planContinuation(session({ status: "completed", results: [] }), undefined, dead);
    expect(c).toMatchObject({ kind: "resume", at: 1 });
    expect(c.why).toMatch(/dry run/);
  });

  it("finished but left over: a step out of tool turns, a failing gate, an incomplete review", () => {
    const parent = session({
      status: "failed",
      results: [
        result("A", "completed"),
        result("B", "completed", { turn_cap: true }),
        result("C", "completed"),
      ],
      verification: {
        cmd: "npm test",
        passed: false,
        exit_code: 1,
        attempts: 2,
        tail: "FAIL slug.test.js",
      },
      review: {
        verdict: "incomplete",
        goal_met: false,
        tests_passed: false,
        destructive: false,
        scope_ok: true,
        concerns: [
          { severity: "high", issue: "negative pages return items", evidence: "slice(-4)" },
        ],
        model: "gpt-6.1-sol",
        provider: "openai",
        cost_usd: 0.01,
      },
    });
    expect(leftovers(parent)).toHaveLength(3);
    const c = planContinuation(parent, undefined, dead);
    expect(c.kind).toBe("follow_up");
    expect(c.goal).toContain("Finish the earlier task: make three files");
    expect(c.goal).toContain('Step 2 ("B") ran out of tool turns');
    expect(c.goal).toContain("`npm test` still fails (exit 1) after 2 attempt(s)");
    expect(c.goal).toContain("without weakening the tests");
    expect(c.goal).toContain("FAIL slug.test.js");
    expect(c.goal).toContain("[high] negative pages return items");
  });

  it("finished clean: nothing to continue without an instruction; with one, it is the follow-up", () => {
    const parent = session({
      results: [result("A", "completed"), result("B", "completed"), result("C", "completed")],
    });
    expect(() => planContinuation(parent, undefined, dead)).toThrow(ContinueError);
    expect(isContinuable(parent)).toBe(false);
    const c = planContinuation(parent, "now add a README", dead);
    expect(c).toMatchObject({ kind: "follow_up", goal: "now add a README" });
    expect(c.context).toContain("Its goal was: make three files");
  });

  it("stopped before it had a plan: the goal runs again", () => {
    const c = planContinuation(session({ status: "failed", plan: undefined }), undefined, dead);
    expect(c).toMatchObject({ kind: "follow_up", goal: "make three files" });
  });

  it("keeps the earlier-run context bounded", () => {
    const long = session({
      results: [result("A", "completed", { output_summary: "x".repeat(9000) })],
      goal: "y".repeat(5000),
    });
    expect(priorContext(long).length).toBeLessThan(4100);
  });

  it("knows a live pid from a dead one", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 30)).toBe(false);
    expect(processAlive(undefined)).toBe(false);
  });
});

describe("findSession", () => {
  const dir = mkdtempSync(join(tmpdir(), "patchwork-harness-continue-sessions-"));
  const put = (s: Partial<SessionState>) =>
    writeFileSync(join(dir, `${s.sessionId}.json`), JSON.stringify(session(s)));
  put({ sessionId: "ses_old", cwd: "C:\\Work\\proj", started_at: "2026-10-01T00:00:00Z" });
  put({ sessionId: "ses_new", cwd: "C:\\Work\\proj", started_at: "2026-10-02T00:00:00Z" });
  put({ sessionId: "ses_other", cwd: "C:\\Work\\other", started_at: "2026-10-03T00:00:00Z" });
  writeFileSync(join(dir, "broken.json"), "{ not json");

  it("takes the latest session in this directory, matching the path loosely", () => {
    expect(findSession({ cwd: "c:\\work\\proj\\", dir }).sessionId).toBe("ses_new");
  });
  it("takes an id or a unique prefix, and refuses an ambiguous or unknown one", () => {
    expect(findSession({ cwd: "/x", id: "ses_ol", dir }).sessionId).toBe("ses_old");
    expect(() => findSession({ cwd: "/x", id: "ses_", dir })).toThrow(/matches 3 sessions/);
    expect(() => findSession({ cwd: "/x", id: "nope", dir })).toThrow(/no session matches/);
    expect(() => findSession({ cwd: "C:\\Elsewhere", dir })).toThrow(/no earlier session/);
  });
});

describe("oneShot: continuing for real", () => {
  const base = (cwd: string) => ({
    goal: "make three files",
    cwd,
    permission_mode: "auto" as const,
    budget_usd: 1,
    budget_mode: "balanced" as const,
    yes: true,
    reporter: new NoOpJsonReporter(),
    worldViewEnabled: false,
    lessonsEnabled: false,
  });

  it("a failed run is on disk mid-run, and resumes from the failed step with no new planning", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-continue-r-"));
    Object.assign(script, { planner: 0, failB: true, midRun: null, prompts: [], turns: 3 });
    script.steps = ["Write a.txt", "Write b.txt", "Write c.txt"];
    const first = await oneShot(base(cwd));
    expect(first.state.status).toBe("failed");
    expect(first.state.results.map((r) => r.status)).toEqual(["completed", "failed"]);
    // while step 2 ran, the session file already held step 1's result
    expect(script.midRun).toEqual({ status: "in_progress", results: 1 });
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
    expect(existsSync(join(cwd, "c.txt"))).toBe(false);

    script.failB = false;
    const plannerCalls = script.planner;
    const parent = findSession({ cwd });
    expect(parent.sessionId).toBe(first.state.sessionId);
    const c = planContinuation(parent);
    if (c.kind !== "resume") throw new Error(c.kind);
    script.prompts = [];
    const second = await oneShot({
      ...base(cwd),
      goal: c.goal,
      continuation: { from: c.from, context: c.context, steps: c.steps },
    });
    expect(script.planner).toBe(plannerCalls); // no planner (or critic) call
    expect(second.state.status).toBe("completed");
    expect(second.state.continued_from).toBe(first.state.sessionId);
    expect(second.state.results.map((r) => r.step.title)).toEqual(["Write b.txt", "Write c.txt"]);
    expect(existsSync(join(cwd, "b.txt"))).toBe(true);
    expect(existsSync(join(cwd, "c.txt"))).toBe(true);
    // the resumed step saw why it stopped and what step 1 did
    expect(script.prompts[0]).toMatch(/this step failed: .*provider exploded/);
    expect(script.prompts[0]).toContain("1. Write a.txt [completed]");
    // the parent's record is untouched
    expect(findSession({ cwd, id: first.state.sessionId }).status).toBe("failed");
    expect(readdirSync(join(HOME, ".patchwork-harness", "sessions")).some((f) => f.endsWith(".tmp"))).toBe(
      false,
    );
  }, 60_000);

  it("a step that runs out of tool turns is flagged, and continue follows up on it in one direct step", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-continue-t-"));
    Object.assign(script, { planner: 0, failB: false, midRun: null, prompts: [], turns: 2 });
    script.steps = ["Slow step"];
    const first = await oneShot(base(cwd));
    expect(first.state.status).toBe("completed");
    expect(first.state.results[0]?.turn_cap).toBe(true);
    expect(isContinuable(first.state)).toBe(true);

    const c = planContinuation(findSession({ cwd }));
    expect(c.kind).toBe("follow_up");
    script.prompts = [];
    const second = await oneShot({
      ...base(cwd),
      goal: c.goal,
      lane: "direct",
      continuation: { from: c.from, context: c.context },
    });
    expect(second.state.status).toBe("completed");
    expect(second.state.results[0]?.turn_cap).toBeUndefined();
    expect(script.prompts[0]).toContain('Step 1 ("Slow step") ran out of tool turns');
    expect(script.prompts[0]).toContain("This continues an earlier session");
    expect(existsSync(join(cwd, "follow.txt"))).toBe(true);
  }, 60_000);
});

describe("the `patchwork-harness continue` command", () => {
  it("is `run --continue`, not a goal called 'continue': with no earlier run it says so and spends nothing", () => {
    const root = process.cwd();
    const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-continue-cli-"));
    const home = mkdtempSync(join(tmpdir(), "patchwork-harness-continue-clihome-"));
    mkdirSync(join(home, ".patchwork-harness", "sessions"), { recursive: true });
    const r = spawnSync(
      process.execPath,
      [tsx, join(root, "src", "cli.ts"), "continue", "--cwd", cwd],
      {
        cwd, // no project .env with real keys in reach
        // fake keys only: if the rewrite ever broke, "continue" would run as a goal, and must not spend
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          ANTHROPIC_API_KEY: "sk-ant-fake",
          OPENAI_API_KEY: "sk-fake",
          GEMINI_API_KEY: "fake",
          XAI_API_KEY: "",
          GROK_API_KEY: "",
          PERPLEXITY_API_KEY: "",
          TYPESAFE_API_KEY: "",
        },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    expect(`${r.stdout}${r.stderr}`).toContain("no earlier session in");
    expect(r.status).toBe(1);
  }, 70_000);
});
