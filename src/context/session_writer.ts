/**
 * Session writer. Turns an `ExtractedSession` into rows on the memory
 * spine. Idempotent: re-running for the same session_id upserts the
 * sessions_log row, refreshes file_index entries, and skips creating a
 * duplicate session-summary document if one already exists.
 *
 * Errors here MUST NOT take down the executor — callers should
 * `try { writeExtractedSession(...) } catch (e) { log.warn(...) }`.
 */

import type Sqlite from "better-sqlite3";
import {
  insertChunksForDocument,
  insertDocument,
  upsertFileIndex,
  upsertProject,
  upsertSessionLog,
} from "./repository.js";
import type { ExtractedSession } from "./extractor.js";

export interface WriteResult {
  session_id: string;
  project_id: number | null;
  sessions_log_written: boolean;
  files_touched: number;
  summary_document_id: number | null;
}

const SESSION_DOC_URI = (session_id: string) => `session://${session_id}`;

function existingSummaryDocumentId(db: Sqlite.Database, session_id: string): number | null {
  const row = db
    .prepare("SELECT id FROM documents WHERE uri = ? LIMIT 1")
    .get(SESSION_DOC_URI(session_id)) as { id: number } | undefined;
  return row?.id ?? null;
}

export function writeExtractedSession(
  db: Sqlite.Database,
  s: ExtractedSession,
): WriteResult {
  // 1. Upsert the project (if any) so we have an id to link rows to.
  let project_id: number | null = null;
  if (s.project_name) {
    const p = upsertProject(db, {
      name: s.project_name,
      root_path: s.project_root ?? undefined,
    });
    project_id = p.id;
  }

  // 2. Upsert the sessions_log row.
  upsertSessionLog(db, {
    session_id: s.session_id,
    goal: s.goal ?? undefined,
    project_id: project_id ?? undefined,
    started_at: s.started_at ?? new Date().toISOString(),
    ended_at: s.ended_at ?? undefined,
    status: s.status ?? undefined,
    total_cost_usd: s.total_cost_usd ?? undefined,
    summary: s.summary,
    next_action: s.next_action ?? undefined,
  });

  // 3. Upsert file_index for every touched file (deduped by path within
  //    the extractor already).
  if (project_id !== null) {
    for (const t of s.file_touches) {
      upsertFileIndex(db, { project_id, path: t.path });
    }
  }

  // 4. Create or skip the searchable session-summary document. We use
  //    the URI `session://<session_id>` so it's an idempotent key.
  let summary_document_id = existingSummaryDocumentId(db, s.session_id);
  if (summary_document_id === null && s.summary) {
    const doc = insertDocument(db, {
      uri: SESSION_DOC_URI(s.session_id),
      title: s.goal ? `session: ${s.goal.slice(0, 80)}` : `session ${s.session_id}`,
      source_type: "note",
      project_id: project_id ?? undefined,
    });
    insertChunksForDocument(db, doc.id, [s.summary]);
    summary_document_id = doc.id;
  }

  return {
    session_id: s.session_id,
    project_id,
    sessions_log_written: true,
    files_touched: s.file_touches.length,
    summary_document_id,
  };
}
