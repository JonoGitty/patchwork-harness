import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SESSIONS_DIR, ensureDirs } from "../util/paths.js";
import type { SessionState } from "./types.js";

/** Write the session manifest to ~/.patchwork-harness/sessions/<sid>.json */
export function persistSession(state: SessionState): string {
  ensureDirs();
  const path = join(SESSIONS_DIR, `${state.sessionId}.json`);
  writeFileSync(path, JSON.stringify(state, null, 2));
  return path;
}
