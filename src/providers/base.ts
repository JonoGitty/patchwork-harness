/**
 * Provider abstraction. One shape for the agent loop; per-provider
 * adapters translate to native APIs.
 *
 * See DECISIONS/0003-tool-protocol.md for the rationale.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/**
 * `thought_signature` is Gemini 3.x's opaque reasoning token: the API
 * attaches one to a response part and REQUIRES it back, on the same part,
 * in every follow-up request ("Function call is missing a
 * thought_signature", 400). Other providers ignore it. Carried here so the
 * executor's provider-neutral history round-trips it untouched.
 */
export type ContentBlock =
  | {
      type: "text";
      text: string;
      thought_signature?: string;
      /**
       * An opaque provider-native block (e.g. an Anthropic `thinking` block
       * with its signature) that must be sent back VERBATIM on the same
       * model's next turn and is never user-facing. Carried on an
       * empty-text block so the rest of the pipeline can ignore it.
       */
      provider_block?: unknown;
    }
  | { type: "tool_use"; id: string; name: string; input: unknown; thought_signature?: string }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Message {
  role: Role;
  content: ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema. zod is converted to JSON Schema before reaching here. */
  inputSchema: Record<string, unknown>;
}

/**
 * A non-text input attached to the request (image, video, PDF, audio).
 * Currently consumed only by the Gemini provider — other adapters reject
 * media with a clear error. `source` is either a remote URL (e.g. a
 * YouTube link, sent as fileData) or a local file path (read + sent
 * inline as base64). `mimeType` is inferred from the extension when omitted.
 */
export interface MediaPart {
  kind: "image" | "video" | "pdf" | "audio";
  source: string;
  mimeType?: string;
}

export interface CompletionRequest {
  model: string;
  system?: string;
  /**
   * Per-turn system text (live budget, timers) kept OUT of the cached prefix.
   * Anthropic sends it as a second, uncached system block; every other
   * adapter appends it via systemText(). Putting live spend inside `system`
   * re-wrote the prompt cache on every paid turn and never read it
   * (measured 28 Sept 2026: 4,292 tokens re-written per turn, 0 read).
   */
  systemDynamic?: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  /** Non-text inputs (Gemini only for now). Attached to the last user turn. */
  media?: MediaPart[];
  /**
   * Enable live Google Search grounding (Gemini only). When set, the model
   * searches the web and returns answers backed by real sources, whose URLs
   * the adapter appends as a Sources list. Mutually exclusive with local
   * tool calling, so grounded requests run without the function tools.
   */
  grounded?: boolean;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop" | "error";

export interface CompletionResponse {
  content: ContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    /** Anthropic prompt cache (already inside input_tokens): what was read / written. */
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
  cost_usd?: number;
  stop_reason: StopReason;
  duration_ms: number;
  /**
   * Set when the provider answered HTTP 200 but produced no usable content
   * (a Gemini RECITATION/SAFETY block, an Anthropic refusal …). The tokens
   * were still billed, so this is a response, not an exception - callers
   * must treat it as a failed turn, never as an empty answer.
   */
  error?: string;
}

/**
 * Streaming chunk shape — common across providers. The executor renders
 * `text_delta` / tool_use deltas as they arrive and uses the final `done`
 * chunk for audit emit (full content, usage, cost).
 */
export type StreamChunk =
  | { type: "text_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; partial_json: string }
  | { type: "usage"; input_tokens: number; output_tokens: number }
  | { type: "done"; final: CompletionResponse };

export interface Provider {
  /** Registry key. */
  name: "anthropic" | "openai" | "gemini" | "xai" | "perplexity" | "local";
  /** Whether the provider is usable in this process (e.g. has key). */
  available(): boolean;
  /** Default model id when none is specified. */
  defaultModel: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /**
   * Streaming variant of `complete`. Yields incremental chunks. The final
   * chunk has type "done" and carries the full CompletionResponse.
   * Providers that don't support streaming throw on the first iteration.
   */
  stream(req: CompletionRequest): AsyncIterable<StreamChunk>;
}

export class ProviderUnavailableError extends Error {
  constructor(provider: string, reason: string) {
    super(`provider ${provider} unavailable: ${reason}`);
    this.name = "ProviderUnavailableError";
  }
}

/** The full system text for adapters with no multi-block system (all but Anthropic). */
export function systemText(
  req: Pick<CompletionRequest, "system" | "systemDynamic">,
): string | undefined {
  if (!req.systemDynamic) return req.system;
  return req.system ? `${req.system}\n\n${req.systemDynamic}` : req.systemDynamic;
}
