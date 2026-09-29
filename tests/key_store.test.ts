import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("key_store", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "patchwork-harness-keys-"));
    process.env.HOME = tmpHome;
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("rejects values containing newlines (env-var injection guard)", async () => {
    const { setKey, InvalidKeyValueError } = await import("../src/util/key_store.js");
    expect(() => setKey("ANTHROPIC_API_KEY", "sk-ant-good\nMALICIOUS=evil"))
      .toThrow(InvalidKeyValueError);
  });

  it("rejects empty values", async () => {
    const { setKey, InvalidKeyValueError } = await import("../src/util/key_store.js");
    expect(() => setKey("ANTHROPIC_API_KEY", "")).toThrow(InvalidKeyValueError);
  });

  it("rejects oversized values", async () => {
    const { setKey, InvalidKeyValueError } = await import("../src/util/key_store.js");
    expect(() => setKey("ANTHROPIC_API_KEY", "x".repeat(2000))).toThrow(InvalidKeyValueError);
  });

  it("writes the env file at mode 0600", async () => {
    const { setKey, envFilePath } = await import("../src/util/key_store.js");
    setKey("ANTHROPIC_API_KEY", "sk-ant-test-12345678");
    const path = envFilePath();
    const stat = statSync(path);
    // POSIX permission bits — user-only rw
    expect(stat.mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toContain("ANTHROPIC_API_KEY=sk-ant-test-12345678");
  });

  it("set + unset round trips and updates listKeys", async () => {
    const { setKey, unsetKey, listKeys } = await import("../src/util/key_store.js");
    setKey("OPENAI_API_KEY", "sk-openai-test-abc");
    let entry = listKeys().find((k) => k.name === "OPENAI_API_KEY");
    expect(entry?.set).toBe(true);
    unsetKey("OPENAI_API_KEY");
    entry = listKeys().find((k) => k.name === "OPENAI_API_KEY");
    expect(entry?.set).toBe(false);
  });
});
