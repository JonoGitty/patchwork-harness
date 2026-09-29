/**
 * Memory spine Phase 4 — resume packet selection tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openContextDb, resetContextDbCache } from "../../src/context/db.js";
import { ensureContextSchema } from "../../src/context/migrations.js";
import {
  insertClaim,
  upsertFileIndex,
  upsertProject,
  upsertSessionLog,
} from "../../src/context/repository.js";
import { buildResumePacket, renderResumePacket } from "../../src/context/resume.js";

let tmpHome: string;
const origHarnessHome = process.env.PATCHWORK_HARNESS_HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "patchwork-harness-resume-"));
  process.env.PATCHWORK_HARNESS_HOME = tmpHome;
  resetContextDbCache();
});
afterEach(() => {
  resetContextDbCache();
  if (origHarnessHome === undefined) delete process.env.PATCHWORK_HARNESS_HOME;
  else process.env.PATCHWORK_HARNESS_HOME = origHarnessHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

/** Seeds two projects with two sessions each, plus some files + claims. */
function seed(db: ReturnType<typeof openContextDb>) {
  const a = upsertProject(db, { name: "alpha", root_path: "/repos/alpha" });
  const b = upsertProject(db, { name: "beta",  root_path: "/repos/beta" });

  upsertSessionLog(db, {
    session_id: "ses_a1",
    goal: "alpha early",
    project_id: a.id,
    started_at: "2026-05-26T10:00:00Z",
    ended_at:   "2026-05-26T10:05:00Z",
    status: "completed",
    total_cost_usd: 0.01,
    summary: "alpha early summary",
    next_action: "continue alpha",
  });
  upsertSessionLog(db, {
    session_id: "ses_a2",
    goal: "alpha latest",
    project_id: a.id,
    started_at: "2026-05-27T10:00:00Z",
    ended_at:   "2026-05-27T10:10:00Z",
    status: "completed",
    total_cost_usd: 0.05,
    summary: "alpha latest summary",
    next_action: "verify alpha",
  });
  upsertSessionLog(db, {
    session_id: "ses_b1",
    goal: "beta work",
    project_id: b.id,
    started_at: "2026-05-27T09:00:00Z",
    ended_at:   "2026-05-27T09:05:00Z",
    status: "failed",
    total_cost_usd: 0.02,
    next_action: "Investigate the failure and retry",
  });

  upsertFileIndex(db, { project_id: a.id, path: "src/index.ts", language: "TypeScript", one_line_summary: "entry point" });
  upsertFileIndex(db, { project_id: a.id, path: "README.md" });
  upsertFileIndex(db, { project_id: b.id, path: "main.go" });

  insertClaim(db, {
    statement: "alpha uses better-sqlite3",
    project_id: a.id,
    created_by: "model:opus-4-7",
    confidence: 0.95,
    status: "supported",
  });
  insertClaim(db, {
    statement: "an obsolete alpha fact",
    project_id: a.id,
    created_by: "model:opus-4-7",
    status: "obsolete",
  });

  return { a, b };
}

describe("buildResumePacket", () => {
  it("with no opts: picks the globally-latest session", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    seed(db);
    const p = buildResumePacket(db);
    expect(p.session?.session_id).toBe("ses_a2"); // 2026-05-27 10:00 > 09:00 > 26
    expect(p.project?.name).toBe("alpha");
    expect(p.session?.next_action).toBe("verify alpha");
  });

  it("with --project filter: picks latest in that project", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    seed(db);
    const p = buildResumePacket(db, { project_name: "beta" });
    expect(p.session?.session_id).toBe("ses_b1");
    expect(p.session?.status).toBe("failed");
    expect(p.session?.next_action).toMatch(/investigate/i);
  });

  it("with --session: picks exactly that session", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    seed(db);
    const p = buildResumePacket(db, { session_id: "ses_a1" });
    expect(p.session?.session_id).toBe("ses_a1");
    expect(p.project?.name).toBe("alpha");
  });

  it("prior_sessions excludes the picked session and only includes same-project ones", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    seed(db);
    const p = buildResumePacket(db);
    expect(p.prior_sessions.map((s) => s.session_id)).toEqual(["ses_a1"]); // beta not included
  });

  it("excludes obsolete and contradicted claims by default", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    seed(db);
    const p = buildResumePacket(db);
    expect(p.claims.length).toBe(1);
    expect(p.claims[0].statement).toContain("better-sqlite3");
  });

  it("only lists files from the picked project", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    seed(db);
    const p = buildResumePacket(db);
    const paths = p.files.map((f) => f.path);
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("README.md");
    expect(paths).not.toContain("main.go");
  });

  it("empty spine: returns a packet with session=null", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const p = buildResumePacket(db);
    expect(p.session).toBeNull();
    expect(p.files).toEqual([]);
    expect(p.claims).toEqual([]);
  });

  it("unknown --project: returns session=null gracefully", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    seed(db);
    const p = buildResumePacket(db, { project_name: "nonexistent" });
    expect(p.session).toBeNull();
  });
});

describe("renderResumePacket", () => {
  it("renders key fields on a populated packet", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    seed(db);
    const text = renderResumePacket(buildResumePacket(db));
    expect(text).toContain("ses_a2");
    expect(text).toContain("Goal:");
    expect(text).toContain("Next:    verify alpha");
    expect(text).toContain("Project: alpha");
    expect(text).toContain("Prior sessions (1)");
    expect(text).toContain("ses_a1");
    expect(text).toContain("src/index.ts");
    expect(text).toContain("better-sqlite3");
  });

  it("graceful empty-spine message", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const text = renderResumePacket(buildResumePacket(db));
    expect(text).toMatch(/no resumable session/i);
  });
});
