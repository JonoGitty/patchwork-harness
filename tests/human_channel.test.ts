import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonHumanChannel } from "../src/permissions/human.js";
import type { JsonEventType, JsonReporter } from "../src/util/json_reporter.js";

class CaptureReporter implements JsonReporter {
  events: Array<{ type: JsonEventType; data: Record<string, unknown> }> = [];
  setSessionId(_id: string): void {}
  emit(type: JsonEventType, data: Record<string, unknown> = {}): void {
    this.events.push({ type, data });
  }
  ofType(type: JsonEventType) {
    return this.events.filter((e) => e.type === type);
  }
}

function makeChannel(opts: { timeout_s?: number } = {}) {
  const reporter = new CaptureReporter();
  const input = new PassThrough();
  const channel = new JsonHumanChannel(reporter, { input, ...opts });
  const answer = (id: string, answer: string) =>
    input.write(`${JSON.stringify({ type: "human_answer", id, answer })}\n`);
  return { reporter, input, channel, answer };
}

describe("JsonHumanChannel", () => {
  it("emits permission_required and resolves yes", async () => {
    const { reporter, channel, answer } = makeChannel();
    const p = channel.askYesNo("Allow: write foo.ts?", false, { kind: "permission" });
    const q = reporter.ofType("permission_required")[0];
    expect(q).toBeDefined();
    expect(q.data.question).toBe("Allow: write foo.ts?");
    expect(q.data.kind).toBe("permission");
    answer(q.data.id as string, "yes");
    await expect(p).resolves.toBe(true);
    const a = reporter.ofType("human_answer")[0];
    expect(a.data.source).toBe("human");
    channel.close();
  });

  it("resolves no for a deny answer", async () => {
    const { reporter, channel, answer } = makeChannel();
    const p = channel.askYesNo("Allow?", false);
    answer(reporter.ofType("permission_required")[0].data.id as string, "no");
    await expect(p).resolves.toBe(false);
    channel.close();
  });

  it("askText emits human_pause and returns the text", async () => {
    const { reporter, channel, answer } = makeChannel();
    const p = channel.askText("Which database should we use?", { kind: "pause" });
    const q = reporter.ofType("human_pause")[0];
    expect(q).toBeDefined();
    answer(q.data.id as string, "sqlite, keep it local");
    await expect(p).resolves.toBe("sqlite, keep it local");
    channel.close();
  });

  it("falls back to the default when stdin closes unanswered", async () => {
    const { reporter, input, channel } = makeChannel();
    const p = channel.askYesNo("Allow?", false);
    input.end();
    await expect(p).resolves.toBe(false);
    expect(reporter.ofType("human_answer")[0].data.source).toBe("stdin_closed");
    expect(channel.interactive).toBe(false);
    channel.close();
  });

  it("falls back to the default on timeout", async () => {
    const { reporter, channel } = makeChannel({ timeout_s: 0.05 });
    const p = channel.askYesNo("Allow?", true);
    await expect(p).resolves.toBe(true); // default applied
    expect(reporter.ofType("human_answer")[0].data.source).toBe("timeout");
    channel.close();
  });

  it("matches answers to question ids, not arrival order", async () => {
    const { reporter, channel, answer } = makeChannel();
    const p1 = channel.askYesNo("first?", false);
    const p2 = channel.askYesNo("second?", false);
    const [q1, q2] = reporter.ofType("permission_required");
    answer(q2.data.id as string, "yes");
    answer(q1.data.id as string, "no");
    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBe(true);
    channel.close();
  });

  it("ignores junk lines on stdin", async () => {
    const { reporter, input, channel, answer } = makeChannel();
    const p = channel.askYesNo("Allow?", false);
    input.write("not json at all\n");
    input.write(`${JSON.stringify({ type: "something_else" })}\n`);
    answer(reporter.ofType("permission_required")[0].data.id as string, "allow");
    await expect(p).resolves.toBe(true);
    channel.close();
  });

  it("close() flushes pending questions with the default", async () => {
    const { channel } = makeChannel();
    const p = channel.askText("still there?");
    channel.close();
    await expect(p).resolves.toBeNull();
  });
});
