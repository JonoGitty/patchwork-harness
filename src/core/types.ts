import type { Provider } from "../providers/base.js";
import type { BudgetMode } from "./budget.js";

export interface Step {
  title: string;
  description: string;
  provider: "anthropic" | "openai" | "gemini" | "xai" | "perplexity" | "local";
  model: string;
  max_tool_turns: number;
  reason: string;
  /**
   * Research steps: when true and provider is gemini, the step runs with
   * live Google Search grounding (real cited sources) instead of the local
   * tool loop. Use for fact-finding / current-info steps, never for steps
   * that must read/write files.
   */
  grounded?: boolean;
  /**
   * Human-in-the-loop steps: when true the step makes NO provider call.
   * The description is a question put to the person running the session
   * (terminal prompt, or an interactive card in the web dashboard). The
   * answer becomes the step's output and feeds every later step. Use for
   * design decisions and ambiguities the agent must not resolve alone.
   */
  pause_for_human?: boolean;
}

export interface Plan {
  goal: string;
  reasoning: string;
  steps: Step[];
  estimated_cost_usd: number;
}

export type SessionStatus = "in_progress" | "completed" | "failed" | "denied" | "bedrock_aborted";

export interface StepResult {
  step: Step;
  status: "completed" | "failed" | "denied" | "bedrock_aborted";
  output_summary: string;
  cost_usd: number;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  tool_calls: number;
  error?: string;
}

export interface SessionState {
  sessionId: string;
  cwd: string;
  goal: string;
  plan?: Plan;
  results: StepResult[];
  total_cost_usd: number;
  budget: {
    bedrock_usd: number;
    session_usd: number;
    mode: BudgetMode;
  };
  permission_mode: "auto" | "default" | "cautious";
  status: SessionStatus;
  started_at: string;
  ended_at?: string;
  /** --verify-cmd gate outcome (ADR-0015); absent when no gate was asked for. */
  verification?: {
    cmd: string;
    passed: boolean;
    exit_code: number;
    attempts: number;
    tail: string;
  };
  /** --checkpoint snapshots taken (labels under refs/patchwork-harness/<session>/). */
  checkpoints?: string[];
  /** ADR-0018: which intent lane ran, and why (absent = planned by default). */
  lane?: {
    lane: "direct" | "planned";
    mode: "direct" | "planned" | "auto";
    stage?: "head" | "llm" | "none";
    p_fast?: number;
    label?: string;
    llm_label?: string;
    latency_ms?: number;
  };
  /** L5 reviewer verdict (ADR-0016); absent unless --review. */
  review?: import("./reviewer.js").ReviewResult;
}

export type ProviderResolver = (name: Step["provider"]) => Provider;
