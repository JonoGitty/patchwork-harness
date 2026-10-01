/**
 * `patchwork-harness eval classifier <rows.jsonl>` - score a System One classifier (Jeff,
 * Kev or Jev) on labelled rows BEFORE anything in the harness trusts it
 * (ADR-0013 / ADR-0018; the eval rule from ADR-0017 applied to classifiers).
 *
 * Rows use Jeff's adapter-kit format, so the same files go through
 * `jeff-kit check-rows / split / leak-check / shortcut-report` and back here:
 *   {"id", "suite", "family", "state", "question": {type, instructions, criteria?},
 *    "label": "<option key>" | true | false, ...}
 *
 * Reported against the constant baseline, always: a classifier that cannot
 * beat "always the commonest label" has not earned a place in the pipeline.
 * A call that fails is counted as an error, never as a correct answer.
 */
import { readFileSync } from "node:fs";
import {
  type AskOptions,
  type ClassifierConfig,
  type Question,
  type SystemOneResponse,
  askSystemOne,
} from "../classifier/systemone.js";

export interface ClassifierRow {
  id: string;
  family?: string;
  state: unknown;
  question: Question;
  label: string | boolean;
}

export interface ClassifierEvalOptions {
  model?: string;
  orders?: 1 | 2;
  /** Option keys whose probabilities sum to the "positive" score (AUC, bands). Noul: always P(true). */
  positive?: string[];
  hi?: number;
  lo?: number;
  limit?: number;
  concurrency?: number;
  ask?: (
    cfg: ClassifierConfig,
    state: unknown,
    questions: Record<string, Question>,
    opts?: AskOptions,
  ) => Promise<SystemOneResponse>;
}

export interface RowResult {
  id: string;
  family?: string;
  label: string;
  predicted?: string;
  confidence?: number;
  /** P(positive) - for AUC and bands */
  score?: number;
  /** Probability per option (noul: {true, false}) */
  probabilities?: Record<string, number>;
  latency_ms: number;
  error?: string;
}

export interface ClassifierReport {
  backend: string;
  model: string;
  orders: number;
  n: number;
  errors: number;
  accuracy: number;
  constant: { label: string; accuracy: number };
  ece: number;
  brier: number;
  auc?: number;
  positive?: string[];
  bands?: {
    hi: number;
    lo: number;
    high: { n: number; positive: number };
    low: { n: number; positive: number };
  };
  median_latency_ms: number;
  families: number;
  rows: RowResult[];
}

export function readRows(path: string): ClassifierRow[] {
  const rows: ClassifierRow[] = [];
  readFileSync(path, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!line.trim()) return;
      const r = JSON.parse(line) as ClassifierRow;
      if (!r.id || r.state === undefined || !r.question?.type || r.label === undefined)
        throw new Error(`${path}:${i + 1}: a row needs id, state, question and label`);
      rows.push(r);
    });
  if (!rows.length) throw new Error(`${path}: no rows`);
  return rows;
}

const labelOf = (l: string | boolean) => (typeof l === "boolean" ? String(l) : l);

/** Expected calibration error over equal-width confidence bins (15, as Jeff reports it). */
export function expectedCalibrationError(
  results: Array<{ confidence: number; correct: boolean }>,
  bins = 15,
): number {
  if (!results.length) return Number.NaN;
  let ece = 0;
  for (let b = 0; b < bins; b++) {
    const lo = b / bins;
    const hi = (b + 1) / bins;
    const inBin = results.filter(
      (r) => (b === 0 ? r.confidence >= lo : r.confidence > lo) && r.confidence <= hi,
    );
    if (!inBin.length) continue;
    const acc = inBin.filter((r) => r.correct).length / inBin.length;
    const conf = inBin.reduce((s, r) => s + r.confidence, 0) / inBin.length;
    ece += (inBin.length / results.length) * Math.abs(acc - conf);
  }
  return ece;
}

/** Probability that a random positive outranks a random negative (ties count half). */
export function auc(scores: Array<{ score: number; positive: boolean }>): number | undefined {
  const pos = scores.filter((s) => s.positive).map((s) => s.score);
  const neg = scores.filter((s) => !s.positive).map((s) => s.score);
  if (!pos.length || !neg.length) return undefined;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export async function evalClassifier(
  cfg: ClassifierConfig,
  allRows: ClassifierRow[],
  opts: ClassifierEvalOptions = {},
): Promise<ClassifierReport> {
  const ask = opts.ask ?? askSystemOne;
  const rows = opts.limit ? allRows.slice(0, opts.limit) : allRows;
  const results: RowResult[] = new Array(rows.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < rows.length; i = next++) {
      const row = rows[i]!;
      const started = Date.now();
      const base: RowResult = {
        id: row.id,
        family: row.family,
        label: labelOf(row.label),
        latency_ms: 0,
      };
      try {
        const res = await ask(
          cfg,
          row.state,
          { q: row.question },
          { model: opts.model, orders: opts.orders, retries: 1 },
        );
        const a = res.answers.q!;
        let probabilities: Record<string, number>;
        if (a.type === "noul") probabilities = { true: a.noul, false: 1 - a.noul };
        else probabilities = { ...a.probabilities };
        const predicted = Object.entries(probabilities).reduce((x, y) => (y[1] > x[1] ? y : x))[0];
        const positive = row.question.type === "noul" ? ["true"] : (opts.positive ?? []);
        const score = positive.length
          ? positive.reduce((s, k) => s + (probabilities[k] ?? 0), 0)
          : undefined;
        results[i] = {
          ...base,
          predicted,
          confidence: probabilities[predicted],
          score,
          probabilities,
          latency_ms: Date.now() - started,
        };
      } catch (e) {
        results[i] = {
          ...base,
          latency_ms: Date.now() - started,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 2) }, worker));

  const ok = results.filter((r) => !r.error);
  const n = results.length;
  // errors count against accuracy: unknowable is never a correct answer
  const correct = ok.filter((r) => r.predicted === r.label).length;
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
  const [constLabel, constN] = [...counts.entries()].reduce((x, y) => (y[1] > x[1] ? y : x));
  const brier =
    ok.reduce((s, r) => {
      const keys = new Set([...Object.keys(r.probabilities ?? {}), r.label]);
      let e = 0;
      for (const k of keys) e += ((r.probabilities?.[k] ?? 0) - (k === r.label ? 1 : 0)) ** 2;
      return s + e;
    }, 0) / Math.max(ok.length, 1);
  const positive = rows[0]?.question.type === "noul" ? ["true"] : opts.positive;
  const scored = ok.filter((r) => r.score !== undefined);
  const isPos = (r: RowResult) => (positive ?? []).includes(r.label);
  const hi = opts.hi ?? 0.7;
  const lo = opts.lo ?? 0.3;
  const lat = ok.map((r) => r.latency_ms).sort((a, b) => a - b);
  return {
    backend: cfg.backend,
    model: opts.model ?? cfg.model,
    orders: opts.orders ?? 1,
    n,
    errors: n - ok.length,
    accuracy: correct / Math.max(n, 1),
    constant: { label: constLabel, accuracy: constN / Math.max(n, 1) },
    ece: expectedCalibrationError(
      ok.map((r) => ({ confidence: r.confidence ?? 0, correct: r.predicted === r.label })),
    ),
    brier,
    auc: positive?.length
      ? auc(scored.map((r) => ({ score: r.score!, positive: isPos(r) })))
      : undefined,
    positive,
    bands: positive?.length
      ? {
          hi,
          lo,
          high: {
            n: scored.filter((r) => r.score! >= hi).length,
            positive: scored.filter((r) => r.score! >= hi && isPos(r)).length,
          },
          low: {
            n: scored.filter((r) => r.score! <= lo).length,
            positive: scored.filter((r) => r.score! <= lo && isPos(r)).length,
          },
        }
      : undefined,
    median_latency_ms: lat.length ? lat[Math.floor(lat.length / 2)]! : 0,
    families: new Set(results.map((r) => r.family ?? r.id)).size,
    rows: results,
  };
}
