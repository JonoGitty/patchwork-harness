import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { diffSummary, unifiedDiff } from "../util/diff.js";
import type { Tool, RiskAssessment } from "./base.js";

const Input = z.object({
  path: z.string(),
  content: z.string(),
});
type In = z.infer<typeof Input>;

interface Out {
  path: string;
  bytes: number;
  created: boolean;
  added: number;
  removed: number;
  diff: string;
}

function classify(path: string): RiskAssessment {
  if (/\.env(\.|$)|id_rsa|\.aws\/|\.ssh\/|secret|credential/i.test(path)) {
    return { level: "critical", flags: ["sensitive_file_access"] };
  }
  if (/^\/etc\/|^\/usr\/|^\/var\//.test(path)) {
    return { level: "critical", flags: ["system_modification"] };
  }
  return { level: "low", flags: [] };
}

export const writeTool: Tool<In, Out> = {
  name: "write",
  description: "Create or overwrite a file with the given content.",
  inputSchema: Input,
  assess: (i) => classify(i.path),
  preview: (i) => ({ description: `write ${i.path} (${i.content.length} bytes)`, details: { path: i.path } }),
  async run(input, ctx) {
    const abs = resolve(ctx.cwd, input.path);
    let before = "";
    let created = true;
    try {
      before = await readFile(abs, "utf8");
      created = false;
    } catch {
      // file doesn't exist — treat as create
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, input.content, "utf8");
    const stats = diffSummary(before, input.content);
    const diff = unifiedDiff(before, input.content, {
      oldPath: created ? "/dev/null" : `a/${input.path}`,
      newPath: `b/${input.path}`,
    });
    return {
      path: abs,
      bytes: Buffer.byteLength(input.content, "utf8"),
      created,
      added: stats.added,
      removed: stats.removed,
      diff,
    };
  },
};
