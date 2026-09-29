/**
 * context_search — FTS5 search over the memory spine's chunks (and,
 * optionally, claims). Read-only. The executor uses this before doing
 * work to recall what we already know about a question.
 */

import { z } from "zod";
import { getInitialisedContextDb } from "../context/db.js";
import { searchChunks, listClaims, getProjectByName } from "../context/repository.js";
import type { Tool } from "./base.js";

const Input = z.object({
  query: z.string().min(1).describe("FTS5 MATCH expression. Plain text works; for prefix use `term*`, for phrase use `\"exact phrase\"`."),
  limit: z.number().int().min(1).max(100).default(10).describe("Max hits per source (default 10)."),
  project: z.string().optional().describe("Restrict to a project by name."),
  source_type: z.enum(["file", "web", "notebook", "pdf", "video", "note"]).optional().describe("Restrict chunks to a single source type."),
  include_claims: z.boolean().default(false).describe("Also include matching claims (text LIKE) alongside chunk hits."),
});
type In = z.infer<typeof Input>;

export interface SearchResult {
  type: "chunk" | "claim";
  id: number;
  text: string;
  source: string;
  score?: number;
  meta?: Record<string, unknown>;
}

export const contextSearchTool: Tool<In, { results: SearchResult[]; count: number }> = {
  name: "context_search",
  description:
    "Search the durable memory spine (patchwork-harness's local SQLite store) for relevant chunks of prior context. Use this BEFORE doing research to see what we already know — saves tokens and avoids re-fetching. Returns FTS5 BM25-ranked chunks (+ optional claims). Read-only.",
  inputSchema: Input,
  assess: () => ({ level: "none", flags: [] }),
  preview: (i) => ({ description: `context_search "${i.query.slice(0, 60)}" (limit=${i.limit ?? 10})` }),
  async run(input) {
    const db = await getInitialisedContextDb();
    const project_id = input.project
      ? getProjectByName(db, input.project)?.id
      : undefined;

    const hits = searchChunks(db, input.query, {
      limit: input.limit,
      project_id: project_id ?? undefined,
      source_type: input.source_type,
    });
    const results: SearchResult[] = hits.map((h) => ({
      type: "chunk",
      id: h.chunk_id,
      text: h.text,
      source: h.document_title ?? h.document_uri,
      score: h.bm25,
      meta: { document_id: h.document_id, ordinal: h.ordinal, source_type: h.source_type },
    }));

    if (input.include_claims) {
      // FTS5 doesn't directly index claims; LIKE match is good enough for the
      // small claim count we'll have in practice. We exclude obsolete claims
      // by default so stale beliefs don't contaminate retrieval.
      const allClaims = listClaims(db, { limit: input.limit * 2 });
      const q = input.query.toLowerCase();
      for (const c of allClaims) {
        if (c.status === "obsolete" || c.status === "contradicted") continue;
        if (!c.statement.toLowerCase().includes(q)) continue;
        results.push({
          type: "claim",
          id: c.id,
          text: c.statement,
          source: c.evidence_uri ?? `claim:${c.id}`,
          meta: { status: c.status, confidence: c.confidence, created_by: c.created_by },
        });
        if (results.length >= input.limit * 2) break;
      }
    }

    return { results, count: results.length };
  },
};
