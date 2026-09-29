/**
 * `claude_skill` tool — invokes a Claude skill from inside patchwork-harness by
 * spawning `claude -p "/<name> <args>"` and capturing the result.
 *
 * Registered by the claude_compat plugin (only when `claude` is on PATH).
 */

import { execa } from "execa";
import { z } from "zod";
import type { Tool, RiskAssessment } from "../tools/base.js";

const Input = z.object({
  skill_name: z.string().describe("Claude skill name (e.g. 'dashboard', 'finance', 'gv2fld')"),
  args: z
    .string()
    .default("")
    .describe("Arguments passed after the skill name, as a single string."),
  timeout_ms: z.number().int().positive().max(900_000).default(300_000),
});
type In = z.infer<typeof Input>;

interface Out {
  output: string;
  exit_code: number;
  duration_ms: number;
}

function classify(name: string): RiskAssessment {
  // Trust the skill itself — it is user-installed Claude content. The
  // executor's risk story is delegated to whatever audit/policy runs
  // inside the spawned `claude` process (which itself respects
  // Patchwork hooks installed for claude-code).
  if (/finance|tax|networth|portfolio/.test(name)) {
    return { level: "low", flags: ["delegated_to_claude_skill"] };
  }
  return { level: "medium", flags: ["delegated_to_claude_skill"] };
}

export const claudeSkillTool: Tool<In, Out> = {
  name: "claude_skill",
  description:
    "Invoke a Claude Code skill (from ~/.claude/skills/) as a subroutine. Spawns 'claude -p \"/<name> <args>\"' and returns the result. Use when an existing skill already does what this step needs (check the skill catalogue in your context).",
  inputSchema: Input,
  assess: (i) => classify(i.skill_name),
  preview: (i) => ({
    description: `claude_skill: /${i.skill_name} ${i.args.slice(0, 60)}`,
    details: { command: `claude -p "/${i.skill_name} ${i.args}"` },
  }),
  async run(input, ctx) {
    const t0 = performance.now();
    try {
      const prompt = `/${input.skill_name}${input.args ? " " + input.args : ""}`;
      const result = await execa(
        "claude",
        ["-p", prompt, "--output-format", "json"],
        {
          cwd: ctx.cwd,
          env: { ...process.env, PATCHWORK_HARNESS_PARENT_SESSION: ctx.sessionId },
          timeout: input.timeout_ms,
          reject: false,
        },
      );
      // Try to extract `result` field from claude's JSON output; fall back to raw.
      let output = result.stdout;
      try {
        const parsed = JSON.parse(result.stdout);
        if (parsed.result) output = parsed.result;
      } catch {
        /* not JSON; keep raw */
      }
      return {
        output,
        exit_code: result.exitCode ?? -1,
        duration_ms: Math.round(performance.now() - t0),
      };
    } catch (e) {
      return {
        output: `error spawning claude: ${(e as Error).message}`,
        exit_code: -1,
        duration_ms: Math.round(performance.now() - t0),
      };
    }
  },
};
