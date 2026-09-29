import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("memory store", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "patchwork-harness-mem-"));
    process.env.HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns empty list when nothing saved", async () => {
    const { listMemory } = await import("../src/core/memory.js");
    expect(listMemory()).toEqual([]);
  });

  it("round-trips an add → list → show → forget cycle", async () => {
    const { addMemory, listMemory, getMemory, forgetMemory } = await import("../src/core/memory.js");
    addMemory({
      name: "user prefers TypeScript",
      description: "Default language preference",
      type: "user",
      body: "When language is unspecified, use TypeScript over JavaScript.",
    });
    const all = listMemory();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe("user prefers TypeScript");
    expect(all[0]?.type).toBe("user");
    const got = getMemory(all[0]?.slug ?? "");
    expect(got?.body).toContain("TypeScript over JavaScript");
    expect(forgetMemory(all[0]?.slug ?? "")).toBe(true);
    expect(listMemory()).toEqual([]);
  });

  it("renders memory as a planner block", async () => {
    const { addMemory, renderMemoryForPlanner } = await import("../src/core/memory.js");
    addMemory({
      name: "house style",
      description: "Patchwork required",
      type: "feedback",
      body: "Never bypass Patchwork.",
    });
    const block = renderMemoryForPlanner();
    expect(block).toContain("patchwork-harness memory");
    expect(block).toContain("Never bypass Patchwork.");
  });

  it("returns empty planner block when no memory", async () => {
    const { renderMemoryForPlanner } = await import("../src/core/memory.js");
    expect(renderMemoryForPlanner()).toBe("");
  });

  it("rejects no-op forget gracefully", async () => {
    const { forgetMemory } = await import("../src/core/memory.js");
    expect(forgetMemory("does_not_exist")).toBe(false);
  });
});
