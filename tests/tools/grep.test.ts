import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findGrepBinary, grepTool, jsGrep, resetGrepBinaryCache } from "../../src/tools/grep.js";
import { findOnPath } from "../../src/util/which.js";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "patchwork-harness-grep-"));
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(dir, "build"));
  writeFileSync(
    join(dir, "src", "a.ts"),
    "const alpha = 1;\nfunction needle() {}\nconst beta = needle();\n",
  );
  writeFileSync(join(dir, "src", "b.py"), "def needle():\n    pass\n");
  writeFileSync(join(dir, "src", "c.log"), "needle in a log file\n");
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "needle in node_modules\n");
  writeFileSync(join(dir, "build", "out.js"), "needle in build\n");
  writeFileSync(
    join(dir, "src", "bin.dat"),
    Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]),
  );
  writeFileSync(join(dir, ".gitignore"), "*.log\nbuild\n");
  return dir;
}

describe("grep: pure-JS fallback", () => {
  it("finds matches with file:line, skips ignored dirs, .gitignore patterns and binaries", () => {
    const dir = fixture();
    const out = jsGrep(
      { pattern: "needle", path: ".", case_insensitive: false, max_matches: 100 },
      dir,
    );
    expect(out.engine).toBe("js");
    const files = out.matches.map((m) => m.file).sort();
    expect(files).toEqual(["src/a.ts", "src/a.ts", "src/b.py"]);
    expect(out.matches.find((m) => m.file === "src/a.ts" && m.line === 2)?.text).toContain(
      "function needle",
    );
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.endsWith(".log"))).toBe(false);
    expect(files.some((f) => f.startsWith("build"))).toBe(false);
    expect(files.some((f) => f.endsWith(".dat"))).toBe(false);
    expect(out.truncated).toBe(false);
  });

  it("honours max_matches and reports truncation", () => {
    const dir = fixture();
    const out = jsGrep(
      { pattern: "needle", path: "src", case_insensitive: false, max_matches: 1 },
      dir,
    );
    expect(out.matches).toHaveLength(1);
    expect(out.truncated).toBe(true);
  });

  it("is case-insensitive on request", () => {
    const dir = fixture();
    const out = jsGrep(
      { pattern: "NEEDLE", path: "src/a.ts", case_insensitive: true, max_matches: 10 },
      dir,
    );
    expect(out.matches.length).toBe(2);
  });
});

describe("grep: binary discovery is PATH-only, never the cwd", () => {
  it("does not pick up an rg/grep sitting in the working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "patchwork-harness-evil-"));
    for (const name of ["rg", "rg.exe", "rg.cmd", "grep", "grep.exe"]) {
      writeFileSync(join(dir, name), "#!/bin/sh\necho pwned\n");
      try {
        chmodSync(join(dir, name), 0o755);
      } catch {
        /* windows */
      }
    }
    // PATH contains only an empty temp dir; cwd (dir) holds the impostors
    const emptyDir = mkdtempSync(join(tmpdir(), "patchwork-harness-empty-"));
    const found = findGrepBinary({ PATH: emptyDir, PATHEXT: ".EXE;.CMD" });
    expect(found).toBeNull();
    expect(findOnPath("rg", { PATH: emptyDir, PATHEXT: ".EXE;.CMD" })).toBeNull();
  });

  it("returns an ABSOLUTE path from a PATH entry", () => {
    const binDir = mkdtempSync(join(tmpdir(), "patchwork-harness-bin-"));
    const name = process.platform === "win32" ? "rg.exe" : "rg";
    writeFileSync(join(binDir, name), "#!/bin/sh\nexit 0\n");
    try {
      chmodSync(join(binDir, name), 0o755);
    } catch {
      /* windows */
    }
    const found = findGrepBinary({
      PATH: [binDir, "/nonexistent"].join(delimiter),
      PATHEXT: ".EXE;.CMD",
    });
    expect(found?.kind).toBe("rg");
    expect(found?.path).toBe(join(binDir, name));
  });
});

describe("grep tool", () => {
  it("treats a pattern that looks like an option as a pattern (the `--` guard)", async () => {
    resetGrepBinaryCache();
    const dir = fixture();
    writeFileSync(join(dir, "src", "opt.txt"), "the string --version appears here\n");
    const out = await grepTool.run(
      { pattern: "--version", path: "src", case_insensitive: false, max_matches: 10 },
      { cwd: dir, sessionId: "t" },
    );
    // with `--` in place the engine searches for the literal; without it rg/grep
    // would print their own version (a line with no file:line shape → file "?")
    expect(out.matches.every((m) => m.file !== "?")).toBe(true);
    expect(out.matches.some((m) => m.file === "src/opt.txt" && m.line === 1)).toBe(true);
    expect(["rg", "grep", "js"]).toContain(out.engine);
  });

  it("never returns 'zero matches' for a bad regex when an engine is present", async () => {
    resetGrepBinaryCache();
    const dir = fixture();
    const bin = findGrepBinary();
    if (!bin) return; // JS engine throws SyntaxError from RegExp - covered implicitly
    await expect(
      grepTool.run(
        { pattern: "(unclosed", path: "src", case_insensitive: false, max_matches: 10 },
        { cwd: dir, sessionId: "t" },
      ),
    ).rejects.toThrow(/do NOT treat this as zero matches/);
  });
});
