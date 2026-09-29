import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmpHome: string;
const origHome = process.env.HOME;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "patchwork-harness-env-"));
  process.env.HOME = tmpHome;
  vi.resetModules();
  // Wipe any leaked test keys from prior tests
  for (const k of ["TEST_FAKE_KEY", "ANOTHER_FAKE_KEY"]) delete process.env[k];
});
afterEach(() => {
  process.env.HOME = origHome;
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* */ }
});

describe("loadEnvFiles", () => {
  it("reads ~/.patchwork-harness/.env into process.env", async () => {
    mkdirSync(join(tmpHome, ".patchwork-harness"), { recursive: true });
    writeFileSync(join(tmpHome, ".patchwork-harness/.env"), "TEST_FAKE_KEY=hello-world\n");
    const { loadEnvFiles } = await import("../src/util/env.js");
    loadEnvFiles();
    expect(process.env.TEST_FAKE_KEY).toBe("hello-world");
  });

  it("does not override values already set in the shell", async () => {
    mkdirSync(join(tmpHome, ".patchwork-harness"), { recursive: true });
    writeFileSync(join(tmpHome, ".patchwork-harness/.env"), "TEST_FAKE_KEY=from-file\n");
    process.env.TEST_FAKE_KEY = "from-shell";
    const { loadEnvFiles } = await import("../src/util/env.js");
    loadEnvFiles();
    expect(process.env.TEST_FAKE_KEY).toBe("from-shell");
  });

  it("strips matching outer quotes", async () => {
    mkdirSync(join(tmpHome, ".patchwork-harness"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".patchwork-harness/.env"),
      ['TEST_FAKE_KEY="quoted-value"', "ANOTHER_FAKE_KEY='single-quoted'"].join("\n"),
    );
    const { loadEnvFiles } = await import("../src/util/env.js");
    loadEnvFiles();
    expect(process.env.TEST_FAKE_KEY).toBe("quoted-value");
    expect(process.env.ANOTHER_FAKE_KEY).toBe("single-quoted");
  });

  it("ignores comments and blank lines", async () => {
    mkdirSync(join(tmpHome, ".patchwork-harness"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".patchwork-harness/.env"),
      ["# leading comment", "", "TEST_FAKE_KEY=value", "  # indented comment", ""].join("\n"),
    );
    const { loadEnvFiles } = await import("../src/util/env.js");
    loadEnvFiles();
    expect(process.env.TEST_FAKE_KEY).toBe("value");
  });

  it("does nothing when neither file exists", async () => {
    const { loadEnvFiles } = await import("../src/util/env.js");
    expect(() => loadEnvFiles()).not.toThrow();
    expect(process.env.TEST_FAKE_KEY).toBeUndefined();
  });
});

describe("key_store", () => {
  it("set + list round-trips a key", async () => {
    const { setKey, listKeys } = await import("../src/util/key_store.js");
    setKey("ANTHROPIC_API_KEY", "sk-ant-test-1234567890");
    const found = listKeys().find((k) => k.name === "ANTHROPIC_API_KEY");
    expect(found?.set).toBe(true);
    expect(found?.preview).toContain("sk-ant-");
  });

  it("unset removes the key from process.env", async () => {
    const { setKey, unsetKey } = await import("../src/util/key_store.js");
    setKey("XAI_API_KEY", "xai-test-key");
    expect(process.env.XAI_API_KEY).toBe("xai-test-key");
    unsetKey("XAI_API_KEY");
    expect(process.env.XAI_API_KEY).toBeUndefined();
  });
});
