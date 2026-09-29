/**
 * budget_status tool — executors call this to query their remaining
 * spend and adjust their behaviour. Read-only, no side effects.
 *
 * The current budget state is held in a per-session module-level cell
 * that the orchestrator updates between steps. This is a simple
 * cross-cutting concern and keeps the tool API uniform with everything
 * else.
 */

import { z } from "zod";
import type { Tool } from "./base.js";
import { snapshot, type BudgetState, type BudgetSnapshot } from "../core/budget.js";

const STATE = new Map<string, BudgetState>();

export function setBudgetState(sessionId: string, state: BudgetState): void {
  STATE.set(sessionId, state);
}

export function getBudgetState(sessionId: string): BudgetState | null {
  return STATE.get(sessionId) ?? null;
}

const Input = z.object({});
type In = z.infer<typeof Input>;

export const budgetStatusTool: Tool<In, BudgetSnapshot | { error: string }> = {
  name: "budget_status",
  description:
    "Query the current session's budget state. Returns spent_usd, session_cap_usd, bedrock_usd, mode, and headroom. Use this when deciding whether to take an expensive action.",
  inputSchema: Input,
  assess: () => ({ level: "none", flags: [] }),
  preview: () => ({ description: "budget_status (read-only)" }),
  async run(_input, ctx) {
    const state = STATE.get(ctx.sessionId);
    if (!state) return { error: "no budget state for this session" };
    return snapshot(state);
  },
};
