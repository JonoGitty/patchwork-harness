import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Vitest cannot trivially override the module-resolved SESSIONS_DIR after
// import. Stub at the boundary by setting HOME so paths resolves into a
// tempdir under the runner's control.
let tmpHome: string;
const origHome = process.env.HOME;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "patchwork-harness-lessons-"));
  process.env.HOME = tmpHome;
  // Re-import after env change so paths picks up the new HOME
  vi.resetModules();
});
afterEach(() => {
  process.env.HOME = origHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

function writeSession(sid: string, body: object): void {
  const dir = join(tmpHome, ".patchwork-harness/sessions");
  // Lazy require to ensure dir exists
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdirSync } = require("node:fs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.json`), JSON.stringify(body));
}

describe("findSimilarSessions", () => {
  it("returns empty when no sessions exist", async () => {
    const { findSimilarSessions } = await import("../src/core/lessons.js");
    const out = await findSimilarSessions("rename foo to bar in src/");
    expect(out).toEqual([]);
  });

  it("ranks goal-similar sessions higher than unrelated ones", async () => {
    const now = new Date().toISOString();
    writeSession("sess_unrelated", {
      sessionId: "sess_unrelated",
      goal: "configure terraform module for vpc",
      started_at: now,
      status: "completed",
      total_cost_usd: 0.05,
      results: [{ step: { model: "claude-sonnet-4-6" }, duration_ms: 30_000 }],
      plan: { steps: [{ model: "claude-sonnet-4-6" }] },
    });
    writeSession("sess_match", {
      sessionId: "sess_match",
      goal: "rename foo helper to bar across src/",
      started_at: now,
      status: "completed",
      total_cost_usd: 0.04,
      results: [{ step: { model: "claude-sonnet-4-6" }, duration_ms: 60_000 }],
      plan: { steps: [{ model: "claude-sonnet-4-6" }] },
    });
    const { findSimilarSessions } = await import("../src/core/lessons.js");
    const out = await findSimilarSessions("rename foo to bar in src/");
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.session_id).toBe("sess_match");
  });

  it("filters out sessions older than daysBack", async () => {
    const old = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    writeSession("sess_old", {
      sessionId: "sess_old",
      goal: "rename foo to bar",
      started_at: old,
      status: "completed",
      total_cost_usd: 0.01,
    });
    const { findSimilarSessions } = await import("../src/core/lessons.js");
    const out = await findSimilarSessions("rename foo to bar", 10, 60);
    expect(out).toEqual([]);
  });
});

describe("renderLessons", () => {
  it("formats summaries in the ADR-0008 shape", async () => {
    const { renderLessons } = await import("../src/core/lessons.js");
    const out = renderLessons([
      {
        session_id: "s1",
        goal: "rename foo to bar in src/",
        started_at: new Date().toISOString(),
        age_human: "3 weeks ago",
        step_count: 3,
        models: ["claude-sonnet-4-6"],
        status: "completed",
        total_cost_usd: 0.04,
        duration_ms: 120_000,
        similarity: 0.5,
      },
    ]);
    expect(out).toContain("Evidence from past sessions like this");
    expect(out).toContain("3 weeks ago");
    expect(out).toContain("3 steps");
    expect(out).toContain("claude-sonnet-4-6 only");
    expect(out).toContain("$0.04");
    expect(out).toContain("✓");
  });

  it("returns empty string for empty input", async () => {
    const { renderLessons } = await import("../src/core/lessons.js");
    expect(renderLessons([])).toBe("");
  });
});
