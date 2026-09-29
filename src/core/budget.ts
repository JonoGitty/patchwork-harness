/**
 * Budget plumbing. Three layers:
 *
 *   bedrock_usd  — HARD ceiling, checked before AND after every provider
 *                  call. Never crossed. Hitting it ends the session with
 *                  status "bedrock_aborted".
 *
 *   session_usd  — SOFT cap, the planner's target. Exceeded only if mode
 *                  allows (see soft_overrun_pct in budget.yml).
 *
 *   mode         — strategy the planner uses to pick models. Budget,
 *                  balanced, or unlimited.
 *
 * `monthly_cap_usd` aggregates across all sessions in a calendar month.
 * If the cap is hit, new sessions refuse to start until the next month
 * or the user raises the cap.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { load as yamlLoad } from "js-yaml";
import { CONFIG_DIR, HOME_HARNESS, SESSIONS_DIR } from "../util/paths.js";

export type BudgetMode = "budget" | "balanced" | "unlimited";

export interface BudgetState {
  bedrock_usd: number;
  session_usd: number;
  mode: BudgetMode;
  spent_usd: number;
}

export interface ModeProfile {
  description: string;
  prefer_models: string[];
  avoid_models: string[];
  soft_overrun_pct: number;
}

const ModeProfileSchema = z.object({
  description: z.string(),
  prefer_models: z.array(z.string()).default([]),
  avoid_models: z.array(z.string()).default([]),
  soft_overrun_pct: z.number().default(20),
});

const BudgetConfigSchema = z.object({
  defaults: z.object({
    bedrock_usd: z.number(),
    session_usd: z.number(),
    mode: z.enum(["budget", "balanced", "unlimited"]),
    monthly_cap_usd: z.number(),
  }),
  modes: z.object({
    budget: ModeProfileSchema,
    balanced: ModeProfileSchema,
    unlimited: ModeProfileSchema,
  }),
});

export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

let cached: BudgetConfig | null = null;
export function loadBudgetConfig(): BudgetConfig {
  if (cached) return cached;
  const userPath = join(HOME_HARNESS, "budget.yml");
  const path = existsSync(userPath) ? userPath : join(CONFIG_DIR, "budget.yml");
  cached = BudgetConfigSchema.parse(yamlLoad(readFileSync(path, "utf8")));
  return cached;
}

/** Force the next loadBudgetConfig() call to re-read from disk. */
export function invalidateBudgetCache(): void {
  cached = null;
}

export function getModeProfile(mode: BudgetMode): ModeProfile {
  return loadBudgetConfig().modes[mode];
}

export class BedrockBreachError extends Error {
  constructor(public spent: number, public bedrock: number) {
    super(`bedrock breached: spent $${spent.toFixed(4)} > bedrock $${bedrock.toFixed(4)}`);
    this.name = "BedrockBreachError";
  }
}

export class MonthlyCapBreachError extends Error {
  constructor(public month_total: number, public cap: number) {
    super(
      `monthly cap reached: this month $${month_total.toFixed(2)} >= cap $${cap.toFixed(2)}`,
    );
    this.name = "MonthlyCapBreachError";
  }
}

/**
 * Check the bedrock — call BEFORE every provider call (with conservative
 * estimate of next call's cost) AND AFTER (with actuals). Throws on breach.
 */
export function assertWithinBedrock(state: BudgetState, additional: number = 0): void {
  if (state.spent_usd + additional > state.bedrock_usd) {
    throw new BedrockBreachError(state.spent_usd + additional, state.bedrock_usd);
  }
}

/** Headroom remaining within session_usd (negative if over). */
export function sessionHeadroom(state: BudgetState): number {
  return state.session_usd - state.spent_usd;
}

/** Headroom within bedrock — the absolute floor. */
export function bedrockHeadroom(state: BudgetState): number {
  return state.bedrock_usd - state.spent_usd;
}

/** Are we within session_usd, including the mode's soft overrun allowance? */
export function withinSessionAllowance(state: BudgetState): boolean {
  const profile = getModeProfile(state.mode);
  const allowance = state.session_usd * (1 + profile.soft_overrun_pct / 100);
  return state.spent_usd <= allowance;
}

/**
 * Sum spend across all session manifests with started_at in the current
 * calendar month (UTC). Cheap enough to call once per session_start.
 */
export function monthSpendUsd(): number {
  if (!existsSync(SESSIONS_DIR)) return 0;
  const yearMonth = new Date().toISOString().slice(0, 7);
  let total = 0;
  let names: string[] = [];
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, name), "utf8"));
      if ((data.started_at ?? "").slice(0, 7) === yearMonth) {
        total += Number(data.total_cost_usd ?? 0);
      }
    } catch {
      /* skip unreadable */
    }
  }
  return Math.round(total * 10000) / 10000;
}

/** Throws MonthlyCapBreachError if this session would push us over the monthly cap. */
export function assertMonthlyCap(): void {
  const cfg = loadBudgetConfig();
  const monthTotal = monthSpendUsd();
  if (monthTotal >= cfg.defaults.monthly_cap_usd) {
    throw new MonthlyCapBreachError(monthTotal, cfg.defaults.monthly_cap_usd);
  }
}

/** Live status snapshot — what the budget_status tool returns. */
export interface BudgetSnapshot {
  spent_usd: number;
  session_cap_usd: number;
  bedrock_usd: number;
  mode: BudgetMode;
  headroom_usd: number;
  bedrock_headroom_usd: number;
  percent_used: number;
  within_session_allowance: boolean;
}

export function snapshot(state: BudgetState): BudgetSnapshot {
  return {
    spent_usd: state.spent_usd,
    session_cap_usd: state.session_usd,
    bedrock_usd: state.bedrock_usd,
    mode: state.mode,
    headroom_usd: sessionHeadroom(state),
    bedrock_headroom_usd: bedrockHeadroom(state),
    percent_used: state.session_usd > 0
      ? Math.round((state.spent_usd / state.session_usd) * 1000) / 10
      : 0,
    within_session_allowance: withinSessionAllowance(state),
  };
}
