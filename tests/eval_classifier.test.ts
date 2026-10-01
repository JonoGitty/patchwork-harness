/**
 * `patchwork-harness eval classifier` and the Jeff backend (ADR-0013, 1 Oct 2026):
 * the metrics, errors never scored as correct, and the wire details that
 * matter for Jeff (per-call adapter, `orders` only when asked for).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Question, askSystemOne, classifierConfig } from "../src/classifier/systemone.js";
import { auc, evalClassifier, expectedCalibrationError, readRows } from "../src/eval/classifier.js";

const cfg = { backend: "jeff" as const, url: "http://127.0.0.1:1", model: "jeff-latest" };
const choiceQ: Question = { type: "choice", instructions: "which?", criteria: { a: "A", b: "B" } };
const noulQ: Question = { type: "noul", instructions: "true?" };

describe("metrics", () => {
  it("auc: perfect, inverted, ties and one-class", () => {
    expect(
      auc([
        { score: 0.9, positive: true },
        { score: 0.1, positive: false },
      ]),
    ).toBe(1);
    expect(
      auc([
        { score: 0.1, positive: true },
        { score: 0.9, positive: false },
      ]),
    ).toBe(0);
    expect(
      auc([
        { score: 0.5, positive: true },
        { score: 0.5, positive: false },
      ]),
    ).toBe(0.5);
    expect(auc([{ score: 0.5, positive: true }])).toBeUndefined();
  });
  it("ece: zero when confidence equals accuracy, large when overconfident", () => {
    expect(
      expectedCalibrationError([
        { confidence: 1, correct: true },
        { confidence: 1, correct: true },
      ]),
    ).toBe(0);
    expect(
      expectedCalibrationError([
        { confidence: 1, correct: false },
        { confidence: 1, correct: false },
      ]),
    ).toBe(1);
  });
});

describe("evalClassifier", () => {
  it("scores choice rows against the constant baseline and counts errors as wrong", async () => {
    const rows = [
      { id: "1", family: "f1", state: "x", question: choiceQ, label: "a" },
      { id: "2", family: "f1", state: "x", question: choiceQ, label: "a" },
      { id: "3", family: "f2", state: "x", question: choiceQ, label: "b" },
      { id: "4", family: "f3", state: "boom", question: choiceQ, label: "a" },
    ];
    const seen: Array<{ model?: string; orders?: number }> = [];
    const report = await evalClassifier(cfg, rows, {
      model: "guard",
      orders: 2,
      positive: ["b"],
      ask: async (_c, state, _q, o) => {
        seen.push({ model: o?.model, orders: o?.orders });
        if (state === "boom") throw new Error("server down");
        // right on rows 1 and 3, wrong on 2
        const pb = seen.length === 2 ? 0.8 : seen.length === 3 ? 0.9 : 0.2;
        return {
          model: "m",
          answers: {
            q: {
              type: "choice",
              choice: pb > 0.5 ? "b" : "a",
              probabilities: { a: 1 - pb, b: pb },
              confidence: Math.max(pb, 1 - pb),
            },
          },
        };
      },
      concurrency: 1,
    });
    expect(seen.every((s) => s.model === "guard" && s.orders === 2)).toBe(true);
    expect(report.n).toBe(4);
    expect(report.errors).toBe(1);
    // 2 right of 4: the failed row is never a correct answer
    expect(report.accuracy).toBe(0.5);
    expect(report.constant).toEqual({ label: "a", accuracy: 0.75 });
    expect(report.families).toBe(3);
    expect(report.auc).toBeDefined();
    expect(report.bands?.high.n).toBe(2);
  });

  it("scores noul rows with P(true) as the positive score", async () => {
    const rows = [
      { id: "1", state: "s", question: noulQ, label: true },
      { id: "2", state: "s", question: noulQ, label: false },
    ];
    let i = 0;
    const report = await evalClassifier(cfg, rows, {
      ask: async () => ({
        model: "m",
        answers: { q: { type: "noul", noul: i++ === 0 ? 0.9 : 0.2 } },
      }),
      concurrency: 1,
    });
    expect(report.accuracy).toBe(1);
    expect(report.auc).toBe(1);
    expect(report.positive).toEqual(["true"]);
  });

  it("reads Jeff-kit rows and rejects rows without a label", () => {
    const dir = mkdtempSync(join(tmpdir(), "patchwork-harness-evalc-"));
    const good = join(dir, "good.jsonl");
    writeFileSync(
      good,
      `${JSON.stringify({ id: "1", suite: "s", family: "f", state: {}, question: noulQ, label: true, target: true, source: {} })}\n`,
    );
    expect(readRows(good)).toHaveLength(1);
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, `${JSON.stringify({ id: "1", state: {}, question: noulQ })}\n`);
    expect(() => readRows(bad)).toThrow(/needs id, state, question and label/);
  });
});

describe("Jeff backend", () => {
  it("PATCHWORK_HARNESS_JEFF_URL selects jeff with the base model", () => {
    expect(
      classifierConfig({ PATCHWORK_HARNESS_JEFF_URL: "http://127.0.0.1:8765/" } as NodeJS.ProcessEnv),
    ).toMatchObject({
      backend: "jeff",
      url: "http://127.0.0.1:8765",
      model: "jeff-latest",
    });
    expect(
      classifierConfig({
        PATCHWORK_HARNESS_CLASSIFIER_URL: "http://x:1",
        PATCHWORK_HARNESS_CLASSIFIER_BACKEND: "jeff",
      } as NodeJS.ProcessEnv)?.backend,
    ).toBe("jeff");
  });
  it("queues overlapping calls to one local server instead of colliding (no 529s from ourselves)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return new Response(
        JSON.stringify({ model: "m", answers: { q: { type: "noul", noul: 0.5 } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const local = { ...cfg, url: "http://127.0.0.1:2" };
    await Promise.all(
      Array.from({ length: 4 }, () => askSystemOne(local, {}, { q: noulQ }, { fetchImpl })),
    );
    expect(maxInFlight).toBe(1);
  });
  it("retries a 529 on the server's Retry-After and then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ detail: "The model is busy." }), {
            status: 529,
            headers: { "Retry-After": "0.05" },
          })
        : new Response(
            JSON.stringify({ model: "m", answers: { q: { type: "noul", noul: 0.7 } } }),
            { status: 200 },
          );
    }) as unknown as typeof fetch;
    const started = Date.now();
    const r = await askSystemOne(
      { ...cfg, url: "http://127.0.0.1:3" },
      {},
      { q: noulQ },
      { fetchImpl, backoffMs: 1 },
    );
    expect(r.answers.q).toMatchObject({ noul: 0.7 });
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });
  it("sends the per-call adapter, and `orders` only when asked for", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(
        JSON.stringify({ model: "m", answers: { q: { type: "noul", noul: 0.5 } } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await askSystemOne(cfg, { text: "x" }, { q: noulQ }, { fetchImpl, model: "guard" });
    await askSystemOne(cfg, { text: "x" }, { q: noulQ }, { fetchImpl, orders: 2 });
    expect(bodies[0]).toMatchObject({ model: "guard" });
    expect(bodies[0]).not.toHaveProperty("orders");
    expect(bodies[1]).toMatchObject({ model: "jeff-latest", orders: 2 });
  });
});
