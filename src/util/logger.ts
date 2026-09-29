import chalk from "chalk";

export type Level = "debug" | "info" | "warn" | "error";

let LEVEL: Level = (process.env.PATCHWORK_HARNESS_LOG_LEVEL as Level) || "info";

const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function setLevel(l: Level): void {
  LEVEL = l;
}

function should(l: Level): boolean {
  return order[l] >= order[LEVEL];
}

/**
 * When true, all logger output goes to stderr instead of stdout. Used by
 * --json mode so that only NDJSON events appear on stdout. Errors and
 * warnings still surface on stderr where a parent process can find them.
 */
let SILENT_STDOUT = false;

export function setSilentStdout(s: boolean): void {
  SILENT_STDOUT = s;
}

function out(...a: unknown[]): void {
  if (SILENT_STDOUT) console.error(...a);
  else console.log(...a);
}

export const log = {
  debug: (...a: unknown[]) => should("debug") && out(chalk.gray("·"), ...a),
  info: (...a: unknown[]) => should("info") && out(chalk.cyan("›"), ...a),
  warn: (...a: unknown[]) => should("warn") && out(chalk.yellow("⚠"), ...a),
  error: (...a: unknown[]) => should("error") && out(chalk.red("✖"), ...a),
  ok: (...a: unknown[]) => out(chalk.green("✓"), ...a),
  step: (label: string, why?: string) => {
    const w = why ? chalk.dim(`  — ${why}`) : "";
    out(chalk.bold.cyan(`▸ ${label}`) + w);
  },
  cost: (usd: number, tokens: { in?: number; out?: number }, ms?: number) => {
    const parts = [chalk.dim(`$${usd.toFixed(4)}`)];
    if (tokens.in != null) parts.push(chalk.dim(`in ${tokens.in}`));
    if (tokens.out != null) parts.push(chalk.dim(`out ${tokens.out}`));
    if (ms != null) parts.push(chalk.dim(`${ms}ms`));
    out("  " + parts.join("  "));
  },
};
