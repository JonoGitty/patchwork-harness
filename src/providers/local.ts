/**
 * Local provider — talks to an Ollama server (default
 * http://127.0.0.1:11434) through its OpenAI-compatible endpoint, via the
 * OpenAI SDK. Free ($0 per token) and fully private: nothing leaves the
 * machine, which makes it the right route for personal writing/drafting
 * and anything sensitive.
 *
 * Availability is a liveness probe, not a key check: one short curl to
 * the server, cached for the process lifetime. Override the URL with
 * PATCHWORK_HARNESS_LOCAL_URL or OLLAMA_HOST; force availability (skip the probe)
 * with PATCHWORK_HARNESS_LOCAL_FORCE=1.
 *
 * Some local models (e.g. Gemma 3) have no tool-calling template. When
 * the server rejects a request because of tools, we retry once without
 * them — the step degrades to pure text generation, which is exactly
 * what a writing/drafting step wants anyway.
 */

import { spawnSync } from "node:child_process";
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

/**
 * The model names a running Ollama actually serves (its `/api/tags` body),
 * each with and without the implicit ":latest" tag. null when the body is
 * not a tags listing - unknown, never "nothing installed".
 */
export function parseOllamaTags(body: string): Set<string> | null {
  try {
    const models = (JSON.parse(body) as { models?: Array<{ name?: unknown }> }).models;
    if (!Array.isArray(models)) return null;
    const out = new Set<string>();
    for (const m of models) {
      if (typeof m.name !== "string") continue;
      out.add(m.name);
      if (m.name.endsWith(":latest")) out.add(m.name.slice(0, -":latest".length));
    }
    return out;
  } catch {
    return null;
  }
}

export function localBaseUrl(): string {
  const env = process.env.PATCHWORK_HARNESS_LOCAL_URL ?? process.env.OLLAMA_HOST;
  if (env) {
    const base = env.replace(/\/+$/, "");
    return base.endsWith("/v1") ? base : `${base}/v1`;
  }
  return "http://127.0.0.1:11434/v1";
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
    const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    out.push({ role: "user", content: text });
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

/** Does this error mean "the model has no tool template"? */
export function isNoToolSupportError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /does not support tools|tool.*not.*support/i.test(msg);
}

export class LocalProvider implements Provider {
  readonly name = "local" as const;
  defaultModel = process.env.PATCHWORK_HARNESS_LOCAL_MODEL ?? "gemma3:12b";
  private client: OpenAI | null = null;
  private probed: boolean | null = null;
  private installed: Set<string> | null | undefined;

  /**
   * Liveness probe, cached for the process. spawnSync(curl) because
   * Provider.available() is synchronous; curl ships with Windows 10+,
   * macOS and effectively all Linux. No curl → treated as unavailable
   * (force with PATCHWORK_HARNESS_LOCAL_FORCE=1).
   */
  available(): boolean {
    if (process.env.PATCHWORK_HARNESS_LOCAL_FORCE === "1") return true;
    if (this.probed != null) return this.probed;
    try {
      const url = localBaseUrl().replace(/\/v1$/, "/api/tags");
      const r = spawnSync(
        "curl",
        [
          "-s",
          "-m",
          "2",
          "-o",
          process.platform === "win32" ? "NUL" : "/dev/null",
          "-w",
          "%{http_code}",
          url,
        ],
        {
          timeout: 3000,
          encoding: "utf8",
        },
      );
      this.probed = r.status === 0 && r.stdout?.trim() === "200";
    } catch {
      this.probed = false;
    }
    return this.probed;
  }

  /**
   * Which models the live server can run right now, cached for the process.
   * Liveness is not presence: on 28 Sept 2026 an Ollama started by another app answered /api/tags serving only its own models, so every
   * catalogued local model looked available and a writing step would have
   * failed at run time. null = unknown (probe failed, or PATCHWORK_HARNESS_LOCAL_FORCE).
   */
  installedModels(): Set<string> | null {
    if (process.env.PATCHWORK_HARNESS_LOCAL_FORCE === "1") return null;
    if (this.installed !== undefined) return this.installed;
    try {
      const url = localBaseUrl().replace(/\/v1$/, "/api/tags");
      const r = spawnSync("curl", ["-s", "-m", "2", url], { timeout: 3000, encoding: "utf8" });
      this.installed = r.status === 0 && r.stdout ? parseOllamaTags(r.stdout) : null;
    } catch {
      this.installed = null;
    }
    return this.installed;
  }

  private getClient(): OpenAI {
    if (!this.client) {
      // Ollama ignores the key but the SDK requires one.
      this.client = new OpenAI({ baseURL: localBaseUrl(), apiKey: "ollama" });
    }
    return this.client;
  }

  private baseParams(req: CompletionRequest, withTools: boolean) {
    return {
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      temperature: req.temperature,
      messages: toMessages(systemText(req), req.messages),
      ...(withTools && req.tools?.length ? { tools: toTools(req.tools) } : {}),
    };
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const client = this.getClient();
    const t0 = performance.now();

    let resp: OpenAI.Chat.Completions.ChatCompletion;
    try {
      resp = await client.chat.completions.create(this.baseParams(req, true));
    } catch (e) {
      if (!isNoToolSupportError(e) || !req.tools?.length) throw e;
      // Model has no tool template (e.g. Gemma 3) — degrade to plain text.
      resp = await client.chat.completions.create(this.baseParams(req, false));
    }

    const duration_ms = Math.round(performance.now() - t0);
    const choice = resp.choices[0];
    if (!choice) throw new Error("local model returned no choices");
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
      cost_usd: 0, // local inference is free
      stop_reason: fromFinish(choice.finish_reason),
      duration_ms,
    };
  }

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const client = this.getClient();
    const t0 = performance.now();

    let stream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;
    try {
      stream = await client.chat.completions.create({
        ...this.baseParams(req, true),
        stream: true,
        stream_options: { include_usage: true },
      });
    } catch (e) {
      if (!isNoToolSupportError(e) || !req.tools?.length) throw e;
      stream = await client.chat.completions.create({
        ...this.baseParams(req, false),
        stream: true,
        stream_options: { include_usage: true },
      });
    }

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
        cost_usd: 0,
        stop_reason: fromFinish(finishReason),
        duration_ms,
      },
    };
  }
}
