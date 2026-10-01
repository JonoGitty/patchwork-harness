/**
 * Opt-in harness options (ADR-0015). All OFF by default. They exist because
 * the top hackathon and leaderboard harnesses share one thing patchwork-harness lacked:
 * a finish gate that RUNS something, plus a bounded retry until it passes
 * (Factory Droid, Anthropic's SWE-bench harness, OpenHands early stopping,
 * Tekton - see docs/research/2026-09-28-winning-harnesses.md).
 *
 *   --verify-cmd <cmd>   test gate: run a command in cwd after the plan; exit 0 = pass
 *   --attempts <n>       bounded repair loop: on a failed gate, one repair step
 *                        gets the failure output, then the gate runs again
 *   --checkpoint         git snapshot of the working tree before every step,
 *                        stored under refs/patchwork-harness/<session>/ (your branch, index
 *                        and stash are untouched); `patchwork-harness rewind` restores one
 *   --guard-loop / --time-budget   live in the executor
 */
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { execa } from "execa";
import type { AuditEmitter } from "../audit.js";
import { bashTool } from "../tools/bash.js";

export interface HarnessOptions {
  verifyCmd?: string;
  verifyTimeoutS?: number;
  attempts?: number;
  checkpoint?: boolean;
  loopGuard?: boolean;
  timeBudgetS?: number;
  /** L5 reviewer (ADR-0016): true/"auto" picks by role, or a model id. */
  review?: boolean | string;
  /** A non-"complete" L5 verdict fails the command. */
  reviewStrict?: boolean;
  /** On an INCOMPLETE L5 verdict: one repair step from its concerns, re-gate, re-review. */
  reviewFix?: boolean;
  /** ADR-0019: screen outside content for prompt injection (Jeff's `guard` adapter). */
  guard?: { threshold?: number; mode?: "flag" | "withhold" };
}

export interface GateResult {
  cmd: string;
  passed: boolean;
  exit_code: number;
  tail: string;
  duration_ms: number;
}

/**
 * Run the user's verification command through the bash tool and put its
 * VERBATIM output on the audit trail as a completed tool result - so L4.5
 * can ground (or refute) a "tests pass" claim against what really ran.
 * No `input` provenance: the command is the user's, not model-authored,
 * so it must not taint the evidence.
 */
export async function runGate(
  cmd: string,
  cwd: string,
  sessionId: string,
  audit: AuditEmitter,
  timeoutS = 600,
): Promise<GateResult> {
  audit.emit({
    action: "tool_use_start",
    risk: { level: "low", flags: [] },
    target: { tool: "bash", command: cmd, harness: "verify_cmd" },
  });
  const r = await bashTool.run(
    { command: cmd, timeout_ms: Math.min(timeoutS, 600) * 1000 },
    { cwd, sessionId },
  );
  const out = JSON.stringify(r).slice(0, 16000);
  audit.emit({
    action: "tool_use_end",
    status: "completed", // the tool ran; pass/fail is in exit_code
    target: { tool: "bash", harness: "verify_cmd", exit_code: r.exit_code },
    content: out,
    provenance: { output: out },
  });
  const tail = `${r.stdout}\n${r.stderr}`.trim().slice(-4000);
  return {
    cmd,
    passed: r.exit_code === 0,
    exit_code: r.exit_code,
    tail,
    duration_ms: r.duration_ms,
  };
}

/** The repair instruction handed to the executor after a failed gate. */
export function repairDescription(
  goal: string,
  gate: GateResult,
  attempt: number,
  of: number,
): string {
  return [
    `The goal was: ${goal}`,
    `The verification command \`${gate.cmd}\` FAILED (exit ${gate.exit_code}). This is repair attempt ${attempt} of ${of}.`,
    "Last output of the command:",
    "```",
    gate.tail || "(no output)",
    "```",
    "Find and fix the cause so the command passes. Do NOT weaken, skip, delete or edit the tests or the check itself to make it pass - fix the code under test. If the failure is outside what you can fix, say so plainly.",
  ].join("\n");
}

// ─── checkpoints ────────────────────────────────────────────────────────────

const GIT_ID = {
  GIT_AUTHOR_NAME: "patchwork-harness",
  GIT_AUTHOR_EMAIL: "patchwork-harness@localhost",
  GIT_COMMITTER_NAME: "patchwork-harness",
  GIT_COMMITTER_EMAIL: "patchwork-harness@localhost",
};

async function git(cwd: string, args: string[], env: Record<string, string> = {}) {
  return execa("git", args, { cwd, reject: false, env: { ...process.env, ...env } });
}

export const refPrefix = (sessionId: string) => `refs/patchwork-harness/${sessionId}/`;

/**
 * Snapshot the whole working tree (tracked + untracked, .gitignore honoured)
 * into a commit reachable only from refs/patchwork-harness/<session>/<label>. Uses a
 * throwaway index seeded from the real one, so the user's index, HEAD,
 * branch and stash are never touched. null = not a git repo (or git failed).
 */
export async function checkpoint(
  cwd: string,
  sessionId: string,
  label: string,
): Promise<string | null> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.exitCode !== 0) return null;
  const root = top.stdout.trim();
  const idxPath = (await git(root, ["rev-parse", "--git-path", "index"])).stdout.trim();
  const realIndex = isAbsolute(idxPath) ? idxPath : join(root, idxPath);
  const tmpIndex = join(tmpdir(), `patchwork-harness-idx-${sessionId}-${label}-${process.pid}`);
  try {
    if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex, ...GIT_ID };
    if ((await git(root, ["add", "-A"], env)).exitCode !== 0) return null;
    const tree = (await git(root, ["write-tree"], env)).stdout.trim();
    if (!tree) return null;
    const head = await git(root, ["rev-parse", "--verify", "-q", "HEAD"]);
    const parent = head.exitCode === 0 ? ["-p", head.stdout.trim()] : [];
    const commit = await git(
      root,
      ["commit-tree", tree, ...parent, "-m", `patchwork-harness checkpoint ${sessionId} ${label}`],
      env,
    );
    const sha = commit.stdout.trim();
    if (commit.exitCode !== 0 || !sha) return null;
    if ((await git(root, ["update-ref", `${refPrefix(sessionId)}${label}`, sha])).exitCode !== 0)
      return null;
    return sha;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

export interface Checkpoint {
  label: string;
  sha: string;
  date: string;
}

export async function listCheckpoints(cwd: string, sessionId: string): Promise<Checkpoint[]> {
  const r = await git(cwd, [
    "for-each-ref",
    "--sort=creatordate",
    "--format=%(refname)%09%(objectname)%09%(creatordate:iso)",
    refPrefix(sessionId),
  ]);
  if (r.exitCode !== 0) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref = "", sha = "", date = ""] = line.split("\t");
      return { label: ref.slice(refPrefix(sessionId).length), sha, date };
    });
}

/**
 * Restore the working tree to a checkpoint. Snapshots the CURRENT state
 * first (label pre-rewind-<ts>), so a rewind is itself undoable. Files
 * created after the checkpoint are removed; files it had are restored.
 * The index, HEAD and branch are not touched.
 */
export async function rewind(
  cwd: string,
  sessionId: string,
  label: string,
): Promise<{ restored_to: string; safety: string; removed: string[] }> {
  const target = (await listCheckpoints(cwd, sessionId)).find((c) => c.label === label);
  if (!target) throw new Error(`no checkpoint '${label}' for session ${sessionId}`);
  const safetyLabel = `pre-rewind-${Date.now()}`;
  const safety = await checkpoint(cwd, sessionId, safetyLabel);
  if (!safety) throw new Error("could not snapshot the current state first - refusing to rewind");
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
  const added = (
    await git(root, ["diff", "--name-only", "--diff-filter=A", target.sha, safety])
  ).stdout
    .split("\n")
    .filter(Boolean);
  for (const f of added) rmSync(join(root, f), { force: true });
  // An empty snapshot (taken before any file existed) has nothing to restore;
  // `git restore ... :/` rejects that pathspec, so skip it (28 Sept 2026).
  const hasFiles =
    (await git(root, ["ls-tree", "-r", "--name-only", target.sha])).stdout.trim() !== "";
  if (hasFiles) {
    const restore = await git(root, [
      "restore",
      `--source=${target.sha}`,
      "--worktree",
      "--",
      ":/",
    ]);
    if (restore.exitCode !== 0)
      throw new Error(`git restore failed: ${restore.stderr.slice(0, 300)}`);
  }
  return { restored_to: label, safety: safetyLabel, removed: added };
}
