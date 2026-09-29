import { join } from "node:path";
/** CLI smoke: the verify command must be able to FAIL (exit 1 on fab-001). */
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { PROJECT_ROOT } from "../src/util/paths.js";

const tsx = join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const cli = join(PROJECT_ROOT, "src", "cli.ts");
const corpus = (id: string) =>
  join(PROJECT_ROOT, "tests", "fixtures", "verifier-corpus", `${id}.json`);

describe("patchwork-harness verify file", () => {
  it("fab-001 (the fabrication) exits 1 — the command can fail", async () => {
    const r = await execa(process.execPath, [tsx, cli, "verify", "file", corpus("fab-001")], {
      reject: false,
      timeout: 120_000,
    });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("NOT_GREEN");
  }, 150_000);

  it("ok-001 exits 0 with a proof-bearing green", async () => {
    const r = await execa(process.execPath, [tsx, cli, "verify", "file", corpus("ok-001")], {
      reject: false,
      timeout: 120_000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("VERIFIED");
    expect(r.stdout).toContain("[ev_01]"); // green carries its proof
  }, 150_000);

  it("--expect validates against the corpus's own answer key", async () => {
    const r = await execa(
      process.execPath,
      [tsx, cli, "verify", "file", corpus("mis-001"), "--expect"],
      { reject: false, timeout: 120_000 },
    );
    expect(r.exitCode).toBe(0);
  }, 150_000);
});
