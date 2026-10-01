/**
 * System One client — ADR-0013. One wire format, two backends:
 *
 *   Jev — TypeSafe's hosted decision model. POST
 *         https://api.typesafe.ai/v1/systemone, Bearer TYPESAFE_API_KEY.
 *   Kev — the open, local model that serves the same API
 *         (`python -m kev.serve --port 8009`). Point PATCHWORK_HARNESS_CLASSIFIER_URL
 *         at it; PATCHWORK_HARNESS_CLASSIFIER_KEY only if the server wants a bearer.
 *
 * A decision model returns calibrated probabilities over fixed options,
 * not text. That makes it a ROUTER, never a verifier: nothing in this
 * module is allowed to produce a VERIFIED. See src/verifier/triage.ts.
 */

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type Answer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      probabilities: Record<string, number>;
      confidence: number;
    }
  | {
      type: "score";
      score: number;
      legend: Record<string, string>;
      probabilities: Record<string, number>;
      confidence: number;
    };

export interface SystemOneResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
  latency_ms?: number;
}

export interface ClassifierConfig {
  /**
   * jev: TypeSafe's hosted model. kev: jaredpalmer/kev served locally.
   * jeff: firelex/jeff served locally (`jeff-serve`): Jev-compatible, with
   * LoRA adapters chosen per request by model name (ADR-0013, 1 Oct 2026).
   */
  backend: "jev" | "kev" | "jeff";
  url: string; // base, without /v1/systemone
  model: string;
  apiKey?: string;
}

export const JEV_URL = "https://api.typesafe.ai";

/**
 * PATCHWORK_HARNESS_CLASSIFIER_URL wins (a local Kev, or any System One server);
 * otherwise TYPESAFE_API_KEY selects hosted Jev; otherwise none.
 */
export function classifierConfig(env: NodeJS.ProcessEnv = process.env): ClassifierConfig | null {
  const clean = (u: string) => u.replace(/\/+$/, "").replace(/\/v1\/systemone$/, "");
  const url = env.PATCHWORK_HARNESS_CLASSIFIER_URL?.trim();
  if (url) {
    const backend = env.PATCHWORK_HARNESS_CLASSIFIER_BACKEND?.trim() === "jeff" ? "jeff" : "kev";
    return {
      backend,
      url: clean(url),
      model:
        env.PATCHWORK_HARNESS_CLASSIFIER_MODEL?.trim() || (backend === "jeff" ? "jeff-latest" : "kev-latest"),
      apiKey: env.PATCHWORK_HARNESS_CLASSIFIER_KEY?.trim() || undefined,
    };
  }
  const jeff = env.PATCHWORK_HARNESS_JEFF_URL?.trim();
  if (jeff) {
    return {
      backend: "jeff",
      url: clean(jeff),
      model: env.PATCHWORK_HARNESS_CLASSIFIER_MODEL?.trim() || "jeff-latest",
      apiKey: env.PATCHWORK_HARNESS_JEFF_KEY?.trim() || undefined,
    };
  }
  const key = env.TYPESAFE_API_KEY?.trim();
  if (key) {
    return {
      backend: "jev",
      url: JEV_URL,
      model: env.PATCHWORK_HARNESS_CLASSIFIER_MODEL?.trim() || "jev-latest",
      apiKey: key,
    };
  }
  return null;
}

export class ClassifierError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ClassifierError";
  }
}

export interface AskOptions {
  /** Per-call model: a Jeff adapter ("guard", "ground", ...) or the base. Default: cfg.model. */
  model?: string;
  /** Jeff: 2 answers twice with the options reversed and averages (removes position bias; 2x cost). */
  orders?: 1 | 2;
  timeoutMs?: number;
  /** extra attempts on 429/529 (TypeSafe's documented back-off codes) */
  retries?: number;
  backoffMs?: number;
  fetchImpl?: typeof fetch;
}

const isProb = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/** Reject any reply that doesn't answer every question with a well-formed probability. */
function checkReply(body: unknown, questions: Record<string, Question>): SystemOneResponse {
  const r = body as SystemOneResponse;
  if (!r || typeof r !== "object" || !r.answers || typeof r.answers !== "object")
    throw new ClassifierError("malformed reply: no answers object");
  for (const [id, q] of Object.entries(questions)) {
    const a = r.answers[id];
    if (!a) throw new ClassifierError(`malformed reply: question '${id}' unanswered`);
    if (a.type !== q.type)
      throw new ClassifierError(`malformed reply: '${id}' answered as ${a.type}, asked ${q.type}`);
    if (a.type === "noul" && !isProb(a.noul))
      throw new ClassifierError(`malformed reply: '${id}' noul is not a probability`);
    if (a.type !== "noul" && !Object.values(a.probabilities ?? {}).every(isProb))
      throw new ClassifierError(`malformed reply: '${id}' has an invalid probability`);
  }
  return r;
}

/**
 * A local model server (Jeff, Kev) runs one decision at a time: Jeff answers
 * a second, overlapping request with 529 "The model is busy" (Retry-After: 1)
 * instead of queueing it. So calls from this process to the same local URL
 * go through one queue; only other processes can still collide, and those
 * collisions are retried on the server's Retry-After (1 Oct 2026: an eval at
 * parallel 2 lost 100 of 287 decisions to 529s before this).
 */
const localQueues = new Map<string, Promise<unknown>>();
function queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = localQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  localQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** Seconds from a Retry-After header, capped; undefined when absent or not a number. */
export function retryAfterMs(res: Response, capMs = 5_000): number | undefined {
  const v = res.headers?.get?.("retry-after");
  if (!v) return undefined;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, capMs) : undefined;
}

export async function askSystemOne(
  cfg: ClassifierConfig,
  state: unknown,
  questions: Record<string, Question>,
  opts: AskOptions = {},
): Promise<SystemOneResponse> {
  if (cfg.backend === "jev") return askOnce(cfg, state, questions, opts);
  return queued(cfg.url, () => askOnce(cfg, state, questions, opts));
}

async function askOnce(
  cfg: ClassifierConfig,
  state: unknown,
  questions: Record<string, Question>,
  opts: AskOptions,
): Promise<SystemOneResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 250;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  // `orders` only when asked for: Jev and Kev may reject a field they don't know
  const body = JSON.stringify({
    state,
    model: opts.model ?? cfg.model,
    questions,
    ...(opts.orders === 2 ? { orders: 2 } : {}),
  });

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(`${cfg.url}/v1/systemone`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw new ClassifierError(
        `${cfg.backend} unreachable at ${cfg.url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      // the server's own hint wins over our back-off (Jeff sends Retry-After: 1)
      const wait = Math.max(backoff * 2 ** attempt, retryAfterMs(res) ?? 0);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new ClassifierError(
        `${cfg.backend} HTTP ${res.status}: ${text.slice(0, 200)}`,
        res.status,
      );
    }
    return checkReply(await res.json(), questions);
  }
}
