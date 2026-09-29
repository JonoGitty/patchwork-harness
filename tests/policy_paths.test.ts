import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decide, pathInsideCwd } from "../src/permissions/policy.js";

// 3 Sept 2026 security review: the inside-cwd predicate gates reads AND
// writes; it must follow symlinks and the deny tier must see the real path.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "patchwork-harness-paths-"));
  const cwd = join(root, "proj");
  const outside = join(root, "outside");
  mkdirSync(cwd);
  mkdirSync(outside);
  mkdirSync(join(root, "proj-evil"));
  writeFileSync(join(cwd, "inside.txt"), "ok");
  writeFileSync(join(outside, "secret.txt"), "shh");
  writeFileSync(join(outside, "id_rsa"), "key");
  // a directory link inside the project pointing OUT (junction on
  // Windows needs no privilege; a plain symlink elsewhere)
  symlinkSync(outside, join(cwd, "link"), process.platform === "win32" ? "junction" : "dir");
  return { root, cwd, outside };
}

const ctx = (cwd: string, path: string) => ({
  cwd,
  toolName: "read",
  risk: { level: "none" as const, flags: [] as string[] },
  description: `read ${path}`,
  details: { path },
  mode: "default" as const,
});

describe("pathInsideCwd", () => {
  const { root, cwd } = fixture();
  it("a plain relative file is inside", () => {
    expect(pathInsideCwd("inside.txt", cwd)).toBe(true);
  });
  it("a not-yet-created file under cwd is inside", () => {
    expect(pathInsideCwd("new/dir/file.txt", cwd)).toBe(true);
  });
  it(".. traversal is outside", () => {
    expect(pathInsideCwd("../outside/secret.txt", cwd)).toBe(false);
  });
  it("a sibling directory sharing the prefix is outside", () => {
    expect(pathInsideCwd(join(root, "proj-evil", "x"), cwd)).toBe(false);
  });
  it("a symlink inside the project that points OUT is outside (the 3 Sept finding)", () => {
    expect(pathInsideCwd("link/secret.txt", cwd)).toBe(false);
  });
  it("a not-yet-created file UNDER an out-pointing symlink is outside", () => {
    expect(pathInsideCwd("link/new.txt", cwd)).toBe(false);
  });
});

describe("decide(): the sensitive-path deny tier sees the real path", () => {
  const { cwd } = fixture();
  it("id_rsa reached through a symlink named `link` is DENIED, not merely prompted", () => {
    const d = decide(ctx(cwd, "link/id_rsa"));
    expect(d.kind).toBe("deny");
  });
  it("a plain file inside cwd is auto", () => {
    expect(decide(ctx(cwd, "inside.txt")).kind).toBe("auto");
  });
});
