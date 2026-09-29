import fg from "fast-glob";
import { z } from "zod";
import type { Tool } from "./base.js";

const Input = z.object({
  pattern: z.string(),
  cwd: z.string().optional(),
  max_results: z.number().int().positive().max(2000).default(500),
});
type In = z.infer<typeof Input>;

export const globTool: Tool<In, { files: string[]; truncated: boolean }> = {
  name: "glob",
  description: "Find files matching a glob pattern (e.g. 'src/**/*.ts').",
  inputSchema: Input,
  assess: () => ({ level: "none", flags: [] }),
  preview: (i) => ({ description: `glob ${i.pattern}` }),
  async run(input, ctx) {
    const files = await fg(input.pattern, {
      cwd: input.cwd ?? ctx.cwd,
      onlyFiles: true,
      ignore: ["node_modules/**", "dist/**", ".git/**"],
    });
    const sliced = files.slice(0, input.max_results);
    return { files: sliced, truncated: files.length > input.max_results };
  },
};
