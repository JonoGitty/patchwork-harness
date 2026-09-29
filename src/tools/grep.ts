import { readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { findOnPath } from "../util/which.js";
import type { Tool } from "./base.js";

const Input = z.object({
  pattern: z.string().describe("Regular expression (rg/JS syntax)"),
  path: z.string().default(".").describe("File or directory to search, relative to cwd"),
  case_insensitive: z.boolean().default(false),
  max_matches: z.number().int().positive().max(500).default(100),
});
type In = z.infer<typeof Input>;

interface Match {
  file: string;
  line: number;
  text: string;
}
export interface GrepOut {
  matches: Match[];
  truncated: boolean;
  /** Which search engine produced the result: ripgrep, GNU grep, or the built-in JS walker. */
  engine: "rg" | "grep" | "js";
  note?: string;
}

const TIMEOUT_MS = 30_000;
const MAX_LINE_CHARS = 500;

// ─── binary discovery: PATH only, resolved once, spawned by absolute path ──
//
// A bare `execa("rg", …, { cwd })` on Windows lets process creation search
// the child's CURRENT DIRECTORY before PATH, so a cloned repo carrying an
// rg.exe/rg.cmd at its root would run under a tool whose risk level is
// "none" (auto-approved in every mode) - flagged by both external reviewers
// on 3 Sept 2026. We therefore walk PATH ourselves, never the cwd, cache
// the absolute path for the process lifetime, and spawn that.

export interface GrepBinary {
  kind: "rg" | "grep";
  path: string;
}

let resolvedBinary: GrepBinary | null | undefined;

export function findGrepBinary(env: NodeJS.ProcessEnv = process.env): GrepBinary | null {
  for (const kind of ["rg", "grep"] as const) {
    const path = findOnPath(kind, env);
    if (path) return { kind, path };
  }
  return null;
}

function grepBinary(): GrepBinary | null {
  if (resolvedBinary === undefined) resolvedBinary = findGrepBinary();
  return resolvedBinary;
}

/** Test seam: forget the cached binary so the next call re-resolves, or pin one engine (null = the JS walker). */
export function resetGrepBinaryCache(force?: GrepBinary | null): void {
  resolvedBinary = force;
}

/**
 * The tool promises rg/JS regex syntax. GNU/BSD grep read patterns as BASIC
 * regex by default, where `(`, `|` and `+` are literals, so `alpha|beta`
 * silently matched nothing on any machine without ripgrep (the public CI
 * caught it, 29 Sept 2026). `-E` covers groups and alternation; the syntax
 * below has no ERE equivalent, so those patterns go to the JS walker, which
 * IS JS syntax. A silent zero is never an acceptable answer.
 */
const NEEDS_JS_ENGINE = /\\[dD]|\(\?|[*+?}]\?/;

// ─── pure-JS fallback ────────────────────────────────────────────────────

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  "target",
  ".idea",
  ".vscode",
  ".tox",
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 20_000;

interface IgnoreRule {
  kind: "name" | "ext" | "prefix";
  value: string;
}

/**
 * .gitignore-ish: bare names (match any path segment), `*.ext` (basename
 * suffix) and `/dir` (root-relative prefix). Negations and complex globs
 * are ignored - this is a fallback, not git.
 */
function loadIgnoreRules(root: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  let raw = "";
  try {
    raw = readFileSync(join(root, ".gitignore"), "utf8");
  } catch {
    return rules;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("!")) continue;
    if (/^\*\.[\w.-]+$/.test(t)) rules.push({ kind: "ext", value: t.slice(1) });
    else if (/^[\w.-]+\/?$/.test(t)) rules.push({ kind: "name", value: t.replace(/\/$/, "") });
    else if (/^\/[\w./-]+$/.test(t))
      rules.push({ kind: "prefix", value: t.slice(1).replace(/\/$/, "") });
  }
  return rules;
}

function ignored(relPath: string, name: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  if (isDir && DEFAULT_IGNORED_DIRS.has(name)) return true;
  for (const r of rules) {
    if (r.kind === "name" && name === r.value) return true;
    if (r.kind === "ext" && !isDir && name.endsWith(r.value)) return true;
    if (r.kind === "prefix" && (relPath === r.value || relPath.startsWith(`${r.value}/`)))
      return true;
  }
  return false;
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export function jsGrep(input: In, cwd: string): GrepOut {
  const root = resolve(cwd, input.path);
  const re = new RegExp(input.pattern, input.case_insensitive ? "i" : "");
  const matches: Match[] = [];
  let truncated = false;
  let scanned = 0;
  const rules = loadIgnoreRules(cwd);

  const rel = (abs: string) => relative(cwd, abs).split("\\").join("/") || ".";

  const searchFile = (abs: string): boolean => {
    let buf: Buffer;
    try {
      const st = statSync(abs);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return true;
      buf = readFileSync(abs);
    } catch {
      return true;
    }
    if (looksBinary(buf)) return true;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i] ?? "";
      if (!re.test(text)) continue;
      if (matches.length >= input.max_matches) {
        truncated = true;
        return false;
      }
      matches.push({ file: rel(abs), line: i + 1, text: text.slice(0, MAX_LINE_CHARS) });
    }
    return true;
  };

  const walk = (dir: string): boolean => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const abs = join(dir, ent.name);
      const r = rel(abs);
      if (ent.isSymbolicLink()) continue; // never follow links out of the tree
      if (ignored(r, ent.name, ent.isDirectory(), rules)) continue;
      if (ent.isDirectory()) {
        if (!walk(abs)) return false;
      } else if (ent.isFile()) {
        if (++scanned > MAX_FILES) {
          truncated = true;
          return false;
        }
        if (!searchFile(abs)) return false;
      }
    }
    return true;
  };

  const st = statSync(root);
  if (st.isDirectory()) walk(root);
  else searchFile(root);
  return {
    matches,
    truncated,
    engine: "js",
    note: "built-in JS search (no ripgrep/grep on PATH): honours .gitignore names/*.ext and skips binaries, symlinks and files > 2MB",
  };
}

// ─── the tool ────────────────────────────────────────────────────────────

export const grepTool: Tool<In, GrepOut> = {
  name: "grep",
  description:
    "Search for a regex pattern across files (ripgrep when installed, else GNU grep, else a built-in JS search). Returns file:line matches; `truncated: true` means more matches exist - narrow the pattern/path or raise max_matches.",
  inputSchema: Input,
  assess: () => ({ level: "none", flags: [] }),
  preview: (i) => ({ description: `grep ${i.pattern} in ${i.path}`, details: { path: i.path } }),
  async run(input, ctx) {
    const bin = grepBinary();
    if (!bin) return jsGrep(input, ctx.cwd);
    if (bin.kind === "grep" && NEEDS_JS_ENGINE.test(input.pattern)) {
      return {
        ...jsGrep(input, ctx.cwd),
        note: "built-in JS search: the pattern uses JS/rg syntax that grep -E cannot express (\\d, (?...), lazy quantifiers)",
      };
    }

    // `--` before the pattern on BOTH engines: a pattern like
    // `--file=/etc/shadow` must never be parsed as an option (the grep
    // branch lacked it until 7 Sept 2026).
    const args =
      bin.kind === "rg"
        ? [
            "--line-number",
            "--no-heading",
            "--color",
            "never",
            ...(input.case_insensitive ? ["-i"] : []),
            "--",
            input.pattern,
            input.path,
          ]
        : [
            "-rn",
            "-I",
            "--exclude-dir=.git",
            "--exclude-dir=node_modules",
            "--exclude-dir=dist",
            "-E",
            ...(input.case_insensitive ? ["-i"] : []),
            "--",
            input.pattern,
            input.path,
          ];

    const r = await execa(bin.path, args, { cwd: ctx.cwd, reject: false, timeout: TIMEOUT_MS });
    const res = r as {
      timedOut?: boolean;
      code?: string;
      stderr?: string;
      exitCode?: number;
      stdout: string;
    };
    // Distinguish the three non-match outcomes: a TIMEOUT is not "binary
    // missing", a missing binary is not "zero matches", and a bad regex
    // (exit 2) is not "zero matches" either. Unknowable is never zero.
    if (res.timedOut) {
      throw new Error(
        `grep timed out after ${TIMEOUT_MS / 1000}s searching ${input.path} - narrow the path or pattern; do NOT treat this as zero matches`,
      );
    }
    if (res.code === "ENOENT") {
      resetGrepBinaryCache();
      return jsGrep(input, ctx.cwd);
    }
    const stdout = res.stdout ?? "";
    if (res.exitCode !== undefined && res.exitCode >= 2 && stdout.trim() === "") {
      throw new Error(
        `${bin.kind} failed (exit ${res.exitCode}): ${(res.stderr ?? "").trim().slice(0, 400) || "no stderr"} - fix the pattern/path; do NOT treat this as zero matches`,
      );
    }
    const all = stdout.split("\n").filter(Boolean);
    const lines = all.slice(0, input.max_matches);
    const matches: Match[] = lines.map((l) => {
      const m = l.match(/^(.+?):(\d+):(.*)$/);
      return m
        ? {
            file: m[1]!.split("\\").join("/"),
            line: Number(m[2]),
            text: m[3]!.slice(0, MAX_LINE_CHARS),
          }
        : { file: "?", line: 0, text: l.slice(0, MAX_LINE_CHARS) };
    });
    const out: GrepOut = { matches, truncated: all.length > input.max_matches, engine: bin.kind };
    if (res.exitCode !== undefined && res.exitCode >= 2) {
      out.note = `${bin.kind} reported errors on some files (exit ${res.exitCode}): ${(res.stderr ?? "").trim().slice(0, 300)}`;
    }
    return out;
  },
};
