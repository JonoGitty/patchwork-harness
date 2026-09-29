import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmp: string;
let tmpHome: string;
const origHome = process.env.HOME;
const origUser = process.env.USER;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "patchwork-harness-wv-"));
  tmpHome = mkdtempSync(join(tmpdir(), "patchwork-harness-wv-home-"));
  process.env.HOME = tmpHome;
  process.env.USER = "nobody";
  vi.resetModules();
});
afterEach(() => {
  process.env.HOME = origHome;
  process.env.USER = origUser;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

async function importWV() {
  return (await import("../src/core/world_view.js")).assembleWorldView;
}

describe("assembleWorldView", () => {
  it("returns empty string when no sources are present", async () => {
    const assembleWorldView = await importWV();
    const out = await assembleWorldView(tmp, "do something");
    // No README/CLAUDE.md/ROADMAP.md, no git, no reachable dashboard, no user memory under tmpHome
    expect(out).toBe("");
  });

  it("includes project memory when README.md exists", async () => {
    writeFileSync(join(tmp, "README.md"), "# Test Project\n\nA test project for world view.");
    const assembleWorldView = await importWV();
    const out = await assembleWorldView(tmp, "anything");
    expect(out).toContain("Project memory");
    expect(out).toContain("README.md");
    expect(out).toContain("Test Project");
  });

  it("clips long project files to a budget", async () => {
    const huge = "A".repeat(50_000);
    writeFileSync(join(tmp, "ROADMAP.md"), huge);
    const assembleWorldView = await importWV();
    const out = await assembleWorldView(tmp, "x");
    const idx = out.indexOf("ROADMAP.md");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(out.slice(idx)).toMatch(/truncated/);
  });

  it("packet stays under the global cap", async () => {
    for (const f of ["README.md", "CLAUDE.md", "ROADMAP.md"]) {
      writeFileSync(join(tmp, f), "X".repeat(10_000));
    }
    const assembleWorldView = await importWV();
    const out = await assembleWorldView(tmp, "x");
    expect(out.length).toBeLessThanOrEqual(24_500);
  });

  it("includes git context when cwd is a git repo", async () => {
    mkdirSync(join(tmp, ".git"));
    const assembleWorldView = await importWV();
    const out = await assembleWorldView(tmp, "x");
    expect(typeof out).toBe("string");
  });

  it("includes user memory when MEMORY.md links match goal keywords", async () => {
    const memDir = join(tmpHome, ".claude/projects/-Users-nobody/memory");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, "MEMORY.md"), "- [my-feedback](feedback_test.md) — about testing\n");
    writeFileSync(
      join(memDir, "feedback_test.md"),
      "Notes about testing the orchestrator and how to write better tests.",
    );
    const assembleWorldView = await importWV();
    const out = await assembleWorldView(tmp, "improve testing for the orchestrator");
    expect(out).toContain("User memory");
    expect(out).toContain("Notes about testing");
  });
});
