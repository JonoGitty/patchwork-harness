import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR, ensureDirs } from "../util/paths.js";
import type { SessionState } from "./types.js";

/**
 * Write the session manifest to ~/.patchwork-harness/sessions/<sid>.json. Written after
 * the plan and after every step as well as at the end, so a killed run can be
 * continued (ADR-0022); via a temp file + rename, so a kill mid-write never
 * leaves a half-written manifest.
 */
export function persistSession(state: SessionState): string {
  ensureDirs();
  const path = join(SESSIONS_DIR, `${state.sessionId}.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
  return path;
}
