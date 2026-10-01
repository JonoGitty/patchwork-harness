/**
 * Intent lanes - ADR-0018. Opt-in; the default lane is "planned", which is
 * the pipeline exactly as it was.
 *
 *   --lane planned   world view + lessons + planner + critic + N steps (default)
 *   --lane direct    no planner, no critic: ONE executor step does the goal
 *   --lane auto      a cascade picks (ADR-0018 addendum, 29 Sept 2026):
 *                      1. a custom intent head (a small classifier trained on
 *                         labelled goals, served locally over the System One
 *                         wire format at PATCHWORK_HARNESS_INTENT_URL) decides the clear
 *                         cases in milliseconds;
 *                      2. only in its uncertain band does a cheap LLM router
 *                         (defaults.intent_router) get asked, and only a
 *                         CONFIDENT "no plan needed" from it counts;
 *                      3. everything else - including every failure - is planned.
 *
 * Why: the audit trail says planning costs a median 13.8 s before any work
 * starts (24% of a run's wall time), the planner splits nearly every goal
 * into 3 steps, and steps 2-3 carry 79% of executor input tokens. On one-pass
 * jobs the direct lane passed 16/16 hidden checks against 8/16 for the
 * pipeline, with 63% fewer input tokens (same model, same bill).
 *
 * Why a cascade: on 224 labelled real requests, local Kev-0.8B zero-shot was no
 * better than a constant (46.9% vs 45.1%); a trained head on local embeddings
 * reached 72.5% at 3.4 ms; gpt-6-luna reached 78.6% at 2.1 s but misroutes
 * context-dependent chat. Head decides, LLM only in the band [0.4, 0.6) with
 * confidence >= 0.9: 96% precision on "fast", the LLM called ~9% of the time.
 *
 * The router only ROUTES. A misroute costs money or quality, never
 * correctness guarantees: the test gate, repair loop and L5 review run the
 * same on both lanes.
 */
import { type ClassifierConfig, askSystemOne } from "../classifier/systemone.js";
import { loadModels } from "../config.js";
import type { CompletionRequest, CompletionResponse } from "../providers/base.js";
import { providerForModel } from "./planner.js";
import type { Plan, Step } from "./types.js";

export type Lane = "direct" | "planned";
export type LaneMode = Lane | "auto";

/** The labels a router chooses from. answer + direct both mean "no plan needed". */
export const INTENT_LABELS = {
  answer:
    "a question or discussion that needs no files, tools, commands or code changes; a model can reply from knowledge plus the text given",
  direct:
    "one focused action a capable agent can finish in a single pass without a plan: a small edit, one command or check, one lookup in a repo, a bug whose location is clear, one short file",
  planned:
    "needs decomposition: several parts, files or systems, investigation before changing anything, design choices, research plus build, or reviewing a whole system",
  unclear:
    "the text alone does not say what to do (it depends on earlier conversation, e.g. 'yes go', 'carry on'), so no lane can be chosen safely",
} as const;
export type IntentLabel = keyof typeof INTENT_LABELS;

/** Head P(fast) at or above this: direct, no LLM call. */
export const DEFAULT_HEAD_HI = 0.6;
/** Head P(fast) below this: planned, no LLM call. Between the two: ask the LLM. */
export const DEFAULT_HEAD_LO = 0.4;
/** The LLM's "no plan needed" only counts at or above this self-reported confidence. */
export const DEFAULT_LLM_CONFIDENCE = 0.9;
/** Kev was trained on states of at most ~384 tokens; the head of a goal carries the intent. */
const MAX_STATE_CHARS = 1500;
/** A direct step gets the tool budget a 3-step plan would have spread over its steps. */
export const DIRECT_TOOL_TURNS = 20;
const INSTRUCTIONS =
  "Which is the cheapest lane that would still do this request WELL, judged only from the request text?";

export interface IntentRoute {
  lane: Lane;
  /** Which stage decided: the custom head, the LLM router, or neither (fallback). */
  stage: "head" | "llm" | "none";
  /** Head P(answer) + P(direct): the probability that no plan is needed. */
  p_fast?: number;
  label?: IntentLabel;
  probabilities?: Record<string, number>;
  head_model?: string;
  head_latency_ms?: number;
  llm_model?: string;
  llm_label?: string;
  llm_confidence?: number;
  llm_latency_ms?: number;
  reason: string;
}

export interface RouteUsage {
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
}

export interface RouteOptions {
  hi?: number;
  lo?: number;
  llmConfidence?: number;
  /** The custom head. undefined = PATCHWORK_HARNESS_INTENT_URL; null = none. */
  head?: ClassifierConfig | null;
  /** The LLM router model. undefined = defaults.intent_router; null = none. */
  llmModel?: string | null;
  fetchImpl?: typeof fetch;
  /** Test seam: replaces the provider call for the LLM router. */
  complete?: (req: CompletionRequest) => Promise<CompletionResponse>;
  /** Called once if the LLM router is asked, so the ledger counts it. */
  onUsage?: (u: RouteUsage) => void;
}

/** The head's pure rule: direct, planned, or ask the LLM. Tested exhaustively. */
export function headDecision(
  probabilities: Record<string, number>,
  hi = DEFAULT_HEAD_HI,
  lo = DEFAULT_HEAD_LO,
): { decision: Lane | "ask"; p_fast: number; label: IntentLabel } {
  const p = (k: string) => (Number.isFinite(probabilities[k]) ? probabilities[k]! : 0);
  const p_fast = p("answer") + p("direct");
  const label = (Object.keys(INTENT_LABELS) as IntentLabel[]).reduce((a, b) =>
    p(b) > p(a) ? b : a,
  );
  const decision = p_fast >= hi ? "direct" : p_fast < lo ? "planned" : "ask";
  return { decision, p_fast, label };
}

export function intentHeadConfig(env: NodeJS.ProcessEnv = process.env): ClassifierConfig | null {
  const url = env.PATCHWORK_HARNESS_INTENT_URL?.trim();
  if (!url) return null;
  return {
    backend: "kev",
    url: url.replace(/\/+$/, ""),
    model: env.PATCHWORK_HARNESS_INTENT_MODEL?.trim() || "intent-head",
    apiKey: env.PATCHWORK_HARNESS_INTENT_KEY?.trim() || undefined,
  };
}

export function llmRouterPrompt(): string {
  return [
    "You route requests given to an AI coding agent. Pick the CHEAPEST lane that would still do the request WELL, judged only from the request text. Lanes:",
    ...Object.entries(INTENT_LABELS).map(([k, v]) => `- ${k}: ${v}`),
    'Reply with JSON only: {"label": "<lane>", "confidence": <0..1>}',
  ].join("\n");
}

async function askLlm(
  goal: string,
  model: string,
  opts: RouteOptions,
): Promise<{ label?: string; confidence?: number; latency_ms: number; error?: string }> {
  const started = Date.now();
  try {
    const complete =
      opts.complete ??
      ((req: CompletionRequest) => {
        const provider = providerForModel(model);
        if (!provider.available()) throw new Error(`${provider.name} key not set`);
        return provider.complete(req);
      });
    const resp = await complete({
      model,
      maxTokens: 200,
      system: llmRouterPrompt(),
      messages: [
        { role: "user", content: [{ type: "text", text: goal.slice(0, MAX_STATE_CHARS) }] },
      ],
    });
    opts.onUsage?.({
      model,
      tokens_in: resp.usage?.input_tokens ?? 0,
      tokens_out: resp.usage?.output_tokens ?? 0,
      cost_usd: resp.cost_usd ?? 0,
      duration_ms: resp.duration_ms ?? 0,
    });
    const text = resp.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { latency_ms: Date.now() - started, error: "no JSON in reply" };
    const j = JSON.parse(m[0]) as { label?: unknown; confidence?: unknown };
    return {
      label: typeof j.label === "string" ? j.label : undefined,
      confidence: typeof j.confidence === "number" ? j.confidence : undefined,
      latency_ms: Date.now() - started,
    };
  } catch (e) {
    return { latency_ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function routeIntent(goal: string, opts: RouteOptions = {}): Promise<IntentRoute> {
  const hi = opts.hi ?? DEFAULT_HEAD_HI;
  const lo = opts.lo ?? DEFAULT_HEAD_LO;
  const conf = opts.llmConfidence ?? DEFAULT_LLM_CONFIDENCE;
  const head = opts.head === undefined ? intentHeadConfig() : opts.head;
  const route: Partial<IntentRoute> = {};
  const why: string[] = [];

  // 1. the custom head
  if (head) {
    const started = Date.now();
    try {
      const res = await askSystemOne(
        head,
        { request: goal.slice(0, MAX_STATE_CHARS) },
        { lane: { type: "choice", instructions: INSTRUCTIONS, criteria: { ...INTENT_LABELS } } },
        { fetchImpl: opts.fetchImpl, timeoutMs: 1_500, retries: 0 },
      );
      const a = res.answers.lane;
      route.head_model = res.model;
      route.head_latency_ms = Date.now() - started;
      if (a && a.type === "choice") {
        const d = headDecision(a.probabilities, hi, lo);
        Object.assign(route, { p_fast: d.p_fast, label: d.label, probabilities: a.probabilities });
        if (d.decision !== "ask") {
          return {
            ...route,
            lane: d.decision,
            stage: "head",
            reason: `head P(no plan needed) ${d.p_fast.toFixed(2)} ${d.decision === "direct" ? `>= ${hi}` : `< ${lo}`}: ${d.decision}`,
          };
        }
        why.push(`head unsure (P ${d.p_fast.toFixed(2)} in [${lo}, ${hi}))`);
      } else {
        why.push("head reply had no lane choice");
      }
    } catch (e) {
      route.head_latency_ms = Date.now() - started;
      why.push(`head failed (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    why.push("no intent head (PATCHWORK_HARNESS_INTENT_URL)");
  }

  // 2. the LLM router, only for what the head could not decide
  const model =
    opts.llmModel === undefined ? (loadModels().defaults.intent_router ?? null) : opts.llmModel;
  if (model) {
    const r = await askLlm(goal, model, opts);
    Object.assign(route, {
      llm_model: model,
      llm_label: r.label,
      llm_confidence: r.confidence,
      llm_latency_ms: r.latency_ms,
    });
    if (r.error) {
      why.push(`LLM router failed (${r.error})`);
    } else {
      const fast = r.label === "answer" || r.label === "direct";
      if (fast && (r.confidence ?? 0) >= conf) {
        return {
          ...route,
          lane: "direct",
          stage: "llm",
          reason: `${why.join("; ")}; ${model} says ${r.label} at ${r.confidence} >= ${conf}: direct`,
        };
      }
      return {
        ...route,
        lane: "planned",
        stage: "llm",
        reason: `${why.join("; ")}; ${model} says ${r.label ?? "?"} at ${r.confidence ?? "?"}: planned`,
      };
    }
  } else {
    why.push("no LLM router (defaults.intent_router)");
  }

  // 3. nothing could decide: the safe lane
  return { ...route, lane: "planned", stage: "none", reason: `${why.join("; ")}: planned` };
}

export function directDescription(goal: string): string {
  return [
    "Do this whole task in this one step. There is no separate plan and no later step.",
    "Look at only what you need, make the change, check it works, then give a short summary of what you did and how you checked it.",
    "",
    "TASK:",
    goal,
  ].join("\n");
}

/** A one-step plan for the direct lane (no planner or critic call). */
export function directPlan(
  goal: string,
  executor: { id: string; provider: Step["provider"] },
): Plan {
  return {
    goal,
    reasoning: "direct lane (ADR-0018): no planner, no critic, one executor step",
    steps: [
      {
        title: "Do the task (direct lane)",
        description: directDescription(goal),
        provider: executor.provider,
        model: executor.id,
        max_tool_turns: DIRECT_TOOL_TURNS,
        reason: "intent lane: direct",
      },
    ],
    estimated_cost_usd: 0,
  };
}
