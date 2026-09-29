/**
 * context_write — structured insert into the memory spine. Discriminated
 * by `kind` so the LLM picks the right shape rather than crafting raw
 * SQL. Inputs are validated by zod before they ever touch the DB.
 *
 * Auto-extraction code (Phase 3) will call this on session end. The
 * executor can also call it during a step to record a verified claim.
 */

import { z } from "zod";
import { getInitialisedContextDb } from "../context/db.js";
import {
  insertDocument,
  insertChunksForDocument,
  insertClaim,
  upsertFileIndex,
  upsertProject,
  upsertSessionLog,
} from "../context/repository.js";
import {
  ClaimInput,
  DocumentInput,
  FileIndexInput,
  ProjectInput,
  SessionLogInput,
} from "../context/types.js";
import type { Tool } from "./base.js";

const Input = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("project"),
    data: ProjectInput,
  }),
  z.object({
    kind: z.literal("document"),
    data: DocumentInput,
    /** Optional list of text chunks to insert under this document. */
    chunks: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    kind: z.literal("claim"),
    data: ClaimInput,
  }),
  z.object({
    kind: z.literal("file_index"),
    data: FileIndexInput,
  }),
  z.object({
    kind: z.literal("session_log"),
    data: SessionLogInput,
  }),
]);
type In = z.infer<typeof Input>;

export const contextWriteTool: Tool<
  In,
  { ok: true; kind: In["kind"]; id: number | string; chunks_inserted?: number }
> = {
  name: "context_write",
  description:
    "Write a durable record to the memory spine (patchwork-harness's local SQLite store). Use this to remember decisions, verified facts, project metadata, file inventory, and session outcomes — so future sessions can recall them without burning tokens. `kind` picks the table: 'project' | 'document' (+ optional chunks) | 'claim' | 'file_index' | 'session_log'. Every claim MUST set `created_by` (who/what produced it), `confidence` (0.0–1.0), and `status` (unverified|supported|contradicted|obsolete) — never store anonymous facts.",
  inputSchema: Input,
  assess: (i) => {
    // Writing claims marked 'supported' with high confidence has higher
    // stakes than a mere 'unverified' write — surfaces in the audit.
    if (i.kind === "claim" && i.data.status === "supported" && (i.data.confidence ?? 0.5) >= 0.9) {
      return { level: "low", flags: ["high_confidence_supported_claim"] };
    }
    return { level: "none", flags: [] };
  },
  preview: (i) => ({
    description: `context_write kind=${i.kind}${i.kind === "document" ? ` (+${i.chunks?.length ?? 0} chunks)` : ""}`,
  }),
  async run(input) {
    const db = await getInitialisedContextDb();
    switch (input.kind) {
      case "project": {
        const row = upsertProject(db, input.data);
        return { ok: true, kind: "project", id: row.id };
      }
      case "document": {
        const doc = insertDocument(db, input.data);
        let chunks_inserted = 0;
        if (input.chunks && input.chunks.length > 0) {
          const rows = insertChunksForDocument(db, doc.id, input.chunks);
          chunks_inserted = rows.length;
        }
        return { ok: true, kind: "document", id: doc.id, chunks_inserted };
      }
      case "claim": {
        const row = insertClaim(db, input.data);
        return { ok: true, kind: "claim", id: row.id };
      }
      case "file_index": {
        const row = upsertFileIndex(db, input.data);
        return { ok: true, kind: "file_index", id: row.id };
      }
      case "session_log": {
        const row = upsertSessionLog(db, input.data);
        return { ok: true, kind: "session_log", id: row.session_id };
      }
    }
  },
};
