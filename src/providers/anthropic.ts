import Anthropic from "@anthropic-ai/sdk";
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
import { ProviderUnavailableError } from "./base.js";
import { type Price, priceForModel } from "./pricing.js";

/**
 * Fallback per-million pricing for ids the catalog (config/models.yml)
 * does not list (dated snapshots). Verified against
 * platform.claude.com/docs/en/about-claude/pricing on 7 Sept 2026 - the
 * Opus line has been $5/$25 since 4.5, not the $15/$75 the old table said.
 */
const PRICING: Record<string, Price> = {
  "claude-fable-5-1": { in: 10.0, out: 50.0 },
  "claude-fable-5": { in: 10.0, out: 50.0 },
  "claude-mythos-5-1": { in: 10.0, out: 50.0 },
  "claude-opus-5-5": { in: 4.0, out: 20.0 },
  "claude-opus-5": { in: 5.0, out: 25.0 },
  "claude-opus-4": { in: 5.0, out: 25.0 }, // 4.5 - 4.8
  "claude-sonnet-5-5": { in: 2.0, out: 10.0 },
  "claude-sonnet-5": { in: 2.0, out: 10.0 },
  "claude-sonnet-4": { in: 3.0, out: 15.0 },
  "claude-haiku-4-5": { in: 1.0, out: 5.0 },
};

function priceFor(model: string): Price | null {
  return priceForModel(model, PRICING);
}

/** Cache-hit price as a share of base input (vendor pricing page, 28 Sept 2026). */
export function cacheReadMultiplier(model: string): number {
  if (/^claude-(fable|mythos)-5-1/.test(model)) return 0.025;
  if (/^claude-opus-5-5/.test(model)) return 0.05;
  return 0.1;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Anthropic's `input_tokens` EXCLUDES cache writes and reads. Pricing it
 * alone left every cached token off the ledger - the bedrock never saw most
 * of the input spend (measured 28 Sept 2026: 78 counted, 4,292 written).
 * Writes bill at 1.25x (5-minute cache), reads at the model's multiplier.
 */
export function anthropicCost(model: string, u: AnthropicUsage): number | undefined {
  const p = priceFor(model);
  if (!p) return undefined;
  const write = u.cache_creation_input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  return (
    (u.input_tokens * p.in +
      write * p.in * 1.25 +
      read * p.in * cacheReadMultiplier(model) +
      u.output_tokens * p.out) /
    1_000_000
  );
}

/** All input the model saw (uncached + written + read), for honest token stats. */
export function totalInput(u: AnthropicUsage): number {
  return u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
}

/** Stable prompt cached; per-turn text (systemDynamic) after the breakpoint. */
function systemBlocks(req: CompletionRequest): Anthropic.Messages.MessageCreateParams["system"] {
  const blocks: Anthropic.Messages.TextBlockParam[] = [];
  if (req.system)
    blocks.push({ type: "text", text: req.system, cache_control: { type: "ephemeral" } });
  if (req.systemDynamic) blocks.push({ type: "text", text: req.systemDynamic });
  return blocks.length ? blocks : undefined;
}

/**
 * Second breakpoint on the newest message, so each turn of a tool loop
 * reads the previous turns from cache instead of re-sending them at full
 * price. Only on blocks that accept cache_control (not thinking).
 */
export function withConversationCache(
  msgs: Anthropic.Messages.MessageParam[],
): Anthropic.Messages.MessageParam[] {
  const last = msgs[msgs.length - 1];
  if (!last || typeof last.content === "string" || last.content.length === 0) return msgs;
  const blocks = [...last.content];
  const tail = blocks[blocks.length - 1] as { type: string };
  if (!["text", "tool_result", "tool_use"].includes(tail.type)) return msgs;
  blocks[blocks.length - 1] = {
    ...(tail as Anthropic.Messages.ContentBlockParam),
    cache_control: { type: "ephemeral" },
  } as Anthropic.Messages.ContentBlockParam;
  return [...msgs.slice(0, -1), { ...last, content: blocks }];
}

export function toAnthropicMessages(msgs: Message[]): Anthropic.Messages.MessageParam[] {
  // Anthropic doesn't take a "tool" role — tool results go inside a user
  // message as a tool_result block. Same for tool_use which lives inside
  // an assistant message. Our common shape matches Anthropic's content
  // blocks closely so this is mostly a passthrough - except thinking
  // blocks, which ride on `provider_block` and go back VERBATIM (the API
  // binds them to the producing model and, on Fable 5.1, rejects edited
  // history). Empty text blocks are dropped: the API rejects them.
  return msgs
    .filter((m) => m.role !== "system")
    .map((m): Anthropic.Messages.MessageParam => {
      const role = m.role === "tool" ? "user" : (m.role as "user" | "assistant");
      const content: Anthropic.Messages.ContentBlockParam[] = [];
      for (const c of m.content) {
        if (c.type === "text") {
          if (c.provider_block)
            content.push(c.provider_block as Anthropic.Messages.ContentBlockParam);
          else if (c.text.length > 0) content.push({ type: "text", text: c.text });
        } else if (c.type === "tool_use") {
          content.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
        } else {
          content.push({
            type: "tool_result",
            tool_use_id: c.tool_use_id,
            content: c.content,
            is_error: c.is_error,
          });
        }
      }
      return { role, content };
    });
}

/**
 * Response blocks → our shape. Text and tool_use pass through; `thinking` /
 * `redacted_thinking` (on by default on Opus 5 / Fable, display "omitted"
 * so the text is empty but the signature is not) become empty-text blocks
 * carrying the raw block, so they are never shown as prose and are echoed
 * back unchanged. Before 7 Sept 2026 they were JSON.stringify'd INTO the
 * answer text - a 20k-char signature blob led every Opus 5 / Fable reply.
 */
export function fromAnthropicContent(
  blocks: Array<{ type: string } & Record<string, unknown>>,
): ContentBlock[] {
  return blocks.map((c): ContentBlock => {
    if (c.type === "text") return { type: "text", text: String(c.text ?? "") };
    if (c.type === "tool_use")
      return { type: "tool_use", id: String(c.id), name: String(c.name), input: c.input };
    if (c.type === "thinking" || c.type === "redacted_thinking") {
      return { type: "text", text: "", provider_block: c };
    }
    // anything else (compaction, fallback markers …): keep it round-trippable, not readable
    return { type: "text", text: "", provider_block: c };
  });
}

/**
 * `temperature` / `top_p` / `top_k` were removed on the 4.7+ / 5 family
 * (400 if sent); older models still accept them.
 */
export function samplingAllowed(model: string): boolean {
  return !/^claude-(fable|mythos|opus-5|sonnet-5|opus-4-[78])/.test(model);
}

function toAnthropicTools(tools: ToolDef[] | undefined): Anthropic.Messages.Tool[] | undefined {
  if (!tools) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // Anthropic requires a top-level `type: "object"`; a tool whose zod
    // input is a discriminated union (context_write) converts to a bare
    // {anyOf:[...]} and was rejected with "input_schema.type: Input should
    // be 'object'" (2 Sept 2026) - wrap without changing the shape
    input_schema: (() => {
      const js = (t.inputSchema ?? {}) as Record<string, unknown>;
      return (
        js.type === undefined ? { type: "object", ...js } : js
      ) as Anthropic.Messages.Tool["input_schema"];
    })(),
  }));
}

function fromAnthropicStop(s: Anthropic.Messages.Message["stop_reason"]): StopReason {
  switch (s) {
    case "tool_use":
      return "tool_use";
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    default:
      return "stop";
  }
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic" as const;
  defaultModel = "claude-opus-5-5";
  private client: Anthropic | null = null;

  available(): boolean {
    return !!process.env.ANTHROPIC_API_KEY;
  }

  private getClient(): Anthropic {
    if (!this.available())
      throw new ProviderUnavailableError("anthropic", "ANTHROPIC_API_KEY not set");
    if (!this.client) this.client = new Anthropic();
    return this.client;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const client = this.getClient();
    const t0 = performance.now();

    const sys = systemBlocks(req);

    const resp = await client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      ...(samplingAllowed(req.model) && req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      system: sys,
      messages: withConversationCache(toAnthropicMessages(req.messages)),
      tools: toAnthropicTools(req.tools),
    });

    const duration_ms = Math.round(performance.now() - t0);

    const content: ContentBlock[] = fromAnthropicContent(
      resp.content as unknown as Array<{ type: string } & Record<string, unknown>>,
    );

    const usage = resp.usage;
    const cost_usd = anthropicCost(req.model, usage);

    return {
      content,
      usage: {
        input_tokens: totalInput(usage),
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_input_tokens ?? 0,
        cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
      },
      cost_usd,
      stop_reason: fromAnthropicStop(resp.stop_reason),
      duration_ms,
    };
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const client = this.getClient();
    const t0 = performance.now();

    const sys = systemBlocks(req);

    const stream = client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      ...(samplingAllowed(req.model) && req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
      system: sys,
      messages: withConversationCache(toAnthropicMessages(req.messages)),
      tools: toAnthropicTools(req.tools),
    });

    // Track tool_use blocks by content-block index so input_json deltas
    // can be tagged with the correct id.
    const toolBlocks = new Map<number, { id: string; name: string }>();

    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        const block = ev.content_block;
        if (block.type === "tool_use") {
          toolBlocks.set(ev.index, { id: block.id, name: block.name });
          yield { type: "tool_use_start", id: block.id, name: block.name };
        }
      } else if (ev.type === "content_block_delta") {
        const delta = ev.delta;
        if (delta.type === "text_delta") {
          yield { type: "text_delta", text: delta.text };
        } else if (delta.type === "input_json_delta") {
          const tb = toolBlocks.get(ev.index);
          if (tb)
            yield { type: "tool_use_input_delta", id: tb.id, partial_json: delta.partial_json };
        }
      }
      // message_delta / message_stop carry the final usage; we'll get it
      // via finalMessage() below for accuracy.
    }

    const final = await stream.finalMessage();
    const duration_ms = Math.round(performance.now() - t0);

    const content: ContentBlock[] = fromAnthropicContent(
      final.content as unknown as Array<{ type: string } & Record<string, unknown>>,
    );

    const usage = final.usage;
    yield { type: "usage", input_tokens: totalInput(usage), output_tokens: usage.output_tokens };

    const cost_usd = anthropicCost(req.model, usage);

    yield {
      type: "done",
      final: {
        content,
        usage: {
          input_tokens: totalInput(usage),
          output_tokens: usage.output_tokens,
          cache_read_tokens: usage.cache_read_input_tokens ?? 0,
          cache_write_tokens: usage.cache_creation_input_tokens ?? 0,
        },
        cost_usd,
        stop_reason: fromAnthropicStop(final.stop_reason),
        duration_ms,
      },
    };
  }
}
