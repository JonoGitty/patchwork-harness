import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AmbiguousMatchError, NoMatchError, resolveJsonl, tailFile } from "../src/util/tailer.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tailer-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("tailFile", () => {
  it("replays the last N lines then follows appends", async () => {
    const p = join(dir, "a.jsonl");
    writeFileSync(p, "one\ntwo\nthree\n");
    const got: string[] = [];
    const t = tailFile(p, (l) => got.push(l), { tailLines: 2, intervalMs: 50 });
    expect(got).toEqual(["two", "three"]);
    appendFileSync(p, "four\n");
    await sleep(250);
    t.close();
    expect(got).toEqual(["two", "three", "four"]);
  });

  it("holds a partial line until its newline arrives", async () => {
    const p = join(dir, "b.jsonl");
    writeFileSync(p, "");
    const got: string[] = [];
    const t = tailFile(p, (l) => got.push(l), { intervalMs: 50 });
    appendFileSync(p, "par");
    await sleep(150);
    expect(got).toEqual([]); // incomplete line must NOT be emitted
    appendFileSync(p, "tial\n");
    await sleep(250);
    t.close();
    expect(got).toEqual(["partial"]);
  });

  it("resets on truncation and re-reads the new content", async () => {
    const p = join(dir, "c.jsonl");
    writeFileSync(p, "old-1\nold-2\nold-3\n");
    const got: string[] = [];
    const t = tailFile(p, (l) => got.push(l), { intervalMs: 50 });
    writeFileSync(p, "new-1\n"); // smaller => truncation => new run
    await sleep(250);
    t.close();
    expect(got).toContain("new-1");
  });

  it("waitForFile: attaches once the file is created", async () => {
    const p = join(dir, "later.jsonl");
    const got: string[] = [];
    const t = tailFile(p, (l) => got.push(l), { intervalMs: 50, waitForFile: true });
    await sleep(120);
    writeFileSync(p, "hello\n");
    await sleep(300);
    t.close();
    expect(got).toEqual(["hello"]);
  });

  it("throws without waitForFile when the file is missing", () => {
    expect(() => tailFile(join(dir, "nope.jsonl"), () => {})).toThrow(/does not exist/);
  });
});

describe("resolveJsonl", () => {
  it("prefix beats suffix beats substring, and no-arg picks newest", async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "ses_abc123.jsonl"), "x\n");
    await sleep(20);
    writeFileSync(join(dir, "ses_def456.jsonl"), "x\n");
    expect(resolveJsonl(dir, "ses_abc").id).toBe("ses_abc123");
    expect(resolveJsonl(dir, "456").id).toBe("ses_def456"); // suffix
    expect(resolveJsonl(dir).id).toBe("ses_def456"); // newest
  });

  it("rejects ambiguity and no-match with typed errors", () => {
    writeFileSync(join(dir, "ses_aaa1.jsonl"), "x\n");
    writeFileSync(join(dir, "ses_aaa2.jsonl"), "x\n");
    expect(() => resolveJsonl(dir, "ses_aaa")).toThrow(AmbiguousMatchError);
    expect(() => resolveJsonl(dir, "zzz")).toThrow(NoMatchError);
  });
});
