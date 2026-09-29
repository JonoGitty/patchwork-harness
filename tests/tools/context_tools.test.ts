/**
 * Tests for the executor's context_* tools (Phase 2 of the memory spine).
 * Each test runs against a fresh PATCHWORK_HARNESS_HOME so it doesn't touch real state.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { tools, getTool } from "../../src/tools/registry.js";
import { resetContextDbCache } from "../../src/context/db.js";
import { contextWriteTool } from "../../src/tools/context_write.js";
import { contextQueryTool } from "../../src/tools/context_query.js";
import { contextSearchTool } from "../../src/tools/context_search.js";

let tmpHome: string;
const origHarnessHome = process.env.PATCHWORK_HARNESS_HOME;

const ctx = { cwd: "/tmp", sessionId: "test-session" };

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "patchwork-harness-tools-"));
  process.env.PATCHWORK_HARNESS_HOME = tmpHome;
  resetContextDbCache();
});
afterEach(() => {
  resetContextDbCache();
  if (origHarnessHome === undefined) delete process.env.PATCHWORK_HARNESS_HOME;
  else process.env.PATCHWORK_HARNESS_HOME = origHarnessHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

describe("registry registration", () => {
  it("contains the three context tools by exact name", () => {
    const names = tools().map((t) => t.name);
    expect(names).toContain("context_search");
    expect(names).toContain("context_query");
    expect(names).toContain("context_write");
  });
  it("getTool('context_search') returns the right tool", () => {
    expect(getTool("context_search")).toBe(contextSearchTool);
    expect(getTool("context_query")).toBe(contextQueryTool);
    expect(getTool("context_write")).toBe(contextWriteTool);
  });
});

describe("context_write", () => {
  it("writes a project then a claim, returning ids", async () => {
    const p = await contextWriteTool.run(
      contextWriteTool.inputSchema.parse({ kind: "project", data: { name: "test-proj" } }),
      ctx,
    );
    expect(p.ok).toBe(true);
    expect(p.kind).toBe("project");
    expect(typeof p.id).toBe("number");

    const c = await contextWriteTool.run(
      contextWriteTool.inputSchema.parse({
        kind: "claim",
        data: { statement: "tests work", created_by: "test", confidence: 0.9, status: "supported" },
      }),
      ctx,
    );
    expect(c.ok).toBe(true);
    expect(c.kind).toBe("claim");
  });

  it("writes a document with chunks in one call", async () => {
    const r = await contextWriteTool.run(
      contextWriteTool.inputSchema.parse({
        kind: "document",
        data: { uri: "manual://t", title: "t", source_type: "note" },
        chunks: ["chunk one with FTS words", "chunk two"],
      }),
      ctx,
    );
    expect(r.chunks_inserted).toBe(2);
  });

  it("rejects an invalid claim status via zod (no DB hit)", () => {
    expect(() =>
      contextWriteTool.inputSchema.parse({
        kind: "claim",
        data: { statement: "bad", created_by: "test", status: "bogus" },
      }),
    ).toThrow();
  });

  it("flags high-confidence supported claims in assess()", () => {
    const input = contextWriteTool.inputSchema.parse({
      kind: "claim",
      data: { statement: "x", created_by: "test", confidence: 0.95, status: "supported" },
    });
    const risk = contextWriteTool.assess(input, ctx);
    expect(risk.flags).toContain("high_confidence_supported_claim");
  });
});

describe("context_query (structured, NO raw SQL)", () => {
  it("reads back rows after writes", async () => {
    await contextWriteTool.run(
      contextWriteTool.inputSchema.parse({ kind: "project", data: { name: "alpha" } }),
      ctx,
    );
    const r = await contextQueryTool.run(
      contextQueryTool.inputSchema.parse({ table: "projects", where: { name: "alpha" } }),
      ctx,
    );
    expect(r.count).toBe(1);
    expect((r.rows[0] as { name: string }).name).toBe("alpha");
  });

  it("REJECTS a non-allowlisted column in `where`", async () => {
    await expect(() =>
      contextQueryTool.run(
        contextQueryTool.inputSchema.parse({
          table: "claims",
          where: { confidence: 0.9 },  // confidence is NOT on the allowlist
        }),
        ctx,
      ),
    ).rejects.toThrow(/not allowlisted/);
  });

  it("REJECTS a SQL-shaped value attempting injection", async () => {
    // Even if a malicious value is passed, parameterised binding makes it
    // a literal — but we want to also confirm structured equality is the
    // only path: passing a column not on the allowlist must fail.
    await expect(() =>
      contextQueryTool.run(
        contextQueryTool.inputSchema.parse({
          table: "documents",
          where: { "uri; DROP TABLE projects": "x" },
        }),
        ctx,
      ),
    ).rejects.toThrow(/not allowlisted/);
  });

  it("REJECTS an unknown table at zod parse time", () => {
    expect(() =>
      contextQueryTool.inputSchema.parse({ table: "schema_migrations" }),
    ).toThrow();
  });
});

describe("context_search", () => {
  it("finds the right chunk via FTS5 after a context_write", async () => {
    await contextWriteTool.run(
      contextWriteTool.inputSchema.parse({
        kind: "document",
        data: { uri: "manual://s", title: "s", source_type: "note" },
        chunks: ["the quick brown fox jumps over the lazy dog"],
      }),
      ctx,
    );
    const r = await contextSearchTool.run(
      contextSearchTool.inputSchema.parse({ query: "brown fox", limit: 5 }),
      ctx,
    );
    expect(r.count).toBeGreaterThan(0);
    expect(r.results[0].type).toBe("chunk");
    expect(r.results[0].text).toContain("brown fox");
  });

  it("include_claims surfaces matching active claims and excludes obsolete ones", async () => {
    await contextWriteTool.run(
      contextWriteTool.inputSchema.parse({
        kind: "claim",
        data: { statement: "Patchwork Harness uses better-sqlite3.", created_by: "test", status: "supported" },
      }),
      ctx,
    );
    await contextWriteTool.run(
      contextWriteTool.inputSchema.parse({
        kind: "claim",
        data: { statement: "Patchwork Harness uses raw sqlite3.", created_by: "test", status: "obsolete" },
      }),
      ctx,
    );
    const r = await contextSearchTool.run(
      contextSearchTool.inputSchema.parse({ query: "Patchwork Harness", include_claims: true, limit: 10 }),
      ctx,
    );
    const claims = r.results.filter((x) => x.type === "claim");
    expect(claims.some((c) => c.text.includes("better-sqlite3"))).toBe(true);
    expect(claims.some((c) => c.text.includes("raw sqlite3"))).toBe(false);
  });
});
