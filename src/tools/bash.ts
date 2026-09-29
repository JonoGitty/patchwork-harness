import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { RiskAssessment, Tool, ToolCtx } from "./base.js";

const Input = z.object({
  command: z
    .string()
    .min(1)
    .describe("Shell command to run via a POSIX sh -c (Git Bash on Windows)"),
  timeout_ms: z.number().int().positive().max(600_000).default(120_000),
});
type In = z.infer<typeof Input>;

interface Out {
  stdout: string;
  stderr: string;
  exit_code: number;
  duration_ms: number;
}

const DESTRUCTIVE = [/^\s*sudo\b/, /\brm\s+-rf\s+/, /\bgit\s+push\s+--force/, /\bchmod\s+777\b/];
const PIPE_TO_SHELL = [/\|\s*(bash|sh)\b/, /curl\s+[^|]*\|\s*(bash|sh)/];

function classify(cmd: string): RiskAssessment {
  const flags: string[] = [];
  if (PIPE_TO_SHELL.some((re) => re.test(cmd))) {
    flags.push("pipe_to_shell");
    return { level: "critical", flags };
  }
  if (DESTRUCTIVE.some((re) => re.test(cmd))) {
    flags.push("destructive_command");
    return { level: "critical", flags };
  }
  if (/\bgit\s+push\b/.test(cmd)) {
    flags.push("git_push");
    return { level: "high", flags };
  }
  if (/\bgit\s+commit\b/.test(cmd) || /\bnpm\s+(test|run|install)/.test(cmd)) {
    return { level: "low", flags };
  }
  // Default for arbitrary commands
  return { level: "medium", flags };
}

/**
 * The shell commands run in. On Windows node /bin/sh does not exist, so
 * EVERY command came back exit -1 with no output - the bash tool had never
 * worked on this machine (found 28 Sept 2026). Prefer Git Bash, whose POSIX
 * semantics (&&, test, grep -q) are what the planner and models assume;
 * fall back to cmd.exe. PATCHWORK_HARNESS_SHELL overrides.
 */
export function resolveShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): string | true {
  if (env.PATCHWORK_HARNESS_SHELL) return env.PATCHWORK_HARNESS_SHELL;
  if (platform !== "win32") return "/bin/sh";
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], "C:\\Program Files"].filter(
    (r): r is string => !!r,
  );
  for (const r of roots) {
    const bash = join(r, "Git", "bin", "bash.exe");
    if (exists(bash)) return bash;
  }
  return true; // cmd.exe via ComSpec
}

export const bashTool: Tool<In, Out> = {
  name: "bash",
  description:
    "Run a shell command in the current working directory. Use for build/test/git/install commands. Does not support interactive programs.",
  inputSchema: Input,
  assess: (input) => classify(input.command),
  preview: (input) => ({
    description: `bash: ${input.command.slice(0, 80)}`,
    details: { command: input.command },
  }),
  async run(input, ctx) {
    const t0 = performance.now();
    try {
      const result = await execa(input.command, {
        cwd: ctx.cwd,
        shell: resolveShell(),
        timeout: input.timeout_ms,
        reject: false,
        env: { ...process.env, PATCHWORK_HARNESS_SESSION: ctx.sessionId },
      });
      return {
        stdout: result.stdout,
        // a shell that never started has no exit code - say why, never a silent -1
        stderr:
          result.exitCode === undefined
            ? `${result.stderr}${result.stderr ? "\n" : ""}${result.shortMessage ?? "command did not start"}`
            : result.stderr,
        exit_code: result.exitCode ?? -1,
        duration_ms: Math.round(performance.now() - t0),
      };
    } catch (e) {
      return {
        stdout: "",
        stderr: (e as Error).message,
        exit_code: -1,
        duration_ms: Math.round(performance.now() - t0),
      };
    }
  },
};
