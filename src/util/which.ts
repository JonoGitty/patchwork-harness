/**
 * Resolve an executable to an ABSOLUTE path by walking PATH ourselves.
 *
 * Never the current directory: on Windows, spawning a bare name lets
 * process creation search the child's cwd before PATH, so a cloned repo
 * carrying `rg.exe` / `git.cmd` at its root would be executed by a tool
 * that was auto-approved. Every spawn in patchwork-harness that takes a bare binary
 * name goes through here (7 Sept 2026).
 */
import { constants, accessSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const pathVar = env.PATH ?? env.Path ?? env.path ?? "";
  const dirs = pathVar.split(delimiter).filter((d) => d.trim().length > 0);
  const exts =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext.toLowerCase()}`);
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}
