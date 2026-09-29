/**
 * API-key persistence. Reads/writes ~/.patchwork-harness/.env so keys survive across
 * shells. Recognised keys are the four provider keys plus the Google
 * fallback. Anything else is preserved as-is on writes.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_HARNESS } from "./paths.js";

const MAX_KEY_LENGTH = 1024;

export const KEY_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "XAI_API_KEY",
  "TYPESAFE_API_KEY", // ADR-0013 classifier (Jev)
] as const;

export type KeyName = (typeof KEY_NAMES)[number];

const ENV_PATH = join(HOME_HARNESS, ".env");

function readAllLines(): string[] {
  if (!existsSync(ENV_PATH)) return [];
  return readFileSync(ENV_PATH, "utf8").split("\n");
}

function writeAll(lines: string[]): void {
  if (!existsSync(HOME_HARNESS)) mkdirSync(HOME_HARNESS, { recursive: true });
  // Atomic write at mode 0600 from creation: write to a tempfile in the
  // same dir then rename. This avoids the brief window where ~/.patchwork-harness/.env
  // would have default umask (0644) before chmod ran.
  const data = lines.join("\n").replace(/\n+$/, "") + "\n";
  const tmp = `${ENV_PATH}.tmp.${process.pid}`;
  writeFileSync(tmp, data, { mode: 0o600 });
  // Belt-and-suspenders chmod (umask might still apply on some platforms)
  try { chmodSync(tmp, 0o600); } catch { /* best-effort on non-POSIX */ }
  renameSync(tmp, ENV_PATH);
}

export function listKeys(): { name: KeyName; set: boolean; preview: string }[] {
  // Combine shell env (live) with file-stored keys (persistent)
  const fileKeys = new Map<string, string>();
  for (const line of readAllLines()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    fileKeys.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return KEY_NAMES.map((name) => {
    const live = process.env[name] ?? fileKeys.get(name) ?? "";
    return {
      name,
      set: !!live,
      preview: live ? `${live.slice(0, 7)}…${live.slice(-4)}` : "",
    };
  });
}

export class InvalidKeyValueError extends Error {
  constructor(reason: string) {
    super(`invalid key value: ${reason}`);
    this.name = "InvalidKeyValueError";
  }
}

export function setKey(name: string, value: string): void {
  // Reject newlines / CR (would inject extra env vars or corrupt the file)
  // and bound the length so a malformed paste can't bomb ~/.patchwork-harness/.env.
  if (/[\r\n]/.test(value)) {
    throw new InvalidKeyValueError("contains newline");
  }
  if (value.length > MAX_KEY_LENGTH) {
    throw new InvalidKeyValueError(`length exceeds ${MAX_KEY_LENGTH}`);
  }
  if (!value) {
    throw new InvalidKeyValueError("empty");
  }
  const lines = readAllLines();
  const idx = lines.findIndex((l) => l.trim().startsWith(`${name}=`));
  const line = `${name}=${value}`;
  if (idx >= 0) lines[idx] = line;
  else lines.push(line);
  writeAll(lines);
  process.env[name] = value;
}

export function unsetKey(name: string): void {
  const lines = readAllLines();
  const filtered = lines.filter((l) => !l.trim().startsWith(`${name}=`));
  writeAll(filtered);
  delete process.env[name];
}

export function envFilePath(): string {
  return ENV_PATH;
}
