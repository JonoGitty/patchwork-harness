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
  backend: "jev" | "kev";
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
  const url = env.PATCHWORK_HARNESS_CLASSIFIER_URL?.trim();
  if (url) {
    return {
      backend: "kev",
      url: url.replace(/\/+$/, "").replace(/\/v1\/systemone$/, ""),
      model: env.PATCHWORK_HARNESS_CLASSIFIER_MODEL?.trim() || "kev-latest",
      apiKey: env.PATCHWORK_HARNESS_CLASSIFIER_KEY?.trim() || undefined,
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

export async function askSystemOne(
  cfg: ClassifierConfig,
  state: unknown,
  questions: Record<string, Question>,
  opts: AskOptions = {},
): Promise<SystemOneResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 250;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
  const body = JSON.stringify({ state, model: cfg.model, questions });

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
      await new Promise((r) => setTimeout(r, backoff * 2 ** attempt));
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
