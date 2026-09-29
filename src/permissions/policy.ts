/**
 * Permission gate. Decides whether an action proceeds, prompts, or is
 * refused. The effective allowlist is the intersection of patchwork-harness's own
 * policy and Patchwork's. See DECISIONS/0004-permission-model.md.
 */

import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import minimatch from "../util/minimatch-shim.js";
import { loadPolicy, type PolicyConfig } from "../config.js";
import type { RiskLevel } from "../audit.js";

export type PermissionDecision =
  | { kind: "auto" }
  | { kind: "prompt"; reason: string }
  | { kind: "deny"; reason: string };

export interface ToolCallContext {
  cwd: string;
  toolName: string;
  /** Risk classification produced by the tool itself. */
  risk: { level: RiskLevel; flags: string[] };
  /** What the tool would do, in human terms (one line). */
  description: string;
  /** Free-form details — paths, commands. */
  details?: { path?: string; command?: string; url?: string };
  /** User flags. */
  mode: "auto" | "default" | "cautious";
}

let _policy: PolicyConfig | null = null;
function policy(): PolicyConfig {
  if (!_policy) _policy = loadPolicy();
  return _policy;
}

/**
 * The real filesystem location of `p`: realpath of the deepest EXISTING
 * ancestor with the lexical tail re-joined, so a not-yet-created file is
 * judged by where its parent REALLY is and a symlink anywhere on the
 * path is followed. 3 Sept 2026 security review (GPT-5.6 Sol, Opus 5,
 * Fable 5.1 - all three led with it): the lexical check let a symlink
 * inside the project that points at ~/.ssh or another repo's .git
 * pass as "inside", and the same predicate gates WRITES.
 * Still TOCTOU against a link swapped between decision and open; the
 * write/edit tools would need O_NOFOLLOW to close that.
 */
export function realish(p: string): string {
  let cur = resolve(p);
  let tail = "";
  for (;;) {
    try {
      const real = realpathSync.native(cur);
      return tail ? join(real, tail) : real;
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      tail = tail ? join(basename(cur), tail) : basename(cur);
      cur = up;
    }
  }
}

function norm(x: string): string {
  return process.platform === "win32" ? x.toLowerCase() : x;
}

export function pathInsideCwd(p: string, cwd: string): boolean {
  const base = realish(cwd);
  const r = realish(resolve(cwd, p));
  const prefix = base.endsWith(sep) ? base : base + sep;
  return norm(r) === norm(base) || norm(r).startsWith(norm(prefix));
}

function matchAny(value: string, patterns: string[]): boolean {
  return patterns.some((p) => minimatch(value, p));
}

function isSensitivePath(p: string): boolean {
  const sens = policy().sensitive_paths;
  return matchAny(p, sens);
}

function bashAllowlisted(cmd: string): boolean {
  return policy().bash_allowlist.some((p) => minimatch(cmd, p));
}

function bashDenylisted(cmd: string): boolean {
  return policy().bash_denylist.some((p) => minimatch(cmd, p));
}

export function decide(ctx: ToolCallContext): PermissionDecision {
  // Hard refusals first — never auto, never prompt-out.
  if (ctx.risk.level === "critical") {
    return { kind: "deny", reason: "patchwork classified as critical" };
  }
  if (ctx.details?.path) {
    // match the RAW spelling and the RESOLVED real path (forward
    // slashes): `link/id_rsa` through a symlink named `link`, or
    // `sub/../.env`, never carries the pattern's text in raw form -
    // the deny tier was bypassable by construction (3 Sept review)
    const raw = ctx.details.path;
    const real = realish(resolve(ctx.cwd, raw)).split(sep).join("/");
    if (isSensitivePath(raw) || isSensitivePath(real)) {
      return { kind: "deny", reason: `sensitive path matched: ${raw}` };
    }
  }
  if (ctx.details?.command && bashDenylisted(ctx.details.command)) {
    return { kind: "deny", reason: "command matched bash denylist" };
  }

  // Bash allowlist
  if (ctx.toolName === "bash" && ctx.details?.command) {
    if (bashAllowlisted(ctx.details.command)) return { kind: "auto" };
    if (policy().prompt_for.bash_off_allowlist) {
      return { kind: "prompt", reason: "bash command not on allowlist" };
    }
  }

  // Path-aware tools (read/write/edit/grep/glob)
  if (ctx.details?.path) {
    if (!pathInsideCwd(ctx.details.path, ctx.cwd)) {
      if (policy().prompt_for.write_outside_cwd) {
        return { kind: "prompt", reason: "path is outside cwd" };
      }
    }
  }

  // Git ops
  if (ctx.toolName === "git_ops" && ctx.details?.command?.startsWith("git push")) {
    if (policy().prompt_for.push) return { kind: "prompt", reason: "git push" };
  }
  if (ctx.toolName === "git_ops" && ctx.details?.command?.startsWith("gh pr")) {
    if (policy().prompt_for.pr) return { kind: "prompt", reason: "gh pr op" };
  }

  // Mode overrides
  if (ctx.mode === "auto" && ctx.risk.level !== "high") return { kind: "auto" };
  if (ctx.mode === "cautious" && ctx.risk.level !== "none") {
    return { kind: "prompt", reason: "cautious mode" };
  }

  // Default rules by risk
  if (ctx.risk.level === "high") {
    return { kind: "prompt", reason: "high-risk action" };
  }

  return { kind: "auto" };
}
