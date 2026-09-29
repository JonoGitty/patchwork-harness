/**
 * Typed CRUD + search helpers over the memory spine. Validates inputs
 * with zod before they ever hit SQLite; returns plain row objects.
 *
 * No raw-SQL mutations are exposed. Search returns FTS5 bm25 hits joined
 * to documents so callers know provenance without a second query.
 */

import type Sqlite from "better-sqlite3";
import {
  ChunkInput,
  ChunkRow,
  ClaimInput,
  ClaimRow,
  DocumentInput,
  DocumentRow,
  FileIndexInput,
  FileIndexRow,
  ProjectInput,
  ProjectRow,
  SearchHit,
  SessionLogInput,
  SessionLogRow,
} from "./types.js";

// ─── projects ────────────────────────────────────────────────────────────

export function upsertProject(db: Sqlite.Database, input: ProjectInput): ProjectRow {
  const p = ProjectInput.parse(input);
  const stmt = db.prepare(`
    INSERT INTO projects(name, root_path, status, language, package_manager, test_command, notes)
    VALUES (@name, @root_path, @status, @language, @package_manager, @test_command, @notes)
    ON CONFLICT(name) DO UPDATE SET
      root_path        = COALESCE(excluded.root_path, projects.root_path),
      status           = excluded.status,
      language         = COALESCE(excluded.language, projects.language),
      package_manager  = COALESCE(excluded.package_manager, projects.package_manager),
      test_command     = COALESCE(excluded.test_command, projects.test_command),
      notes            = COALESCE(excluded.notes, projects.notes),
      last_touched_at  = CURRENT_TIMESTAMP
    RETURNING *
  `);
  return stmt.get({
    name: p.name,
    root_path: p.root_path ?? null,
    status: p.status,
    language: p.language ?? null,
    package_manager: p.package_manager ?? null,
    test_command: p.test_command ?? null,
    notes: p.notes ?? null,
  }) as ProjectRow;
}

export function listProjects(db: Sqlite.Database): ProjectRow[] {
  return db.prepare("SELECT * FROM projects ORDER BY last_touched_at DESC, id DESC").all() as ProjectRow[];
}

export function getProjectByName(db: Sqlite.Database, name: string): ProjectRow | null {
  return (db.prepare("SELECT * FROM projects WHERE name = ?").get(name) as ProjectRow) ?? null;
}

// ─── documents ───────────────────────────────────────────────────────────

export function insertDocument(db: Sqlite.Database, input: DocumentInput): DocumentRow {
  const d = DocumentInput.parse(input);
  const stmt = db.prepare(`
    INSERT INTO documents(uri, title, source_type, project_id, content_hash, notebook_id, metadata_json)
    VALUES (@uri, @title, @source_type, @project_id, @content_hash, @notebook_id, @metadata_json)
    RETURNING *
  `);
  return stmt.get({
    uri: d.uri,
    title: d.title ?? null,
    source_type: d.source_type,
    project_id: d.project_id ?? null,
    content_hash: d.content_hash ?? null,
    notebook_id: d.notebook_id ?? null,
    metadata_json: d.metadata_json ?? null,
  }) as DocumentRow;
}

export function listDocuments(
  db: Sqlite.Database,
  opts?: { project_id?: number; limit?: number },
): DocumentRow[] {
  const limit = opts?.limit ?? 50;
  if (opts?.project_id !== undefined) {
    return db
      .prepare("SELECT * FROM documents WHERE project_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(opts.project_id, limit) as DocumentRow[];
  }
  return db
    .prepare("SELECT * FROM documents ORDER BY created_at DESC LIMIT ?")
    .all(limit) as DocumentRow[];
}

// ─── chunks ──────────────────────────────────────────────────────────────

export function insertChunk(db: Sqlite.Database, input: ChunkInput): ChunkRow {
  const c = ChunkInput.parse(input);
  const stmt = db.prepare(`
    INSERT INTO chunks(document_id, ordinal, text, token_count, start_offset, end_offset)
    VALUES (@document_id, @ordinal, @text, @token_count, @start_offset, @end_offset)
    RETURNING *
  `);
  return stmt.get({
    document_id: c.document_id,
    ordinal: c.ordinal,
    text: c.text,
    token_count: c.token_count ?? null,
    start_offset: c.start_offset ?? null,
    end_offset: c.end_offset ?? null,
  }) as ChunkRow;
}

export function insertChunksForDocument(
  db: Sqlite.Database,
  document_id: number,
  texts: string[],
): ChunkRow[] {
  if (texts.length === 0) return [];
  const insertStmt = db.prepare(`
    INSERT INTO chunks(document_id, ordinal, text)
    VALUES (@document_id, @ordinal, @text)
    RETURNING *
  `);
  const out: ChunkRow[] = [];
  db.transaction(() => {
    for (let i = 0; i < texts.length; i++) {
      out.push(
        insertStmt.get({ document_id, ordinal: i, text: texts[i] }) as ChunkRow,
      );
    }
  })();
  return out;
}

// ─── claims ──────────────────────────────────────────────────────────────

export function insertClaim(db: Sqlite.Database, input: ClaimInput): ClaimRow {
  const c = ClaimInput.parse(input);
  const stmt = db.prepare(`
    INSERT INTO claims(statement, document_id, page_or_quote, project_id, confidence,
                       status, created_by, used_in, evidence_uri, expiry_hint, depends_on_json)
    VALUES (@statement, @document_id, @page_or_quote, @project_id, @confidence,
            @status, @created_by, @used_in, @evidence_uri, @expiry_hint, @depends_on_json)
    RETURNING *
  `);
  return stmt.get({
    statement: c.statement,
    document_id: c.document_id ?? null,
    page_or_quote: c.page_or_quote ?? null,
    project_id: c.project_id ?? null,
    confidence: c.confidence,
    status: c.status,
    created_by: c.created_by,
    used_in: c.used_in ?? null,
    evidence_uri: c.evidence_uri ?? null,
    expiry_hint: c.expiry_hint ?? null,
    depends_on_json: c.depends_on ? JSON.stringify(c.depends_on) : null,
  }) as ClaimRow;
}

export function listClaims(
  db: Sqlite.Database,
  opts?: { status?: string; project_id?: number; limit?: number },
): ClaimRow[] {
  const limit = opts?.limit ?? 50;
  const where: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (opts?.status) {
    where.push("status = @status");
    params.status = opts.status;
  }
  if (opts?.project_id !== undefined) {
    where.push("project_id = @project_id");
    params.project_id = opts.project_id;
  }
  const sql = `
    SELECT * FROM claims
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC
    LIMIT @limit
  `;
  return db.prepare(sql).all(params) as ClaimRow[];
}

export function setClaimStatus(
  db: Sqlite.Database,
  id: number,
  status: ClaimInput["status"],
): ClaimRow | null {
  const stmt = db.prepare(`
    UPDATE claims SET status = ?, last_verified_at = CURRENT_TIMESTAMP
    WHERE id = ? RETURNING *
  `);
  return (stmt.get(status, id) as ClaimRow) ?? null;
}

// ─── file_index ──────────────────────────────────────────────────────────

export function upsertFileIndex(db: Sqlite.Database, input: FileIndexInput): FileIndexRow {
  const f = FileIndexInput.parse(input);
  const stmt = db.prepare(`
    INSERT INTO file_index(project_id, path, language, one_line_summary, content_hash, last_seen_at)
    VALUES (@project_id, @path, @language, @one_line_summary, @content_hash, CURRENT_TIMESTAMP)
    ON CONFLICT(project_id, path) DO UPDATE SET
      language         = COALESCE(excluded.language, file_index.language),
      one_line_summary = COALESCE(excluded.one_line_summary, file_index.one_line_summary),
      content_hash     = COALESCE(excluded.content_hash, file_index.content_hash),
      last_seen_at     = CURRENT_TIMESTAMP
    RETURNING *
  `);
  return stmt.get({
    project_id: f.project_id,
    path: f.path,
    language: f.language ?? null,
    one_line_summary: f.one_line_summary ?? null,
    content_hash: f.content_hash ?? null,
  }) as FileIndexRow;
}

// ─── sessions_log ────────────────────────────────────────────────────────

export function upsertSessionLog(db: Sqlite.Database, input: SessionLogInput): SessionLogRow {
  const s = SessionLogInput.parse(input);
  const stmt = db.prepare(`
    INSERT INTO sessions_log(session_id, goal, project_id, started_at, ended_at,
                             status, total_cost_usd, summary, next_action)
    VALUES (@session_id, @goal, @project_id, @started_at, @ended_at,
            @status, @total_cost_usd, @summary, @next_action)
    ON CONFLICT(session_id) DO UPDATE SET
      goal           = COALESCE(excluded.goal,            sessions_log.goal),
      project_id     = COALESCE(excluded.project_id,      sessions_log.project_id),
      ended_at       = COALESCE(excluded.ended_at,        sessions_log.ended_at),
      status         = COALESCE(excluded.status,          sessions_log.status),
      total_cost_usd = COALESCE(excluded.total_cost_usd,  sessions_log.total_cost_usd),
      summary        = COALESCE(excluded.summary,         sessions_log.summary),
      next_action    = COALESCE(excluded.next_action,     sessions_log.next_action)
    RETURNING *
  `);
  return stmt.get({
    session_id: s.session_id,
    goal: s.goal ?? null,
    project_id: s.project_id ?? null,
    started_at: s.started_at,
    ended_at: s.ended_at ?? null,
    status: s.status ?? null,
    total_cost_usd: s.total_cost_usd ?? null,
    summary: s.summary ?? null,
    next_action: s.next_action ?? null,
  }) as SessionLogRow;
}

export function latestSession(
  db: Sqlite.Database,
  opts?: { project_id?: number },
): SessionLogRow | null {
  if (opts?.project_id !== undefined) {
    return (db
      .prepare("SELECT * FROM sessions_log WHERE project_id = ? ORDER BY started_at DESC LIMIT 1")
      .get(opts.project_id) as SessionLogRow) ?? null;
  }
  return (db
    .prepare("SELECT * FROM sessions_log ORDER BY started_at DESC LIMIT 1")
    .get() as SessionLogRow) ?? null;
}

// ─── search (FTS5 over chunks) ──────────────────────────────────────────

/**
 * Full-text search across chunks. Returns top-N hits ordered by BM25
 * (lower bm25 score = more relevant; we expose it raw so callers can
 * mix it with recency / status if they want a custom rank).
 *
 * Caller is responsible for escaping FTS5 metacharacters in `query` if
 * the input came from the model; we treat the query as a literal FTS5
 * MATCH expression (lets advanced users use prefix/phrase syntax).
 */
export function searchChunks(
  db: Sqlite.Database,
  query: string,
  opts?: { limit?: number; project_id?: number; source_type?: string },
): SearchHit[] {
  const limit = opts?.limit ?? 10;
  const where: string[] = ["chunks_fts MATCH @query"];
  const params: Record<string, unknown> = { query, limit };
  if (opts?.project_id !== undefined) {
    where.push("d.project_id = @project_id");
    params.project_id = opts.project_id;
  }
  if (opts?.source_type) {
    where.push("d.source_type = @source_type");
    params.source_type = opts.source_type;
  }
  const sql = `
    SELECT
      c.id          AS chunk_id,
      c.document_id AS document_id,
      d.uri         AS document_uri,
      d.title       AS document_title,
      d.source_type AS source_type,
      c.ordinal     AS ordinal,
      c.text        AS text,
      bm25(chunks_fts) AS bm25
    FROM chunks_fts
    JOIN chunks    c ON c.id = chunks_fts.rowid
    JOIN documents d ON d.id = c.document_id
    WHERE ${where.join(" AND ")}
    ORDER BY bm25
    LIMIT @limit
  `;
  return db.prepare(sql).all(params) as SearchHit[];
}

// ─── high-level status summary (for `patchwork-harness context status`) ────────────

export interface ContextStatus {
  db_path: string;
  schema_version: number | null;
  counts: {
    projects: number;
    documents: number;
    chunks: number;
    claims: number;
    file_index: number;
    sessions_log: number;
  };
  claims_by_status: Record<string, number>;
}

export function status(db: Sqlite.Database, db_path: string): ContextStatus {
  const count = (t: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const versionRow = db
    .prepare("SELECT MAX(version) AS v FROM schema_migrations")
    .get() as { v: number | null };
  const byStatus = db
    .prepare("SELECT status, COUNT(*) AS n FROM claims GROUP BY status")
    .all() as Array<{ status: string; n: number }>;
  const claims_by_status: Record<string, number> = {};
  for (const r of byStatus) claims_by_status[r.status] = r.n;
  return {
    db_path,
    schema_version: versionRow.v,
    counts: {
      projects: count("projects"),
      documents: count("documents"),
      chunks: count("chunks"),
      claims: count("claims"),
      file_index: count("file_index"),
      sessions_log: count("sessions_log"),
    },
    claims_by_status,
  };
}
