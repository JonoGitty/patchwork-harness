/**
 * Claude skill backwards-compatibility plugin.
 *
 * Reads ~/.claude/skills/<name>/SKILL.md frontmatter and surfaces each
 * skill's description to the planner so the user's existing investment
 * in Claude skills is visible from day one.
 *
 * M1: enumeration only. M2: actual invocation via a `claude_skill` tool.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { claudeSkillTool } from "./claude_skill_tool.js";
import type { Plugin } from "./types.js";

const SKILLS_DIR = join(homedir(), ".claude", "skills");

async function claudeOnPath(): Promise<boolean> {
  try {
    const r = await execa("which", ["claude"], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

function parseFrontmatter(content: string): Record<string, string> | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = content.slice(3, end).trim();
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  return out;
}

interface SkillSummary {
  name: string;
  description: string;
}

function enumerateSkills(): SkillSummary[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const out: SkillSummary[] = [];
  for (const entry of readdirSync(SKILLS_DIR)) {
    const skillPath = join(SKILLS_DIR, entry, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    try {
      const fm = parseFrontmatter(readFileSync(skillPath, "utf8"));
      if (fm?.name && fm.description) {
        out.push({ name: fm.name, description: fm.description });
      }
    } catch {
      // ignore unreadable skills
    }
  }
  return out;
}

export const claudeCompatPlugin: Plugin = {
  name: "claude_compat",
  description: "Enumerates ~/.claude/skills/* AND registers a `claude_skill` tool that invokes them via `claude -p`.",
  version: "0.2.0",
  init: async (ctx) => {
    if (await claudeOnPath()) {
      ctx.registerTool(claudeSkillTool as any);
    }
  },
  hooks: {
    catalogueEntries: () => {
      const skills = enumerateSkills();
      return skills.map(
        (s) => `${s.name} — ${s.description.slice(0, 120)} (call via claude_skill tool)`,
      );
    },
  },
};
