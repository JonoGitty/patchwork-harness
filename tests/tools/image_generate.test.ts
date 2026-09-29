import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { imageCost, plan } from "../../src/tools/image_generate.js";

// Use a real absolute path for the platform so node:path semantics (drive
// letters + separators on win32) match between the impl and the assertions.
const CWD = resolve("/work/proj");
const base = { size: "auto", quality: "auto", background: "auto", n: 1 } as const;

describe("plan() output resolution", () => {
  it("defaults to <cwd>/images with a png filename when out is omitted", () => {
    const p = plan({ prompt: "a red fox", ...base }, CWD);
    expect(p.dir).toBe(join(CWD, "images"));
    expect(p.format).toBe("png");
    expect(p.file(0)).toMatch(/^.+-a-red-fox\.png$/);
  });

  it("treats a relative file path as exact, resolved against cwd", () => {
    const p = plan({ prompt: "hero", out: "assets/hero.png", ...base }, CWD);
    expect(p.dir).toBe(resolve(CWD, "assets"));
    expect(p.format).toBe("png");
    expect(p.file(0)).toBe("hero.png");
  });

  it("derives format from a jpg/webp extension", () => {
    expect(plan({ prompt: "x", out: "a/b.jpg", ...base }, CWD).format).toBe("jpeg");
    expect(plan({ prompt: "x", out: "a/b.webp", ...base }, CWD).format).toBe("webp");
  });

  it("treats an extension-less out as a directory and auto-names", () => {
    const p = plan({ prompt: "logo idea", out: "renders", ...base }, CWD);
    expect(p.dir).toBe(resolve(CWD, "renders"));
    expect(p.format).toBe("png");
    expect(p.file(0)).toMatch(/^.+-logo-idea\.png$/);
  });

  it("keeps an absolute out path as-is", () => {
    const abs = resolve("/tmp/out.png");
    const p = plan({ prompt: "x", out: abs, ...base }, CWD);
    expect(p.dir).toBe(dirname(abs));
    expect(p.file(0)).toBe("out.png");
  });

  it("suffixes filenames with an index when n > 1", () => {
    const file = { prompt: "x", out: "a/shot.png", ...base, n: 3 };
    const p = plan(file, CWD);
    expect(p.file(0)).toBe("shot-1.png");
    expect(p.file(2)).toBe("shot-3.png");
    const dir = plan({ prompt: "concept art", ...base, n: 2 }, CWD);
    expect(dir.file(0)).toMatch(/-concept-art-1\.png$/);
    expect(dir.file(1)).toMatch(/-concept-art-2\.png$/);
  });

  it("falls back to a safe slug for prompts with no alphanumerics", () => {
    expect(plan({ prompt: "!!!", ...base }, CWD).file(0)).toMatch(/-image\.png$/);
  });
});

describe("imageCost()", () => {
  it("returns undefined when usage is missing", () => {
    expect(imageCost(undefined)).toBeUndefined();
  });

  it("prices a text-only prompt: text-in @ $5/M + image-out @ $30/M", () => {
    // 1000 text input + 2000 image output = (1000*5 + 2000*30)/1e6 = 0.065
    const cost = imageCost({
      input_tokens: 1000,
      output_tokens: 2000,
      input_tokens_details: { text_tokens: 1000, image_tokens: 0 },
    });
    expect(cost).toBeCloseTo(0.065, 6);
  });

  it("adds image-input @ $8/M when an input image is present (edits)", () => {
    // 500 text + 1000 image in + 2000 out = (500*5 + 1000*8 + 2000*30)/1e6
    const cost = imageCost({
      input_tokens: 1500,
      output_tokens: 2000,
      input_tokens_details: { text_tokens: 500, image_tokens: 1000 },
    });
    expect(cost).toBeCloseTo(0.0705, 6);
  });

  it("treats all input as text when details are absent", () => {
    // 1000 in (as text) + 1000 out = (1000*5 + 1000*30)/1e6 = 0.035
    expect(imageCost({ input_tokens: 1000, output_tokens: 1000 })).toBeCloseTo(0.035, 6);
  });
});
