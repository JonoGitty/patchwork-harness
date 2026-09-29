import { describe, expect, it } from "vitest";
import type {
  CompletionRequest,
  CompletionResponse,
  Provider,
  StreamChunk,
} from "../src/providers/base.js";

/**
 * Mock provider that yields a scripted sequence of stream chunks. Used to
 * verify the executor's streaming wrapper handles deltas correctly and
 * surfaces the final CompletionResponse.
 */
function mockStreamingProvider(chunks: StreamChunk[], available = true): Provider {
  return {
    name: "anthropic",
    available: () => available,
    defaultModel: "mock-model",
    async complete(_req: CompletionRequest): Promise<CompletionResponse> {
      throw new Error("complete() should not be called when stream() works");
    },
    async *stream(_req: CompletionRequest): AsyncIterable<StreamChunk> {
      for (const c of chunks) yield c;
    },
  };
}

function mockNonStreamingProvider(resp: CompletionResponse): Provider {
  return {
    name: "gemini",
    available: () => true,
    defaultModel: "mock-model",
    async complete(_req: CompletionRequest): Promise<CompletionResponse> {
      return resp;
    },
    // eslint-disable-next-line require-yield
    async *stream(_req: CompletionRequest): AsyncIterable<StreamChunk> {
      throw new Error("stream() not implemented in M2");
    },
  };
}

describe("streaming", () => {
  it("yields text deltas in order and ends with a 'done' chunk", async () => {
    const final: CompletionResponse = {
      content: [{ type: "text", text: "hello world" }],
      usage: { input_tokens: 10, output_tokens: 5 },
      cost_usd: 0.0001,
      stop_reason: "end_turn",
      duration_ms: 42,
    };
    const provider = mockStreamingProvider([
      { type: "text_delta", text: "hello " },
      { type: "text_delta", text: "world" },
      { type: "usage", input_tokens: 10, output_tokens: 5 },
      { type: "done", final },
    ]);

    const collected: string[] = [];
    let doneSeen = false;
    for await (const chunk of provider.stream({ model: "mock", messages: [] })) {
      if (chunk.type === "text_delta") collected.push(chunk.text);
      if (chunk.type === "done") {
        doneSeen = true;
        expect(chunk.final.stop_reason).toBe("end_turn");
        expect(chunk.final.usage.output_tokens).toBe(5);
      }
    }
    expect(collected.join("")).toBe("hello world");
    expect(doneSeen).toBe(true);
  });

  it("surfaces tool_use_start and input_delta events", async () => {
    const final: CompletionResponse = {
      content: [{ type: "tool_use", id: "tool_1", name: "read", input: { path: "x" } }],
      usage: { input_tokens: 8, output_tokens: 12 },
      stop_reason: "tool_use",
      duration_ms: 50,
    };
    const provider = mockStreamingProvider([
      { type: "tool_use_start", id: "tool_1", name: "read" },
      { type: "tool_use_input_delta", id: "tool_1", partial_json: '{"path":' },
      { type: "tool_use_input_delta", id: "tool_1", partial_json: '"x"}' },
      { type: "done", final },
    ]);

    const events: string[] = [];
    for await (const chunk of provider.stream({ model: "mock", messages: [] })) {
      events.push(chunk.type);
    }
    expect(events).toEqual([
      "tool_use_start",
      "tool_use_input_delta",
      "tool_use_input_delta",
      "done",
    ]);
  });

  it("non-streaming provider's stream() throws an actionable error", async () => {
    const provider = mockNonStreamingProvider({
      content: [{ type: "text", text: "x" }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      duration_ms: 1,
    });
    await expect(async () => {
      for await (const _c of provider.stream({ model: "m", messages: [] })) {
        /* should throw before yielding */
      }
    }).rejects.toThrow(/not implemented/);
  });
});
