-- Memory spine v0 schema. See DIRECTION.md + DECISIONS/0009 for rationale.
-- One file = one migration; the runner records applied versions in schema_migrations.

-- Projects = things you work on. A "project" is whatever scope makes sense:
-- a git repo, a uni module, a one-off investigation.
CREATE TABLE projects (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT    NOT NULL UNIQUE,
    root_path       TEXT,
    status          TEXT    NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'archived'
    language        TEXT,
    package_manager TEXT,
    test_command    TEXT,
    last_touched_at TEXT,
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Documents = sources we can cite from (files, URLs, NotebookLM notebooks,
-- PDFs, videos, notes). One row per logical source; the actual retrievable
-- text lives in chunks.
CREATE TABLE documents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    uri             TEXT    NOT NULL,
    title           TEXT,
    source_type     TEXT    NOT NULL,  -- 'file' | 'web' | 'notebook' | 'pdf' | 'video' | 'note'
    project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    content_hash    TEXT,
    notebook_id     TEXT,               -- when source_type='notebook', the nlm notebook id
    metadata_json   TEXT,
    created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TEXT,
    indexed_at      TEXT
);
CREATE INDEX idx_documents_project ON documents(project_id);
CREATE INDEX idx_documents_uri     ON documents(uri);

-- Chunks = retrievable units inside documents. FTS lives over THESE, not
-- whole documents, so retrieval stays relevant. ordinal preserves order
-- within a document for reassembly.
CREATE TABLE chunks (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id     INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    ordinal         INTEGER NOT NULL,
    text            TEXT    NOT NULL,
    token_count     INTEGER,
    start_offset    INTEGER,
    end_offset      INTEGER,
    created_at      TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_chunks_document ON chunks(document_id);

-- FTS5 virtual table mirrored to chunks via content= triggers (external
-- content table pattern). Avoids data duplication while keeping search fast.
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
    INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
    INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

-- Claims = atomic statements we want to remember and (eventually) verify.
-- Every claim is provenance-tagged: who/what produced it, how confident,
-- what's its current status. depends_on_json carries claim ids this one
-- was derived from, so an obsolete parent can cascade-invalidate children
-- (see DIRECTION.md, research delta #1).
CREATE TABLE claims (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    statement         TEXT    NOT NULL,
    document_id       INTEGER REFERENCES documents(id) ON DELETE SET NULL,
    page_or_quote     TEXT,
    project_id        INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    confidence        REAL    NOT NULL DEFAULT 0.5,    -- 0.0 - 1.0
    status            TEXT    NOT NULL DEFAULT 'unverified',
        -- 'unverified' | 'supported' | 'contradicted' | 'obsolete'
    created_by        TEXT    NOT NULL,                -- 'user' | 'model:<id>' | 'tool:<name>' | 'system'
    used_in           TEXT,                            -- free-form session/file ref
    evidence_uri      TEXT,
    expiry_hint       TEXT,                            -- 'pricing' | 'api' | 'never' | etc
    depends_on_json   TEXT,                            -- JSON array of claim ids this was derived from
    created_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_verified_at  TEXT,
    CHECK (status IN ('unverified', 'supported', 'contradicted', 'obsolete')),
    CHECK (confidence >= 0.0 AND confidence <= 1.0)
);
CREATE INDEX idx_claims_status  ON claims(status);
CREATE INDEX idx_claims_project ON claims(project_id);

-- File index = per-project file inventory + a one-line "what's in this".
-- The planner reads this to orient quickly in a fresh session.
CREATE TABLE file_index (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path                TEXT    NOT NULL,
    language            TEXT,
    one_line_summary    TEXT,
    last_seen_at        TEXT,
    content_hash        TEXT,
    UNIQUE(project_id, path)
);

-- Sessions log = thin link between patchwork-harness sessions and their outcomes.
-- next_action is the resume target.
CREATE TABLE sessions_log (
    session_id      TEXT    PRIMARY KEY,
    goal            TEXT,
    project_id      INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    started_at      TEXT    NOT NULL,
    ended_at        TEXT,
    status          TEXT,                              -- 'completed' | 'failed' | 'denied' | 'bedrock_aborted' | 'in_progress'
    total_cost_usd  REAL,
    summary         TEXT,
    next_action     TEXT
);
CREATE INDEX idx_sessions_ended_at ON sessions_log(ended_at);

-- Migration bookkeeping. The runner inserts a row per applied version.
CREATE TABLE schema_migrations (
    version     INTEGER PRIMARY KEY,
    applied_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    name        TEXT    NOT NULL
);
