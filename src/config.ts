/**
 * Config loading. Reads the bundled defaults from /config and overlays
 * user overrides at ~/.patchwork-harness/<file> when present.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { load as yamlLoad } from "js-yaml";
import { z } from "zod";
import { CONFIG_DIR, HOME_HARNESS } from "./util/paths.js";

/**
 * A price is a number per million tokens, or the literal `unknown` when
 * the vendor has published none (never a guess - 7 Sept 2026 rule).
 * `unknown` parses to null; cost tracking then records no spend for that
 * model and the planner is told the price is unknown.
 */
const Price = z
  .union([z.number(), z.literal("unknown")])
  .transform((v): number | null => (v === "unknown" ? null : v));

const ModelInfo = z.object({
  id: z.string(),
  provider: z.enum(["anthropic", "openai", "gemini", "xai", "perplexity", "local"]),
  context_window: z.number(),
  cost_per_m_in: Price,
  cost_per_m_out: Price,
  strengths: z.array(z.string()).default([]),
  /**
   * `verified` = a real call on this key succeeded on `verified_on`.
   * `unverified` = catalogued from announcements only; the runtime probe
   * (src/providers/availability.ts) checks it each session and the planner
   * routes to it automatically the moment the key gains access.
   */
  availability: z.enum(["verified", "unverified"]).default("verified"),
  verified_on: z.string().optional(),
  /** OpenAI only: models served solely by the Responses API (the -pro line). */
  api: z.enum(["chat", "responses"]).optional(),
  notes: z.string().optional(),
});

const RoleList = z.union([z.string(), z.array(z.string())]);

const ModelsConfig = z.object({
  models: z.array(ModelInfo),
  defaults: z.object({
    planner: z.string(),
    planner_fallback: z.string().optional(),
    executor: z.string(),
    bulk_executor: z.string().optional(),
    critic: z.string().optional(),
    /** Ordered preference list; `patchwork-harness review` takes the first reachable
     *  model per provider. Unverified ids may lead - they are skipped
     *  silently until the key can reach them. */
    security_reviewer: RoleList.optional(),
    /** L5 reviewer (ADR-0016): ordered list; the first reachable model from a
     *  DIFFERENT vendor than the executor's reviews the finished work. */
    reviewer: RoleList.optional(),
    /** ADR-0018: the LLM asked by `--lane auto` when the custom intent head is unsure. */
    intent_router: z.string().optional(),
  }),
});
export type ModelsConfig = z.infer<typeof ModelsConfig>;
export type ModelInfo = z.infer<typeof ModelInfo>;

/** Normalise a role that may be a single id or an ordered list. */
export function roleList(v: string | string[] | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

const ModelCapability = z.object({
  id: z.string(),
  tier: z.string(),
  speed: z.string(),
  relative_cost: z.string(),
  best_for: z.array(z.string()).default([]),
  avoid_for: z.array(z.string()).default([]),
  quirks: z.array(z.string()).default([]),
  typical_cost_per_step_usd: z.number().default(0.01),
  last_reviewed: z.string().optional(),
});

const CorpusMetadata = z.object({
  last_reviewed: z.string(),
  next_review_due: z.string().optional(),
  review_policy: z.string().optional(),
});
export type CorpusMetadata = z.infer<typeof CorpusMetadata>;

const DomainRouting = z.object({
  /** Tier the planner should match against (preferred over named picks). */
  preferred_tier: z.string().optional(),
  /** Current best-in-tier shortlist (frozen at corpus_metadata.last_reviewed). */
  preferred_models: z.array(z.string()).optional(),
  /** Old name retained for backwards compat; treated as preferred_models. */
  preferred: z.array(z.string()).optional(),
  cheap_fallback: z.array(z.string()).default([]),
  why: z.string(),
});
export type DomainRouting = z.infer<typeof DomainRouting>;

const ModelCapabilitiesConfig = z.object({
  corpus_metadata: CorpusMetadata.optional(),
  models: z.array(ModelCapability),
  domain_routing: z.record(z.string(), DomainRouting).default({}),
  routing_heuristics: z.array(z.string()).default([]),
  anti_patterns: z.array(z.string()).default([]),
});
export type ModelCapabilitiesConfig = z.infer<typeof ModelCapabilitiesConfig>;
export type ModelCapability = z.infer<typeof ModelCapability>;

const PolicyConfig = z.object({
  version: z.literal(1),
  mode: z.enum(["fail-closed", "fail-open"]).default("fail-closed"),
  bash_allowlist: z.array(z.string()).default([]),
  bash_denylist: z.array(z.string()).default([]),
  sensitive_paths: z.array(z.string()).default([]),
  prompt_for: z.object({
    push: z.boolean().default(true),
    pr: z.boolean().default(true),
    bash_off_allowlist: z.boolean().default(true),
    write_outside_cwd: z.boolean().default(true),
  }),
  max_budget_usd: z.number().default(1.0),
});
export type PolicyConfig = z.infer<typeof PolicyConfig>;

function loadYamlMaybe<S extends z.ZodTypeAny>(path: string, schema: S): z.infer<S> | null {
  if (!existsSync(path)) return null;
  const raw = yamlLoad(readFileSync(path, "utf8"));
  return schema.parse(raw);
}

function loadYaml<S extends z.ZodTypeAny>(path: string, schema: S): z.infer<S> {
  const raw = yamlLoad(readFileSync(path, "utf8"));
  return schema.parse(raw);
}

export function loadModels(): ModelsConfig {
  const userPath = join(HOME_HARNESS, "models.yml");
  const user = loadYamlMaybe(userPath, ModelsConfig);
  if (user) return user;
  return loadYaml(join(CONFIG_DIR, "models.yml"), ModelsConfig);
}

export function loadPolicy(): PolicyConfig {
  const userPath = join(HOME_HARNESS, "policy.yml");
  const user = loadYamlMaybe(userPath, PolicyConfig);
  if (user) return user;
  return loadYaml(join(CONFIG_DIR, "policy.yml"), PolicyConfig);
}

export function loadModelCapabilities(): ModelCapabilitiesConfig {
  const userPath = join(HOME_HARNESS, "model_capabilities.yml");
  const user = loadYamlMaybe(userPath, ModelCapabilitiesConfig);
  if (user) return user;
  return loadYaml(join(CONFIG_DIR, "model_capabilities.yml"), ModelCapabilitiesConfig);
}
