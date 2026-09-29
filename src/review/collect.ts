/**
 * Gather the code a security review will look at: explicit paths/globs,
 * or the git diff (working tree, or a commit range) PLUS the full current
 * text of every changed file, so reviewers see context, not just hunks.
 * Sizes are capped and every omission is recorded - a reviewer that is
 * shown a slice must be told it is a slice.
 */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { execa } from "execa";
import fg from "fast-glob";
import { findOnPath } from "../util/which.js";

export interface ReviewFile {
  /** Path relative to cwd, forward slashes. */
  path: string;
  content: string;
  bytes: number;
  lines: number;
  truncated: boolean;
}

export interface Collected {
  source: "paths" | "diff";
  files: ReviewFile[];
  diff?: string;
  diffTruncated?: boolean;
  totalChars: number;
  skipped: Array<{ path: string; reason: string }>;
}

export interface CollectOptions {
  /** Per-file cap in chars (default 120k). */
  maxFileChars?: number;
  /** Total cap across files (default 400k ≈ 100k tokens). */
  maxTotalChars?: number;
}

const DEFAULT_IGNORE = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.git/**",
  "**/coverage/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/*.min.js",
  "**/*.map",
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
  "**/*.lock",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.ico",
  "**/*.pdf",
  "**/*.zip",
  "**/*.woff",
  "**/*.woff2",
  "**/*.ttf",
  "**/*.db",
  "**/*.sqlite",
];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function toRel(cwd: string, abs: string): string {
  return relative(cwd, abs).split("\\").join("/");
}

function readOne(cwd: string, rel: string, maxFileChars: number): ReviewFile | { skip: string } {
  const abs = resolve(cwd, rel);
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(abs);
  } catch {
    return { skip: "not found" };
  }
  if (!st.isFile()) return { skip: "not a file" };
  if (st.size > MAX_FILE_BYTES) return { skip: `too large (${st.size} bytes)` };
  const buf = readFileSync(abs);
  if (looksBinary(buf)) return { skip: "binary" };
  let content = buf.toString("utf8");
  const truncated = content.length > maxFileChars;
  if (truncated) content = content.slice(0, maxFileChars);
  return {
    path: toRel(cwd, abs),
    content,
    bytes: st.size,
    lines: content.split(/\r?\n/).length,
    truncated,
  };
}

function assemble(
  cwd: string,
  rels: string[],
  opts: CollectOptions,
): Pick<Collected, "files" | "totalChars" | "skipped"> {
  const maxFileChars = opts.maxFileChars ?? 120_000;
  const maxTotal = opts.maxTotalChars ?? 400_000;
  const files: ReviewFile[] = [];
  const skipped: Collected["skipped"] = [];
  let total = 0;
  for (const rel of rels) {
    const r = readOne(cwd, rel, maxFileChars);
    if ("skip" in r) {
      skipped.push({ path: rel, reason: r.skip });
      continue;
    }
    if (total + r.content.length > maxTotal) {
      skipped.push({ path: rel, reason: `total cap ${maxTotal} chars reached` });
      continue;
    }
    total += r.content.length;
    files.push(r);
  }
  return { files, totalChars: total, skipped };
}

/** Expand paths / directories / globs to a stable, de-duplicated file list. */
export async function expandPaths(cwd: string, patterns: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const p of patterns) {
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    let st: ReturnType<typeof statSync> | null = null;
    try {
      st = statSync(abs);
    } catch {
      st = null;
    }
    if (st?.isFile()) {
      out.add(toRel(cwd, abs));
      continue;
    }
    const glob = st?.isDirectory() ? `${toRel(cwd, abs) || "."}/**/*` : p.split("\\").join("/");
    const hits = await fg(glob, { cwd, onlyFiles: true, ignore: DEFAULT_IGNORE, dot: false });
    for (const h of hits.sort()) out.add(h);
  }
  return [...out];
}

export async function collectPaths(
  cwd: string,
  patterns: string[],
  opts: CollectOptions = {},
): Promise<Collected> {
  const rels = await expandPaths(cwd, patterns);
  return { source: "paths", ...assemble(cwd, rels, opts) };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const bin = findOnPath("git");
  if (!bin) throw new Error("git not found on PATH (needed for --diff)");
  const r = await execa(bin, args, { cwd, reject: false, timeout: 60_000 });
  if (r.exitCode !== 0)
    throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
  return r.stdout;
}

/**
 * `range` undefined = working tree vs HEAD (staged + unstaged) plus untracked
 * files; a string = `git diff <range>` (e.g. main..HEAD, abc123~1..abc123).
 */
export async function collectDiff(
  cwd: string,
  range?: string,
  opts: CollectOptions = {},
): Promise<Collected> {
  const diffArgs = range ? ["diff", range] : ["diff", "HEAD"];
  let diff = await git(cwd, [...diffArgs, "--no-color"]);
  const named = (await git(cwd, [...diffArgs, "--name-only"]))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const untracked = range
    ? []
    : (await git(cwd, ["ls-files", "--others", "--exclude-standard"]))
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
  const maxDiff = opts.maxTotalChars ?? 400_000;
  const diffTruncated = diff.length > maxDiff;
  if (diffTruncated) diff = diff.slice(0, maxDiff);
  const rels = [...new Set([...named, ...untracked])];
  const base = assemble(cwd, rels, opts);
  return {
    source: "diff",
    diff,
    diffTruncated,
    ...base,
    totalChars: base.totalChars + diff.length,
  };
}
