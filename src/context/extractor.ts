/**
 * Session extractor. Reads an audit JSONL file (the
 * ~/.patchwork-harness/events/<session>.jsonl Patchwork-shape log) and produces a
 * structured `ExtractedSession` ready to be written into the memory spine.
 *
 * Deliberately conservative. V1 extracts:
 *   - the session row (goal, status, started/ended, cost)
 *   - touched files (write/edit/git_commit targets) into a file_index list
 *   - an auto-summary string + a searchable session "document" + chunk so
 *     future `context_search` finds prior session memory
 *
 * V1 does NOT extract `claims` from prose. Auto-claim extraction is high
 * false-positive risk and would pollute the spine. Claims should be
 * written explicitly via `context_write { kind: 'claim', ... }` with
 * proper provenance.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface AuditEvent {
  id?: string;
  session_id: string;
  timestamp: string;
  action: string;
  status?: string;
  target?: Record<string, unknown>;
  content?: { hash?: string; size_bytes?: number; redacted?: boolean };
  provenance?: Record<string, unknown>;
  project?: { root?: string; name?: string };
}

export interface ExtractedFileTouch {
  path: string;
  action: "write" | "edit" | "git_commit" | "delete";
  last_seen_at: string;
}

export interface ExtractedSession {
  session_id: string;
  project_name: string | null;
  project_root: string | null;
  goal: string | null;
  started_at: string | null;
  ended_at: string | null;
  status: string | null;
  total_cost_usd: number | null;
  summary: string;
  next_action: string | null;
  file_touches: ExtractedFileTouch[];
  step_count: number;
  /** Raw event count, useful for diagnostics. */
  event_count: number;
}

function eventsPath(session_id: string): string {
  const home = process.env.PATCHWORK_HARNESS_HOME ?? join(homedir(), ".patchwork-harness");
  return join(home, "events", `${session_id}.jsonl`);
}

function readJsonl(path: string): AuditEvent[] {
  if (!existsSync(path)) {
    throw new Error(`audit JSONL not found: ${path}`);
  }
  const text = readFileSync(path, "utf8");
  const out: AuditEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEvent);
    } catch {
      // Skip malformed lines silently — we'd rather extract what we can than fail.
    }
  }
  return out;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

/** Pull `path` out of an event's `target` if present, normalising key
 *  names some tools use (path / file / abs_path). */
function targetPath(t: Record<string, unknown> | undefined): string | null {
  if (!t) return null;
  for (const k of ["path", "file", "abs_path", "target_path"]) {
    const v = t[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

// Mirrors src/audit.ts KEY_PATTERNS. Extractor writes its own derived
// strings (goal, summary, next_action) into the spine — those weren't
// covered by audit.ts redaction at write time because audit redacts
// `target`/`provenance` JSON shapes, not the free-form text the extractor
// later assembles. Re-redact here so a user goal like "my key is pplx-..."
// never lands in the memory spine in plaintext.
const SECRET_REGEXES = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-(?:proj|live|test|admin|user|svcacct)-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /pplx-[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /xox[bpars]-[A-Za-z0-9-]{20,}/g,
  /xai-[A-Za-z0-9_-]{20,}/g,
  /hf_[A-Za-z0-9]{20,}/g,
  /npm_[A-Za-z0-9]{30,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Redact known secret shapes from any string that will be persisted to the
 *  spine. Returns the input unchanged if no patterns match. */
export function redactSecrets(s: string | null): string | null {
  if (!s) return s;
  let out = s;
  for (const re of SECRET_REGEXES) out = out.replace(re, "[REDACTED-KEY]");
  return out;
}

function buildSummary(s: Omit<ExtractedSession, "summary">): string {
  const parts: string[] = [];
  if (s.goal) parts.push(`Goal: ${s.goal.slice(0, 240)}`);
  if (s.status) parts.push(`Status: ${s.status}`);
  if (s.step_count) parts.push(`Steps: ${s.step_count}`);
  if (typeof s.total_cost_usd === "number") parts.push(`Cost: $${s.total_cost_usd.toFixed(4)}`);
  if (s.file_touches.length) {
    const sample = s.file_touches.slice(0, 6).map((f) => f.path).join(", ");
    const more = s.file_touches.length > 6 ? `, +${s.file_touches.length - 6} more` : "";
    parts.push(`Touched: ${sample}${more}`);
  }
  if (s.next_action) parts.push(`Next: ${s.next_action}`);
  return parts.join(" · ");
}

function inferNextAction(
  status: string | null,
  step_count: number,
  goal: string | null,
): string | null {
  if (status === "failed") return "Investigate the failure and retry";
  if (status === "bedrock_aborted") return "Raise bedrock cap or trim scope, then retry";
  if (status === "denied") return "Re-approve or adjust permissions";
  if (status === "completed" && step_count > 0 && goal) {
    return `Verify outcome of: ${goal.slice(0, 120)}`;
  }
  return null;
}

/** Extract from an in-memory event list (used by both the file path and
 *  tests that build events directly). */
export function extractFromEvents(events: AuditEvent[]): ExtractedSession {
  if (events.length === 0) {
    throw new Error("extractor: no events to extract from");
  }
  const session_id = events[0]?.session_id ?? "";
  let project_name: string | null = null;
  let project_root: string | null = null;
  let goal: string | null = null;
  let started_at: string | null = null;
  let ended_at: string | null = null;
  let status: string | null = null;
  let total_cost_usd: number | null = null;
  let step_count = 0;
  const touchesByPath = new Map<string, ExtractedFileTouch>();

  for (const e of events) {
    if (e.project) {
      project_name = project_name ?? asString(e.project.name);
      project_root = project_root ?? asString(e.project.root);
    }
    switch (e.action) {
      case "session_start": {
        started_at = started_at ?? e.timestamp;
        goal = goal ?? asString(e.target?.goal);
        break;
      }
      case "session_end": {
        ended_at = e.timestamp;
        status = asString(e.provenance?.final_status) ?? e.status ?? status;
        total_cost_usd = asNumber(e.provenance?.total_cost_usd) ?? total_cost_usd;
        break;
      }
      case "step_start": {
        step_count += 1;
        break;
      }
      // Patchwork Harness emits the file path on `tool_use_start` (tool_use_end
      // tracks only the tool name + content hash). We record on either
      // event that carries a path so we never miss a touch.
      case "tool_use_start":
      case "tool_use_end": {
        const tool = asString(e.target?.tool);
        const path = targetPath(e.target);
        if (path && (tool === "write" || tool === "edit")) {
          touchesByPath.set(path, {
            path,
            action: tool,
            last_seen_at: e.timestamp,
          });
        }
        break;
      }
      case "git_commit": {
        const files = e.target?.files;
        if (Array.isArray(files)) {
          for (const f of files) {
            if (typeof f === "string") {
              touchesByPath.set(f, { path: f, action: "git_commit", last_seen_at: e.timestamp });
            }
          }
        }
        break;
      }
    }
  }

  const file_touches = [...touchesByPath.values()];
  const next_action = inferNextAction(status, step_count, goal);

  // Apply secret redaction to every free-form string before it lands in
  // the spine. A user's goal can easily contain a pasted token; we'd
  // rather over-redact than persist a key.
  const partial: Omit<ExtractedSession, "summary"> = {
    session_id,
    project_name,
    project_root,
    goal: redactSecrets(goal),
    started_at,
    ended_at,
    status,
    total_cost_usd,
    next_action: redactSecrets(next_action),
    file_touches,
    step_count,
    event_count: events.length,
  };

  return { ...partial, summary: redactSecrets(buildSummary(partial)) ?? "" };
}

/** Load an audit JSONL by session id and extract. */
export function extractFromSession(session_id: string): ExtractedSession {
  return extractFromEvents(readJsonl(eventsPath(session_id)));
}

/** Load an audit JSONL by path. Used by the manual backfill CLI. */
export function extractFromFile(path: string): ExtractedSession {
  return extractFromEvents(readJsonl(path));
}
