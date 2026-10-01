/**
 * Runtime model availability (7 Sept 2026).
 *
 * The catalog (config/models.yml) may list models the key cannot reach
 * yet - `availability: unverified` (gpt-6, gpt-6-pro, claude-mythos-5-1).
 * Rather than let the planner route to them and fail mid-run, this module
 *   1. probes each unverified model ONCE per session with a 1-token call,
 *      caching the answer on disk (~/.patchwork-harness/cache/model_availability.json)
 *      so repeated CLI invocations don't re-pay it; a 404 costs nothing,
 *   2. hides unreachable models from the planner/reviewer,
 *   3. hands the executor a same-tier fallback when a model turns out to
 *      be unreachable mid-run (a "does not exist or you do not have
 *      access" 404 is ambiguous - treated as unreachable-on-this-key, never
 *      as nonexistent).
 * The moment the key gains access, the next session's probe succeeds and
 * routing picks the model up with no code change.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ModelInfo, loadModelCapabilities, loadModels } from "../config.js";
import { CACHE_DIR } from "../util/paths.js";
import { getProvider } from "./registry.js";

/**
 * Reachability is a property of (model, KEY), not of the model: a different
 * key has different access, and a test placeholder key must never vouch
 * for the real one (a mocked provider under `npm test` once wrote
 * "gpt-6: reachable" into the real cache, 7 Sept 2026). Cache entries are
 * therefore keyed by a short hash of the provider's key material.
 */
const KEY_ENV: Record<string, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  xai: ["XAI_API_KEY", "GROK_API_KEY"],
  perplexity: ["PERPLEXITY_API_KEY"],
  local: ["PATCHWORK_HARNESS_LOCAL_URL", "OLLAMA_HOST"],
};

export function keyFingerprint(provider: string): string {
  const raw =
    (KEY_ENV[provider] ?? []).map((n) => process.env[n] ?? "").find((v) => v.length > 0) ?? "";
  if (!raw) return "nokey";
  return createHash("sha256").update(raw).digest("hex").slice(0, 10);
}

function cacheKey(m: Pick<ModelInfo, "id" | "provider">): string {
  return `${m.id}@${keyFingerprint(m.provider)}`;
}

export type Reach = "reachable" | "unreachable" | "unknown";

interface CacheEntry {
  status: Reach;
  checked_at: string;
  detail?: string;
}

const TTL_MS: Record<Reach, number> = {
  reachable: 6 * 60 * 60 * 1000,
  unreachable: 30 * 60 * 1000,
  unknown: 5 * 60 * 1000,
};
const PROBE_TIMEOUT_MS = 25_000;

const memo = new Map<string, Promise<Reach>>();
let disk: Record<string, CacheEntry> | null = null;

function cachePath(): string {
  return join(CACHE_DIR, "model_availability.json");
}

function loadDisk(): Record<string, CacheEntry> {
  if (disk) return disk;
  try {
    disk = existsSync(cachePath())
      ? (JSON.parse(readFileSync(cachePath(), "utf8")) as Record<string, CacheEntry>)
      : {};
  } catch {
    disk = {};
  }
  return disk;
}

function saveDisk(): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(loadDisk(), null, 2));
  } catch {
    /* cache is best-effort */
  }
}

/** Test seam: forget the in-memory state (the disk cache is re-read on the
 *  next call); `wipe` also deletes the disk cache file. */
export function resetAvailabilityCache(opts: { wipe?: boolean } = {}): void {
  memo.clear();
  disk = null;
  if (opts.wipe) {
    try {
      unlinkSync(cachePath());
    } catch {
      /* nothing to wipe */
    }
  }
}

/** "The model `x` does not exist or you do not have access to it" et al. */
export function isModelNotFoundError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number })?.status;
  if (status === 404) return true;
  return /does not exist|not[_ ]found|no such model|unknown model|is not supported for generateContent|Model not found|model:\s*\S+$/i.test(
    msg,
  );
}

/**
 * Errors that hit the whole ACCOUNT, not one model: no credit, quota
 * exhausted, bad or revoked key. Falling back to another model from the
 * same provider cannot help (29 Sept 2026: an empty Anthropic balance made
 * the executor try Opus 5.5, then Opus 5, on the same empty account).
 */
export function isAccountWideError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const status = (e as { status?: number })?.status;
  if (status === 401 || status === 403) return true;
  return /credit balance|billing|insufficient_quota|exceeded your current quota|invalid[_ ]?(x-)?api[_ -]?key|incorrect api key|api key (?:not valid|expired)/i.test(
    msg,
  );
}

function fresh(entry: CacheEntry | undefined): boolean {
  if (!entry) return false;
  const age = Date.now() - Date.parse(entry.checked_at);
  return Number.isFinite(age) && age >= 0 && age < TTL_MS[entry.status];
}

async function probe(m: ModelInfo): Promise<Reach> {
  const provider = getProvider(m.provider);
  if (!provider.available()) return "unreachable";
  const call = provider.complete({
    model: m.id,
    maxTokens: 1,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  });
  const timeout = new Promise<never>((_, rej) =>
    setTimeout(() => rej(new Error("probe timeout")), PROBE_TIMEOUT_MS).unref(),
  );
  try {
    await Promise.race([call, timeout]);
    return "reachable";
  } catch (e) {
    if (isModelNotFoundError(e)) return "unreachable";
    return "unknown"; // 401/429/credit/timeout: not proof either way; skip this session
  }
}

/**
 * Reachability of one catalog model. Verified models are trusted (their
 * provider key must merely be present); unverified ones are probed and
 * the result cached.
 */
export function modelReach(m: ModelInfo): Promise<Reach> {
  const provider = (() => {
    try {
      return getProvider(m.provider);
    } catch {
      return null;
    }
  })();
  if (!provider || !provider.available()) return Promise.resolve("unreachable");
  // Local models: the server answering is not the model being there
  // (see LocalProvider.installedModels). Unknown listing = trust as before.
  const installed = (
    provider as { installedModels?: () => Set<string> | null }
  ).installedModels?.();
  if (installed && !installed.has(m.id)) return Promise.resolve("unreachable");
  const key = cacheKey(m);
  const disk = loadDisk();
  const cached = disk[key];
  // A verified model that a mid-run 404 marked unreachable stays out until
  // the cache entry expires; otherwise verified == reachable, no probe.
  if (m.availability !== "unverified") {
    if (cached?.status === "unreachable" && fresh(cached)) return Promise.resolve("unreachable");
    return Promise.resolve("reachable");
  }
  // PATCHWORK_HARNESS_AVAILABILITY_PROBE=off: no network, no disk writes - unverified
  // models are simply hidden. Used by CI/offline runs and by the unit-test
  // suite (a mocked provider must never vouch for a real key).
  if (process.env.PATCHWORK_HARNESS_AVAILABILITY_PROBE === "off") return Promise.resolve("unreachable");
  if (fresh(cached)) return Promise.resolve(cached!.status);
  let p = memo.get(key);
  if (!p) {
    p = probe(m).then((status) => {
      loadDisk()[key] = { status, checked_at: new Date().toISOString() };
      saveDisk();
      return status;
    });
    memo.set(key, p);
  }
  return p;
}

/** Record a mid-run discovery so the rest of this session (and the next
 *  30 minutes of sessions) route around the model. */
export function markUnreachable(modelId: string, detail: string): void {
  let provider: ModelInfo["provider"] | "" = "";
  try {
    provider = loadModels().models.find((m) => m.id === modelId)?.provider ?? "";
  } catch {
    /* no catalog */
  }
  const key = cacheKey({ id: modelId, provider: provider as ModelInfo["provider"] });
  loadDisk()[key] = {
    status: "unreachable",
    checked_at: new Date().toISOString(),
    detail: detail.slice(0, 200),
  };
  memo.set(key, Promise.resolve("unreachable"));
  saveDisk();
}

export interface ReachableCatalog {
  reachable: ModelInfo[];
  skipped: Array<{ id: string; status: Reach }>;
}

/** The catalog filtered to what this key can use right now. */
export async function reachableModels(
  models: ModelInfo[] = loadModels().models,
): Promise<ReachableCatalog> {
  const statuses = await Promise.all(models.map((m) => modelReach(m)));
  const reachable: ModelInfo[] = [];
  const skipped: ReachableCatalog["skipped"] = [];
  models.forEach((m, i) => {
    const s = statuses[i] ?? "unknown";
    if (s === "reachable") reachable.push(m);
    else skipped.push({ id: m.id, status: s });
  });
  return { reachable, skipped };
}

/**
 * Walk an ordered preference list and return the first reachable model
 * per provider, up to `max`. Ids missing from the catalog are ignored.
 */
export async function pickReachable(
  ids: string[],
  opts: { max?: number; distinctProviders?: boolean } = {},
): Promise<ModelInfo[]> {
  const max = opts.max ?? 3;
  const distinct = opts.distinctProviders ?? true;
  const catalog = loadModels().models;
  const picked: ModelInfo[] = [];
  const seenProviders = new Set<string>();
  for (const id of ids) {
    if (picked.length >= max) break;
    const m = catalog.find((c) => c.id === id);
    if (!m) continue;
    if (distinct && seenProviders.has(m.provider)) continue;
    if ((await modelReach(m)) !== "reachable") continue;
    picked.push(m);
    seenProviders.add(m.provider);
  }
  return picked;
}

/**
 * Same-tier replacement for a model that just proved unreachable. Same
 * provider first (keeps the plan's vendor mix), then any other available
 * provider. Only reachable, non-excluded catalog models qualify; when the
 * capability corpus has no tier for the model, the catalog's executor
 * default is the last resort.
 */
export async function fallbackModelFor(
  modelId: string,
  exclude: Iterable<string> = [],
): Promise<ModelInfo | null> {
  const excluded = new Set([modelId, ...exclude]);
  const models = loadModels();
  const tierOf = new Map<string, string>();
  try {
    for (const c of loadModelCapabilities().models) tierOf.set(c.id, c.tier);
  } catch {
    /* corpus optional */
  }
  const original = models.models.find((m) => m.id === modelId);
  const tier = tierOf.get(modelId);
  const sameTier = models.models.filter(
    (m) => !excluded.has(m.id) && tier !== undefined && tierOf.get(m.id) === tier,
  );
  const ordered = [
    ...sameTier.filter((m) => m.provider === original?.provider),
    ...sameTier.filter((m) => m.provider !== original?.provider),
  ];
  for (const m of ordered) if ((await modelReach(m)) === "reachable") return m;
  const def = models.models.find((m) => m.id === models.defaults.executor && !excluded.has(m.id));
  if (def && (await modelReach(def)) === "reachable") return def;
  // Nearest tier next. A tier held by one vendor (workhorse = Sonnet only)
  // left every step routed to it with NO fallback when that vendor's account
  // was out: the step failed although other vendors were up (29 Sept 2026,
  // Anthropic out of credit, found by the ADR-0018 eval).
  for (const t of NEAREST_TIERS[tier ?? ""] ?? NEAREST_TIERS.default!) {
    for (const m of models.models) {
      if (excluded.has(m.id) || tierOf.get(m.id) !== t) continue;
      if ((await modelReach(m)) === "reachable") return m;
    }
  }
  return null;
}

/** Where a step goes when its own tier has nothing reachable: closest capability first. */
const NEAREST_TIERS: Record<string, string[]> = {
  workhorse: ["flagship", "flagship_alt", "cheap_fast"],
  flagship: ["workhorse", "flagship_alt", "reasoning"],
  flagship_alt: ["flagship", "workhorse"],
  cheap_fast: ["workhorse", "flagship"],
  reasoning: ["flagship", "flagship_alt"],
  default: ["flagship", "workhorse", "flagship_alt", "cheap_fast"],
};
