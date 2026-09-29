/**
 * boot — fail-closed preflight.
 *
 * Patchwork Harness will not start unless:
 *   1. `patchwork` is on PATH and reports a version
 *   2. ~/.patchwork/ is reachable
 *   3. our audit JSONL accepts a test event
 *   4. config loads
 *
 * See DECISIONS/0001-patchwork-required.md.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execa } from "execa";
import { AuditEmitter } from "./audit.js";
import { loadPolicy, loadModels } from "./config.js";
import { newSessionId } from "./util/ulid.js";

export interface BootCheck {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface BootResult {
  ok: boolean;
  checks: BootCheck[];
  patchworkVersion?: string;
}

async function checkPatchworkBinary(): Promise<BootCheck> {
  try {
    const { stdout } = await execa("patchwork", ["--version"], { timeout: 5000 });
    return {
      name: "patchwork CLI",
      ok: true,
      detail: stdout.trim(),
    };
  } catch {
    return {
      name: "patchwork CLI",
      ok: false,
      detail: "not found on PATH",
      fix: "npm install -g patchwork-audit && patchwork init",
    };
  }
}

function checkPatchworkData(): BootCheck {
  const dir = join(homedir(), ".patchwork");
  if (existsSync(dir)) {
    return { name: "patchwork data dir", ok: true, detail: dir };
  }
  return {
    name: "patchwork data dir",
    ok: false,
    detail: `${dir} missing`,
    fix: "patchwork init",
  };
}

function checkAuditWritable(sessionId: string, cwd: string): BootCheck {
  try {
    const projectName = cwd.split("/").pop() || "unknown";
    const e = new AuditEmitter(sessionId, cwd, projectName);
    e.emit({ action: "boot_check", status: "completed" });
    return { name: "audit sink", ok: true, detail: e.pathOnDisk };
  } catch (err) {
    return {
      name: "audit sink",
      ok: false,
      detail: (err as Error).message,
      fix: "check filesystem permissions on ~/.patchwork-harness/events",
    };
  }
}

function checkConfig(): BootCheck {
  try {
    loadPolicy();
    loadModels();
    return { name: "config load", ok: true, detail: "policy.yml + models.yml" };
  } catch (err) {
    return {
      name: "config load",
      ok: false,
      detail: (err as Error).message,
      fix: "check config/policy.yml and config/models.yml against the schema",
    };
  }
}

export async function boot(opts: { cwd?: string; sessionId?: string } = {}): Promise<BootResult> {
  const cwd = opts.cwd ?? process.cwd();
  const sessionId = opts.sessionId ?? newSessionId();
  const checks: BootCheck[] = [];

  const pwBin = await checkPatchworkBinary();
  checks.push(pwBin);
  checks.push(checkPatchworkData());
  checks.push(checkConfig());
  checks.push(checkAuditWritable(sessionId, cwd));

  const ok = checks.every((c) => c.ok);
  return { ok, checks, patchworkVersion: pwBin.ok ? pwBin.detail : undefined };
}

/** Throws if boot fails. Use this from any code path that expects to run. */
export async function bootOrExit(opts: Parameters<typeof boot>[0] = {}): Promise<BootResult> {
  const result = await boot(opts);
  if (!result.ok) {
    const lines: string[] = ["Patchwork Harness cannot start:"];
    for (const c of result.checks) {
      if (!c.ok) {
        lines.push(`  ✖ ${c.name}: ${c.detail}`);
        if (c.fix) lines.push(`    → ${c.fix}`);
      }
    }
    process.stderr.write(lines.join("\n") + "\n");
    process.exit(1);
  }
  return result;
}
