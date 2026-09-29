/**
 * xAI Grok provider — uses the OpenAI SDK against api.x.ai/v1, since
 * xAI exposes an OpenAI-compatible chat-completions endpoint.
 *
 * We import OpenAI directly here rather than reusing OpenAIProvider so
 * the cost table and default model belong to xAI's pricing.
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
  ToolDef,
} from "./base.js";
import { systemText } from "./base.js";
import { ProviderUnavailableError } from "./base.js";
import { type Price, priceForModel } from "./pricing.js";

// Fallback per-million pricing for ids the catalog does not list.
// Verified against docs.x.ai/docs/models on 7 Sept 2026 (sub-200k tier).
const PRICING: Record<string, Price> = {
  "grok-4.7": { in: 2.0, out: 6.0 },
  "grok-4.6": { in: 2.0, out: 6.0 },
  "grok-4.5": { in: 2.0, out: 6.0 },
  "grok-4.3": { in: 1.25, out: 2.5 },
  "grok-4.20": { in: 1.25, out: 2.5 },
  "grok-build-0.1": { in: 1.0, out: 2.0 },
};

function priceFor(model: string): Price | null {
  return priceForModel(model, PRICING);
}

function toMessages(
  system: string | undefined,
  msgs: Message[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (system) out.push({ role: "system", content: system });
  for (const m of msgs) {
    if (m.role === "tool") {
      for (const c of m.content) {
        if (c.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: c.tool_use_id, content: c.content });
        }
      }
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
        .map((c) => c.text)
        .join("");
      const toolUses = m.content.filter(
        (c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use",
      );
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: text || null,
      };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((t) => ({
          id: t.id,
          type: "function",
          function: { name: t.name, arguments: JSON.stringify(t.input) },
        }));
      }
      out.push(msg);
      continue;
    }
    if (m.role === "user") {
      const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
      out.push({ role: "user", content: text });
    }
  }
  return out;
}

function toTools(
  tools: ToolDef[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));
}

function fromFinish(reason: string | null): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return "stop";
  }
}

export class XAIProvider implements Provider {
  readonly name = "xai" as const;
  defaultModel = "grok-4.7";
  private client: OpenAI | null = null;

  available(): boolean {
    // GROK_API_KEY is the name the project .env has used since day one;
    // XAI_API_KEY is the one `patchwork-harness keys` knows. Accept both.
    return !!(process.env.XAI_API_KEY || process.env.GROK_API_KEY);
  }

  private getClient(): OpenAI {
    if (!this.available())
      throw new ProviderUnavailableError("xai", "XAI_API_KEY (or GROK_API_KEY) not set");
    if (!this.client) {
      this.client = new OpenAI({
        apiKey: (process.env.XAI_API_KEY ?? process.env.GROK_API_KEY)!,
        baseURL: "https://api.x.ai/v1",
      });
    }
    return this.client;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const client = this.getClient();
    const t0 = performance.now();

    const resp = await client.chat.completions.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature,
      messages: toMessages(systemText(req), req.messages),
      tools: toTools(req.tools),
    });

    const duration_ms = Math.round(performance.now() - t0);
    const choice = resp.choices[0];
    if (!choice) throw new Error("xai returned no choices");

    const content: ContentBlock[] = [];
    if (choice.message.content) content.push({ type: "text", text: choice.message.content });
    for (const tc of choice.message.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      let input: unknown;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = tc.function.arguments;
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
    }

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
    throw new Error("XAIProvider.stream() not implemented in M2 — falling back to complete()");
  }
}
