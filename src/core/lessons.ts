/**
 * Smart conductor — Layer 2: Lessons from history.
 *
 * Mine ~/.patchwork-harness/sessions/*.json for past sessions whose goals overlap
 * with this one, summarise their outcomes, and inject as evidence into
 * the planner prompt. TF-IDF scoring keeps it cheap and dependency-free.
 *
 * See DECISIONS/0008-smart-conductor.md §Layer 2.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR } from "../util/paths.js";

export interface SessionSummary {
  session_id: string;
  goal: string;
  started_at: string;
  age_human: string;
  step_count: number;
  models: string[];
  status: string;
  total_cost_usd: number;
  duration_ms: number;
  similarity: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "have", "has",
  "into", "your", "their", "them", "are", "was", "were", "will", "would",
  "could", "should", "what", "when", "where", "which", "while", "after",
  "before", "all", "but", "not", "make", "made", "use", "using", "used",
  "add", "set", "get", "need", "needs", "needed", "want",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_-]+/g)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

function ageHuman(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const days = Math.floor((now - then) / (1000 * 60 * 60 * 24));
  if (days < 1) {
    const hours = Math.floor((now - then) / (1000 * 60 * 60));
    return hours <= 1 ? "just now" : `${hours} hours ago`;
  }
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

interface RawSession {
  sessionId?: string;
  goal?: string;
  started_at?: string;
  ended_at?: string;
  total_cost_usd?: number;
  status?: string;
  results?: { step?: { model?: string }; duration_ms?: number }[];
  plan?: { steps?: { model?: string }[] };
}

function loadSessions(daysBack: number): RawSession[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const out: RawSession[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(SESSIONS_DIR);
  } catch {
    return [];
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const data = JSON.parse(readFileSync(join(SESSIONS_DIR, name), "utf8")) as RawSession;
      const ts = Date.parse(data.started_at ?? "");
      if (Number.isFinite(ts) && ts >= cutoff) out.push(data);
    } catch {
      /* skip unreadable */
    }
  }
  return out;
}

function score(query: string[], doc: string[]): number {
  if (doc.length === 0) return 0;
  const docFreq = new Map<string, number>();
  for (const t of doc) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  let s = 0;
  for (const t of query) {
    const f = docFreq.get(t);
    if (f) s += 1 + Math.log(f); // simple TF-only score
  }
  // Length normalisation so long-goal docs don't drown short ones
  return s / Math.sqrt(doc.length);
}

function summarise(s: RawSession, similarity: number): SessionSummary {
  const stepResults = s.results ?? [];
  const planSteps = s.plan?.steps ?? [];
  const modelsRaw = stepResults.map((r) => r.step?.model).concat(planSteps.map((p) => p.model));
  const models = Array.from(new Set(modelsRaw.filter((m): m is string => Boolean(m))));
  let duration_ms = 0;
  for (const r of stepResults) duration_ms += r.duration_ms ?? 0;
  return {
    session_id: s.sessionId ?? "",
    goal: s.goal ?? "",
    started_at: s.started_at ?? "",
    age_human: s.started_at ? ageHuman(s.started_at) : "?",
    step_count: planSteps.length || stepResults.length,
    models,
    status: s.status ?? "unknown",
    total_cost_usd: s.total_cost_usd ?? 0,
    duration_ms,
    similarity,
  };
}

/**
 * Find sessions similar to `goal`. Returns at most `limit`, sorted by
 * similarity desc, restricted to the last `daysBack` days.
 */
export async function findSimilarSessions(
  goal: string,
  limit = 10,
  daysBack = 60,
): Promise<SessionSummary[]> {
  const query = tokenize(goal);
  if (query.length === 0) return [];
  const sessions = loadSessions(daysBack);
  const scored: SessionSummary[] = [];
  for (const s of sessions) {
    if (!s.goal) continue;
    const docTokens = tokenize(s.goal);
    const sim = score(query, docTokens);
    if (sim <= 0) continue;
    scored.push(summarise(s, sim));
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, limit);
}

/**
 * Render a list of sessions as the markdown block injected into the
 * planner prompt. Shape mirrors the example in ADR-0008.
 */
export function renderLessons(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return "";
  const lines = ["### Evidence from past sessions like this"];
  for (const s of sessions) {
    const tick = s.status === "completed" ? "✓" : "✗";
    const mins = Math.round(s.duration_ms / 60_000);
    const dur = mins > 0 ? `${mins}m` : `${Math.max(1, Math.round(s.duration_ms / 1000))}s`;
    const modelStr =
      s.models.length === 1 ? `${s.models[0]} only` : s.models.join(" + ") || "no model logged";
    const goalShort = s.goal.length > 80 ? `${s.goal.slice(0, 77)}…` : s.goal;
    lines.push(
      `- "${goalShort}" (${s.age_human}) — ${s.step_count} step${s.step_count === 1 ? "" : "s"}, ${modelStr}, ${s.status} in ${dur}, $${s.total_cost_usd.toFixed(2)}. ${tick}`,
    );
  }
  return lines.join("\n");
}
