/**
 * ADR-0015 harness options + the bash-tool shell fix they depend on.
 * 28 Sept 2026: under Windows node the bash tool spawned /bin/sh, which does
 * not exist - every command returned exit -1 with no output.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

process.env.HOME = mkdtempSync(join(tmpdir(), "patchwork-harness-harness-home-"));

const { bashTool, resolveShell } = await import("../src/tools/bash.js");
const { checkpoint, listCheckpoints, repairDescription, rewind, runGate } = await import(
  "../src/core/harness.js"
);
const { AuditEmitter } = await import("../src/audit.js");

describe("bash tool shell (the fix the gate depends on)", () => {
  it("picks /bin/sh on Unix, Git Bash on Windows, cmd.exe as a last resort, PATCHWORK_HARNESS_SHELL first", () => {
    expect(resolveShell("linux", {}, () => false)).toBe("/bin/sh");
    const bash = resolveShell("win32", { ProgramFiles: "C:\\PF" }, (p) => p.includes("Git"));
    expect(String(bash)).toMatch(/Git[\\/]bin[\\/]bash\.exe$/);
    expect(resolveShell("win32", {}, () => false)).toBe(true);
    expect(resolveShell("win32", { PATCHWORK_HARNESS_SHELL: "X" }, () => true)).toBe("X");
  });
  it("actually runs a command on this machine with real exit codes", async () => {
    const ok = await bashTool.run(
      { command: "echo hi", timeout_ms: 30_000 },
      { cwd: tmpdir(), sessionId: "t" },
    );
    expect(ok.exit_code).toBe(0);
    expect(ok.stdout.trim()).toBe("hi");
    const bad = await bashTool.run(
      { command: "exit 3", timeout_ms: 30_000 },
      { cwd: tmpdir(), sessionId: "t" },
    );
    expect(bad.exit_code).toBe(3);
  }, 60_000);
});

describe("test gate (--verify-cmd)", () => {
  it("passes on exit 0, fails otherwise, and returns the output tail", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-gate-"));
    const audit = new AuditEmitter("gate-test", cwd, "gate");
    const pass = await runGate("echo all 12 tests passed", cwd, "gate-test", audit, 30);
    expect(pass).toMatchObject({ passed: true, exit_code: 0 });
    expect(pass.tail).toContain("12 tests passed");
    const fail = await runGate("echo 3 failed; exit 1", cwd, "gate-test", audit, 30);
    expect(fail).toMatchObject({ passed: false, exit_code: 1 });
    expect(fail.tail).toContain("3 failed");
  }, 60_000);

  it("hands the repair step the failure and forbids gaming the check", () => {
    const d = repairDescription(
      "add a parser",
      {
        cmd: "npm test",
        passed: false,
        exit_code: 1,
        tail: "1 failed: parses dates",
        duration_ms: 1,
      },
      2,
      3,
    );
    expect(d).toContain("`npm test` FAILED (exit 1)");
    expect(d).toContain("repair attempt 2 of 3");
    expect(d).toContain("1 failed: parses dates");
    expect(d).toContain("Do NOT weaken, skip, delete or edit the tests");
  });
});

describe("checkpoints and rewind (--checkpoint, patchwork-harness rewind)", () => {
  const git = (cwd: string, ...args: string[]) =>
    execa("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });

  it("rewinds to an EMPTY snapshot (taken before any file existed)", async () => {
    // live e2e, 28 Sept 2026: git restore rejected the empty ':/' pathspec
    const repo = mkdtempSync(join(tmpdir(), "patchwork-harness-cp-empty-"));
    await git(repo, "init", "-q");
    await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
    expect(await checkpoint(repo, "ses_E", "step-1")).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(repo, "hello.txt"), "hi");
    const r = await rewind(repo, "ses_E", "step-1");
    expect(r.removed).toEqual(["hello.txt"]);
    expect(existsSync(join(repo, "hello.txt"))).toBe(false);
  }, 60_000);

  it("returns null outside a git repo", async () => {
    expect(
      await checkpoint(mkdtempSync(join(tmpdir(), "patchwork-harness-nogit-")), "s", "step-1"),
    ).toBeNull();
  }, 60_000);

  it("snapshots tracked + untracked files, leaves index/HEAD alone, and rewinds exactly", async () => {
    const repo = mkdtempSync(join(tmpdir(), "patchwork-harness-cp-"));
    await git(repo, "init", "-q");
    writeFileSync(join(repo, "a.txt"), "v1\n");
    await git(repo, "add", "a.txt");
    await git(repo, "commit", "-q", "-m", "init");
    const head = (await git(repo, "rev-parse", "HEAD")).stdout;

    // state at the checkpoint: a.txt edited, b.txt untracked
    writeFileSync(join(repo, "a.txt"), "v2\n");
    writeFileSync(join(repo, "b.txt"), "new\n");
    const statusBefore = (await git(repo, "status", "--porcelain")).stdout;
    const sha = await checkpoint(repo, "ses_T", "step-1");
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect((await git(repo, "status", "--porcelain")).stdout).toBe(statusBefore); // index untouched
    expect((await git(repo, "rev-parse", "HEAD")).stdout).toBe(head); // no commit on the branch

    // the agent then makes a mess
    writeFileSync(join(repo, "a.txt"), "v3 broken\n");
    writeFileSync(join(repo, "c.txt"), "junk\n");

    const r = await rewind(repo, "ses_T", "step-1");
    expect(readFileSync(join(repo, "a.txt"), "utf8").replace(/\r/g, "")).toBe("v2\n");
    expect(existsSync(join(repo, "b.txt"))).toBe(true);
    expect(existsSync(join(repo, "c.txt"))).toBe(false);
    expect(r.removed).toEqual(["c.txt"]);
    expect((await git(repo, "rev-parse", "HEAD")).stdout).toBe(head);

    // the rewind is itself undoable
    const labels = (await listCheckpoints(repo, "ses_T")).map((c) => c.label);
    expect(labels).toContain("step-1");
    expect(labels).toContain(r.safety);
    await rewind(repo, "ses_T", r.safety);
    expect(readFileSync(join(repo, "a.txt"), "utf8").replace(/\r/g, "")).toBe("v3 broken\n");
    expect(existsSync(join(repo, "c.txt"))).toBe(true);
  }, 120_000);
});
