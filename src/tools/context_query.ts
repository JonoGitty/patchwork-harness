/**
 * context_query — structured (NOT raw SQL) read from the memory spine.
 *
 * The LLM picks a table from a whitelist and supplies equality-only
 * `where` filters from a per-table allowlist of columns. This shape
 * deliberately rejects raw SQL strings, JOINs, UPDATE/DELETE etc — the
 * tool can never execute arbitrary SQL even if a prompt-injection tries.
 */

import { z } from "zod";
import { getInitialisedContextDb } from "../context/db.js";
import type { Tool } from "./base.js";

const Table = z.enum(["projects", "documents", "claims", "file_index", "sessions_log"]);
type Table = z.infer<typeof Table>;

// Column allowlist per table (for `where` equality filters). Anything
// off this list is rejected at parse time. Keeps the surface tight.
const ALLOWED: Record<Table, readonly string[]> = {
  projects:     ["id", "name", "status", "language"],
  documents:    ["id", "uri", "source_type", "project_id", "notebook_id"],
  claims:       ["id", "status", "created_by", "project_id", "document_id"],
  file_index:   ["id", "project_id", "path", "language"],
  sessions_log: ["session_id", "project_id", "status"],
};

const Where = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

const Input = z.object({
  table: Table.describe("Which spine table to read from."),
  where: Where.optional().describe("Equality filters: column -> value. Only allowlisted columns per table."),
  limit: z.number().int().min(1).max(200).default(20),
  order_by: z.string().optional().describe("Column to order by (must be allowlisted for this table)."),
  order_desc: z.boolean().default(true),
});
type In = z.infer<typeof Input>;

function validateWhere(table: Table, where: Record<string, unknown> | undefined): void {
  if (!where) return;
  const allow = ALLOWED[table];
  for (const k of Object.keys(where)) {
    if (!allow.includes(k)) {
      throw new Error(
        `context_query: column "${k}" is not allowlisted for table "${table}". ` +
        `Allowed: ${allow.join(", ")}`,
      );
    }
  }
}

function validateOrderBy(table: Table, col: string | undefined): void {
  if (!col) return;
  const allow = ALLOWED[table];
  if (!allow.includes(col)) {
    throw new Error(
      `context_query: order_by column "${col}" is not allowlisted for table "${table}". ` +
      `Allowed: ${allow.join(", ")}`,
    );
  }
}

export const contextQueryTool: Tool<In, { table: Table; rows: unknown[]; count: number }> = {
  name: "context_query",
  description:
    "Read rows from the memory spine by table + structured equality filters. NEVER executes raw SQL. Tables: projects | documents | claims | file_index | sessions_log. Use this for targeted reads (e.g. 'all supported claims in project X'); use context_search for fuzzy text retrieval.",
  inputSchema: Input,
  assess: () => ({ level: "none", flags: [] }),
  preview: (i) => ({
    description: `context_query ${i.table}${i.where ? " " + JSON.stringify(i.where) : ""} (limit=${i.limit ?? 20})`,
  }),
  async run(input) {
    validateWhere(input.table, input.where);
    validateOrderBy(input.table, input.order_by);

    const db = await getInitialisedContextDb();
    const where = input.where ?? {};
    const cols = Object.keys(where);
    const whereSql = cols.length ? `WHERE ${cols.map((c) => `${c} = @${c}`).join(" AND ")}` : "";
    const orderSql = input.order_by
      ? `ORDER BY ${input.order_by} ${input.order_desc ? "DESC" : "ASC"}`
      : "";
    const sql = `SELECT * FROM ${input.table} ${whereSql} ${orderSql} LIMIT @__limit`;
    const params: Record<string, unknown> = { ...where, __limit: input.limit };

    const rows = db.prepare(sql).all(params);
    return { table: input.table, rows, count: rows.length };
  },
};
