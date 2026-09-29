import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Honour an explicit $HOME before os.homedir(): on Windows homedir() reads
// USERPROFILE and ignores HOME, so the test suite's HOME=<tmpdir> override
// was silently writing the TEST placeholder key into the REAL key store
// (every `npm test` clobbered ~/.patchwork-harness/.env - found 2 Sept 2026).
export const HOME_HARNESS = join(process.env.HOME || homedir(), ".patchwork-harness");
export const EVENTS_DIR = join(HOME_HARNESS, "events");
export const SESSIONS_DIR = join(HOME_HARNESS, "sessions");
export const CACHE_DIR = join(HOME_HARNESS, "cache");
export const MEMORY_DIR = join(HOME_HARNESS, "memory");
// PATCHWORK_HARNESS_TEST_LOG_DIR overrides (same env the vitest reporter honours) so
// the web routes, CLI and tests all resolve the ONE test-log location.
export const TESTS_DIR = process.env.PATCHWORK_HARNESS_TEST_LOG_DIR || join(HOME_HARNESS, "tests");

/**
 * Walk up from this file until we find OUR package.json — i.e. one whose
 * `name` field is "patchwork-harness" — alongside a config/ directory.
 * Anchoring on the name avoids matching a containing project's package
 * if patchwork-harness ever ends up inside another monorepo.
 */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (dir !== "/" && dir.length > 1) {
    const pkgPath = join(dir, "package.json");
    const configDir = join(dir, "config");
    if (existsSync(pkgPath) && existsSync(configDir)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "patchwork-harness") return dir;
      } catch {
        /* fall through */
      }
    }
    dir = dirname(dir);
  }
  throw new Error("patchwork-harness: package root not found (looking for patchwork-harness + config/)");
}

export const PROJECT_ROOT = findPackageRoot();
export const CONFIG_DIR = join(PROJECT_ROOT, "config");

export function ensureDirs(): void {
  for (const d of [HOME_HARNESS, EVENTS_DIR, SESSIONS_DIR, CACHE_DIR, MEMORY_DIR, TESTS_DIR, join(TESTS_DIR, "runs")]) {
    mkdirSync(d, { recursive: true });
  }
}
