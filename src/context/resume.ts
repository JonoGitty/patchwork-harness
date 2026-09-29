/**
 * Build a "resume packet" from the memory spine — what was I doing last
 * time, what matters in this project, what should I do next, and where
 * are the relevant files.
 *
 * This is the orient-yourself read used by `patchwork-harness resume`. It does NOT
 * mutate state and never auto-injects into an active session. (Planner
 * injection lives in Phase 5 / world_view.ts.)
 */

import type Sqlite from "better-sqlite3";
import {
  ClaimRow,
  FileIndexRow,
  ProjectRow,
  SessionLogRow,
} from "./types.js";

export interface ResumePacket {
  /** The session this packet was built around. */
  session: SessionLogRow | null;
  /** The session's project (or the requested one), if any. */
  project: ProjectRow | null;
  /** Prior sessions in the same project, newest-first, excluding `session`. */
  prior_sessions: SessionLogRow[];
  /** Recently-touched files in the project. */
  files: FileIndexRow[];
  /** Recent active (supported / unverified) claims in the project. */
  claims: ClaimRow[];
}

export interface BuildResumeOpts {
  session_id?: string;
  project_name?: string;
  prior_limit?: number;
  files_limit?: number;
  claims_limit?: number;
}

/**
 * Pick the "current" session per the documented precedence:
 *   1. explicit --session <id>            -> exactly that one
 *   2. explicit --project <name>          -> latest session in that project
 *   3. neither                            -> latest session across everything
 */
function pickSession(
  db: Sqlite.Database,
  opts: BuildResumeOpts,
): SessionLogRow | null {
  if (opts.session_id) {
    return (db.prepare("SELECT * FROM sessions_log WHERE session_id = ?")
      .get(opts.session_id) as SessionLogRow) ?? null;
  }
  if (opts.project_name) {
    const p = db.prepare("SELECT id FROM projects WHERE name = ?")
      .get(opts.project_name) as { id: number } | undefined;
    if (!p) return null;
    return (db.prepare(
      "SELECT * FROM sessions_log WHERE project_id = ? ORDER BY started_at DESC LIMIT 1",
    ).get(p.id) as SessionLogRow) ?? null;
  }
  return (db.prepare("SELECT * FROM sessions_log ORDER BY started_at DESC LIMIT 1")
    .get() as SessionLogRow) ?? null;
}

function findProject(
  db: Sqlite.Database,
  session: SessionLogRow | null,
  opts: BuildResumeOpts,
): ProjectRow | null {
  if (opts.project_name) {
    return (db.prepare("SELECT * FROM projects WHERE name = ?")
      .get(opts.project_name) as ProjectRow) ?? null;
  }
  if (session?.project_id !== null && session?.project_id !== undefined) {
    return (db.prepare("SELECT * FROM projects WHERE id = ?")
      .get(session.project_id) as ProjectRow) ?? null;
  }
  return null;
}

export function buildResumePacket(
  db: Sqlite.Database,
  opts: BuildResumeOpts = {},
): ResumePacket {
  const session = pickSession(db, opts);
  const project = findProject(db, session, opts);

  const prior_limit = opts.prior_limit ?? 3;
  const files_limit = opts.files_limit ?? 8;
  const claims_limit = opts.claims_limit ?? 8;

  let prior_sessions: SessionLogRow[] = [];
  let files: FileIndexRow[] = [];
  let claims: ClaimRow[] = [];

  if (project) {
    prior_sessions = db.prepare(`
      SELECT * FROM sessions_log
      WHERE project_id = ? AND session_id != COALESCE(?, '')
      ORDER BY started_at DESC LIMIT ?
    `).all(project.id, session?.session_id ?? null, prior_limit) as SessionLogRow[];

    files = db.prepare(`
      SELECT * FROM file_index
      WHERE project_id = ?
      ORDER BY last_seen_at DESC LIMIT ?
    `).all(project.id, files_limit) as FileIndexRow[];

    claims = db.prepare(`
      SELECT * FROM claims
      WHERE project_id = ? AND status IN ('supported', 'unverified')
      ORDER BY created_at DESC LIMIT ?
    `).all(project.id, claims_limit) as ClaimRow[];
  } else if (session) {
    // No project linked, still surface prior sessions globally.
    prior_sessions = db.prepare(`
      SELECT * FROM sessions_log
      WHERE session_id != ?
      ORDER BY started_at DESC LIMIT ?
    `).all(session.session_id, prior_limit) as SessionLogRow[];
  }

  return { session, project, prior_sessions, files, claims };
}

/** Render a compact text view of a resume packet. */
export function renderResumePacket(p: ResumePacket): string {
  const lines: string[] = [];
  if (!p.session) {
    return "(no resumable session — the spine is empty or your filter matched nothing)";
  }
  lines.push(`Session: ${p.session.session_id}  (status=${p.session.status ?? "?"})`);
  if (p.session.goal) lines.push(`Goal:    ${p.session.goal}`);
  if (p.session.next_action) lines.push(`Next:    ${p.session.next_action}`);
  if (typeof p.session.total_cost_usd === "number")
    lines.push(`Cost:    $${p.session.total_cost_usd.toFixed(4)}`);
  if (p.session.summary) lines.push(`Summary: ${p.session.summary}`);
  if (p.project) lines.push(`Project: ${p.project.name}${p.project.root_path ? ` (${p.project.root_path})` : ""}`);
  lines.push("");

  if (p.prior_sessions.length) {
    lines.push(`Prior sessions (${p.prior_sessions.length}):`);
    for (const s of p.prior_sessions) {
      const cost = typeof s.total_cost_usd === "number" ? ` $${s.total_cost_usd.toFixed(4)}` : "";
      lines.push(`  • ${s.session_id}${cost}  ${s.status ?? "?"}  ${s.goal?.slice(0, 80) ?? ""}`);
    }
    lines.push("");
  }

  if (p.files.length) {
    lines.push(`Recently touched files (${p.files.length}):`);
    for (const f of p.files) {
      lines.push(`  • ${f.path}${f.one_line_summary ? `  — ${f.one_line_summary}` : ""}`);
    }
    lines.push("");
  }

  if (p.claims.length) {
    lines.push(`Active claims (${p.claims.length}):`);
    for (const c of p.claims) {
      lines.push(`  [${c.status} ${c.confidence.toFixed(2)} by ${c.created_by}] ${c.statement.slice(0, 120)}`);
    }
  }

  return lines.join("\n");
}
