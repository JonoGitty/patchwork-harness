/**
 * Run the L4.5 verifier exam strictly and build its board — the ONE
 * implementation behind both `patchwork-harness test --exam` and `patchwork-harness verify exam`.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { PROJECT_ROOT, TESTS_DIR } from "../util/paths.js";
import { tailFile } from "../util/tailer.js";
import type { ExamBoard } from "../verifier/exam_board.js";
import { buildExamBoard, corpusCases } from "../verifier/exam_board.js";
import { parseTestLog } from "./test_events.js";

export async function runExamStrict(): Promise<ExamBoard> {
  const lines: string[] = [];
  const tailer = tailFile(join(TESTS_DIR, "latest.jsonl"), (l) => lines.push(l), {
    waitForFile: true,
  });
  const child = spawn(
    process.execPath,
    [
      join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "tests/verifier-exam.test.ts",
    ],
    {
      cwd: PROJECT_ROOT,
      env: { ...process.env, PATCHWORK_HARNESS_VERIFIER_EXAM: "strict" },
      stdio: "ignore",
    },
  );
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));
  await new Promise((r) => setTimeout(r, 1500)); // let the tailer drain
  tailer.close();
  const { events } = parseTestLog(lines);
  return buildExamBoard(
    events,
    corpusCases(join(PROJECT_ROOT, "tests", "fixtures", "verifier-corpus")),
  );
}

export function renderBoard(
  board: ExamBoard,
  paint: {
    green: (s: string) => string;
    red: (s: string) => string;
    yellow: (s: string) => string;
    bold: (s: string) => string;
  },
): string {
  const lines: string[] = [];
  for (const cse of board.cases) {
    const colour =
      cse.state === "PASS" ? paint.green : cse.state === "FAIL" ? paint.red : paint.yellow;
    lines.push(`  ${colour(cse.state.padEnd(8))} ${cse.id}`);
  }
  const { pass, fail, skip, missing, running } = board.counts;
  lines.push("");
  lines.push(
    `  exam board: ${paint.bold(board.overall)} — ${paint.green(`${pass} pass`)} · ` +
      `${paint.red(`${fail} fail`)} · ${paint.yellow(`${skip} skip`)} · ` +
      `${paint.yellow(`${missing} missing`)} · ${running} running`,
  );
  return lines.join("\n");
}
