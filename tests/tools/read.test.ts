import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { READ_DEFAULT_LIMIT, READ_MAX_CHARS, readTool } from "../../src/tools/read.js";

function file(lines: number, width = 10): { cwd: string; path: string } {
  const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-read-"));
  const body = Array.from(
    { length: lines },
    (_, i) => `L${String(i + 1).padStart(5, "0")} ${"x".repeat(width)}`,
  ).join("\n");
  writeFileSync(join(cwd, "big.txt"), `${body}\n`);
  return { cwd, path: "big.txt" };
}

const ctx = (cwd: string) => ({ cwd, sessionId: "t" });
const parse = (i: Record<string, unknown>) =>
  readTool.inputSchema.parse(i) as Parameters<typeof readTool.run>[0];

describe("read tool: line paging", () => {
  it("returns the whole file when it fits, with counts and no next_offset", async () => {
    const f = file(20);
    const out = await readTool.run(parse({ path: f.path }), ctx(f.cwd));
    expect(out.total_lines).toBe(20);
    expect(out.start_line).toBe(1);
    expect(out.end_line).toBe(20);
    expect(out.truncated).toBe(false);
    expect(out.next_offset).toBeUndefined();
    expect(out.content.split("\n")).toHaveLength(20);
  });

  it("pages with offset/limit and hands back next_offset", async () => {
    const f = file(100);
    const p1 = await readTool.run(parse({ path: f.path, limit: 40 }), ctx(f.cwd));
    expect(p1.start_line).toBe(1);
    expect(p1.end_line).toBe(40);
    expect(p1.truncated).toBe(true);
    expect(p1.next_offset).toBe(41);
    const p2 = await readTool.run(
      parse({ path: f.path, offset: p1.next_offset, limit: 40 }),
      ctx(f.cwd),
    );
    expect(p2.content.startsWith("L00041")).toBe(true);
    expect(p2.end_line).toBe(80);
    const p3 = await readTool.run(
      parse({ path: f.path, offset: p2.next_offset, limit: 40 }),
      ctx(f.cwd),
    );
    expect(p3.end_line).toBe(100);
    expect(p3.truncated).toBe(false);
    expect(p3.next_offset).toBeUndefined();
  });

  it("defaults to a page that keeps a real file under the executor read cap", async () => {
    const f = file(READ_DEFAULT_LIMIT + 500);
    const out = await readTool.run(parse({ path: f.path }), ctx(f.cwd));
    expect(out.end_line).toBe(READ_DEFAULT_LIMIT);
    expect(out.next_offset).toBe(READ_DEFAULT_LIMIT + 1);
    expect(out.content.length).toBeLessThanOrEqual(READ_MAX_CHARS);
  });

  it("caps a page of huge lines by chars and still says how to continue", async () => {
    const f = file(200, 1000); // 200 lines × ~1kB = 200k chars
    const out = await readTool.run(parse({ path: f.path }), ctx(f.cwd));
    expect(out.content.length).toBeLessThanOrEqual(READ_MAX_CHARS);
    expect(out.truncated).toBe(true);
    expect(out.next_offset).toBe(out.end_line + 1);
    expect(out.end_line).toBeLessThan(200);
  });
});
