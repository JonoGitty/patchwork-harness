/**
 * Planner head-to-head: which model should hold the `planner` role?
 *
 * Six goals, one per kind of job. Each is planned by every candidate planner
 * (critic on, unattended, same budget), REPS times. Scored on things that can
 * be checked without an LLM:
 *   valid    - a plan came back at all
 *   routed   - the goal's routing rule holds (tiers from model_capabilities.yml)
 *   critic   - the Gemini critic approved the DRAFT (no revision needed)
 * plus latency and the plan's own cost estimate. Makes real API calls.
 *
 *   npx tsx scripts/eval_planner.ts [planner,planner,...] [reps]
 */
// Keys load exactly as the CLI loads them (shell env, ~/.patchwork-harness/.env, ./.env).
import { loadEnvFiles } from "../src/util/env.js";
loadEnvFiles();

import { loadModelCapabilities } from "../src/config.js";
import type { BudgetState } from "../src/core/budget.js";
import { plan } from "../src/core/planner.js";
import type { Step } from "../src/core/types.js";

const PLANNERS = (process.argv[2] ?? "claude-haiku-4-5,gpt-6-luna,claude-sonnet-5").split(",");
const REPS = Number(process.argv[3] ?? 2);

const tierOf = new Map(loadModelCapabilities().models.map((m) => [m.id, m.tier]));
const tiers = (steps: Step[]) =>
  steps.filter((s) => !s.pause_for_human).map((s) => tierOf.get(s.model) ?? "?");
const has = (steps: Step[], ...want: string[]) => tiers(steps).some((t) => want.includes(t));
const only = (steps: Step[], ...allowed: string[]) =>
  tiers(steps).every((t) => allowed.includes(t));

const GOALS: Array<{ id: string; goal: string; rule: string; ok: (s: Step[]) => boolean }> = [
  {
    id: "security",
    goal: "Add rate limiting and input validation to the POST /login handler in src/server/auth.ts, then get the change security-reviewed.",
    rule: "a flagship writes, a reasoning-tier model reviews, nothing cheap_fast",
    ok: (s) => has(s, "flagship") && has(s, "reasoning") && !has(s, "cheap_fast"),
  },
  {
    id: "bulk",
    goal: "Rename the function getUserData to fetchUser everywhere under src/ and update every call site.",
    rule: "workhorse or cheap_fast only (no flagship, no reasoning)",
    ok: (s) => only(s, "workhorse", "cheap_fast", "local"),
  },
  {
    id: "writing",
    goal: "Draft a 300-word personal journal entry about today's fishing trip and save it to notes/journal.md.",
    rule: "local tier for the prose, never flagship or reasoning",
    ok: (s) => has(s, "local") && !has(s, "flagship", "reasoning"),
  },
  {
    id: "research",
    goal: "Find out what changed in the latest major Vite release and update vite.config.ts to match.",
    rule: "a grounded/research step, then a coding step",
    ok: (s) =>
      s.some((x) => x.grounded || x.provider === "perplexity") && has(s, "flagship", "workhorse"),
  },
  {
    id: "debugging",
    goal: "Fix the flaky test in tests/parser.test.ts that fails intermittently on Windows.",
    rule: "a flagship-tier model does the fix",
    ok: (s) => has(s, "flagship"),
  },
  {
    id: "architecture",
    goal: "Design a migration from SQLite to Postgres for the memory spine, weighing the trade-offs, and write it up as docs/migration.md.",
    rule: "flagship or reasoning tier does the design",
    ok: (s) => has(s, "flagship", "reasoning"),
  },
];

const budget = (): BudgetState => ({
  bedrock_usd: 5,
  session_usd: 1,
  mode: "balanced",
  spent_usd: 0,
});

interface Row {
  planner: string;
  goal: string;
  rep: number;
  valid: boolean;
  routed: boolean;
  critic_draft: string;
  steps: number;
  models: string[];
  est_usd: number;
  ms: number;
  error?: string;
}

async function runPlanner(p: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let rep = 0; rep < REPS; rep++)
    for (const g of GOALS) {
      const t0 = Date.now();
      try {
        const out = await plan(g.goal, {
          plannerModel: p,
          budget: budget(),
          criticEnabled: true,
          unattended: true,
        });
        rows.push({
          planner: p,
          goal: g.id,
          rep,
          valid: out.steps.length > 0,
          routed: g.ok(out.steps),
          critic_draft: out.critique
            ? out.critique.revised
              ? "revise"
              : out.critique.verdict
            : "none",
          steps: out.steps.length,
          models: out.steps.map((s) => s.model),
          est_usd: out.estimated_cost_usd,
          ms: Date.now() - t0,
        });
      } catch (err) {
        rows.push({
          planner: p,
          goal: g.id,
          rep,
          valid: false,
          routed: false,
          critic_draft: "n/a",
          steps: 0,
          models: [],
          est_usd: 0,
          ms: Date.now() - t0,
          error: err instanceof Error ? err.message.slice(0, 160) : String(err),
        });
      }
      process.stderr.write(".");
    }
  return rows;
}

const all = (await Promise.all(PLANNERS.map(runPlanner))).flat();
process.stderr.write("\n");
console.log(
  JSON.stringify({ goals: GOALS.map(({ id, rule }) => ({ id, rule })), rows: all }, null, 2),
);
