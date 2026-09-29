/**
 * Memory spine — bootstrap + migration tests.
 * Each test runs against a fresh PATCHWORK_HARNESS_HOME in a tmp dir so they
 * don't touch the real ~/.patchwork-harness/context.db.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openContextDb, resetContextDbCache, contextDbPath } from "../../src/context/db.js";
import { ensureContextSchema, migrate } from "../../src/context/migrations.js";

let tmpHome: string;
const origHarnessHome = process.env.PATCHWORK_HARNESS_HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "patchwork-harness-ctx-"));
  process.env.PATCHWORK_HARNESS_HOME = tmpHome;
  resetContextDbCache();
});
afterEach(() => {
  resetContextDbCache();
  if (origHarnessHome === undefined) delete process.env.PATCHWORK_HARNESS_HOME;
  else process.env.PATCHWORK_HARNESS_HOME = origHarnessHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

describe("context db bootstrap", () => {
  it("contextDbPath honours PATCHWORK_HARNESS_HOME", () => {
    expect(contextDbPath()).toBe(join(tmpHome, "context.db"));
  });

  it("opens a connection and applies the initial migration", () => {
    const db = openContextDb({ fresh: true });
    const result = ensureContextSchema(db);
    expect(result.applied).toContain(1);
    expect(result.skipped.length).toBe(0);
  });

  it("creates every expected table + FTS5 virtual table", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const tables = (db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') ORDER BY name")
      .all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of [
      "projects",
      "documents",
      "chunks",
      "chunks_fts",
      "claims",
      "file_index",
      "sessions_log",
      "schema_migrations",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("running migrations a second time is a no-op", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const second = migrate(db);
    expect(second.applied.length).toBe(0);
    expect(second.skipped).toContain(1);
  });

  it("foreign_keys pragma is ON", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const fk = db.pragma("foreign_keys", { simple: true });
    expect(fk).toBe(1);
  });

  it("WAL journal mode is active", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const mode = db.pragma("journal_mode", { simple: true });
    expect(mode).toBe("wal");
  });
});
