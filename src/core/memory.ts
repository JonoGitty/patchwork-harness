/**
 * patchwork-harness's own auto-memory store. Mirrors the shape of Claude Code's
 * memory directory: an index `MEMORY.md` whose lines link to per-memory
 * files with frontmatter (name, description, type).
 *
 * Memory is for things that DON'T live in the codebase or audit log:
 * user preferences, "we tried X and it failed", project-level notes the
 * planner should know about across sessions.
 *
 * Stored at ~/.patchwork-harness/memory/.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { MEMORY_DIR } from "../util/paths.js";

export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryEntry {
  /** Slug used as filename (without .md). */
  slug: string;
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

const INDEX_FILE = "MEMORY.md";
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/;

function ensureMemoryDir(): void {
  if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m || !m[1]) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    let v = line.slice(idx + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[k] = v;
  }
  return { meta, body: m[2] ?? "" };
}

function safeYamlScalar(s: string): string {
  // Quote anything that might confuse the parser (colon, hash, quote, newline, leading whitespace).
  if (/^\s|[:#"'\n]/.test(s)) return JSON.stringify(s);
  return s;
}

function dumpMemoryFile(entry: Pick<MemoryEntry, "name" | "description" | "type" | "body">): string {
  return `---\nname: ${safeYamlScalar(entry.name)}\ndescription: ${safeYamlScalar(entry.description)}\ntype: ${entry.type}\n---\n\n${entry.body.trim()}\n`;
}

/** List all memory entries (index-driven, falls back to scanning the dir). */
export function listMemory(): MemoryEntry[] {
  ensureMemoryDir();
  const entries: MemoryEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(MEMORY_DIR).filter((f) => f.endsWith(".md") && f !== INDEX_FILE);
  } catch {
    return [];
  }
  for (const name of names) {
    try {
      const raw = readFileSync(join(MEMORY_DIR, name), "utf8");
      const parsed = parseFrontmatter(raw);
      if (!parsed) continue;
      const slug = name.replace(/\.md$/, "");
      const t = parsed.meta.type as MemoryType | undefined;
      entries.push({
        slug,
        name: parsed.meta.name ?? slug,
        description: parsed.meta.description ?? "",
        type: (t === "user" || t === "feedback" || t === "project" || t === "reference") ? t : "project",
        body: parsed.body.trim(),
      });
    } catch {
      /* skip unreadable */
    }
  }
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

export function getMemory(slug: string): MemoryEntry | null {
  ensureMemoryDir();
  const path = join(MEMORY_DIR, `${slug}.md`);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf8");
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const t = parsed.meta.type as MemoryType | undefined;
  return {
    slug,
    name: parsed.meta.name ?? slug,
    description: parsed.meta.description ?? "",
    type: (t === "user" || t === "feedback" || t === "project" || t === "reference") ? t : "project",
    body: parsed.body.trim(),
  };
}

export interface AddMemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  /** Override slug; defaults to slugified name. */
  slug?: string;
}

export function addMemory(input: AddMemoryInput): MemoryEntry {
  ensureMemoryDir();
  const slug = input.slug ?? slugify(input.name);
  const entry: MemoryEntry = { slug, name: input.name, description: input.description, type: input.type, body: input.body };
  // Atomic write: tempfile + rename so a crash mid-write can't truncate
  // an existing memory file.
  atomicWrite(join(MEMORY_DIR, `${slug}.md`), dumpMemoryFile(entry));
  rewriteIndex();
  return entry;
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

export function forgetMemory(slug: string): boolean {
  ensureMemoryDir();
  const path = join(MEMORY_DIR, `${slug}.md`);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  rewriteIndex();
  return true;
}

function rewriteIndex(): void {
  const entries = listMemory();
  const lines = ["# patchwork-harness memory index", ""];
  if (entries.length === 0) {
    lines.push("_empty — no memory yet_");
  } else {
    for (const e of entries) {
      lines.push(`- [${e.name}](${e.slug}.md) — ${e.description}`);
    }
  }
  lines.push("");
  atomicWrite(join(MEMORY_DIR, INDEX_FILE), lines.join("\n"));
}

/**
 * Render the memory store as a section to inject into the planner's
 * world-view packet. Returns "" if there's nothing.
 */
export function renderMemoryForPlanner(): string {
  const entries = listMemory();
  if (entries.length === 0) return "";
  const lines = ["## patchwork-harness memory (persisted across sessions)"];
  lines.push(
    "(Carry these facts forward — they reflect prior user preferences, project context, and lessons.)\n",
  );
  for (const e of entries) {
    lines.push(`### ${e.name} _(${e.type})_`);
    lines.push(e.body);
    lines.push("");
  }
  return lines.join("\n");
}
