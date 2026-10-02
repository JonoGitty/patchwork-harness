import OpenAI from "openai";
import { loadModels } from "../config.js";
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

// Fallback per-million pricing for ids the catalog (config/models.yml)
// does not list (dated snapshots). Verified against
// developers.openai.com/api/docs/pricing on 7 Sept 2026 (gpt-6.1-sol on
// 2 Oct 2026).
const PRICING: Record<string, Price> = {
  "gpt-6-astra": { in: 10.0, out: 50.0 },
  "gpt-6.1-sol": { in: 2.0, out: 10.0 },
  "gpt-6-sol": { in: 2.0, out: 10.0 },
  "gpt-6-luna": { in: 0.1, out: 0.5 },
  "gpt-5.6-sol": { in: 4.0, out: 20.0 },
  "gpt-5.6-terra": { in: 2.0, out: 12.0 },
  "gpt-5.6-luna": { in: 0.2, out: 1.2 },
  "gpt-5.5-pro": { in: 30.0, out: 180.0 },
  "gpt-5.5": { in: 5.0, out: 30.0 },
  "gpt-5.4-pro": { in: 30.0, out: 180.0 },
  "gpt-5.4-mini": { in: 0.75, out: 4.5 },
  "gpt-5.4-nano": { in: 0.2, out: 1.25 },
  "gpt-5.4": { in: 2.5, out: 15.0 },
  "gpt-4.1-nano": { in: 0.1, out: 0.4 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
  "gpt-4.1": { in: 2.0, out: 8.0 },
  "o3-pro": { in: 20.0, out: 80.0 },
  "o4-mini": { in: 1.1, out: 4.4 },
};
// Requests over 272k input tokens bill at the long-context tier.
const LONG_CONTEXT_TOKENS = 272_000;
const LONG_CONTEXT: Record<string, Price> = {
  "gpt-6-astra": { in: 20.0, out: 75.0 },
  "gpt-6.1-sol": { in: 4.0, out: 15.0 },
  "gpt-6-sol": { in: 4.0, out: 15.0 },
  "gpt-6-luna": { in: 0.2, out: 0.75 },
  "gpt-5.6-sol": { in: 8.0, out: 30.0 },
  "gpt-5.6-terra": { in: 4.0, out: 18.0 },
  "gpt-5.6-luna": { in: 0.4, out: 1.8 },
  "gpt-5.5": { in: 10.0, out: 45.0 },
  "gpt-5.4-pro": { in: 60.0, out: 270.0 },
  "gpt-5.4": { in: 5.0, out: 22.5 },
};

export function openaiCost(model: string, tIn: number, tOut: number): number | undefined {
  let price = priceForModel(model, PRICING);
  if (tIn > LONG_CONTEXT_TOKENS) {
    const keys = Object.keys(LONG_CONTEXT).sort((a, b) => b.length - a.length);
    for (const k of keys)
      if (model.startsWith(k)) {
        price = LONG_CONTEXT[k]!;
        break;
      }
  }
  return price ? (tIn * price.in + tOut * price.out) / 1_000_000 : undefined;
}

/**
 * GPT-5.x and the o-series reasoning models reject `max_tokens` and require
 * `max_completion_tokens` instead. Older chat models (gpt-4*, gpt-3.5*)
 * still take the old name. Pick the right one by model id prefix.
 */
function tokenLimitParam(model: string, maxTokens: number | undefined): Record<string, number> {
  const limit = maxTokens ?? 4096;
  if (/^(gpt-5|gpt-6|o[3-9]|o\d{2,})/.test(model)) {
    return { max_completion_tokens: limit };
  }
  return { max_tokens: limit };
}

/**
 * The reasoning-era models reject any non-default `temperature` with a 400
 * ("Only the default (1) value is supported"). Measured 28 Sept 2026:
 * gpt-6-astra/sol/luna, gpt-5.6-*, gpt-5.5 and o4-mini reject 0.2;
 * gpt-5.4-mini and gpt-4.1 accept it. Until this guard, the planner's 0.2
 * and the critic's 0.1 made any OpenAI model fail in those roles.
 */
export function openaiSamplingAllowed(model: string): boolean {
  return !/^(gpt-6|gpt-5\.[5-9]|o\d)/.test(model);
}

/**
 * The -pro line (gpt-5.5-pro, gpt-5.4-pro, o3-pro …) is served ONLY by the
 * Responses API - chat completions answers 404 for them. The catalog can
 * say so (`api: responses`); otherwise the id shape decides.
 */
/**
 * These models reject function tools on chat completions ("Function tools
 * with reasoning_effort are not supported ... use /v1/responses"), measured
 * 28 Sept 2026 for gpt-6-astra/sol/luna and gpt-5.6-sol/luna; gpt-5.5,
 * gpt-5.4-mini and o4-mini still accept them. Until this, EVERY step the
 * planner routed to a GPT-6 model crashed on its first turn.
 */
export const TOOLS_NEED_RESPONSES = /^gpt-(6|5\.[6-9])/;

export function usesResponsesApi(model: string, hasTools = false): boolean {
  if (hasTools && TOOLS_NEED_RESPONSES.test(model)) return true;
  try {
    const cat = loadModels().models.find((m) => m.id === model || model.startsWith(`${m.id}-`));
    if (cat?.api) return cat.api === "responses";
  } catch {
    /* no catalog in this context */
  }
  return /-pro(-\d{4}-\d{2}-\d{2})?$/.test(model);
}

function toOpenAIMessages(
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
    if (m.role === "tool") {
      // Each tool_result becomes its own role:"tool" message.
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
    // user role
    const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    out.push({ role: "user", content: text });
  }
  return out;
}

function toOpenAITools(
  tools: ToolDef[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
  if (!tools) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function fromOpenAIFinish(reason: string | null): StopReason {
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

// ─── Responses API translation (pro models) ──────────────────────────────

function toResponsesInput(msgs: Message[]): any[] {
  const input: any[] = [];
  for (const m of msgs) {
    if (m.role === "system") {
      input.push({
        role: "developer",
        content: m.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
      });
      continue;
    }
    if (m.role === "tool") {
      for (const c of m.content) {
        if (c.type === "tool_result") {
          input.push({ type: "function_call_output", call_id: c.tool_use_id, output: c.content });
        }
      }
      continue;
    }
    if (m.role === "assistant") {
      const text = m.content
        .filter((c): c is Extract<ContentBlock, { type: "text" }> => c.type === "text")
        .map((c) => c.text)
        .join("");
      if (text) input.push({ role: "assistant", content: text });
      for (const c of m.content) {
        if (c.type === "tool_use") {
          input.push({
            type: "function_call",
            call_id: c.id,
            name: c.name,
            arguments: JSON.stringify(c.input ?? {}),
          });
        }
      }
      continue;
    }
    input.push({
      role: "user",
      content: m.content.map((c) => (c.type === "text" ? c.text : "")).join(""),
    });
  }
  return input;
}

function toResponsesTools(tools: ToolDef[] | undefined): any[] | undefined {
  if (!tools) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));
}

export function fromResponsesOutput(resp: any): {
  content: ContentBlock[];
  stop_reason: StopReason;
} {
  const content: ContentBlock[] = [];
  let sawTool = false;
  for (const item of resp?.output ?? []) {
    if (item?.type === "message") {
      const text = (item.content ?? [])
        .filter((c: any) => c?.type === "output_text")
        .map((c: any) => String(c.text ?? ""))
        .join("");
      if (text) content.push({ type: "text", text });
    } else if (item?.type === "function_call") {
      sawTool = true;
      let input: unknown;
      try {
        input = JSON.parse(item.arguments ?? "{}");
      } catch {
        input = item.arguments;
      }
      content.push({
        type: "tool_use",
        id: String(item.call_id ?? item.id),
        name: String(item.name),
        input,
      });
    }
  }
  const incomplete =
    resp?.status === "incomplete" && resp?.incomplete_details?.reason === "max_output_tokens";
  const stop_reason: StopReason = sawTool ? "tool_use" : incomplete ? "max_tokens" : "end_turn";
  return { content, stop_reason };
}

export class OpenAIProvider implements Provider {
  readonly name = "openai" as const;
  defaultModel = "gpt-6-astra";
  private client: OpenAI | null = null;

  available(): boolean {
    return !!process.env.OPENAI_API_KEY;
  }

  private getClient(): OpenAI {
    if (!this.available()) throw new ProviderUnavailableError("openai", "OPENAI_API_KEY not set");
    if (!this.client) this.client = new OpenAI();
    return this.client;
  }

  private async completeViaResponses(req: CompletionRequest): Promise<CompletionResponse> {
    const client = this.getClient();
    const t0 = performance.now();
    const params: Record<string, unknown> = {
      model: req.model,
      input: toResponsesInput(req.messages),
      max_output_tokens: Math.max(16, req.maxTokens ?? 4096),
    };
    const sys = systemText(req);
    if (sys) params.instructions = sys;
    const tools = toResponsesTools(req.tools);
    if (tools?.length) params.tools = tools;
    const resp: any = await (client as any).responses.create(params);
    const duration_ms = Math.round(performance.now() - t0);
    const { content, stop_reason } = fromResponsesOutput(resp);
    const tIn = Number(resp?.usage?.input_tokens ?? 0);
    const tOut = Number(resp?.usage?.output_tokens ?? 0);
    return {
      content,
      usage: { input_tokens: tIn, output_tokens: tOut },
      cost_usd: openaiCost(req.model, tIn, tOut),
      stop_reason,
      duration_ms,
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    if (usesResponsesApi(req.model, !!req.tools?.length)) return this.completeViaResponses(req);
    const client = this.getClient();
    const t0 = performance.now();

    const resp = await client.chat.completions.create({
      model: req.model,
      ...tokenLimitParam(req.model, req.maxTokens),
      ...(openaiSamplingAllowed(req.model) && req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      messages: toOpenAIMessages(systemText(req), req.messages),
      tools: toOpenAITools(req.tools),
    });

    const duration_ms = Math.round(performance.now() - t0);
    const choice = resp.choices[0];
    if (!choice) throw new Error("openai returned no choices");
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
    return {
      content,
      usage: { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens },
      cost_usd: openaiCost(req.model, usage.prompt_tokens, usage.completion_tokens),
      stop_reason: fromOpenAIFinish(choice.finish_reason),
      duration_ms,
    };
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    if (usesResponsesApi(req.model, !!req.tools?.length)) {
      throw new Error(
        "OpenAIProvider.stream() not implemented for Responses-API models — falling back to complete()",
      );
    }
    const client = this.getClient();
    const t0 = performance.now();

    const stream = await client.chat.completions.create({
      model: req.model,
      ...tokenLimitParam(req.model, req.maxTokens),
      ...(openaiSamplingAllowed(req.model) && req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      messages: toOpenAIMessages(systemText(req), req.messages),
      tools: toOpenAITools(req.tools),
      stream: true,
      stream_options: { include_usage: true },
    });

    // Tool calls in OpenAI streams arrive as deltas keyed by `index`;
    // accumulate into a map and emit start/delta/finalised events.
    const toolCallByIndex = new Map<number, { id: string; name: string; args: string }>();
    const startedTools = new Set<number>();
    let textBuf = "";
    let finishReason: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of stream) {
      if (chunk.usage) {
        promptTokens = chunk.usage.prompt_tokens;
        completionTokens = chunk.usage.completion_tokens;
      }
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta;

      if (delta?.content) {
        textBuf += delta.content;
        yield { type: "text_delta", text: delta.content };
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          let entry = toolCallByIndex.get(idx);
          if (!entry) {
            entry = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "" };
            toolCallByIndex.set(idx, entry);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.function?.name) entry.name = tc.function.name;
          if (tc.function?.arguments) entry.args += tc.function.arguments;

          // Emit start as soon as we have id+name (only once per index)
          if (entry.id && entry.name && !startedTools.has(idx)) {
            startedTools.add(idx);
            yield { type: "tool_use_start", id: entry.id, name: entry.name };
          }
          if (tc.function?.arguments && entry.id) {
            yield {
              type: "tool_use_input_delta",
              id: entry.id,
              partial_json: tc.function.arguments,
            };
          }
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const duration_ms = Math.round(performance.now() - t0);

    const content: ContentBlock[] = [];
    if (textBuf) content.push({ type: "text", text: textBuf });
    for (const tc of toolCallByIndex.values()) {
      let input: unknown;
      try {
        input = JSON.parse(tc.args);
      } catch {
        input = tc.args;
      }
      content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
    }

    yield { type: "usage", input_tokens: promptTokens, output_tokens: completionTokens };

    yield {
      type: "done",
      final: {
        content,
        usage: { input_tokens: promptTokens, output_tokens: completionTokens },
        cost_usd: openaiCost(req.model, promptTokens, completionTokens),
        stop_reason: fromOpenAIFinish(finishReason),
        duration_ms,
      },
    };
  }
}
