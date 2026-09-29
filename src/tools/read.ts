import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { RiskAssessment, Tool } from "./base.js";

/**
 * Default page size. Sized so a page of ordinary source stays under the
 * executor's read cap (TOOL_RESULT_CAP_READ in src/core/executor.ts). A
 * model that wants more calls read again with `offset` = the returned
 * `next_offset`. Before 7 Sept 2026 a read was one unpaged blob that the
 * executor cut at 8k chars, so a 118k file "read" as its first 8k.
 */
export const READ_DEFAULT_LIMIT = 1500;
export const READ_MAX_CHARS = 60_000;

const Input = z.object({
  path: z.string().describe("Absolute or relative path"),
  offset: z
    .number()
    .int()
    .positive()
    .default(1)
    .describe(
      "1-based line to start from; to page a big file pass the previous result's next_offset",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .max(20_000)
    .default(READ_DEFAULT_LIMIT)
    .describe(`Max lines to return (default ${READ_DEFAULT_LIMIT})`),
  max_bytes: z.number().int().positive().default(256_000),
});
type In = z.infer<typeof Input>;

export interface ReadOut {
  path: string;
  content: string;
  /** True when more of the file exists after `end_line` (or a cap cut it). */
  truncated: boolean;
  total_lines: number;
  start_line: number;
  end_line: number;
  /** Pass as `offset` to read the next page. Absent when the file is finished. */
  next_offset?: number;
}

function classify(path: string): RiskAssessment {
  if (/\.env(\.|$)|id_rsa|\.aws\/|\.ssh\/|secret|credential/i.test(path)) {
    return { level: "high", flags: ["sensitive_file_access"] };
  }
  return { level: "none", flags: [] };
}

export const readTool: Tool<In, ReadOut> = {
  name: "read",
  description:
    "Read a file from disk, line-paged: returns up to `limit` lines from `offset` (1-based) plus total_lines; when `truncated` is true call again with offset = next_offset. Refuses sensitive paths.",
  inputSchema: Input,
  assess: (i) => classify(i.path),
  preview: (i) => ({
    description: `read ${i.path}${
      i.offset > 1 || i.limit !== READ_DEFAULT_LIMIT
        ? ` [lines ${i.offset}-${i.offset + i.limit - 1}]`
        : ""
    }`,
    details: { path: i.path },
  }),
  async run(input, ctx) {
    const abs = resolve(ctx.cwd, input.path);
    const s = await stat(abs);
    let text: string;
    let byteCapped = false;
    if (s.size > input.max_bytes) {
      const buf = await readFile(abs);
      text = buf.toString("utf8", 0, input.max_bytes);
      byteCapped = true;
    } else {
      text = await readFile(abs, "utf8");
    }
    const lines = text.split(/\r?\n/);
    // a trailing newline yields one empty phantom line - don't count it
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const start = Math.min(input.offset, Math.max(total, 1));
    const endExclusive = Math.min(total, start - 1 + input.limit);
    let page = lines.slice(start - 1, endExclusive);
    // char cap inside the page so one enormous line cannot blow the result
    let charCapped = false;
    let joined = page.join("\n");
    if (joined.length > READ_MAX_CHARS) {
      charCapped = true;
      let acc = 0;
      const kept: string[] = [];
      for (const l of page) {
        if (acc + l.length + 1 > READ_MAX_CHARS) break;
        kept.push(l);
        acc += l.length + 1;
      }
      page = kept.length ? kept : [joined.slice(0, READ_MAX_CHARS)];
      joined = page.join("\n");
    }
    const end = total === 0 ? 0 : start - 1 + page.length;
    const more = end < total || byteCapped;
    const out: ReadOut = {
      path: abs,
      content: joined,
      truncated: more || charCapped,
      total_lines: total,
      start_line: total === 0 ? 0 : start,
      end_line: end,
    };
    if (more || charCapped) out.next_offset = end + 1;
    return out;
  },
};
