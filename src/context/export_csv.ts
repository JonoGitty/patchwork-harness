/**
 * Explicit CSV export of the context tables. NOT an auto-mirror — runs
 * only when the user (or a script) calls it. Writes one CSV per logical
 * table into a target directory.
 *
 * RFC 4180-ish: comma separator, CRLF line endings, fields containing
 * comma / quote / newline get quoted, embedded quotes are doubled.
 * Good enough for Excel and Numbers on macOS.
 */

import type Sqlite from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const TABLES = [
  "projects",
  "documents",
  "chunks",
  "claims",
  "file_index",
  "sessions_log",
];

function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  // CSV formula-injection defence: Excel / Sheets execute cells starting
  // with =, +, -, @ as formulas. Attacker-controllable fields (claim
  // statements, chunk text, file paths, doc titles) must be neutralised.
  // Prefix with a leading apostrophe so the cell is treated as text.
  // Per OWASP CSV injection guidance and the 2026-05-27 security audit.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function tableToCsv(db: Sqlite.Database, table: string): string {
  const stmt = db.prepare(`SELECT * FROM ${table}`);
  const rows = stmt.all() as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    // Header from PRAGMA so empty tables still get a usable file.
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    return `${cols.join(",")}\r\n`;
  }
  const first = rows[0];
  if (!first) return "";
  const cols = Object.keys(first);
  const header = cols.join(",");
  const body = rows.map((r) => cols.map((c) => csvField(r[c])).join(",")).join("\r\n");
  return `${header}\r\n${body}\r\n`;
}

export interface ExportResult {
  out_dir: string;
  files: Array<{ table: string; path: string; bytes: number; rows: number }>;
}

export function exportCsv(db: Sqlite.Database, outDir: string): ExportResult {
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const files: ExportResult["files"] = [];
  for (const t of TABLES) {
    const csv = tableToCsv(db, t);
    const path = join(outDir, `${t}.csv`);
    // 0600 to match the rest of the spine; CSVs can contain user secrets
    // that accidentally got typed into a claim or goal.
    writeFileSync(path, csv, { mode: 0o600 });
    const rows = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    files.push({ table: t, path, bytes: csv.length, rows });
  }
  return { out_dir: outDir, files };
}
