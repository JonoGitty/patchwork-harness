/**
 * `patchwork-harness eval` - end-to-end task suite (ADR-0017; DIRECTION Next-10 #8).
 *
 * The harness options (ADR-0015/0016) are claims until measured on real
 * tasks. A suite is a folder of tasks:
 *   evals/<suite>/<task>/task.json  {goal, verify, check, budget_usd}
 *   evals/<suite>/<task>/seed/      the repo the agent starts from
 *   evals/<suite>/<task>/hidden/    ground truth, copied in only AFTER the run
 * Each (config, task, trial) gets a fresh git repo, a real `patchwork-harness run -u`,
 * then the hidden check. Scored: pass rate, cost, time, and - when --review
 * is in the config - whether the L5 verdict agreed with the hidden truth.
 */
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { bashTool } from "../tools/bash.js";
import { stripAnsi } from "../tui/ansi.js";
import { HOME_HARNESS, PROJECT_ROOT } from "../util/paths.js";

export interface EvalTask {
  id: string;
  dir: string;
  goal: string;
  /** Visible test command, substituted for {verify} in a config's flags. */
  verify: string;
  /** Hidden ground-truth command, run after hidden/ is copied in. */
  check: string;
  budget_usd: number;
}

export interface EvalConfig {
  name: string;
  flags: string[];
}

export interface EvalRow {
  task: string;
  config: string;
  trial: number;
  pass: boolean;
  status: string;
  cost_usd: number;
  duration_ms: number;
  session_id?: string;
  gate_passed?: boolean;
  review_verdict?: string;
  check_tail: string;
  error?: string;
}

export const PRESETS: Record<string, string[]> = {
  baseline: [],
  gate: ["--verify-cmd", "{verify}", "--attempts", "3"],
  review: ["--review"],
  "gate+review": ["--verify-cmd", "{verify}", "--attempts", "3", "--review"],
  "gate+guards": [
    "--verify-cmd",
    "{verify}",
    "--attempts",
    "3",
    "--guard-loop",
    "--time-budget",
    "600",
  ],
  "gate+review+fix": ["--verify-cmd", "{verify}", "--attempts", "3", "--review", "--review-fix"],
  // ADR-0018 intent lanes
  direct: ["--lane", "direct"],
  intent: ["--lane", "auto"],
  "gate+direct": ["--verify-cmd", "{verify}", "--attempts", "3", "--lane", "direct"],
  // ADR-0019 injection guard
  guard: ["--guard"],
  "gate+guard": ["--verify-cmd", "{verify}", "--attempts", "3", "--guard"],
};

export function loadSuite(dir: string): EvalTask[] {
  if (!existsSync(dir)) throw new Error(`no eval suite at ${dir}`);
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, "task.json")))
    .map((d) => {
      const t = JSON.parse(readFileSync(join(dir, d.name, "task.json"), "utf8"));
      if (typeof t.goal !== "string" || typeof t.check !== "string")
        throw new Error(`${d.name}/task.json needs goal and check`);
      return {
        id: d.name,
        dir: join(dir, d.name),
        goal: t.goal,
        verify: typeof t.verify === "string" ? t.verify : t.check,
        check: t.check,
        budget_usd: typeof t.budget_usd === "number" ? t.budget_usd : 0.5,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Split a flag string like a shell would (double/single quotes group). */
export function tokenize(s: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** "gate" → preset; "name=--flag value" → custom. */
export function parseConfig(spec: string): EvalConfig {
  const eq = spec.indexOf("=");
  if (eq > 0) return { name: spec.slice(0, eq), flags: tokenize(spec.slice(eq + 1)) };
  const flags = PRESETS[spec];
  if (!flags)
    throw new Error(
      `unknown eval config '${spec}' (presets: ${Object.keys(PRESETS).join(", ")}; or name=--flags)`,
    );
  return { name: spec, flags };
}

export const fillFlags = (flags: string[], task: EvalTask) =>
  flags.map((f) => f.replaceAll("{verify}", task.verify).replaceAll("{check}", task.check));

export function estimateUsd(tasks: EvalTask[], configs: EvalConfig[], trials: number): number {
  return tasks.reduce((a, t) => a + t.budget_usd, 0) * configs.length * trials;
}

/** Pull the facts out of a run's NDJSON stream. */
export function readRun(ndjson: string): {
  session_id?: string;
  status: string;
  cost_usd: number;
  gate_passed?: boolean;
  review_verdict?: string;
} {
  let session_id: string | undefined;
  let status = "no_session_end";
  let cost = 0;
  let gate: boolean | undefined;
  let review: string | undefined;
  for (const line of ndjson.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    let e: { type?: string; session_id?: string; data?: Record<string, unknown> };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    session_id ??= e.session_id;
    const d = e.data ?? {};
    if (e.type === "harness" && d.kind === "verify") gate = d.passed === true;
    if (e.type === "harness" && d.kind === "review") review = String(d.verdict);
    if (e.type === "session_end") {
      status = String(d.status ?? "ended");
      cost = Number(d.total_cost_usd ?? 0);
    }
  }
  return { session_id, status, cost_usd: cost, gate_passed: gate, review_verdict: review };
}

export async function runTask(
  task: EvalTask,
  config: EvalConfig,
  trial: number,
  opts: { bin?: string; timeoutMs?: number } = {},
): Promise<EvalRow> {
  const ws = mkdtempSync(join(tmpdir(), `patchwork-harness-eval-${task.id}-`));
  cpSync(join(task.dir, "seed"), ws, { recursive: true });
  const git = (...a: string[]) =>
    execa("git", ["-c", "user.name=patchwork-harness-eval", "-c", "user.email=eval@localhost", ...a], {
      cwd: ws,
      reject: false,
    });
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-q", "-m", "seed");

  const bin = opts.bin ?? join(PROJECT_ROOT, "bin", "patchwork-harness.mjs");
  const args = [
    bin,
    "run",
    task.goal,
    "-u",
    "--cwd",
    ws,
    "--budget",
    String(task.budget_usd),
    ...fillFlags(config.flags, task),
  ];
  const t0 = Date.now();
  const { out, error } = await new Promise<{ out: string; error?: string }>((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err = `${err}${d}`.slice(-2000);
    });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 900_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      // a run that never ended says why (its last stderr), never a silent row
      const died = !/"type":"session_end"/.test(out);
      resolve({
        out,
        error:
          code === null
            ? "timed out"
            : died
              ? `no session_end: ${stripAnsi(err).trim().slice(-300)}`
              : undefined,
      });
    });
  });
  const duration_ms = Date.now() - t0;
  const run = readRun(out);

  const hidden = join(task.dir, "hidden");
  if (existsSync(hidden)) cpSync(hidden, ws, { recursive: true, force: true });
  const chk = await bashTool.run(
    { command: task.check, timeout_ms: 120_000 },
    { cwd: ws, sessionId: "eval-check" },
  );
  return {
    task: task.id,
    config: config.name,
    trial,
    pass: chk.exit_code === 0,
    status: run.status,
    cost_usd: run.cost_usd,
    duration_ms,
    session_id: run.session_id,
    gate_passed: run.gate_passed,
    review_verdict: run.review_verdict,
    check_tail: `${chk.stdout}\n${chk.stderr}`.trim().slice(-400),
    error,
  };
}

export interface ConfigSummary {
  config: string;
  passed: number;
  runs: number;
  mean_cost_usd: number;
  mean_seconds: number;
  total_cost_usd: number;
  /** L5 verdict agreed with the hidden check (complete ⇔ pass), over rows that had one. */
  review_agreement?: { agreed: number; of: number };
}

export function summarise(rows: EvalRow[]): ConfigSummary[] {
  const names = [...new Set(rows.map((r) => r.config))];
  return names.map((config) => {
    const rs = rows.filter((r) => r.config === config);
    const reviewed = rs.filter(
      (r) => r.review_verdict === "complete" || r.review_verdict === "incomplete",
    );
    const total = rs.reduce((a, r) => a + r.cost_usd, 0);
    return {
      config,
      passed: rs.filter((r) => r.pass).length,
      runs: rs.length,
      mean_cost_usd: rs.length ? total / rs.length : 0,
      mean_seconds: rs.length ? rs.reduce((a, r) => a + r.duration_ms, 0) / rs.length / 1000 : 0,
      total_cost_usd: total,
      ...(reviewed.length
        ? {
            review_agreement: {
              agreed: reviewed.filter((r) => (r.review_verdict === "complete") === r.pass).length,
              of: reviewed.length,
            },
          }
        : {}),
    };
  });
}

export async function runSuite(
  suiteDir: string,
  configs: EvalConfig[],
  opts: {
    trials?: number;
    parallel?: number;
    maxUsd?: number;
    bin?: string;
    tasks?: string[];
    onRow?: (r: EvalRow) => void;
  } = {},
): Promise<{ rows: EvalRow[]; summary: ConfigSummary[]; file: string }> {
  const tasks = loadSuite(suiteDir).filter((t) => !opts.tasks?.length || opts.tasks.includes(t.id));
  if (!tasks.length) throw new Error("no tasks matched --tasks");
  const trials = opts.trials ?? 1;
  const est = estimateUsd(tasks, configs, trials);
  if (est > (opts.maxUsd ?? 5))
    throw new Error(
      `worst-case spend $${est.toFixed(2)} (sum of task budgets x configs x trials) exceeds --max-usd $${(opts.maxUsd ?? 5).toFixed(2)}`,
    );
  const jobs: Array<() => Promise<EvalRow>> = [];
  for (let trial = 1; trial <= trials; trial++)
    for (const c of configs)
      for (const t of tasks) jobs.push(() => runTask(t, c, trial, { bin: opts.bin }));
  const rows: EvalRow[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      if (!job) break;
      const row = await job();
      rows.push(row);
      opts.onRow?.(row);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.parallel ?? 2) }, worker));
  const summary = summarise(rows);
  const dir = join(HOME_HARNESS, "evals");
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${suiteDir
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop()}.json`,
  );
  writeFileSync(file, JSON.stringify({ suite: suiteDir, trials, configs, summary, rows }, null, 2));
  return { rows, summary, file };
}
