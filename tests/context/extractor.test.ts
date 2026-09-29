/**
 * Memory spine Phase 3 — extractor + session_writer tests.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { extractFromFile, extractFromEvents } from "../../src/context/extractor.js";
import { writeExtractedSession } from "../../src/context/session_writer.js";
import { openContextDb, resetContextDbCache } from "../../src/context/db.js";
import { ensureContextSchema } from "../../src/context/migrations.js";

const FIXTURE = join(process.cwd(), "tests/fixtures/sessions/sample_session.jsonl");

let tmpHome: string;
const origHarnessHome = process.env.PATCHWORK_HARNESS_HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "patchwork-harness-extract-"));
  process.env.PATCHWORK_HARNESS_HOME = tmpHome;
  resetContextDbCache();
});
afterEach(() => {
  resetContextDbCache();
  if (origHarnessHome === undefined) delete process.env.PATCHWORK_HARNESS_HOME;
  else process.env.PATCHWORK_HARNESS_HOME = origHarnessHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

describe("extractor", () => {
  it("extracts goal/status/cost/steps/files from the fixture", () => {
    const e = extractFromFile(FIXTURE);
    expect(e.session_id).toBe("ses_TEST_01");
    expect(e.project_name).toBe("patchwork-harness");
    expect(e.goal).toContain("memory spine Phase 3");
    expect(e.status).toBe("completed");
    expect(e.total_cost_usd).toBeCloseTo(0.0421);
    expect(e.step_count).toBe(2);
    // Files are deduped by path: extractor.ts touched twice (write + edit) → one entry
    expect(e.file_touches.length).toBe(2);
    expect(e.file_touches.map((f) => f.path)).toContain("src/context/extractor.ts");
    expect(e.file_touches.map((f) => f.path)).toContain("src/core/orchestrator.ts");
  });

  it("builds a non-empty summary with the key facts", () => {
    const e = extractFromFile(FIXTURE);
    expect(e.summary).toContain("memory spine Phase 3");
    expect(e.summary).toContain("Status: completed");
    expect(e.summary).toContain("Steps: 2");
    expect(e.summary).toContain("Cost: $0.0421");
    expect(e.summary).toContain("Touched");
  });

  it("infers a sensible next_action for a completed session", () => {
    const e = extractFromFile(FIXTURE);
    expect(e.next_action).toContain("Verify outcome");
  });

  it("inferred next_action shifts for failure status", () => {
    const e = extractFromEvents([
      {
        session_id: "x",
        timestamp: "2026-05-27T10:00:00Z",
        action: "session_start",
        target: { goal: "do X" },
        project: { root: "/r", name: "p" },
      },
      {
        session_id: "x",
        timestamp: "2026-05-27T10:00:05Z",
        action: "session_end",
        status: "failed",
        provenance: { final_status: "failed" },
      },
    ] as unknown as Parameters<typeof extractFromEvents>[0]);
    expect(e.status).toBe("failed");
    expect(e.next_action).toMatch(/investigate/i);
  });

  it("inferred next_action surfaces a bedrock breach", () => {
    const e = extractFromEvents([
      { session_id: "y", timestamp: "T1", action: "session_start", target: { goal: "g" } },
      {
        session_id: "y",
        timestamp: "T2",
        action: "session_end",
        provenance: { final_status: "bedrock_aborted" },
      },
    ] as unknown as Parameters<typeof extractFromEvents>[0]);
    expect(e.next_action).toMatch(/bedrock/i);
  });

  it("throws on a missing file", () => {
    expect(() => extractFromFile("/tmp/__nonexistent__.jsonl")).toThrow(/not found/);
  });

  it("redacts secret-shaped strings from extracted goal/summary/next_action (post-audit)", () => {
    const e = extractFromEvents([
      {
        session_id: "redact-1",
        timestamp: "2026-05-27T10:00:00Z",
        action: "session_start",
        target: { goal: "Use my key sk-ant-AABBCCDDEEFFGGHHIIJJKKLLMMNNOOPP to test" },
        project: { root: "/r", name: "p" },
      },
      {
        session_id: "redact-1",
        timestamp: "2026-05-27T10:00:05Z",
        action: "session_end",
        status: "completed",
        provenance: { final_status: "completed" },
      },
    ] as unknown as Parameters<typeof extractFromEvents>[0]);
    expect(e.goal).not.toMatch(/sk-ant-AABBCC/);
    expect(e.goal).toContain("[REDACTED-KEY]");
    expect(e.summary).not.toMatch(/sk-ant-AABBCC/);
  });
});

describe("session_writer", () => {
  it("writes a session row + file_index + searchable summary document", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const e = extractFromFile(FIXTURE);
    const r = writeExtractedSession(db, e);

    expect(r.sessions_log_written).toBe(true);
    expect(r.project_id).not.toBeNull();
    expect(r.files_touched).toBe(2);
    expect(r.summary_document_id).not.toBeNull();

    // sessions_log row exists with the right next_action
    const sLog = db.prepare("SELECT * FROM sessions_log WHERE session_id = ?").get("ses_TEST_01") as { next_action: string | null; summary: string };
    expect(sLog.next_action).toContain("Verify outcome");
    expect(sLog.summary).toContain("Status: completed");

    // file_index has both touched files under the same project
    const files = db.prepare("SELECT path FROM file_index ORDER BY path").all() as Array<{ path: string }>;
    expect(files.map((f) => f.path)).toEqual([
      "src/context/extractor.ts",
      "src/core/orchestrator.ts",
    ]);

    // The session-summary document is now searchable via FTS
    const hit = db
      .prepare(`
        SELECT c.text FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ? LIMIT 1
      `)
      .get("Phase 3") as { text: string } | undefined;
    expect(hit?.text).toContain("memory spine Phase 3");
  });

  it("is idempotent — re-running upserts, no duplicate summary document", () => {
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const e = extractFromFile(FIXTURE);
    const r1 = writeExtractedSession(db, e);
    const r2 = writeExtractedSession(db, e);

    expect(r1.summary_document_id).toBe(r2.summary_document_id);

    const docCount = (db.prepare("SELECT COUNT(*) AS n FROM documents WHERE uri = ?").get("session://ses_TEST_01") as { n: number }).n;
    expect(docCount).toBe(1);

    const sessionsCount = (db.prepare("SELECT COUNT(*) AS n FROM sessions_log WHERE session_id = ?").get("ses_TEST_01") as { n: number }).n;
    expect(sessionsCount).toBe(1);
  });
});
