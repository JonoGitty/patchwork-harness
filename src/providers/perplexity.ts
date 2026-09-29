/**
 * Perplexity Sonar provider — uses the OpenAI SDK against
 * api.perplexity.ai, which exposes an OpenAI-compatible chat-completions
 * endpoint.
 *
 * RESEARCH-ONLY. Sonar models are live-web search-answer models: they
 * return grounded answers plus citations, but they do NOT do reliable
 * function/tool calling. So this provider is for "go find out X from
 * current sources" steps and `patchwork-harness ask`, NEVER as a coding executor.
 * We deliberately omit tools from the request and instead surface the
 * returned citations as a Sources list appended to the answer text.
 */

import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamChunk,
} from "./base.js";
import { systemText } from "./base.js";
import { ProviderUnavailableError } from "./base.js";

// Per-million-token pricing (paid tier, 2026). NOTE: Sonar also bills a
// per-request search fee ($5-$14 per 1000 requests) and Deep Research adds
// citation/reasoning-token costs — none of which are captured by this
// token-only model, so real spend runs somewhat higher than estimated.
const PRICING: Record<string, { in: number; out: number }> = {
  "sonar-deep-research": { in: 2.0, out: 8.0 },
  "sonar-reasoning-pro": { in: 2.0, out: 8.0 },
  "sonar-pro": { in: 3.0, out: 15.0 },
  sonar: { in: 1.0, out: 1.0 },
};

function priceFor(model: string): { in: number; out: number } | null {
  for (const [k, v] of Object.entries(PRICING)) if (model.startsWith(k)) return v;
  return null;
}

function toMessages(
  system: string | undefined,
  msgs: Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of msgs) {
    if (m.role === "system") {
      const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      out.push({ role: "system", content: text });
      continue;
    }
    // Sonar has no tool loop; fold any tool_result back in as user context
    // so a research follow-up still sees what a prior step found.
    if (m.role === "tool") {
      const text = m.content.map((c) => (c.type === "tool_result" ? c.content : "")).join("\n");
      if (text) out.push({ role: "user", content: text });
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
        .map((c) => c.text)
        .join("");
      out.push({ role: "assistant", content: text || "" });
      continue;
    }
    // user role
    const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    out.push({ role: "user", content: text });
  }
  return out;
}

function fromFinish(reason: string | null): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return "stop";
  }
}

/** Sonar returns sources in a top-level `citations` (or `search_results`)
 *  field outside the OpenAI schema. Render them as a Sources list so the
 *  research answer is actually verifiable. */
function citationsBlock(resp: unknown): string {
  const r = resp as {
    citations?: unknown;
    search_results?: Array<{ title?: string; url?: string }>;
  };
  if (Array.isArray(r.search_results) && r.search_results.length) {
    const lines = r.search_results
      .map((s, i) => `  [${i + 1}] ${s.title ?? s.url ?? ""}${s.url ? ` — ${s.url}` : ""}`)
      .join("\n");
    return `\n\nSources:\n${lines}`;
  }
  if (Array.isArray(r.citations) && r.citations.length) {
    const lines = (r.citations as string[]).map((u, i) => `  [${i + 1}] ${u}`).join("\n");
    return `\n\nSources:\n${lines}`;
  }
  return "";
}

export class PerplexityProvider implements Provider {
  readonly name = "perplexity" as const;
  defaultModel = "sonar-pro";
  private client: OpenAI | null = null;

  available(): boolean {
    return !!process.env.PERPLEXITY_API_KEY;
  }

  private getClient(): OpenAI {
    if (!this.available()) {
      throw new ProviderUnavailableError("perplexity", "PERPLEXITY_API_KEY not set");
    }
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: process.env.PERPLEXITY_API_KEY!,
        baseURL: "https://api.perplexity.ai",
      });
    }
    return this.client;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const client = this.getClient();
    const t0 = performance.now();

    // No `tools` — Sonar is research-only.
    const resp = await client.chat.completions.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature,
      messages: toMessages(systemText(req), req.messages),
    });

    const duration_ms = Math.round(performance.now() - t0);
    const choice = resp.choices[0];
    if (!choice) throw new Error("perplexity returned no choices");

    const content: ContentBlock[] = [];
    const text = (choice.message.content ?? "") + citationsBlock(resp);
    if (text.trim()) content.push({ type: "text", text });

    const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
    const price = priceFor(req.model);
    const cost_usd = price
      ? (usage.prompt_tokens * price.in + usage.completion_tokens * price.out) / 1_000_000
      : undefined;

    return {
      content,
      usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
      cost_usd,
      stop_reason: fromFinish(choice.finish_reason),
      duration_ms,
    };
  }

  // eslint-disable-next-line require-yield
  async *stream(_req: CompletionRequest): AsyncIterable<StreamChunk> {
    throw new Error("PerplexityProvider.stream() not implemented — falling back to complete()");
  }
}
