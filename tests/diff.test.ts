import { describe, expect, it } from "vitest";
import { diffSummary, unifiedDiff } from "../src/util/diff.js";

describe("unifiedDiff", () => {
  it("returns empty string for identical inputs", () => {
    expect(unifiedDiff("hello\nworld\n", "hello\nworld\n")).toBe("");
  });

  it("emits a single hunk for a one-line replacement", () => {
    const before = "line one\nline two\nline three\n";
    const after = "line one\nLINE TWO\nline three\n";
    const out = unifiedDiff(before, after, { oldPath: "a/x.txt", newPath: "b/x.txt" });
    expect(out).toContain("--- a/x.txt");
    expect(out).toContain("+++ b/x.txt");
    expect(out).toContain("-line two");
    expect(out).toContain("+LINE TWO");
    expect(out).toContain(" line one");
    expect(out).toContain(" line three");
  });

  it("handles pure additions (new file)", () => {
    const out = unifiedDiff("", "alpha\nbeta\n");
    expect(out).toContain("+alpha");
    expect(out).toContain("+beta");
    // No deletion-style lines (excluding the `---` header).
    const body = out.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
    expect(body.some((l) => l.startsWith("-"))).toBe(false);
  });

  it("counts adds and removes in diffSummary", () => {
    const before = "a\nb\nc\nd\n";
    const after = "a\nB\nc\nD\n";
    const s = diffSummary(before, after);
    expect(s.added).toBe(2);
    expect(s.removed).toBe(2);
  });

  it("truncates oversized output", () => {
    const before = Array.from({ length: 5000 }, (_, i) => `old-line-${i}`).join("\n");
    const after = Array.from({ length: 5000 }, (_, i) => `new-line-${i}`).join("\n");
    const out = unifiedDiff(before, after);
    expect(out.length).toBeLessThanOrEqual(8200); // soft cap + truncation marker
  });
});
