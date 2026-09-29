/**
 * Memory spine — row + input types. Mirrors the DDL in
 * src/context/schema/001_initial.sql exactly. Keep them in lockstep.
 */

import { z } from "zod";

export const ClaimStatus = z.enum([
  "unverified",
  "supported",
  "contradicted",
  "obsolete",
]);
export type ClaimStatus = z.input<typeof ClaimStatus>;

export const SourceType = z.enum([
  "file",
  "web",
  "notebook",
  "pdf",
  "video",
  "note",
]);
export type SourceType = z.input<typeof SourceType>;

export const ProjectStatus = z.enum(["active", "paused", "archived"]);
export type ProjectStatus = z.input<typeof ProjectStatus>;

// ─── Inputs (what callers hand to the repository) ─────────────────────────

export const ProjectInput = z.object({
  name: z.string().min(1),
  root_path: z.string().optional(),
  status: ProjectStatus.optional().default("active"),
  language: z.string().optional(),
  package_manager: z.string().optional(),
  test_command: z.string().optional(),
  notes: z.string().optional(),
});
export type ProjectInput = z.input<typeof ProjectInput>;

export const DocumentInput = z.object({
  uri: z.string().min(1),
  title: z.string().optional(),
  source_type: SourceType,
  project_id: z.number().int().optional(),
  content_hash: z.string().optional(),
  notebook_id: z.string().optional(),
  metadata_json: z.string().optional(),
});
export type DocumentInput = z.input<typeof DocumentInput>;

export const ChunkInput = z.object({
  document_id: z.number().int(),
  ordinal: z.number().int().min(0),
  text: z.string().min(1),
  token_count: z.number().int().optional(),
  start_offset: z.number().int().optional(),
  end_offset: z.number().int().optional(),
});
export type ChunkInput = z.input<typeof ChunkInput>;

export const ClaimInput = z.object({
  statement: z.string().min(1),
  document_id: z.number().int().optional(),
  page_or_quote: z.string().optional(),
  project_id: z.number().int().optional(),
  confidence: z.number().min(0).max(1).optional().default(0.5),
  status: ClaimStatus.optional().default("unverified"),
  /** Required: who/what produced this claim. e.g. 'user', 'model:gemini-3.5-flash', 'tool:nlm'. */
  created_by: z.string().min(1),
  used_in: z.string().optional(),
  evidence_uri: z.string().optional(),
  expiry_hint: z.string().optional(),
  /** Claim ids this was derived from. Cascade-invalidates when parents become obsolete. */
  depends_on: z.array(z.number().int()).optional(),
});
export type ClaimInput = z.input<typeof ClaimInput>;

export const FileIndexInput = z.object({
  project_id: z.number().int(),
  path: z.string().min(1),
  language: z.string().optional(),
  one_line_summary: z.string().optional(),
  content_hash: z.string().optional(),
});
export type FileIndexInput = z.input<typeof FileIndexInput>;

export const SessionLogInput = z.object({
  session_id: z.string().min(1),
  goal: z.string().optional(),
  project_id: z.number().int().optional(),
  started_at: z.string(),
  ended_at: z.string().optional(),
  status: z.string().optional(),
  total_cost_usd: z.number().optional(),
  summary: z.string().optional(),
  next_action: z.string().optional(),
});
export type SessionLogInput = z.input<typeof SessionLogInput>;

// ─── Row shapes (what the DB hands back) ─────────────────────────────────

export interface ProjectRow {
  id: number;
  name: string;
  root_path: string | null;
  status: ProjectStatus;
  language: string | null;
  package_manager: string | null;
  test_command: string | null;
  last_touched_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface DocumentRow {
  id: number;
  uri: string;
  title: string | null;
  source_type: SourceType;
  project_id: number | null;
  content_hash: string | null;
  notebook_id: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string | null;
  indexed_at: string | null;
}

export interface ChunkRow {
  id: number;
  document_id: number;
  ordinal: number;
  text: string;
  token_count: number | null;
  start_offset: number | null;
  end_offset: number | null;
  created_at: string;
}

export interface ClaimRow {
  id: number;
  statement: string;
  document_id: number | null;
  page_or_quote: string | null;
  project_id: number | null;
  confidence: number;
  status: ClaimStatus;
  created_by: string;
  used_in: string | null;
  evidence_uri: string | null;
  expiry_hint: string | null;
  depends_on_json: string | null;
  created_at: string;
  last_verified_at: string | null;
}

export interface FileIndexRow {
  id: number;
  project_id: number;
  path: string;
  language: string | null;
  one_line_summary: string | null;
  last_seen_at: string | null;
  content_hash: string | null;
}

export interface SessionLogRow {
  session_id: string;
  goal: string | null;
  project_id: number | null;
  started_at: string;
  ended_at: string | null;
  status: string | null;
  total_cost_usd: number | null;
  summary: string | null;
  next_action: string | null;
}

/** Result row for FTS5 search over chunks_fts joined to documents. */
export interface SearchHit {
  chunk_id: number;
  document_id: number;
  document_uri: string;
  document_title: string | null;
  source_type: SourceType;
  ordinal: number;
  text: string;
  /** SQLite's bm25() score: lower is better (it's a distance, not a relevance). */
  bm25: number;
}
