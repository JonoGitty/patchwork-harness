/**
 * SQLite connection factory for the memory spine. One DB at
 * `$PATCHWORK_HARNESS_HOME/context.db` (defaults to ~/.patchwork-harness/context.db).
 *
 * Pragmas: WAL for concurrent readers, NORMAL sync (durable enough for
 * a single-user dev tool, much faster than FULL), foreign keys on.
 *
 * better-sqlite3 chosen over sqlite3 / node:sqlite for synchronous API
 * (matches the audit emitter style), ~10x faster on our small reads,
 * native FTS5, prebuilt binaries on macOS Intel + ARM. See ADR-0009.
 */

import Sqlite from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Resolve the context DB path. Honour $PATCHWORK_HARNESS_HOME when set (lets tests
 *  point at a tmp dir without monkey-patching `os.homedir()`). */
export function contextDbPath(): string {
  const home = process.env.PATCHWORK_HARNESS_HOME ?? join(homedir(), ".patchwork-harness");
  return join(home, "context.db");
}

/** Ensure the directory holding the DB exists with safe perms (0700). */
export function ensureContextDir(): void {
  const dir = process.env.PATCHWORK_HARNESS_HOME ?? join(homedir(), ".patchwork-harness");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    // Best-effort tighten if someone created it with looser perms.
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
  }
}

let cached: Sqlite.Database | null = null;

/** Open (and cache) the singleton context DB connection.
 *  `fresh: true` returns a brand-new connection without caching — for tests. */
export function openContextDb(opts?: { path?: string; fresh?: boolean }): Sqlite.Database {
  if (!opts?.fresh && cached) return cached;

  ensureContextDir();
  const path = opts?.path ?? contextDbPath();
  const db = new Sqlite(path);
  // Pragmas before any other statement.
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("temp_store = MEMORY");

  // Lock down file perms once it's been created on disk.
  if (path !== ":memory:") {
    try { chmodSync(path, 0o600); } catch { /* may fail under tmp on some FS; ignore */ }
  }

  if (!opts?.fresh) cached = db;
  return db;
}

/** Forget the cached connection. Tests call this between cases. */
export function resetContextDbCache(): void {
  if (cached) {
    try { cached.close(); } catch { /* ignore */ }
    cached = null;
  }
  initialised = false;
}

let initialised = false;

/**
 * Get the cached, migrated context DB. Migrates lazily on first call per
 * process so callers (e.g. the executor's context_* tools) don't pay the
 * schema check on every invocation. Tests use `openContextDb({fresh:true})`
 * directly to bypass this cache.
 */
export async function getInitialisedContextDb(): Promise<Sqlite.Database> {
  const db = openContextDb();
  if (!initialised) {
    // Lazy import to avoid a cycle when this module is imported first.
    const { ensureContextSchema } = await import("./migrations.js");
    ensureContextSchema(db);
    initialised = true;
  }
  return db;
}
