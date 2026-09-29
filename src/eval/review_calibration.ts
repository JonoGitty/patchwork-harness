/**
 * `patchwork-harness eval review` - calibrate the L5 reviewer (ADR-0017 follow-on).
 *
 * The end-to-end eval can only show L5 AGREEING on passes; failures are
 * rare, so it never shows L5 CATCHING one. Here the failures are planted:
 *   evals/<suite>/<task>/solutions/good/        passes visible AND hidden
 *   evals/<suite>/<task>/solutions/bad-<what>/  passes the VISIBLE tests
 *                                                but violates the spec
 * Every bad case is invisible to a test gate by construction, so this
 * measures exactly what L5 adds: does it catch what the tests miss, and
 * does it cry wolf on good work? No executor runs - just the reviewer,
 * on a real repo, with a real gate result and a real diff.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { AuditEmitter } from "../audit.js";
import { runGate } from "../core/harness.js";
import { type ReviewResult, runReview } from "../core/reviewer.js";
import type { SessionState } from "../core/types.js";
import { NoOpJsonReporter } from "../util/json_reporter.js";
import { newSessionId } from "../util/ulid.js";
import { type EvalTask, loadSuite } from "./runner.js";

export interface PlantedCase {
  task: EvalTask;
  name: string;
  expected: "complete" | "incomplete";
  dir: string;
}

export function loadPlanted(suiteDir: string): PlantedCase[] {
  const out: PlantedCase[] = [];
  for (const task of loadSuite(suiteDir)) {
    const sols = join(task.dir, "solutions");
    if (!existsSync(sols)) continue;
    for (const d of readdirSync(sols, { withFileTypes: true }).filter((x) => x.isDirectory()))
      out.push({
        task,
        name: d.name,
        expected: d.name === "good" ? "complete" : "incomplete",
        dir: join(sols, d.name),
      });
  }
  return out;
}

export interface CalibrationRow {
  task: string;
  case: string;
  expected: "complete" | "incomplete";
  verdict: ReviewResult["verdict"] | "no_reviewer";
  correct: boolean;
  model: string;
  cost_usd: number;
  concerns: string[];
  ungrounded: number;
}

/** Seed + planted solution in a fresh repo, a real gate, then only the L5 review. */
export async function reviewPlanted(c: PlantedCase, model?: string): Promise<CalibrationRow> {
  const ws = mkdtempSync(join(tmpdir(), `patchwork-harness-l5cal-${c.task.id}-`));
  cpSync(join(c.task.dir, "seed"), ws, { recursive: true });
  const git = (...a: string[]) =>
    execa("git", ["-c", "user.name=patchwork-harness-eval", "-c", "user.email=eval@localhost", ...a], {
      cwd: ws,
      reject: false,
    });
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");
  cpSync(c.dir, ws, { recursive: true, force: true }); // the "agent's" work

  const sessionId = newSessionId();
  const audit = new AuditEmitter(sessionId, ws, "l5-calibration");
  const gate = await runGate(c.task.verify, ws, sessionId, audit, 120);
  const state: SessionState = {
    sessionId,
    cwd: ws,
    goal: c.task.goal,
    results: [
      {
        // the executor's claim is the same confident line for good and bad work
        step: {
          title: "Implement the goal",
          description: c.task.goal,
          provider: "anthropic",
          model: "claude-opus-5-5",
          max_tool_turns: 10,
          reason: "planted solution",
        },
        status: "completed",
        output_summary: "Done. Implemented as asked and the tests pass.",
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
        duration_ms: 0,
        tool_calls: 1,
      },
    ],
    total_cost_usd: 0,
    budget: { bedrock_usd: 2, session_usd: 1, mode: "balanced" },
    permission_mode: "auto",
    status: "completed",
    started_at: new Date().toISOString(),
    verification: {
      cmd: gate.cmd,
      passed: gate.passed,
      exit_code: gate.exit_code,
      attempts: 1,
      tail: gate.tail,
    },
  };
  const rv = await runReview({
    goal: c.task.goal,
    cwd: ws,
    sessionId,
    audit,
    budget: { bedrock_usd: 2, session_usd: 1, mode: "balanced", spent_usd: 0 },
    state,
    mode: "auto",
    reporter: new NoOpJsonReporter(),
    unattended: true,
    model,
  });
  const verdict = rv?.verdict ?? "no_reviewer";
  return {
    task: c.task.id,
    case: c.name,
    expected: c.expected,
    verdict,
    correct: verdict === c.expected,
    model: rv ? `${rv.provider}/${rv.model}` : (model ?? "auto"),
    cost_usd: rv?.cost_usd ?? 0,
    concerns: (rv?.concerns ?? []).map((x) => `[${x.severity}] ${x.issue}`),
    ungrounded: rv?.grounding?.ungrounded ?? 0,
  };
}

export interface CalibrationScore {
  model: string;
  /** bad work flagged incomplete */
  caught: number;
  bad: number;
  /** good work passed as complete */
  passed_good: number;
  good: number;
  unparsed: number;
  accuracy: number;
  cost_usd: number;
}

export function scoreCalibration(rows: CalibrationRow[]): CalibrationScore[] {
  const models = [...new Set(rows.map((r) => r.model))];
  return models.map((model) => {
    const rs = rows.filter((r) => r.model === model);
    const bad = rs.filter((r) => r.expected === "incomplete");
    const good = rs.filter((r) => r.expected === "complete");
    return {
      model,
      caught: bad.filter((r) => r.verdict === "incomplete").length,
      bad: bad.length,
      passed_good: good.filter((r) => r.verdict === "complete").length,
      good: good.length,
      unparsed: rs.filter((r) => r.verdict === "unparsed" || r.verdict === "no_reviewer").length,
      accuracy: rs.length ? rs.filter((r) => r.correct).length / rs.length : 0,
      cost_usd: rs.reduce((a, r) => a + r.cost_usd, 0),
    };
  });
}
