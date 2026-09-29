/**
 * Tiny .env loader. Reads ~/.patchwork-harness/.env first (machine-wide), then a
 * .env in the current working directory (project-local), in that
 * order. Existing process.env values WIN — env-vars set in the shell
 * always override the file (matches dotenv conventions).
 *
 * Format: KEY=value per line. Lines starting with # are comments.
 * Values may be optionally quoted with " or '. No multiline support.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_HARNESS } from "./paths.js";

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq <= 0) return null;
  const key = trimmed.slice(0, eq).trim();
  let value = trimmed.slice(eq + 1).trim();
  // Strip matching outer quotes
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function loadFile(path: string): void {
  if (!existsSync(path)) return;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    // Shell env wins — never override what's already set
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

let loaded = false;
export function loadEnvFiles(cwd: string = process.cwd(), opts: { force?: boolean } = {}): void {
  if (loaded && !opts.force) return;
  loaded = true;
  loadFile(join(HOME_HARNESS, ".env"));      // global, machine-wide
  loadFile(join(cwd, ".env"));               // project-local
}

/**
 * Re-read ~/.patchwork-harness/.env and merge any NEW keys into process.env. Used by
 * the web server's /api/settings so adding a key via the UI shows up
 * immediately without a restart. Does NOT overwrite values already set
 * (matches dotenv convention).
 */
export function reloadEnvFiles(cwd: string = process.cwd()): void {
  loadFile(join(HOME_HARNESS, ".env"));
  loadFile(join(cwd, ".env"));
}
