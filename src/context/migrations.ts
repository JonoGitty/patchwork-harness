/**
 * Migration runner. Reads every .sql file in src/context/schema/ (sorted),
 * applies any whose numeric prefix isn't already in schema_migrations.
 * Each migration runs inside a transaction; partial application is
 * impossible.
 *
 * Filename convention: `NNN_name.sql` where NNN is a zero-padded integer.
 */

import type Sqlite from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "../util/paths.js";

// SQL migration files live under src/context/schema/. We resolve via
// PROJECT_ROOT (which walks up to the patchwork-harness repo root) rather than
// import.meta.url so the path works the same whether we're running
// the bundled dist/cli.js or `tsx src/cli.ts`.
const SCHEMA_DIR = join(PROJECT_ROOT, "src", "context", "schema");

interface Migration {
  version: number;
  name: string;
  sql: string;
}

function discover(): Migration[] {
  const out: Migration[] = [];
  for (const file of readdirSync(SCHEMA_DIR).sort()) {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) continue;
    const vStr = match[1] ?? "";
    const name = match[2] ?? "";
    out.push({
      version: Number.parseInt(vStr, 10),
      name,
      sql: readFileSync(join(SCHEMA_DIR, file), "utf8"),
    });
  }
  return out;
}

function applied(db: Sqlite.Database): Set<number> {
  // schema_migrations may not exist on a fresh DB — first migration creates it.
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get();
  if (!exists) return new Set();
  const rows = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

export function migrate(db: Sqlite.Database): { applied: number[]; skipped: number[] } {
  const seen = applied(db);
  const out = { applied: [] as number[], skipped: [] as number[] };
  for (const m of discover()) {
    if (seen.has(m.version)) {
      out.skipped.push(m.version);
      continue;
    }
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare(
        "INSERT INTO schema_migrations(version, name) VALUES (?, ?)",
      ).run(m.version, m.name);
    })();
    out.applied.push(m.version);
  }
  return out;
}

/** Convenience: open + migrate in one call. Returns the migration report
 *  so callers (CLI) can show what happened. */
export function ensureContextSchema(db: Sqlite.Database): ReturnType<typeof migrate> {
  return migrate(db);
}
