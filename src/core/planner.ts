/**
 * Planner. Asks a small, fast model to break a goal into 3-8 ordered
 * steps, each tagged with a provider+model. Returns a typed Plan.
 *
 * The planner is fed:
 *  - the model registry (id, provider, price)
 *  - the model_capabilities corpus (best_for / avoid_for / quirks / heuristics)
 *  - the budget for the whole session
 *  - the plugin catalogue (so it knows about Claude skills it can suggest)
 *
 * The default planner is Anthropic Haiku — cheapest reliable option.
 */

import { z } from "zod";
import type { AuditEmitter } from "../audit.js";
import { type ModelInfo, loadModelCapabilities, loadModels } from "../config.js";
import { fallbackModelFor, reachableModels } from "../providers/availability.js";
import type { Provider } from "../providers/base.js";
import { getProvider } from "../providers/registry.js";
import { type BudgetState, getModeProfile } from "./budget.js";
import type { Plan, Step } from "./types.js";

export interface CritiqueResult {
  verdict: "approve" | "revise";
  suggestions: string[];
  revised: boolean;
}

const StepSchema = z.object({
  title: z.string(),
  description: z.string(),
  provider: z.enum(["anthropic", "openai", "gemini", "xai", "perplexity", "local"]),
  model: z.string(),
  max_tool_turns: z.number().int().min(1).max(20).default(5),
  reason: z.string(),
  grounded: z.boolean().optional(),
  pause_for_human: z.boolean().optional(),
});

const PlanSchema = z.object({
  goal: z.string(),
  reasoning: z.string(),
  steps: z.array(StepSchema).min(1).max(12),
});

/**
 * The configured planner, or `planner_fallback` when the planner's provider
 * has no key on this machine (the planner moved to gpt-6-luna on 28 Sept
 * 2026; a machine with only an Anthropic key still plans, on Haiku).
 */
export function effectivePlanner(): string {
  const d = loadModels().defaults;
  if (d.planner_fallback && !providerForModel(d.planner).available()) return d.planner_fallback;
  return d.planner;
}

/** The provider that serves a catalog model (anthropic when unknown). */
export function providerForModel(modelId: string): Provider {
  let name: ModelInfo["provider"] = "anthropic";
  try {
    const m = loadModels().models.find((x) => x.id === modelId);
    if (m) name = m.provider;
  } catch {
    /* no catalog */
  }
  return getProvider(name);
}

/**
 * Deterministic guard on the planner's picks. The prompt says "only pick
 * models from the Available list", but on 28 Sept 2026 Haiku and Sonnet
 * both routed private writing to gemma3:12b / qwen3:8b while those were
 * hidden (not loaded in the running Ollama) - steps that would have failed
 * at run time. Any step naming a hidden or uncatalogued model is swapped for
 * a reachable one, and the swap is written into the step's reason. A local
 * pick falls back to the writing domain's cheap_fallback (never a flagship);
 * anything else takes the same-tier fallback.
 */
export async function enforceReachable(
  steps: Step[],
  reachable: ModelInfo[],
  fallbackFor: (model: string) => Promise<ModelInfo | null> = (m) => fallbackModelFor(m),
): Promise<Step[]> {
  const ok = new Map(reachable.map((m) => [m.id, m]));
  let writingFallback: string[] = [];
  let tierOf = new Map<string, string>();
  try {
    const caps = loadModelCapabilities();
    writingFallback = caps.domain_routing.writing?.cheap_fallback ?? [];
    tierOf = new Map(caps.models.map((m) => [m.id, m.tier]));
  } catch {
    /* corpus optional */
  }
  const out: Step[] = [];
  for (const step of steps) {
    if (step.pause_for_human || ok.has(step.model)) {
      out.push(step);
      continue;
    }
    let sub: ModelInfo | null | undefined =
      tierOf.get(step.model) === "local" || step.provider === "local"
        ? writingFallback.map((id) => ok.get(id)).find(Boolean)
        : undefined;
    sub ??= await fallbackFor(step.model);
    if (!sub || !ok.has(sub.id)) sub = reachable[0] ?? null;
    if (!sub) {
      out.push(step);
      continue;
    }
    out.push({
      ...step,
      provider: sub.provider,
      model: sub.id,
      reason: `${step.reason} [patchwork-harness: planner picked ${step.model}, not available this session; routed to ${sub.id}]`,
    });
  }
  return out;
}

/** Only models this key can reach right now are shown to the planner. */
function modelCatalogue(models: ModelInfo[]): string {
  const price = (v: number | null) => (v === null ? "price unknown" : `$${v}/M`);
  return models
    .map(
      (m) =>
        `  - ${m.id} (${m.provider}) — ${price(m.cost_per_m_in)} in, ${price(m.cost_per_m_out)} out` +
        (m.availability === "unverified" ? " [newly reachable this session]" : ""),
    )
    .join("\n");
}

function capabilityCorpus(hidden: Set<string>): string {
  const cfg = loadModelCapabilities();
  const lines: string[] = [];
  if (cfg.corpus_metadata) {
    lines.push(`### Corpus freshness`);
    lines.push(`Last reviewed: ${cfg.corpus_metadata.last_reviewed}`);
    if (cfg.corpus_metadata.next_review_due) {
      lines.push(`Next review due: ${cfg.corpus_metadata.next_review_due}`);
    }
    lines.push(
      "If today is well past 'last reviewed', the model picks may be stale. Pick by TIER (flagship / workhorse / cheap_fast / reasoning / flagship_alt), not by vendor name. preferred_models is just the current shortlist as of the review date.",
    );
    lines.push("");
  }
  for (const m of cfg.models) {
    if (hidden.has(m.id)) continue; // unreachable on this key this session
    lines.push(`### ${m.id} — ${m.tier} • ${m.speed} • cost ${m.relative_cost}`);
    lines.push(`Typical cost per step: ~$${m.typical_cost_per_step_usd}`);
    if (m.best_for.length) {
      lines.push("Best for:");
      for (const b of m.best_for) lines.push(`  - ${b}`);
    }
    if (m.avoid_for.length) {
      lines.push("Avoid for:");
      for (const a of m.avoid_for) lines.push(`  - ${a}`);
    }
    if (m.quirks.length) {
      lines.push("Quirks:");
      for (const q of m.quirks) lines.push(`  - ${q}`);
    }
    lines.push("");
  }
  const domains = Object.entries(cfg.domain_routing ?? {});
  if (domains.length) {
    lines.push("### Domain routing — pick by domain FIRST (tier, then current best-in-tier)");
    for (const [domain, route] of domains) {
      const shortlist = (route.preferred_models ?? route.preferred ?? []).filter(
        (id) => !hidden.has(id),
      );
      lines.push(`  ${domain}:`);
      if (route.preferred_tier) lines.push(`    preferred_tier:   ${route.preferred_tier}`);
      lines.push(`    preferred_models: ${shortlist.join(", ")}`);
      lines.push(
        `    cheap_fallback:   ${route.cheap_fallback.length ? route.cheap_fallback.join(", ") : "(none — do not cheap-fallback this domain)"}`,
      );
      lines.push(`    why:              ${route.why}`);
    }
    lines.push("");
  }
  if (cfg.routing_heuristics.length) {
    lines.push("### Routing heuristics");
    for (const h of cfg.routing_heuristics) lines.push(`  - ${h}`);
    lines.push("");
  }
  if (cfg.anti_patterns.length) {
    lines.push("### Anti-patterns");
    for (const a of cfg.anti_patterns) lines.push(`  - ${a}`);
  }
  return lines.join("\n");
}

function availableProviders(): string {
  const names: string[] = [];
  for (const n of ["anthropic", "openai", "gemini", "xai", "perplexity", "local"] as const) {
    try {
      const p = getProvider(n);
      if (p.available()) names.push(n);
    } catch {
      /* skip */
    }
  }
  return names.join(", ") || "anthropic";
}

const PROMPT_TEMPLATE = (args: {
  goal: string;
  budget: BudgetState;
  available: string;
  modeNote: string;
  modelCat: string;
  capabilities: string;
  pluginCatalogue: string;
  worldView: string;
  lessons: string;
  criticFeedback: string;
  unattended: boolean;
}) => `You are the planner inside Patchwork Harness. Decompose the user's goal into 3-8 ordered, concrete steps. For each step, choose the BEST provider + model based on the capability corpus below.

Hard constraints (NON-NEGOTIABLE):
- Bedrock cap: $${args.budget.bedrock_usd.toFixed(2)} — your sum of typical_cost_per_step_usd must NEVER exceed this. If you can't stay under, return fewer steps with cheaper models.
- Available providers in this environment: ${args.available}. Do NOT pick a model from a provider not in that list — the API key is missing.
- Pick ONLY models from the "Available models" list below — it is already filtered to what this key can reach right now.${
  args.unattended
    ? `
- This run is UNATTENDED: nobody can answer questions or approve prompts. NEVER emit a "pause_for_human" step - where a decision is needed, choose the safest reasonable default and state it in the step description. Off-allowlist shell commands and paths outside the working directory will be denied on the spot, so plan steps around read/grep/glob and allowlisted commands.`
    : ""
}

Soft constraints (mode-driven):
- Session target: $${args.budget.session_usd.toFixed(2)} (mode = ${args.budget.mode}).
- ${args.modeNote}

Quality constraints:
- Pick the cheapest model that can reliably do the step. Don't use Opus for a 5-line snippet. Don't use Haiku for hard reasoning.
- Mix providers within a plan when it makes sense (e.g. Haiku to classify, Sonnet to write code).
- max_tool_turns: 2-3 for trivial steps, 5 for typical, 10 for hard ones.

Research / grounding (anti-hallucination — IMPORTANT):
- If a step needs CURRENT/LIVE information or must cite real sources (latest library versions, "what's new", checking a fact or reference exists), it MUST be grounded. Ungrounded models fabricate facts and citations.
- Two ways to ground a research step: (a) provider "gemini" with "grounded": true (live Google Search + citations, uses GEMINI_API_KEY), or (b) provider "perplexity" (Sonar, purpose-built cited research). Prefer whichever is available; if both, gemini grounded is fine and reuses the Google key.
- Set "grounded": true ONLY on a "gemini" step. A grounded step does NO file/tool work — it returns researched text+sources. Pattern: one grounded research step, THEN a separate flagship-coder step that acts on the findings.
- Never grounded on coding/file steps. Never route a perplexity step to read/write files (it has no tools).

Local models (provider "local" — Ollama on this machine, $0, fully private):
- When "local" is in the available providers list, prefer it for WRITING and DRAFTING steps: prose, essays, notes, summaries of provided text, rewording, brainstorming. It costs nothing and nothing leaves the laptop, which also makes it the ONLY correct choice for steps handling personal/sensitive text.
- Local models are weaker than flagships at hard reasoning and multi-file coding — don't route those to local. A good pattern: local step drafts the text, a later cheap cloud step (or a local tool-capable model) files it.
- Note some local models can't call tools (the executor degrades such steps to pure text output automatically) — so give a local writing step a description that asks for the text itself, and let a following step write files if needed.

Human-in-the-loop ("pause_for_human"):
- If the goal contains a decision the agent must NOT make alone — a design choice with several defensible options, an ambiguous requirement, or a hard-to-reverse action — insert a step with "pause_for_human": true. That step makes NO model call: its "description" is THE QUESTION put to the person, phrased directly and answerable in one sentence. Set max_tool_turns to 1; provider/model are ignored for these steps (fill in anthropic / claude-haiku-4-5 as placeholders).
- The person's answer is fed to all later steps as context, so place the pause BEFORE the steps that depend on the decision.
- Use sparingly — only when a wrong guess would waste the budget or build the wrong thing. Never pause for things the goal already specifies.

Output STRICT JSON matching:
{
  "goal": "<echo>",
  "reasoning": "<2-3 sentences explaining your decomposition AND your model choices, including how you stayed within the budget>",
  "steps": [
    { "title": "...", "description": "...", "provider": "...", "model": "...", "max_tool_turns": N, "reason": "...", "grounded": false, "pause_for_human": false }
  ]
}

== Available models ==
${args.modelCat}

== Capability corpus ==
${args.capabilities}

== Available skills (Claude skills via claude_compat — call them by name in step descriptions) ==
${args.pluginCatalogue}

== Budget ==
Session: $${args.budget.session_usd.toFixed(2)}
Bedrock: $${args.budget.bedrock_usd.toFixed(2)}
Mode:    ${args.budget.mode}
${args.worldView ? `\n== Context you should know ==\n${args.worldView}\n` : ""}${args.lessons ? `\n${args.lessons}\n` : ""}${args.criticFeedback ? `\n== Critic feedback on your previous draft (revise accordingly) ==\n${args.criticFeedback}\n` : ""}
== User goal ==
${args.goal}

Return ONLY the JSON object, nothing else.`;

function estimateCost(steps: Step[]): number {
  const cfg = loadModels();
  let total = 0;
  for (const s of steps) {
    if (s.pause_for_human) continue; // humans are free
    const m = cfg.models.find((x) => x.id === s.model);
    if (!m || m.cost_per_m_in === null || m.cost_per_m_out === null) continue; // price unknown: uncounted
    total += (2000 * m.cost_per_m_in + 1000 * m.cost_per_m_out) / 1_000_000;
  }
  return Math.round(total * 10000) / 10000;
}

function modeNote(mode: BudgetState["mode"]): string {
  const profile = getModeProfile(mode);
  const prefer = profile.prefer_models.length ? `Prefer: ${profile.prefer_models.join(", ")}.` : "";
  const avoid = profile.avoid_models.length ? `Avoid: ${profile.avoid_models.join(", ")}.` : "";
  const overrun =
    profile.soft_overrun_pct === 9999
      ? "Session target is informational only — bedrock is the cap."
      : `You may exceed the session target by up to ${profile.soft_overrun_pct}% if needed.`;
  return [profile.description, prefer, avoid, overrun].filter(Boolean).join(" ");
}

/**
 * One planning-side LLM call (planner or critic), reported so the session
 * ledger and the audit trail count it. Until 29 Sept 2026 neither was
 * recorded: every session's total, and the bedrock check, left planning out.
 */
export interface PlanUsage {
  phase: "planner" | "critic";
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  duration_ms: number;
}
type OnUsage = (u: PlanUsage) => void;

async function planOnce(
  goal: string,
  opts: {
    onUsage?: OnUsage;
    plannerModel: string;
    pluginCatalogue: string;
    budget: BudgetState;
    worldView: string;
    lessons: string;
    criticFeedback: string;
    reachable: ModelInfo[];
    hidden: Set<string>;
    unattended: boolean;
  },
): Promise<Plan> {
  const provider = providerForModel(opts.plannerModel);
  if (!provider.available()) {
    throw new Error(
      `planner model ${opts.plannerModel} needs the ${provider.name} API key to be set`,
    );
  }

  const prompt = PROMPT_TEMPLATE({
    goal,
    budget: opts.budget,
    available: availableProviders(),
    modeNote: modeNote(opts.budget.mode),
    modelCat: modelCatalogue(opts.reachable),
    capabilities: capabilityCorpus(opts.hidden),
    pluginCatalogue: opts.pluginCatalogue,
    worldView: opts.worldView,
    lessons: opts.lessons,
    criticFeedback: opts.criticFeedback,
    unattended: opts.unattended,
  });

  const resp = await provider.complete({
    model: opts.plannerModel,
    maxTokens: 2048,
    temperature: 0.2,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });
  // before parsing: an unusable reply still cost money
  opts.onUsage?.({
    phase: "planner",
    model: opts.plannerModel,
    tokens_in: resp.usage?.input_tokens ?? 0,
    tokens_out: resp.usage?.output_tokens ?? 0,
    cost_usd: resp.cost_usd ?? 0,
    duration_ms: resp.duration_ms ?? 0,
  });

  const text = resp.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");

  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`planner produced no JSON: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  const validated = PlanSchema.parse(parsed);
  const steps = await enforceReachable(validated.steps, opts.reachable);

  return {
    goal: validated.goal,
    reasoning: validated.reasoning,
    steps,
    estimated_cost_usd: estimateCost(steps),
  };
}

const CRITIC_PROMPT_TEMPLATE = (
  plan: Plan,
  budget: BudgetState,
) => `You are reviewing a plan another AI just produced. Critique it for:
(1) budget fit — does the sum of typical_cost stay under bedrock $${budget.bedrock_usd.toFixed(2)}?
(2) model-task alignment — does each step use the right tier? Flagships for serious coding, cheap models for bulk/coordination, no Haiku for production code.
(3) step ordering — could any step fail because a dependency wasn't done first?
(4) missing steps — is anything obvious left out?
(5) over-engineering — could this be done in fewer steps?

Plan to review:
${JSON.stringify(plan, null, 2)}

Output STRICT JSON: {"verdict": "approve" | "revise", "suggestions": ["..."]}.
If "approve", suggestions can be empty. If "revise", give 1-3 concrete actionable suggestions.

Return ONLY the JSON.`;

const CritiqueSchema = z.object({
  verdict: z.enum(["approve", "revise"]),
  suggestions: z.array(z.string()).default([]),
});

async function critiquePlan(
  plan: Plan,
  budget: BudgetState,
  criticModel: string,
  fallbackModel: string,
  onUsage?: OnUsage,
): Promise<{ verdict: "approve" | "revise"; suggestions: string[]; model: string }> {
  // The critic is ideally a DIFFERENT vendor from the planner
  // (defaults.critic); fall back to the planner's model, then skip.
  let model = criticModel;
  let provider = providerForModel(model);
  if (!provider.available()) {
    model = fallbackModel;
    provider = providerForModel(model);
  }
  if (!provider.available()) {
    return { verdict: "approve", suggestions: [], model: "(critic skipped: no provider)" };
  }
  const resp = await provider.complete({
    model,
    maxTokens: 1024,
    temperature: 0.1,
    messages: [
      { role: "user", content: [{ type: "text", text: CRITIC_PROMPT_TEMPLATE(plan, budget) }] },
    ],
  });
  onUsage?.({
    phase: "critic",
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
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { verdict: "approve", suggestions: [], model };
  try {
    const parsed = CritiqueSchema.parse(JSON.parse(jsonMatch[0]));
    return { ...parsed, model };
  } catch {
    return { verdict: "approve", suggestions: [], model };
  }
}

/**
 * One retry with the failure fed back, then the planner_fallback model.
 * 28 Sept 2026: an eval run died in planning at $0 with nothing recorded;
 * a malformed or failed planner reply must not end the session.
 */
async function planResilient(goal: string, args: Parameters<typeof planOnce>[1]): Promise<Plan> {
  try {
    return await planOnce(goal, args);
  } catch (e1) {
    const note = `\n\nYOUR PREVIOUS REPLY COULD NOT BE USED (${(e1 as Error).message.slice(0, 300)}). Reply with ONLY the JSON plan object.`;
    try {
      return await planOnce(goal, { ...args, criticFeedback: `${args.criticFeedback}${note}` });
    } catch (e2) {
      const fb = loadModels().defaults.planner_fallback;
      if (fb && fb !== args.plannerModel && providerForModel(fb).available())
        return await planOnce(goal, { ...args, plannerModel: fb });
      throw e2;
    }
  }
}

export async function plan(
  goal: string,
  opts: {
    plannerModel?: string;
    pluginCatalogue?: string;
    budget: BudgetState;
    worldView?: string;
    lessons?: string;
    criticEnabled?: boolean;
    audit?: AuditEmitter;
    /** No human present: never emit pause_for_human steps. */
    unattended?: boolean;
    /** Called once per planner/critic call with its tokens and cost. */
    onUsage?: OnUsage;
  },
): Promise<Plan & { critique?: CritiqueResult }> {
  const cfg = loadModels();
  const plannerModel = opts.plannerModel ?? effectivePlanner();

  // Runtime availability: probe unverified catalog entries (cached), hide
  // whatever this key cannot reach, and say so on the audit trail.
  const { reachable, skipped } = await reachableModels(cfg.models);
  const hidden = new Set(skipped.map((s) => s.id));
  if (skipped.length) {
    opts.audit?.emit({
      action: "route_decision",
      target: { phase: "model_availability", reachable: reachable.length, hidden: skipped.length },
      provenance: { hidden: skipped },
    });
  }

  const planArgs = {
    plannerModel,
    pluginCatalogue: opts.pluginCatalogue ?? "  (none)",
    budget: opts.budget,
    worldView: opts.worldView ?? "",
    lessons: opts.lessons ?? "",
    criticFeedback: "",
    reachable,
    hidden,
    unattended: opts.unattended ?? false,
    onUsage: opts.onUsage,
  };

  let draft = await planResilient(goal, planArgs);
  if (opts.unattended) {
    // belt and braces: a pause step in an unattended plan is dropped here
    // (the executor would skip it anyway, on the record)
    draft = { ...draft, steps: draft.steps.filter((s) => !s.pause_for_human) };
  }

  if (!opts.criticEnabled) {
    return draft;
  }

  // Layer 3: critic pass — at most 1 revision
  opts.audit?.emit({
    action: "plan_ready",
    target: { phase: "draft", steps: draft.steps.length },
    provenance: {
      reasoning: draft.reasoning,
      estimated_cost_usd: draft.estimated_cost_usd,
    },
  });

  const critique = await critiquePlan(
    draft,
    opts.budget,
    cfg.defaults.critic ?? plannerModel,
    plannerModel,
    opts.onUsage,
  );
  opts.audit?.emit({
    action: "plan_ready",
    target: { phase: "critique", verdict: critique.verdict, model: critique.model },
    provenance: { suggestions: critique.suggestions },
  });

  if (critique.verdict === "approve") {
    return { ...draft, critique: { ...critique, revised: false } };
  }

  // Revise once with the critic feedback
  const revisedDraft = await planResilient(goal, {
    ...planArgs,
    criticFeedback: critique.suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n"),
  });
  return { ...revisedDraft, critique: { ...critique, revised: true } };
}

/**
 * Quick scope call — used when --budget=auto. Asks Haiku for a budget
 * proposal in dollars. Cheap (<$0.01).
 */
export async function scopeProposal(
  goal: string,
  bedrock_usd: number,
): Promise<{ proposed_usd: number; reasoning: string }> {
  const scopeModel = effectivePlanner();
  const provider = providerForModel(scopeModel);
  if (!provider.available()) {
    throw new Error(
      `scope proposal needs the ${provider.name} API key to be set (planner model ${scopeModel})`,
    );
  }
  const ScopeSchema = z.object({
    proposed_usd: z
      .number()
      .min(0.01)
      .max(bedrock_usd * 2), // we'll cap to bedrock anyway
    reasoning: z.string(),
  });

  const prompt = `Estimate the budget needed for this AI coding task. Return STRICT JSON: {"proposed_usd": <number>, "reasoning": "<one sentence>"}.

Reference points (typical patchwork-harness-shaped tasks):
  - Trivial (one classification, summary): $0.01-0.05
  - Small (write a short file, fix a typo): $0.05-0.20
  - Medium (build a small CLI, refactor 1-3 files): $0.50-2.00
  - Large (build a small app from scratch with tests): $2-8
  - Enterprise (multi-component, polished, with docs): $8-30

Bedrock (hard cap) is $${bedrock_usd.toFixed(2)}. Don't propose above that.

Goal:
${goal}

Return ONLY the JSON.`;

  const resp = await provider.complete({
    model: scopeModel,
    maxTokens: 256,
    temperature: 0.1,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });

  const text = resp.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("");
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`scope proposal produced no JSON: ${text.slice(0, 200)}`);
  return ScopeSchema.parse(JSON.parse(jsonMatch[0]));
}
