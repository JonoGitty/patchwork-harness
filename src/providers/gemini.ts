import { readFileSync } from "node:fs";
import {
  type FunctionCall,
  type Tool as GeminiTool,
  GoogleGenerativeAI,
} from "@google/generative-ai";
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  MediaPart,
  Message,
  Provider,
  StopReason,
  StreamChunk,
  ToolDef,
} from "./base.js";
import { systemText } from "./base.js";
import { ProviderUnavailableError } from "./base.js";
import { type Price, priceForModel } from "./pricing.js";

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mp3: "audio/mp3",
  wav: "audio/wav",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  flac: "audio/flac",
  aac: "audio/aac",
};

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function inferMime(path: string): string | undefined {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)(?:\?.*)?$/);
  const ext = m?.[1];
  return ext ? EXT_MIME[ext] : undefined;
}

/**
 * Turn MediaPart[] into Gemini parts. Remote URLs (incl. YouTube) become
 * fileData with a fileUri; local paths are read and inlined as base64.
 */
function mediaToParts(media: MediaPart[]): any[] {
  return media.map((m) => {
    if (isUrl(m.source)) {
      const fileData: { fileUri: string; mimeType?: string } = { fileUri: m.source };
      // YouTube URLs are resolved server-side; a mimeType is optional and
      // best omitted. For other remote files, pass it through if known.
      const mime = m.mimeType ?? (m.kind === "video" ? undefined : inferMime(m.source));
      if (mime) fileData.mimeType = mime;
      return { fileData };
    }
    const data = readFileSync(m.source).toString("base64");
    const mimeType = m.mimeType ?? inferMime(m.source) ?? "application/octet-stream";
    return { inlineData: { data, mimeType } };
  });
}

// Fallback per-million pricing for ids the catalog (config/models.yml)
// does not list. Verified against ai.google.dev/gemini-api/docs/pricing on
// 7 Sept 2026. Longest prefix wins in priceForModel().
const PRICING: Record<string, Price> = {
  "gemini-3.8-flash": { in: 0.75, out: 3.75 }, // $1.50/$7.50 from 1 Jan 2027
  "gemini-3.7-flash": { in: 0.75, out: 3.75 },
  "gemini-3.6-flash": { in: 0.75, out: 3.75 },
  "gemini-3.5-flash": { in: 1.5, out: 9.0 },
  "gemini-3.1-pro": { in: 2.0, out: 12.0 },
  "gemini-3.1-flash-lite": { in: 0.25, out: 1.5 },
  "gemini-2.5-pro": { in: 1.25, out: 10.0 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
};
/** Extra output budget for Gemini 3.x thinking (billed as output). */
export const THINKING_HEADROOM_TOKENS = 16_384;
// Prompts over 200k input tokens bill at the long-context tier.
const LONG_CONTEXT_TOKENS = 200_000;
const LONG_CONTEXT: Record<string, Price> = {
  "gemini-3.1-pro": { in: 4.0, out: 18.0 },
  "gemini-2.5-pro": { in: 2.5, out: 15.0 },
};

export function geminiCost(model: string, tIn: number, tOut: number): number | undefined {
  let price = priceForModel(model, PRICING);
  if (tIn > LONG_CONTEXT_TOKENS) {
    for (const [k, v] of Object.entries(LONG_CONTEXT)) if (model.startsWith(k)) price = v;
  }
  return price ? (tIn * price.in + tOut * price.out) / 1_000_000 : undefined;
}

/**
 * Our provider-neutral history → Gemini `contents`.
 *
 * Three Gemini 3.x rules live here (all bit the executor on 2 Sept 2026):
 *  1. THOUGHT SIGNATURES: a response part may carry `thoughtSignature`; it
 *     MUST be returned on the same part in every later request, or the API
 *     answers 400 "Function call is missing a thought_signature". We stash
 *     it on the ContentBlock (`thought_signature`) and echo it here.
 *  2. A functionResponse is matched to its call by NAME, not by the id the
 *     executor minted, so the name is mapped back from the assistant turn.
 *  3. All responses to one parallel call batch go in ONE user turn, and
 *     tool results use role "user" (the legacy "function" role is gone).
 */
export function toGeminiContents(msgs: Message[]): { role: "user" | "model"; parts: any[] }[] {
  const out: { role: "user" | "model"; parts: any[] }[] = [];
  const nameById = new Map<string, string>();
  for (const m of msgs) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      const parts: any[] = [];
      for (const c of m.content) {
        if (c.type !== "tool_result") continue;
        const name = nameById.get(c.tool_use_id) ?? c.tool_use_id;
        parts.push({
          functionResponse: {
            name,
            response: c.is_error ? { error: c.content } : { content: c.content },
          },
        });
      }
      if (parts.length) out.push({ role: "user", parts });
      continue;
    }
    const role: "user" | "model" = m.role === "assistant" ? "model" : "user";
    const parts: any[] = [];
    for (const c of m.content) {
      if (c.type === "text") {
        // an empty text part is rejected unless it carries a signature
        if (!c.text && !c.thought_signature) continue;
        const p: Record<string, unknown> = { text: c.text };
        if (c.thought_signature) p.thoughtSignature = c.thought_signature;
        parts.push(p);
      } else if (c.type === "tool_use") {
        nameById.set(c.id, c.name);
        const p: Record<string, unknown> = { functionCall: { name: c.name, args: c.input ?? {} } };
        if (c.thought_signature) p.thoughtSignature = c.thought_signature;
        parts.push(p);
      }
    }
    if (parts.length) out.push({ role, parts });
  }
  return out;
}

/** Render the real sources from a grounded response as a Sources list, so
 *  grounded answers can be checked against actual URLs. */
function groundingSources(gm: unknown): string {
  const meta = gm as {
    groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
    webSearchQueries?: string[];
  };
  const chunks = meta?.groundingChunks;
  if (!Array.isArray(chunks) || chunks.length === 0) return "";
  const lines = chunks
    .map((c, i) => {
      const w = c.web ?? {};
      if (!w.uri && !w.title) return null;
      return `  [${i + 1}] ${w.title ?? w.uri}${w.uri && w.title ? ` — ${w.uri}` : ""}`;
    })
    .filter((l): l is string => l !== null);
  if (!lines.length) return "";
  const queries =
    Array.isArray(meta.webSearchQueries) && meta.webSearchQueries.length
      ? `\n(searches: ${meta.webSearchQueries.join("; ")})`
      : "";
  return `\n\nSources:\n${lines.join("\n")}${queries}`;
}

function stripUnsupportedSchemaKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupportedSchemaKeys);
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "additionalProperties" || k === "$schema") continue;
      out[k] = stripUnsupportedSchemaKeys(v);
    }
    return out;
  }
  return node;
}

function toGeminiTools(tools: ToolDef[] | undefined): GeminiTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        // Gemini's function-declaration schema is a subset of JSON
        // Schema: it rejects `additionalProperties` and `$schema`
        // outright (400 "Unknown name", 2 Sept 2026) - strip them
        // recursively without changing the shape
        parameters: stripUnsupportedSchemaKeys(t.inputSchema) as any,
      })),
    },
  ];
}

/** Response parts → ContentBlocks, keeping each part's thought signature. */
export function fromGeminiParts(parts: any[] | undefined): ContentBlock[] {
  const content: ContentBlock[] = [];
  for (const part of parts ?? []) {
    if (part?.thought === true) continue; // thought summaries are not answer content
    const sig: string | undefined =
      typeof part?.thoughtSignature === "string" ? part.thoughtSignature : undefined;
    if (typeof part?.text === "string") {
      content.push({ type: "text", text: part.text, ...(sig ? { thought_signature: sig } : {}) });
    }
    if (part?.functionCall) {
      const fc = part.functionCall as FunctionCall;
      content.push({
        type: "tool_use",
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name: fc.name,
        input: fc.args ?? {},
        ...(sig ? { thought_signature: sig } : {}),
      });
    }
  }
  return content;
}

export class GeminiProvider implements Provider {
  readonly name = "gemini" as const;
  defaultModel = "gemini-3.8-flash";
  private client: GoogleGenerativeAI | null = null;

  available(): boolean {
    return !!process.env.GEMINI_API_KEY || !!process.env.GOOGLE_API_KEY;
  }

  private getClient(): GoogleGenerativeAI {
    if (!this.available()) {
      throw new ProviderUnavailableError("gemini", "GEMINI_API_KEY (or GOOGLE_API_KEY) not set");
    }
    if (!this.client) {
      this.client = new GoogleGenerativeAI(
        (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)!,
      );
    }
    return this.client;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const client = this.getClient();
    const t0 = performance.now();

    // Grounding with Google Search is mutually exclusive with function
    // tools, so a grounded request runs with ONLY the search tool — research
    // steps don't need local file/bash tools anyway.
    const tools = req.grounded
      ? ([{ googleSearch: {} }] as unknown as GeminiTool[])
      : toGeminiTools(req.tools);

    // Gemini 3.x thinks before it answers and the thinking is billed as
    // output. With maxOutputTokens = the caller's answer budget, 3.1 Pro
    // spent 11.5k tokens thinking and returned NO text (7 Sept 2026), so
    // thinking models get headroom on top of the requested answer size.
    const thinkingModel = /^gemini-3/.test(req.model);
    const model = client.getGenerativeModel({
      model: req.model,
      systemInstruction: systemText(req),
      tools,
      generationConfig: {
        maxOutputTokens: (req.maxTokens ?? 4096) + (thinkingModel ? THINKING_HEADROOM_TOKENS : 0),
        temperature: req.temperature,
      },
    });

    const contents = toGeminiContents(req.messages);
    if (req.media?.length) {
      const parts = mediaToParts(req.media);
      // Attach media to the last user turn so the prompt and its inputs
      // arrive together; create one if (somehow) there isn't a user turn.
      let lastUser: { role: string; parts: any[] } | undefined;
      for (let i = contents.length - 1; i >= 0; i--) {
        const c = contents[i];
        if (c && c.role === "user") {
          lastUser = c;
          break;
        }
      }
      if (lastUser) lastUser.parts.push(...parts);
      else contents.push({ role: "user", parts });
    }

    const result = await model.generateContent({ contents });

    const duration_ms = Math.round(performance.now() - t0);
    const candidate = result.response.candidates?.[0];
    const content: ContentBlock[] = fromGeminiParts(candidate?.content?.parts as any[] | undefined);

    // When grounded, append the real sources the model cited so the answer
    // is verifiable rather than trust-me.
    const sources = groundingSources((candidate as any)?.groundingMetadata);
    if (sources) content.push({ type: "text", text: sources });

    const usage = result.response.usageMetadata;
    const tIn = usage?.promptTokenCount ?? 0;
    // thinking tokens are billed as output; candidatesTokenCount excludes them
    const tOut = (usage?.candidatesTokenCount ?? 0) + ((usage as any)?.thoughtsTokenCount ?? 0);
    const cost_usd = geminiCost(req.model, tIn, tOut);

    let stop_reason: StopReason = "end_turn";
    const finish = String(candidate?.finishReason ?? "");
    let error: string | undefined;
    if (content.some((c) => c.type === "tool_use")) stop_reason = "tool_use";
    else if (finish === "MAX_TOKENS") stop_reason = "max_tokens";
    else if (finish && finish !== "STOP") {
      // RECITATION / SAFETY / PROHIBITED_CONTENT / MALFORMED_FUNCTION_CALL …:
      // HTTP 200, tokens billed, candidate blocked. Until 7 Sept 2026 this
      // read as a clean empty answer ("end_turn").
      stop_reason = "error";
      error = `gemini finishReason=${finish}${content.length ? "" : " (no content returned)"}${
        (candidate as any)?.safetyRatings
          ? ` safety=${JSON.stringify((candidate as any).safetyRatings).slice(0, 200)}`
          : ""
      }${(result.response as any)?.promptFeedback?.blockReason ? ` promptFeedback=${(result.response as any).promptFeedback.blockReason}` : ""}`;
    } else if (!candidate) {
      stop_reason = "error";
      error = `gemini returned no candidate${(result.response as any)?.promptFeedback?.blockReason ? `: promptFeedback=${(result.response as any).promptFeedback.blockReason}` : ""}`;
    }

    return {
      content,
      usage: { input_tokens: tIn, output_tokens: tOut },
      cost_usd,
      stop_reason,
      duration_ms,
      ...(error ? { error } : {}),
    };
  }

  // eslint-disable-next-line require-yield
  async *stream(_req: CompletionRequest): AsyncIterable<StreamChunk> {
    throw new Error("GeminiProvider.stream() not implemented in M2 — falling back to complete()");
  }
}
