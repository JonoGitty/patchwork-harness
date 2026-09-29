/**
 * Smart conductor — Layer 1: Project Awareness.
 *
 * Before planning, assemble a "world view" packet from sources around the
 * machine: user memory, project memory, recent git context, optional
 * dashboard signal. The packet is injected into the planner's system
 * prompt as "Context you should know" so the conductor isn't planning
 * blind.
 *
 * Capped at ~6K tokens (rough char heuristic: 1 token ≈ 4 chars). All
 * sources are best-effort: if a file or process isn't there, skip
 * silently — never block planning.
 *
 * See DECISIONS/0008-smart-conductor.md §Layer 1.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { renderMemoryForPlanner } from "./memory.js";

const MAX_PACKET_CHARS = 24_000; // ~6K tokens
const MAX_PROJECT_FILE_CHARS = 2_000;
const MAX_USER_MEMORY_CHARS = 8_000;
const KEYWORD_MIN_LEN = 4;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} chars]` : s;
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9_-]+/g)
    .filter((w) => w.length >= KEYWORD_MIN_LEN);
}

/**
 * Read the user's MEMORY.md index and any linked memory files. Filter
 * by keyword overlap with the goal so we don't dump everything.
 *
 * Search strategy:
 *  1. cwd-sanitized project path (Claude Code's per-project memory)
 *  2. user-rooted general memory (Claude Code's HOME-level memory)
 * Returns empty string if neither exists.
 */
function userMemoryBlock(goal: string, cwd: string): string {
  const cwdSlug = cwd.replace(/\//g, "-"); // /Users/x/y -> -Users-x-y
  const home = homedir();
  const username = process.env.USER ?? "";
  const candidates = [
    join(home, ".claude/projects", cwdSlug, "memory/MEMORY.md"),
    username ? join(home, ".claude/projects", `-Users-${username}`, "memory/MEMORY.md") : "",
  ].filter(Boolean);

  let memoryDir = "";
  let indexPath = "";
  for (const c of candidates) {
    if (existsSync(c)) {
      indexPath = c;
      memoryDir = c.replace(/\/MEMORY\.md$/, "");
      break;
    }
  }
  if (!indexPath) return "";

  let index = "";
  try {
    index = readFileSync(indexPath, "utf8");
  } catch {
    return "";
  }

  const goalKeywords = new Set(tokenize(goal));
  const linkRe = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  const lines: string[] = ["### User memory (filtered by goal keywords)", ""];
  let totalChars = 0;
  let matched = 0;
  for (const m of index.matchAll(linkRe)) {
    const title = m[1] ?? "";
    const file = m[2] ?? "";
    const path = join(memoryDir, file);
    if (!existsSync(path)) continue;
    let body = "";
    try {
      body = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const fileWords = new Set(tokenize(`${title} ${body}`));
    let overlap = 0;
    for (const w of goalKeywords) if (fileWords.has(w)) overlap++;
    if (overlap === 0) continue;
    const snippet = clip(body, 1500);
    const block = `#### ${title} (overlap=${overlap})\n${snippet}\n`;
    if (totalChars + block.length > MAX_USER_MEMORY_CHARS) break;
    lines.push(block);
    totalChars += block.length;
    matched++;
    if (matched >= 6) break;
  }
  if (matched === 0) return "";
  return lines.join("\n");
}

function projectMemoryBlock(cwd: string): string {
  const lines: string[] = ["### Project memory"];
  let included = false;
  for (const name of ["CLAUDE.md", "README.md", "ROADMAP.md"]) {
    const p = join(cwd, name);
    if (!existsSync(p)) continue;
    let body = "";
    try {
      body = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    lines.push(`#### ${name}`);
    lines.push(clip(body, MAX_PROJECT_FILE_CHARS));
    lines.push("");
    included = true;
  }
  return included ? lines.join("\n") : "";
}

function gitContextBlock(cwd: string): string {
  const safeRun = (cmd: string): string => {
    try {
      return execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  // Quick check: is this a git repo?
  if (!safeRun("git rev-parse --is-inside-work-tree")) return "";
  const branch = safeRun("git rev-parse --abbrev-ref HEAD");
  const log = safeRun("git log --oneline -5");
  const diffstat = safeRun("git diff --stat HEAD~5 HEAD");
  const lines: string[] = ["### Recent git context"];
  if (branch) lines.push(`branch: ${branch}`);
  if (log) {
    lines.push("\nlast 5 commits:");
    lines.push(log);
  }
  if (diffstat) {
    lines.push("\ndiff --stat HEAD~5..HEAD:");
    lines.push(diffstat);
  }
  return lines.join("\n");
}

async function dashboardBlock(): Promise<string> {
  // Best-effort fetch with a 500ms timeout — skip silently if unreachable.
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 500);
    const resp = await fetch("http://127.0.0.1:8000/api/projects/recent", {
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!resp.ok) return "";
    const data = await resp.json();
    const lines = ["### Dashboard signal", clip(JSON.stringify(data, null, 2), 1500)];
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * Assemble the world view packet. Sources run in parallel where
 * possible; the result is capped at MAX_PACKET_CHARS.
 */
export async function assembleWorldView(cwd: string, goal: string): Promise<string> {
  const [userMem, projectMem, gitCtx, dashboard, harnessMem] = await Promise.all([
    Promise.resolve(userMemoryBlock(goal, cwd)),
    Promise.resolve(projectMemoryBlock(cwd)),
    Promise.resolve(gitContextBlock(cwd)),
    dashboardBlock(),
    Promise.resolve(renderMemoryForPlanner()),
  ]);
  const blocks = [harnessMem, userMem, projectMem, gitCtx, dashboard].filter(Boolean);
  if (blocks.length === 0) return "";
  const packet = blocks.join("\n\n---\n\n");
  return clip(packet, MAX_PACKET_CHARS);
}
