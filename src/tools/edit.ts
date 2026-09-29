import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { diffSummary, unifiedDiff } from "../util/diff.js";
import type { Tool, RiskAssessment } from "./base.js";

const Input = z.object({
  path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().default(false),
});
type In = z.infer<typeof Input>;

interface Out {
  path: string;
  replacements: number;
  added: number;
  removed: number;
  diff: string;
}

function classify(path: string): RiskAssessment {
  if (/\.env(\.|$)|id_rsa|\.aws\/|\.ssh\/|secret|credential/i.test(path)) {
    return { level: "critical", flags: ["sensitive_file_access"] };
  }
  if (/package\.json|tsconfig\.json|policy\.yml|\.config\b/.test(path)) {
    return { level: "medium", flags: ["config_file_modification"] };
  }
  return { level: "low", flags: [] };
}

export const editTool: Tool<In, Out> = {
  name: "edit",
  description:
    "Exact-string find-and-replace in a file. Set replace_all=true to replace every occurrence.",
  inputSchema: Input,
  assess: (i) => classify(i.path),
  preview: (i) => ({
    description: `edit ${i.path}: replace ${JSON.stringify(i.old_string.slice(0, 40))}…`,
    details: { path: i.path },
  }),
  async run(input, ctx) {
    const abs = resolve(ctx.cwd, input.path);
    const original = await readFile(abs, "utf8");
    let updated: string;
    let count: number;
    if (input.replace_all) {
      const parts = original.split(input.old_string);
      count = parts.length - 1;
      updated = parts.join(input.new_string);
    } else {
      const idx = original.indexOf(input.old_string);
      if (idx === -1) throw new Error(`old_string not found in ${input.path}`);
      const next = original.indexOf(input.old_string, idx + 1);
      if (next !== -1) throw new Error(`old_string is not unique; pass replace_all or expand context`);
      updated = original.slice(0, idx) + input.new_string + original.slice(idx + input.old_string.length);
      count = 1;
    }
    await writeFile(abs, updated, "utf8");
    const stats = diffSummary(original, updated);
    const diff = unifiedDiff(original, updated, {
      oldPath: `a/${input.path}`,
      newPath: `b/${input.path}`,
    });
    return {
      path: abs,
      replacements: count,
      added: stats.added,
      removed: stats.removed,
      diff,
    };
  },
};
