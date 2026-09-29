import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import { ProviderUnavailableError } from "../providers/base.js";
import type { RiskAssessment, Tool } from "./base.js";

/**
 * GPT Image 2 (released 2026-04-21). We pin the dated snapshot rather than
 * the bare `gpt-image-2` alias so a future server-side model refresh can't
 * change output under a running batch. Bump this when we intentionally adopt
 * a newer snapshot.
 */
export const IMAGE_MODEL = "gpt-image-2-2026-04-21";

const FORMATS = { ".png": "png", ".jpg": "jpeg", ".jpeg": "jpeg", ".webp": "webp" } as const;
type Format = (typeof FORMATS)[keyof typeof FORMATS];

/**
 * GPT Image 2 is billed per token (not per image), in three buckets, priced
 * per million tokens. A plain text-prompt generation only incurs text-input +
 * image-output; image-input applies when an input image is supplied (edits).
 * Verify against a real bill — list prices move.
 */
const PRICE_PER_M = { text_in: 5.0, image_in: 8.0, image_out: 30.0 } as const;

export interface ImageUsage {
  input_tokens: number;
  output_tokens: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

/** USD cost for one images.generate response, derived from its token usage. */
export function imageCost(usage: ImageUsage | undefined): number | undefined {
  if (!usage) return undefined;
  const textIn = usage.input_tokens_details?.text_tokens ?? usage.input_tokens;
  const imageIn = usage.input_tokens_details?.image_tokens ?? 0;
  return (
    (textIn * PRICE_PER_M.text_in +
      imageIn * PRICE_PER_M.image_in +
      usage.output_tokens * PRICE_PER_M.image_out) /
    1_000_000
  );
}

const Input = z.object({
  prompt: z.string().min(1, "prompt is required"),
  /**
   * Destination. A path ending in .png/.jpg/.jpeg/.webp is used as the exact
   * output file (with an index suffix when n > 1); anything else is treated as
   * a directory. Relative paths resolve against the working directory, so in
   * an patchwork-harness project run the image lands inside the project. Defaults to
   * `<cwd>/images`.
   */
  out: z.string().optional(),
  size: z.enum(["1024x1024", "1536x1024", "1024x1536", "auto"]).default("auto"),
  quality: z.enum(["low", "medium", "high", "auto"]).default("auto"),
  background: z.enum(["transparent", "opaque", "auto"]).default("auto"),
  n: z.number().int().min(1).max(4).default(1),
});
type In = z.infer<typeof Input>;

interface Out {
  model: string;
  prompt: string;
  files: string[];
  size: string;
  quality: string;
  usage?: { input_tokens: number; output_tokens: number };
  cost_usd?: number;
}

function slug(prompt: string): string {
  return (
    prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "image"
  );
}

function formatFor(ext: string): Format | null {
  return ext in FORMATS ? FORMATS[ext as keyof typeof FORMATS] : null;
}

/** Resolve the requested `out` into a base directory + filename builder. */
export function plan(
  input: In,
  cwd: string,
): { dir: string; file: (i: number) => string; format: Format } {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = input.out ? (isAbsolute(input.out) ? input.out : resolve(cwd, input.out)) : null;
  const ext = target ? extname(target).toLowerCase() : "";
  const format = formatFor(ext);

  // `out` points at a concrete file (has a known image extension).
  if (target && format) {
    const dir = dirname(target);
    const stem = basename(target, extname(target));
    return {
      dir,
      format,
      file: (i) => `${stem}${input.n > 1 ? `-${i + 1}` : ""}${ext}`,
    };
  }

  // `out` is a directory (or omitted → <cwd>/images).
  const dir = target ?? join(cwd, "images");
  return {
    dir,
    format: "png",
    file: (i) => `${stamp}-${slug(input.prompt)}${input.n > 1 ? `-${i + 1}` : ""}.png`,
  };
}

export const imageGenerateTool: Tool<In, Out> = {
  name: "image_generate",
  description:
    "Generate one or more images from a text prompt using OpenAI's GPT Image 2 model and save them to disk. " +
    "Pass `out` to control where they go — a file path (e.g. assets/hero.png) or a directory; relative paths " +
    "resolve against the working directory so images land in the current project. Defaults to ./images. " +
    "Returns the saved file paths. Requires OPENAI_API_KEY.",
  inputSchema: Input,
  assess: (): RiskAssessment => ({
    level: "low",
    flags: ["network_access", "paid_api", "file_write"],
  }),
  preview: (i) => {
    const where = i.out ?? "./images";
    return {
      description: `generate ${i.n} image${i.n > 1 ? "s" : ""} → ${where} ("${i.prompt.slice(0, 60)}")`,
      details: { path: where },
    };
  },
  async run(input, ctx) {
    if (!process.env.OPENAI_API_KEY) {
      throw new ProviderUnavailableError("openai", "OPENAI_API_KEY not set");
    }
    const { dir, file, format } = plan(input, ctx.cwd);
    await mkdir(dir, { recursive: true });

    const client = new OpenAI();
    const resp = await client.images.generate({
      model: IMAGE_MODEL,
      prompt: input.prompt,
      n: input.n,
      size: input.size,
      quality: input.quality,
      background: input.background,
      output_format: format,
    });

    const data = resp.data ?? [];
    if (data.length === 0) throw new Error("gpt-image-2 returned no image data");

    const files: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const b64 = data[i]?.b64_json;
      if (!b64) continue;
      const abs = join(dir, file(i));
      await writeFile(abs, Buffer.from(b64, "base64"));
      files.push(abs);
    }

    return {
      model: IMAGE_MODEL,
      prompt: input.prompt,
      files,
      size: input.size,
      quality: input.quality,
      usage: resp.usage
        ? { input_tokens: resp.usage.input_tokens, output_tokens: resp.usage.output_tokens }
        : undefined,
      cost_usd: imageCost(resp.usage),
    };
  },
};
