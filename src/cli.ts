#!/usr/bin/env node
/**
 * patchwork-harness — Patchwork Harness CLI.
 *
 * Subcommands:
 *   patchwork-harness                  interactive REPL (no goal given)
 *   patchwork-harness [goal]           default: one-shot
 *   patchwork-harness one-shot <goal>  explicit form
 *   patchwork-harness boot             preflight check (Patchwork, audit, config)
 *   patchwork-harness doctor           verbose preflight + provider key inventory
 *   patchwork-harness keys [list|set|unset]  manage provider API keys (~/.patchwork-harness/.env)
 *   patchwork-harness repl             interactive prompt (same as no-args invocation)
 *   patchwork-harness ls               recent sessions
 *   patchwork-harness show <session>   detail for one session
 *   patchwork-harness web              start the dashboard
 *   patchwork-harness review [paths]   multi-model adversarial security review (+ L4.5 verifier)
 *   patchwork-harness models           model catalog with prices + live reachability on this key
 *   patchwork-harness version          version
 */

// Load .env files BEFORE anything else so provider availability checks work
import { loadEnvFiles } from "./util/env.js";
loadEnvFiles();

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import Table from "cli-table3";
import { Command } from "commander";
import { boot, bootOrExit } from "./boot.js";
import { oneShot } from "./core/orchestrator.js";
import { loadBuiltIns } from "./plugins/manager.js";
import { providers } from "./providers/registry.js";
import { tools } from "./tools/registry.js";
import { EVENTS_DIR, HOME_HARNESS, PROJECT_ROOT, SESSIONS_DIR } from "./util/paths.js";
import { log, setSilentStdout } from "./util/logger.js";
import { StdoutJsonReporter } from "./util/json_reporter.js";
import { listKeys, setKey, unsetKey, envFilePath, KEY_NAMES } from "./util/key_store.js";
import { startRepl } from "./cli/repl.js";

const VERSION = "0.3.0";

const program = new Command();
program
  .name("patchwork-harness")
  .description("Patchwork Harness — Patchwork-audited multi-LLM coding agent")
  .version(VERSION, "-v, --version");

program
  .command("boot")
  .description("Preflight check (Patchwork, audit, config). Exits non-zero if anything is missing.")
  .action(async () => {
    const r = await boot();
    for (const c of r.checks) {
      const tag = c.ok ? chalk.green("ok") : chalk.red("missing");
      console.log(`  ${tag.padEnd(12)} ${chalk.cyan(c.name.padEnd(22))} ${chalk.dim(c.detail)}`);
      if (!c.ok && c.fix) console.log(`               ${chalk.yellow("→")} ${c.fix}`);
    }
    process.exit(r.ok ? 0 : 1);
  });

program
  .command("doctor")
  .description("Verbose preflight + provider key inventory + plugin list.")
  .action(async () => {
    await loadBuiltIns(process.cwd());
    const r = await boot();

    console.log(chalk.bold("\nPreflight"));
    for (const c of r.checks) {
      const tag = c.ok ? chalk.green("✓") : chalk.red("✖");
      console.log(`  ${tag} ${chalk.cyan(c.name.padEnd(22))} ${chalk.dim(c.detail)}`);
      if (!c.ok && c.fix) console.log(`     ${chalk.yellow("→")} ${c.fix}`);
    }

    console.log(chalk.bold("\nProviders"));
    for (const [name, p] of providers()) {
      const tag = p.available() ? chalk.green("✓") : chalk.yellow("·");
      console.log(`  ${tag} ${chalk.cyan(name.padEnd(12))} default=${p.defaultModel}`);
    }

    console.log(chalk.bold("\nTools"));
    for (const t of tools()) {
      console.log(`  ${chalk.cyan(t.name.padEnd(10))} ${chalk.dim(t.description.slice(0, 80))}`);
    }

    const { loadedPlugins } = await import("./plugins/manager.js");
    console.log(chalk.bold("\nPlugins"));
    for (const p of loadedPlugins()) {
      console.log(`  ${chalk.cyan(p.name.padEnd(16))} ${chalk.dim(p.description)}`);
    }

    process.exit(r.ok ? 0 : 1);
  });

program
  .command("ls")
  .description("List recent sessions.")
  .option("-n, --limit <n>", "max sessions to show", "20")
  .action((opts) => {
    let entries: { id: string; mtime: Date; size: number }[] = [];
    try {
      entries = readdirSync(SESSIONS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const st = statSync(join(SESSIONS_DIR, f));
          return { id: f.replace(".json", ""), mtime: st.mtime, size: st.size };
        })
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .slice(0, Number(opts.limit));
    } catch {
      console.log(chalk.dim("no sessions yet"));
      return;
    }
    if (entries.length === 0) {
      console.log(chalk.dim("no sessions yet"));
      return;
    }
    const table = new Table({
      head: [chalk.cyan("session"), chalk.cyan("modified"), chalk.cyan("goal")],
      colWidths: [22, 22, 60],
    });
    for (const e of entries) {
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, `${e.id}.json`), "utf8"));
        table.push([
          e.id.slice(-12),
          e.mtime.toISOString().slice(0, 19).replace("T", " "),
          (data.goal || "").slice(0, 56),
        ]);
      } catch {
        table.push([e.id.slice(-12), e.mtime.toISOString(), "?"]);
      }
    }
    console.log(table.toString());
  });

program
  .command("web")
  .description("Start the web dashboard at http://127.0.0.1:<port>.")
  .option("-p, --port <port>", "port", "4243")
  .action(async (opts) => {
    const { startWeb } = await import("./web/app.js");
    await startWeb(Number(opts.port));
  });

program
  .command("show <session>")
  .description("Show full session detail (suffix-match supported).")
  .action((sessionArg: string) => {
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    const match = files.find((f) => f.includes(sessionArg));
    if (!match) {
      log.error(`no session matching ${sessionArg}`);
      process.exit(1);
    }
    const data = JSON.parse(readFileSync(join(SESSIONS_DIR, match), "utf8"));
    console.log(JSON.stringify(data, null, 2));
  });

program
  .command("repl")
  .description("Interactive prompt — like Claude Code. Type a goal at the › prompt, /help for commands.")
  .option("--cwd <path>", "starting working directory")
  .option("--mode <m>", "starting mode (budget|balanced|unlimited)", "balanced")
  .option("--budget <usd|auto>", "starting session budget", "1.0")
  .option("--bedrock <usd>", "starting bedrock ceiling")
  .action(async (opts) => {
    const budget = opts.budget === "auto" ? "auto" : Number(opts.budget);
    await startRepl({
      cwd: opts.cwd,
      mode: opts.mode,
      budget: budget as number | "auto",
      bedrock: opts.bedrock ? Number(opts.bedrock) : undefined,
    });
  });

// ============== eval (ADR-0017) ==============
const evalCmd = program
  .command("eval")
  .description("End-to-end task suites (ADR-0017): prove a flag helps before you trust it.");

function resolveSuite(nameOrPath: string): string {
  return /[\\/]/.test(nameOrPath) ? nameOrPath : join(PROJECT_ROOT, "evals", nameOrPath);
}

evalCmd
  .command("list [suite]")
  .description("List suites, or the tasks in one suite")
  .action(async (suite?: string) => {
    const { loadSuite, PRESETS } = await import("./eval/runner.js");
    if (!suite) {
      const { readdirSync } = await import("node:fs");
      for (const d of readdirSync(join(PROJECT_ROOT, "evals"), { withFileTypes: true }))
        if (d.isDirectory()) console.log(`  ${d.name}`);
      console.log(chalk.dim(`\n  configs (presets): ${Object.keys(PRESETS).join(", ")}  - or --config name="--flags"`));
      return;
    }
    for (const t of loadSuite(resolveSuite(suite)))
      console.log(`  ${chalk.cyan(t.id.padEnd(14))} $${t.budget_usd.toFixed(2)}  ${t.goal}`);
  });

evalCmd
  .command("run <suite>")
  .description(
    "Run every task under every config in a fresh git repo, then score it with the task's HIDDEN check. " +
    "SPENDS MONEY: refuses when the worst case (sum of task budgets x configs x trials) exceeds --max-usd.",
  )
  .option("--configs <list>", "comma-separated presets (baseline, gate, review, gate+review, gate+guards)", "baseline,gate")
  .option("--config <spec>", "custom config name=\"--flags ...\" ({verify} = the task's visible tests); repeatable", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("--trials <n>", "runs per task per config", "1")
  .option("--tasks <list>", "only these task ids (comma-separated)")
  .option("--parallel <n>", "runs at a time", "2")
  .option("--max-usd <usd>", "refuse if the worst-case spend is above this", "5")
  .option("--json", "print the summary and rows as JSON")
  .action(async (suite: string, opts) => {
    const { parseConfig, runSuite } = await import("./eval/runner.js");
    const configs = [
      ...String(opts.configs).split(",").map((c: string) => c.trim()).filter(Boolean),
      ...(opts.config as string[]),
    ].map(parseConfig);
    try {
      const res = await runSuite(resolveSuite(suite), configs, {
        trials: Number(opts.trials) || 1,
        parallel: Number(opts.parallel) || 2,
        maxUsd: Number(opts.maxUsd) || 5,
        tasks: opts.tasks ? String(opts.tasks).split(",").map((t: string) => t.trim()) : undefined,
        onRow: (r) =>
          opts.json ||
          console.log(
            `  ${r.pass ? chalk.green("PASS") : chalk.red("FAIL")}  ${r.config.padEnd(12)} ${r.task.padEnd(12)} t${r.trial}  $${r.cost_usd.toFixed(4)}  ${(r.duration_ms / 1000).toFixed(0)}s  run=${r.status}${r.gate_passed === undefined ? "" : ` gate=${r.gate_passed ? "pass" : "fail"}`}${r.review_verdict ? ` L5=${r.review_verdict}` : ""}${r.error ? chalk.yellow(` ${r.error}`) : ""}`,
          ),
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify(res) + "\n");
        return;
      }
      console.log();
      for (const c of res.summary)
        console.log(
          `  ${chalk.bold(c.config.padEnd(12))} ${c.passed}/${c.runs} passed   mean $${c.mean_cost_usd.toFixed(4)}   mean ${c.mean_seconds.toFixed(0)}s   total $${c.total_cost_usd.toFixed(4)}` +
            (c.review_agreement ? `   L5 agreed with hidden check ${c.review_agreement.agreed}/${c.review_agreement.of}` : ""),
        );
      console.log(chalk.dim(`\n  results: ${res.file}`));
    } catch (e) {
      log.error((e as Error).message);
      process.exit(1);
    }
  });

evalCmd
  .command("classifier <rows>")
  .description(
    "Score a System One classifier (Jeff, Kev or Jev) on labelled rows in Jeff's adapter-kit format " +
    "(id, family, state, question, label) against the constant baseline: accuracy, calibration error (ECE), " +
    "Brier, AUC and confidence bands for --positive. Prove a classifier before the harness trusts it.",
  )
  .option("--url <url>", "classifier server (default: PATCHWORK_HARNESS_CLASSIFIER_URL / PATCHWORK_HARNESS_JEFF_URL / TYPESAFE_API_KEY)")
  .option("--backend <name>", "with --url: jeff | kev", "jeff")
  .option("--model <name>", "model or Jeff adapter, e.g. jeff-latest, guard, ground")
  .option("--orders <n>", "2 = answer twice with the options reversed and average (Jeff)", "1")
  .option("--positive <keys>", "choice keys counted as the positive class for AUC and bands (noul: always true)")
  .option("--hi <p>", "high band: P(positive) at or above", "0.7")
  .option("--lo <p>", "low band: P(positive) at or below", "0.3")
  .option("--limit <n>", "only the first n rows")
  .option("--parallel <n>", "requests at a time", "2")
  .option("--json", "print the report as JSON")
  .action(async (rowsPath: string, opts) => {
    const { readRows, evalClassifier } = await import("./eval/classifier.js");
    const { classifierConfig } = await import("./classifier/systemone.js");
    const cfg = opts.url
      ? {
          backend: (opts.backend === "kev" ? "kev" : "jeff") as "kev" | "jeff",
          url: String(opts.url).replace(/\/+$/, ""),
          model: opts.backend === "kev" ? "kev-latest" : "jeff-latest",
        }
      : classifierConfig();
    if (!cfg) {
      log.error("no classifier: pass --url, or set PATCHWORK_HARNESS_JEFF_URL, PATCHWORK_HARNESS_CLASSIFIER_URL or TYPESAFE_API_KEY");
      process.exit(1);
    }
    const report = await evalClassifier(cfg, readRows(rowsPath), {
      model: opts.model,
      orders: Number(opts.orders) === 2 ? 2 : 1,
      positive: opts.positive ? String(opts.positive).split(",").map((k: string) => k.trim()) : undefined,
      hi: Number(opts.hi),
      lo: Number(opts.lo),
      limit: opts.limit ? Number(opts.limit) : undefined,
      concurrency: Number(opts.parallel) || 2,
    });
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const { join, basename } = await import("node:path");
    const { HOME_HARNESS } = await import("./util/paths.js");
    const dir = join(HOME_HARNESS, "evals");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-classifier-${basename(rowsPath, ".jsonl")}-${report.model}.json`);
    writeFileSync(out, JSON.stringify(report, null, 1));
    if (opts.json) {
      process.stdout.write(JSON.stringify({ ...report, rows: undefined, file: out }) + "\n");
      return;
    }
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const beats = report.accuracy > report.constant.accuracy;
    console.log(chalk.bold(`\n  ${report.backend}/${report.model}${report.orders === 2 ? " (answered twice)" : ""} on ${report.n} rows, ${report.families} families`));
    console.log(`  accuracy      ${(beats ? chalk.green : chalk.red)(pct(report.accuracy))}   constant "${report.constant.label}" ${pct(report.constant.accuracy)}${report.errors ? chalk.red(`   ${report.errors} error(s) counted wrong`) : ""}`);
    console.log(`  calibration   ECE ${report.ece.toFixed(3)}   Brier ${report.brier.toFixed(4)}`);
    if (report.auc !== undefined) console.log(`  ranking       AUC ${report.auc.toFixed(3)} for positive = ${report.positive?.join("+")}`);
    if (report.bands) {
      const b = report.bands;
      console.log(`  bands         P >= ${b.hi}: ${b.high.n} rows, ${b.high.positive} positive   |   P <= ${b.lo}: ${b.low.n} rows, ${b.low.positive} positive`);
    }
    console.log(chalk.dim(`  median ${report.median_latency_ms} ms per decision   ->  ${out}`));
  });

evalCmd
  .command("review <suite>")
  .description(
    "Calibrate the L5 reviewer on PLANTED solutions (solutions/good, solutions/bad-*): every bad one passes " +
    "the visible tests but breaks the spec, so this measures what L5 catches that a test gate cannot, " +
    "and how often it cries wolf. Compare models with --models.",
  )
  .option("--models <list>", "comma-separated reviewer model ids (default: the reviewer role's pick)")
  .option("--trials <n>", "runs per case per model", "1")
  .option("--parallel <n>", "reviews at a time", "3")
  .option("--max-usd <usd>", "refuse above this rough worst case ($0.15 per review)", "5")
  .option("--json", "print rows and scores as JSON")
  .action(async (suite: string, opts) => {
    const { loadPlanted, reviewPlanted, scoreCalibration } = await import("./eval/review_calibration.js");
    const cases = loadPlanted(resolveSuite(suite));
    const models: Array<string | undefined> = opts.models ? String(opts.models).split(",").map((m: string) => m.trim()) : [undefined];
    const trials = Number(opts.trials) || 1;
    const est = cases.length * models.length * trials * 0.15;
    if (est > (Number(opts.maxUsd) || 5)) {
      log.error(`rough worst case $${est.toFixed(2)} exceeds --max-usd ${opts.maxUsd}`);
      process.exit(1);
    }
    const jobs = models.flatMap((m) => Array.from({ length: trials }, () => cases.map((c) => () => reviewPlanted(c, m))).flat());
    const rows: Awaited<ReturnType<typeof reviewPlanted>>[] = [];
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        if (!job) break;
        const r = await job();
        rows.push(r);
        if (!opts.json)
          console.log(
            `  ${r.correct ? chalk.green("RIGHT") : chalk.red("WRONG")}  ${r.model.padEnd(32)} ${r.task.padEnd(9)} ${r.case.padEnd(20)} expected ${r.expected.padEnd(10)} got ${r.verdict.padEnd(10)} $${r.cost_usd.toFixed(4)}${r.ungrounded ? chalk.yellow(` ${r.ungrounded} ungrounded citation(s)`) : ""}`,
          );
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Number(opts.parallel) || 3) }, worker));
    const scores = scoreCalibration(rows);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ scores, rows }) + "\n");
      return;
    }
    console.log();
    for (const sc of scores)
      console.log(
        `  ${chalk.bold(sc.model.padEnd(32))} caught ${sc.caught}/${sc.bad} bad   passed ${sc.passed_good}/${sc.good} good   accuracy ${(sc.accuracy * 100).toFixed(0)}%   unparsed ${sc.unparsed}   $${sc.cost_usd.toFixed(4)}`,
      );
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const dir = join(HOME_HARNESS, "evals");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-l5cal.json`);
    writeFileSync(file, JSON.stringify({ suite, scores, rows }, null, 2));
    console.log(chalk.dim(`\n  results: ${file}`));
  });

program
  .command("route <goal>")
  .description(
    "ADR-0018: show which lane `--lane auto` would take for a goal, and why " +
    "(intent head first, the LLM router only if the head is unsure). Runs nothing. " +
    "The LLM stage, if reached, costs ~$0.0002.",
  )
  .option("--lane-threshold <p>", "head P(no plan needed) that decides direct on its own", "0.6")
  .option("--json", "print the decision as JSON")
  .action(async (goal: string, opts) => {
    const { routeIntent } = await import("./core/intent.js");
    const r = await routeIntent(goal, { hi: Number(opts.laneThreshold) });
    if (opts.json) {
      console.log(JSON.stringify(r));
      return;
    }
    const tag = r.lane === "direct" ? chalk.cyan("direct") : chalk.yellow("planned");
    console.log(`  lane     ${tag}  (decided by: ${r.stage})`);
    if (r.p_fast !== undefined)
      console.log(`  head     P(no plan) ${r.p_fast.toFixed(2)}  ${chalk.dim(`${r.head_latency_ms} ms · ${r.head_model}`)}`);
    if (r.llm_model)
      console.log(`  llm      ${r.llm_label ?? "?"} @ ${r.llm_confidence ?? "?"}  ${chalk.dim(`${r.llm_latency_ms} ms · ${r.llm_model}`)}`);
    console.log(chalk.dim(`  ${r.reason}`));
  });

program
  .command("rewind <session>")
  .description(
    "ADR-0015: restore the working tree to a --checkpoint snapshot. Lists the " +
    "checkpoints without --to. Snapshots the current state first, so a rewind " +
    "is itself undoable. Your index, HEAD and branch are not touched.",
  )
  .option("--to <label>", "checkpoint label to restore (e.g. step-2)")
  .option("--cwd <path>", "the repo the run used (default: current directory)")
  .option("-y, --yes", "restore without asking")
  .action(async (session: string, opts) => {
    const { listCheckpoints, rewind } = await import("./core/harness.js");
    const cwd = opts.cwd ?? process.cwd();
    const cps = await listCheckpoints(cwd, session);
    if (!opts.to) {
      if (!cps.length) {
        log.warn(`no checkpoints for ${session} in ${cwd} (was the run made with --checkpoint?)`);
        return;
      }
      for (const c of cps) console.log(`  ${chalk.cyan(c.label.padEnd(24))} ${chalk.dim(c.sha.slice(0, 10))} ${chalk.dim(c.date)}`);
      console.log(chalk.dim(`\n  restore with: patchwork-harness rewind ${session} --to <label>`));
      return;
    }
    if (!opts.yes) {
      const { confirm } = await import("./permissions/prompt.js");
      const ok = await confirm(`Overwrite the working tree in ${cwd} with checkpoint '${opts.to}'? (current state is snapshotted first)`, false);
      if (!ok) return;
    }
    try {
      const r = await rewind(cwd, session, opts.to);
      log.info(`restored to ${r.restored_to}; removed ${r.removed.length} file(s) created after it; undo with --to ${r.safety}`);
    } catch (e) {
      log.error((e as Error).message);
      process.exit(1);
    }
  });

program
  .command("mcp")
  .description(
    "Serve patchwork-harness over MCP (stdio) so Claude Code - including Remote Control " +
    "sessions - can drive it with typed tools: plan, run (confirm + budget " +
    "gated), status, verify, classify, review, ask, exam (ADR-0014).",
  )
  .action(async () => {
    const { serve } = await import("./mcp/server.js");
    serve();
  });

program
  .command("cockpit")
  .description(
    "Full-screen live cockpit — sessions, budget, audit stream, test wall, " +
    "verifier verdicts, embedded goal prompt (ADR-0012). Bare `patchwork-harness` in a " +
    "TTY boots straight into this. Non-TTY falls back to the classic repl.",
  )
  .option("--cwd <path>", "starting working directory")
  .option("--mode <m>", "starting mode (budget|balanced|unlimited)", "balanced")
  .option("--budget <usd|auto>", "starting session budget", "1.0")
  .option("--bedrock <usd>", "starting bedrock ceiling")
  .action(async (opts) => {
    const budget = opts.budget === "auto" ? "auto" : Number(opts.budget);
    const replOpts = {
      cwd: opts.cwd,
      mode: opts.mode,
      budget: budget as number | "auto",
      bedrock: opts.bedrock ? Number(opts.bedrock) : undefined,
    };
    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      log.info("not a TTY — falling back to the classic repl");
      await startRepl(replOpts);
      return;
    }
    const { startCockpit } = await import("./tui/cockpit.js");
    await startCockpit(replOpts);
  });

const keysCmd = program
  .command("keys")
  .description("Manage provider API keys (stored in ~/.patchwork-harness/.env, mode 0600).");

keysCmd
  .command("list", { isDefault: true })
  .description("Show which keys are set (default action when no subcommand).")
  .action(() => {
    console.log();
    for (const k of listKeys()) {
      const tag = k.set ? chalk.green("✓ set") : chalk.red("✗ not set");
      const preview = k.set ? chalk.dim(`  ${k.preview}`) : "";
      console.log(`  ${tag.padEnd(14)} ${chalk.cyan(k.name.padEnd(22))}${preview}`);
    }
    console.log();
    console.log(chalk.dim(`Stored in: ${envFilePath()}`));
    console.log(chalk.dim("Set with:  patchwork-harness keys set <NAME> <value>"));
    console.log();
  });

keysCmd
  .command("set <name> <value>")
  .description("Save an API key to ~/.patchwork-harness/.env. Example: patchwork-harness keys set ANTHROPIC_API_KEY sk-ant-...")
  .action((name: string, value: string) => {
    const upper = name.toUpperCase();
    if (!(KEY_NAMES as readonly string[]).includes(upper)) {
      log.warn(`unrecognised key name "${name}". Recognised keys:`);
      for (const k of KEY_NAMES) console.log(`  ${k}`);
      log.warn("(saving anyway — let me know if you'd like another key recognised)");
    }
    setKey(upper, value);
    log.ok(`saved ${upper} to ${envFilePath()}`);
  });

keysCmd
  .command("unset <name>")
  .description("Remove a key from ~/.patchwork-harness/.env.")
  .action((name: string) => {
    unsetKey(name.toUpperCase());
    log.ok(`removed ${name.toUpperCase()}`);
  });

const memoryCmd = program
  .command("memory")
  .description("patchwork-harness's own auto-memory store (~/.patchwork-harness/memory). Persisted across sessions.");

memoryCmd
  .command("list", { isDefault: true })
  .description("List all memory entries.")
  .action(async () => {
    const { listMemory } = await import("./core/memory.js");
    const all = listMemory();
    if (all.length === 0) {
      console.log(chalk.dim("\n  no memory yet — add with: patchwork-harness memory add <type> <name> <description>\n"));
      return;
    }
    console.log();
    for (const e of all) {
      const tag = chalk.dim(`[${e.type}]`);
      console.log(`  ${tag.padEnd(14)} ${chalk.cyan(e.name.padEnd(28))} ${chalk.dim(e.description.slice(0, 80))}`);
      console.log(`  ${" ".repeat(14)} ${chalk.dim(`slug: ${e.slug}`)}`);
    }
    console.log();
  });

memoryCmd
  .command("show <slug>")
  .description("Show one memory entry's full body.")
  .action(async (slug: string) => {
    const { getMemory } = await import("./core/memory.js");
    const e = getMemory(slug);
    if (!e) {
      log.error(`no memory with slug ${slug}`);
      process.exit(1);
    }
    console.log();
    console.log(chalk.bold(e.name) + chalk.dim(` [${e.type}]`));
    console.log(chalk.dim(e.description));
    console.log();
    console.log(e.body);
    console.log();
  });

memoryCmd
  .command("add <type> <name> <description> <body>")
  .description("Add a memory. Type: user|feedback|project|reference. Quote multi-word args.")
  .action(async (type: string, name: string, description: string, body: string) => {
    if (!["user", "feedback", "project", "reference"].includes(type)) {
      log.error(`type must be one of: user|feedback|project|reference (got "${type}")`);
      process.exit(1);
    }
    const { addMemory } = await import("./core/memory.js");
    const e = addMemory({ type: type as "user" | "feedback" | "project" | "reference", name, description, body });
    log.ok(`saved memory: ${e.slug}`);
  });

memoryCmd
  .command("forget <slug>")
  .description("Delete a memory entry.")
  .action(async (slug: string) => {
    const { forgetMemory } = await import("./core/memory.js");
    if (forgetMemory(slug)) log.ok(`forgot ${slug}`);
    else {
      log.error(`no memory with slug ${slug}`);
      process.exit(1);
    }
  });



// ============== verify group (ADR-0011 / ADR-0012) ==============
const CLASSIFY_HELP =
  "ADR-0013: send the MISSED atoms to a decision model (a local Jeff via PATCHWORK_HARNESS_JEFF_URL, " +
  "the best measured; or Jev via TYPESAFE_API_KEY; or Kev via PATCHWORK_HARNESS_CLASSIFIER_URL) and print a review triage under the " +
  "report. Routes only — never changes a verdict or the exit code";

/** --classify: triage rides alongside the report; failures only warn. */
async function classifyMissed(
  answer: string,
  evidence: Array<Record<string, unknown>>,
  report: import("./verifier/grounding.js").Report,
) {
  const { classifierConfig } = await import("./classifier/systemone.js");
  const cfg = classifierConfig();
  if (!cfg) {
    log.warn(
      "--classify: no classifier configured — `patchwork-harness keys set TYPESAFE_API_KEY …` (Jev) " +
        "or set PATCHWORK_HARNESS_CLASSIFIER_URL to a local Kev server",
    );
    return undefined;
  }
  const { triage } = await import("./verifier/triage.js");
  return triage(answer, evidence, report, cfg);
}

const verifyCmd = program
  .command("verify")
  .description(
    "Harness Verifier — deterministic answer-vs-evidence check (L4.5). " +
    "Never a false VERIFIED: every atom is green-with-proof, not-green, or " +
    "missed (reported at equal prominence).",
  );

verifyCmd
  .command("file <path>")
  .description(
    "Verify a corpus-shaped JSON file ({answer, evidence[, expected]}). " +
    "--expect also compares against the file's expected verdicts.",
  )
  .option("--expect", "fail unless the result matches the file's expected block")
  .option("--json", "emit the raw Report as JSON ({report, triage} with --classify)")
  .option("--classify", CLASSIFY_HELP)
  .action(async (path: string, opts) => {
    const { readFileSync } = await import("node:fs");
    const { verify } = await import("./verifier/grounding.js");
    const { renderReport, renderTriage, reportExitCode } = await import("./verifier/render.js");
    let doc: {
      answer?: string;
      evidence?: Array<Record<string, unknown>>;
      expected?: { atoms?: Array<{ value: string; verdict: string }>; overall?: string };
    };
    try {
      doc = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      log.error(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(3);
    }
    if (!doc.answer || !Array.isArray(doc.evidence)) {
      log.error("file must contain {answer: string, evidence: array}");
      process.exit(3);
    }
    const report = verify(doc.answer, doc.evidence);
    const tri = opts.classify ? await classifyMissed(doc.answer, doc.evidence, report) : undefined;
    if (opts.json)
      process.stdout.write(JSON.stringify(tri ? { report, triage: tri } : report) + "\n");
    else {
      console.log("\n" + renderReport(report) + "\n");
      if (tri) console.log(renderTriage(tri) + "\n");
    }
    if (opts.expect && doc.expected) {
      const mismatches: string[] = [];
      if (doc.expected.overall && report.overall !== doc.expected.overall)
        mismatches.push(`overall got ${report.overall} want ${doc.expected.overall}`);
      for (const want of doc.expected.atoms ?? []) {
        const got = report.atoms.find((a) => a.value === want.value);
        if (!got) mismatches.push(`atom '${want.value}' not extracted`);
        else if (got.verdict !== want.verdict)
          mismatches.push(`'${want.value}' got ${got.verdict} want ${want.verdict}`);
      }
      if (mismatches.length) {
        for (const m of mismatches) log.error(m);
        process.exit(1);
      }
      log.info("matches the file's expected block");
      process.exit(0);
    }
    process.exit(reportExitCode(report));
  });

verifyCmd
  .command("session [id]")
  .description(
    "Verify a past session's answer against its OWN audit trail. Evidence " +
    "comes from the events JSONL (verbatim provenance, ADR-0012); the " +
    "answer defaults to the session's recorded output, --answer/--answer-file " +
    "override. Pre-provenance sessions verify UNVERIFIABLE, honestly.",
  )
  .option("--answer <text>", "the answer text to verify (overrides the session's)")
  .option("--answer-file <path>", "read the answer text from a file")
  .option("--json", "emit {report, warnings, stats[, triage]} as JSON")
  .option("--classify", CLASSIFY_HELP)
  .action(async (idArg: string | undefined, opts) => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { resolveJsonl, NoMatchError, AmbiguousMatchError } = await import("./util/tailer.js");
    const { parseAuditJsonl, evidenceFromAuditEvents } = await import(
      "./verifier/session_adapter.js"
    );
    const { verify } = await import("./verifier/grounding.js");
    const { renderReport, renderTriage, reportExitCode } = await import("./verifier/render.js");
    let resolved: { path: string; id: string };
    try {
      resolved = resolveJsonl(EVENTS_DIR, idArg);
    } catch (err) {
      if (err instanceof NoMatchError || err instanceof AmbiguousMatchError) {
        log.error(err.message);
        process.exit(3);
      }
      throw err;
    }
    const events = parseAuditJsonl(readFileSync(resolved.path, "utf8"));
    const adapted = evidenceFromAuditEvents(events);

    let answer = (opts.answer as string | undefined) ?? "";
    if (!answer && opts.answerFile) answer = readFileSync(opts.answerFile, "utf8");
    if (!answer) {
      // fall back to the session record's own outputs
      try {
        const sess = JSON.parse(
          readFileSync(join(SESSIONS_DIR, `${resolved.id}.json`), "utf8"),
        );
        const parts: string[] = [];
        if (typeof sess.summary === "string") parts.push(sess.summary);
        for (const r of sess.results ?? [])
          if (typeof r.output_summary === "string") parts.push(r.output_summary);
        answer = parts.join("\n");
      } catch {
        /* fall through to the guard below */
      }
    }
    if (!answer.trim()) {
      log.error(
        "no answer text to verify — the session record has none; pass --answer or --answer-file",
      );
      process.exit(3);
    }
    // warnings BEFORE the report, so honesty frames the verdict
    for (const w of adapted.warnings) log.warn(w);
    const report = verify(answer, adapted.evidence);
    const triage = opts.classify ? await classifyMissed(answer, adapted.evidence, report) : undefined;
    if (opts.json)
      process.stdout.write(
        JSON.stringify({ session: resolved.id, report, warnings: adapted.warnings, stats: adapted.stats, triage }) + "\n",
      );
    else {
      console.log(chalk.dim(`\n  session ${resolved.id} — ${adapted.stats.toolResults} tool outputs, ${adapted.stats.toolCalls} tool calls as evidence\n`));
      console.log(renderReport(report) + "\n");
      if (triage) console.log(renderTriage(triage) + "\n");
    }
    process.exit(reportExitCode(report));
  });


verifyCmd
  .command("claude [session]")
  .description(
    "Audit a CLAUDE CODE session: check the assistant's final answer " +
    "against what its own tools actually returned. No arg = the newest " +
    "transcript (which, run from inside a session, is that session " +
    "itself — self-audit). Searches Windows and WSL ~/.claude/projects.",
  )
  .option("--answer <text>", "verify this text instead of the last assistant message")
  .option("--list", "list the newest 15 transcripts and exit")
  .option("--json", "emit {session, report, warnings, stats[, triage]} as JSON")
  .option("--classify", CLASSIFY_HELP)
  .action(async (sessionArg: string | undefined, opts) => {
    const { adaptClaudeTranscript, listTranscripts, readTranscript, resolveTranscript } =
      await import("./verifier/claude_adapter.js");
    if (opts.list) {
      for (const t of listTranscripts().slice(0, 15))
        console.log(
          `  ${chalk.dim(new Date(t.mtimeMs).toISOString().slice(0, 16))} ` +
            `${chalk.cyan(t.session.slice(0, 12))} ${chalk.dim(t.project.slice(0, 50))}`,
        );
      return;
    }
    const { verify } = await import("./verifier/grounding.js");
    const { renderReport, renderTriage, reportExitCode } = await import("./verifier/render.js");
    let t: ReturnType<typeof resolveTranscript>;
    try {
      t = resolveTranscript(sessionArg);
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(3);
    }
    const adapted = adaptClaudeTranscript(readTranscript(t));
    const answer = (opts.answer as string | undefined) ?? adapted.answer;
    for (const w of adapted.warnings) log.warn(w);
    if (!answer.trim()) process.exit(3);
    const report = verify(answer, adapted.evidence);
    const triage = opts.classify ? await classifyMissed(answer, adapted.evidence, report) : undefined;
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ session: t.session, project: t.project, report, warnings: adapted.warnings, stats: adapted.stats, triage }) + "\n",
      );
    } else {
      console.log(
        chalk.dim(
          `\n  claude session ${t.session.slice(0, 12)} · ${t.project.slice(0, 40)}\n` +
            `  ${adapted.stats.toolResults} tool outputs · ${adapted.stats.toolCalls} tool calls · ` +
            `${adapted.stats.assistantTurns} assistant turns\n`,
        ),
      );
      console.log(renderReport(report) + "\n");
      if (triage) console.log(renderTriage(triage) + "\n");
    }
    process.exit(reportExitCode(report));
  });


verifyCmd
  .command("hook <action>")
  .description(
    "OPT-IN control of the self-audit Stop hook (on | off | status). " +
    "Wires/unwires ~/.claude/settings.json in WSL. Off by default — " +
    "auditing is requested, never forced (project rule).",
  )
  .action(async (action: string) => {
    const { existsSync, readdirSync, readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    // sessions live in WSL — find its settings.json via UNC
    const wslHomes = "\\\\wsl.localhost\\Ubuntu\\home";
    let settingsPath: string | null = null;
    let hookPath = "";
    try {
      for (const user of readdirSync(wslHomes)) {
        const cand = join(wslHomes, user, ".claude", "settings.json");
        if (existsSync(cand)) {
          settingsPath = cand;
          hookPath = `/home/${user}/.claude/hooks/self-audit-stop.sh`;
          break;
        }
      }
    } catch {
      /* no WSL */
    }
    if (!settingsPath) {
      log.error("could not find a WSL ~/.claude/settings.json");
      process.exit(1);
    }
    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    const wired = Boolean(settings.hooks?.Stop?.some?.((g: { hooks?: Array<{ command?: string }> }) =>
      g.hooks?.some((h) => h.command?.includes("self-audit"))));
    if (action === "status") {
      console.log(wired ? chalk.green("self-audit hook: ON (every session, every stop)") : chalk.dim("self-audit hook: off (opt-in — `patchwork-harness verify hook on`)"));
      return;
    }
    if (action === "on") {
      if (!existsSync(join(wslHomes, hookPath.split("/")[2] ?? "", ".claude", "hooks", "self-audit-stop.sh").replace(/^/, ""))) {
        /* existence check is best-effort over UNC; the hook fails open anyway */
      }
      settings.hooks = settings.hooks ?? {};
      settings.hooks.Stop = [
        { hooks: [{ type: "command", command: hookPath, timeout: 60 }] },
      ];
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(chalk.yellow("self-audit hook ON for all NEW sessions — `patchwork-harness verify hook off` to remove"));
      return;
    }
    if (action === "off") {
      if (settings.hooks?.Stop) {
        settings.hooks.Stop = settings.hooks.Stop.filter((g: { hooks?: Array<{ command?: string }> }) =>
          !g.hooks?.some((h) => h.command?.includes("self-audit")));
        if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
        if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(chalk.dim("self-audit hook off — manual audits still available: patchwork-harness verify claude"));
      return;
    }
    log.error("action must be on | off | status");
    process.exit(1);
  });

verifyCmd
  .command("exam")
  .description("Run the 21-case exam strictly and render the board; exit 0 only on GREEN.")
  .option("--json", "emit the board as JSON")
  .action(async (opts) => {
    const { runExamStrict, renderBoard } = await import("./testing/run_exam.js");
    const board = await runExamStrict();
    if (opts.json) process.stdout.write(JSON.stringify(board) + "\n");
    else
      console.log(
        `\n${renderBoard(board, { green: (x) => chalk.green(x), red: (x) => chalk.red(x), yellow: (x) => chalk.yellow(x), bold: (x) => chalk.bold(x) })}\n`,
      );
    process.exit(board.overall === "GREEN" ? 0 : 1);
  });

program
  .command("test [filter]")
  .description(
    "Run the vitest suite. --live renders a compact real-time wall from the " +
    "NDJSON test log; --exam runs the L4.5 verifier exam strictly and exits " +
    "0 only on a GREEN board (ADR-0012).",
  )
  .option("--live", "compact live wall in the terminal while the run streams")
  .option("--exam", "verifier exam only, strict mode, exit per exam board")
  .option("--json", "stream raw TestEvent NDJSON to stdout")
  .action(async (filter: string | undefined, opts) => {
    const { spawn } = await import("node:child_process");
    const { join } = await import("node:path");
    const { PROJECT_ROOT, TESTS_DIR } = await import("./util/paths.js");
    const vitest = join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs");
    const args = [vitest, "run"];
    if (opts.exam) args.push("tests/verifier-exam.test.ts");
    else if (filter) args.push(filter);
    const env = opts.exam
      ? { ...process.env, PATCHWORK_HARNESS_VERIFIER_EXAM: "strict" }
      : { ...process.env };

    if (!opts.live && !opts.json && !opts.exam) {
      // plain passthrough — vitest owns the terminal, we return its code
      const child = spawn(process.execPath, args, {
        cwd: PROJECT_ROOT,
        env,
        stdio: "inherit",
      });
      child.on("exit", (code) => process.exit(code ?? 1));
      return;
    }

    const { tailFile } = await import("./util/tailer.js");
    const { parseTestLog } = await import("./testing/test_events.js");
    const chalk = (await import("chalk")).default;
    const lines: string[] = [];
    const isTTY = Boolean(process.stdout.isTTY);
    const tailer = tailFile(
      join(TESTS_DIR, "latest.jsonl"),
      (line) => {
        lines.push(line);
        if (opts.json) {
          process.stdout.write(line + "\n");
          return;
        }
        try {
          const e = JSON.parse(line);
          if (e.type === "task" && e.state !== "run") {
            const glyph =
              e.state === "pass"
                ? chalk.green("·")
                : e.state === "fail"
                  ? chalk.red("✗")
                  : chalk.yellow("○");
            if (isTTY) process.stdout.write(glyph);
            else process.stdout.write(`${e.state} ${e.file} > ${e.name}\n`);
            if (e.state === "fail" && isTTY)
              process.stdout.write(`\n${chalk.red(`FAIL ${e.file} > ${e.name}`)}\n  ${chalk.dim(e.error ?? "")}\n`);
          }
        } catch {
          /* skip */
        }
      },
      { waitForFile: true },
    );

    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env,
      stdio: opts.json || opts.live ? "ignore" : "inherit",
    });
    child.on("exit", async (code) => {
      // give the tailer a beat to drain the final events
      await new Promise((r) => setTimeout(r, 1500));
      tailer.close();
      const { events, runComplete } = parseTestLog(lines);
      if (opts.exam) {
        const { buildExamBoard, corpusCases } = await import("./verifier/exam_board.js");
        const board = buildExamBoard(
          events,
          corpusCases(join(PROJECT_ROOT, "tests", "fixtures", "verifier-corpus")),
        );
        if (!opts.json) {
          console.log();
          for (const cse of board.cases) {
            const colour =
              cse.state === "PASS"
                ? chalk.green
                : cse.state === "FAIL"
                  ? chalk.red
                  : chalk.yellow;
            console.log(`  ${colour(cse.state.padEnd(8))} ${cse.id}`);
          }
          const { pass, fail, skip, missing, running } = board.counts;
          console.log(
            `\n  exam board: ${chalk.bold(board.overall)} — ` +
              `${chalk.green(`${pass} pass`)} · ${chalk.red(`${fail} fail`)} · ` +
              `${chalk.yellow(`${skip} skip`)} · ${chalk.yellow(`${missing} missing`)} · ${running} running\n`,
          );
        } else {
          process.stdout.write(JSON.stringify(board) + "\n");
        }
        process.exit(board.overall === "GREEN" ? 0 : 1);
      }
      if (!opts.json && opts.live) {
        const { summarize } = await import("./testing/test_events.js");
        const sum = summarize(events);
        console.log(
          `\n\n  ${chalk.green(`${sum.totals.passed} pass`)} · ` +
            `${chalk.red(`${sum.totals.failed} fail`)} · ` +
            `${chalk.yellow(`${sum.totals.skipped} skipped`)}` +
            (runComplete ? "" : chalk.red(" · RUN DID NOT COMPLETE")),
        );
      }
      process.exit(code ?? 1);
    });
  });

program
  .command("tail [session]")
  .description(
    "Follow the live audit event stream for a session (or the most recent if omitted). " +
    "Use --json to emit each event verbatim — handy for piping into another agent.",
  )
  .option("--json", "emit raw JSONL events as they arrive")
  .option("-n, --tail <n>", "show last N events before following", "20")
  .action(async (sessionArg: string | undefined, opts) => {
    // Follow mechanics live in src/util/tailer.ts (ADR-0012) — shared with
    // the web SSE routes and the cockpit, so there is exactly one
    // implementation of "follow a growing JSONL".
    const { tailFile, resolveJsonl, NoMatchError, AmbiguousMatchError } =
      await import("./util/tailer.js");
    let resolved: { path: string; id: string };
    try {
      resolved = resolveJsonl(EVENTS_DIR, sessionArg);
    } catch (err) {
      if (err instanceof NoMatchError || err instanceof AmbiguousMatchError) {
        log.error(err.message);
        process.exit(1);
      }
      throw err;
    }
    if (!opts.json) log.info(`tailing ${resolved.id}.jsonl`);
    const tailer = tailFile(
      resolved.path,
      (line) => {
        if (opts.json) {
          process.stdout.write(line + "\n");
        } else {
          try {
            renderEventLine(JSON.parse(line));
          } catch {
            console.log(line);
          }
        }
      },
      { tailLines: Number(opts.tail), waitForFile: true },
    );
    const cleanup = (code = 0): void => {
      tailer.close();
      process.exit(code);
    };
    process.on("SIGINT", () => cleanup(0));
    process.on("SIGTERM", () => cleanup(0));
    process.on("SIGHUP", () => cleanup(0));
    // Keep the loop alive: the tailer's interval is unref'd by design, so
    // hold an explicit ref'd heartbeat for the lifetime of the command.
    setInterval(() => {
      /* tick */
    }, 3_600_000);
  });

function renderEventLine(e: {
  timestamp?: string;
  action?: string;
  status?: string;
  target?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  risk?: { level?: string };
}): void {
  const t = (e.timestamp ?? "").slice(11, 19);
  const action = e.action ?? "?";
  const tgt = e.target ? Object.entries(e.target).map(([k, v]) =>
    `${k}=${String(v).slice(0, 40)}`).join(" ") : "";
  const status = e.status ? chalk.dim(`[${e.status}]`) : "";
  const risk = e.risk?.level && e.risk.level !== "none" && e.risk.level !== "low"
    ? chalk.yellow(`!${e.risk.level} `)
    : "";
  const reason = (action === "step_start" || action === "plan_proposed") && e.provenance?.reason
    ? "\n    " + chalk.dim("why: " + String(e.provenance.reason))
    : "";
  const cost = action === "provider_response" && typeof e.provenance?.cost_usd === "number"
    ? chalk.dim(` $${(e.provenance.cost_usd as number).toFixed(4)}`)
    : "";
  console.log(`${chalk.dim(t)} ${risk}${chalk.cyan(action.padEnd(20))} ${status} ${tgt}${cost}${reason}`);
}

/** Commander coercion for repeatable media flags — accumulates into an array. */
function collectMedia(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

program
  .command("ask [prompt]")
  .description(
    "Direct one-shot question to a single provider — no planner, no tools. " +
    "Useful as a cross-vendor sanity check from another agent (e.g. ask GPT-5.5 to review). " +
    "If [prompt] is omitted or '-', reads from stdin.",
  )
  .option("-p, --provider <name>", "anthropic | openai | gemini | xai | perplexity | local (Ollama)", "anthropic")
  .option("-m, --model <id>", "model id (defaults to provider's default)")
  .option("-s, --system <text>", "optional system prompt")
  .option("--json", "emit one JSON object {text, cost_usd, tokens_in, tokens_out, model}")
  .option("--max-tokens <n>", "max output tokens", "1024")
  .option("--image <path-or-url>", "attach an image input (repeatable) — Gemini only", collectMedia, [])
  .option("--video <url>", "attach a video, e.g. a YouTube URL (repeatable) — Gemini only", collectMedia, [])
  .option("--pdf <path-or-url>", "attach a PDF (repeatable) — Gemini only", collectMedia, [])
  .option("--search", "ground the answer in live Google Search with real cited sources — Gemini only")
  .action(async (promptArg: string | undefined, opts) => {
    // Assemble media attachments first so we can relax the prompt requirement
    // when the user is clearly asking about an attached file/video.
    const media: { kind: "image" | "video" | "pdf"; source: string }[] = [
      ...(opts.image as string[]).map((source) => ({ kind: "image" as const, source })),
      ...(opts.video as string[]).map((source) => ({ kind: "video" as const, source })),
      ...(opts.pdf as string[]).map((source) => ({ kind: "pdf" as const, source })),
    ];

    let prompt = promptArg;
    if (!prompt || prompt === "-") {
      if (prompt !== "-" && media.length) {
        // Media given with no prompt — don't block on stdin; ask the obvious.
        prompt = "Describe and summarise the attached media.";
      } else {
        // Read from stdin — useful for large prompts (security audits, code reviews)
        prompt = await new Promise<string>((resolve) => {
          let data = "";
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (c) => { data += c; });
          process.stdin.on("end", () => resolve(data));
        });
        if (!prompt.trim()) {
          log.error("no prompt provided (give as arg or pipe via stdin)");
          process.exit(1);
        }
      }
    }
    if (media.length && opts.provider !== "gemini") {
      log.error(`media input (--image/--video/--pdf) is currently Gemini-only — re-run with --provider gemini (got --provider ${opts.provider})`);
      process.exit(1);
    }
    if (opts.search && opts.provider !== "gemini") {
      log.error(`--search (Google Search grounding) is Gemini-only — re-run with --provider gemini, or use --provider perplexity for cited research (got --provider ${opts.provider})`);
      process.exit(1);
    }
    const { getProvider } = await import("./providers/registry.js");
    const provider = getProvider(opts.provider);
    if (!provider.available()) {
      log.error(`provider ${opts.provider} not available — set its API key (patchwork-harness keys set ...)`);
      process.exit(1);
    }
    const model = opts.model ?? provider.defaultModel;
    const maxTokens = Number(opts.maxTokens);
    if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > 200_000) {
      log.error(`--max-tokens must be a positive integer ≤ 200000 (got ${opts.maxTokens})`);
      process.exit(1);
    }
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: prompt }] }];
    let resp;
    try {
      resp = await provider.complete({
        model,
        messages,
        system: opts.system,
        maxTokens,
        media: media.length ? media : undefined,
        grounded: !!opts.search,
      });
    } catch (e) {
      log.error(`${opts.provider} error: ${(e as Error).message}`);
      process.exit(1);
    }
    const text = resp.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (opts.json) {
      process.stdout.write(JSON.stringify({
        provider: opts.provider,
        model,
        text,
        cost_usd: resp.cost_usd ?? 0,
        tokens_in: resp.usage.input_tokens,
        tokens_out: resp.usage.output_tokens,
        duration_ms: resp.duration_ms,
        stop_reason: resp.stop_reason,
      }) + "\n");
    } else {
      process.stdout.write(text + "\n");
      log.cost(resp.cost_usd ?? 0, { in: resp.usage.input_tokens, out: resp.usage.output_tokens }, resp.duration_ms);
    }
  });

// ============== approve (cross-vendor check before publishing; the tag) ==============
program
  .command("approve [file]")
  .description(
    "The check before you publish: a model from a different vendor reads a draft " +
    "issue, PR description or commit message against your evidence, then approves " +
    "it or lists what to fix. An approved draft is printed with the \"Patchwork " +
    "Harness approved\" tag, ready for `gh issue create --body-file -`. " +
    "If [file] is omitted or '-', reads the draft from stdin.",
  )
  .option("--as <kind>", "issue | pr | commit | text - the form the tag takes", "issue")
  .option("-e, --evidence <file>", "what the draft's claims rest on (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[])
  .option("-m, --model <id>", "reviewer model (default: the first reachable `reviewer` from another vendor)")
  .option("--written-by <vendors>", "comma-separated vendor(s) that wrote the draft (default: the executor's)")
  .option("--no-tag", "check only; print the draft without the tag (or set PATCHWORK_HARNESS_TAG=off)")
  .option("--json", "emit the result as JSON")
  .action(async (file: string | undefined, opts) => {
    // stdout carries only the draft (or the JSON), so it pipes straight into gh/git.
    setSilentStdout(true);
    const kinds = ["issue", "pr", "commit", "text"] as const;
    if (!kinds.includes(opts.as)) {
      log.error(`--as must be one of ${kinds.join(", ")} (got ${opts.as})`);
      process.exit(2);
    }
    const draft =
      file && file !== "-"
        ? readFileSync(file, "utf8")
        : await new Promise<string>((resolve) => {
            let data = "";
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", (c) => { data += c; });
            process.stdin.on("end", () => resolve(data));
          });
    if (!draft.trim()) {
      log.error("approve: the draft is empty");
      process.exit(2);
    }
    const evidence = (opts.evidence as string[]).map((f) => ({ name: f, text: readFileSync(f, "utf8") }));
    const { approve } = await import("./review/approve.js");
    let r;
    try {
      r = await approve({
        draft,
        kind: opts.as,
        evidence,
        model: opts.model,
        writtenBy: opts.writtenBy ? String(opts.writtenBy).split(",").map((v: string) => v.trim()) : undefined,
        tag: opts.tag,
      });
    } catch (e) {
      log.error(`approve: ${(e as Error).message}`);
      process.exit(2);
    }
    if (opts.json) {
      process.stdout.write(JSON.stringify(r) + "\n");
    } else {
      for (const c of r.concerns)
        process.stderr.write(`${c.severity.toUpperCase().padEnd(6)} ${c.issue}${c.quote ? `\n       "${c.quote}"` : ""}\n`);
      if (r.unparsed) process.stderr.write(`could not read the reviewer's answer:\n${r.unparsed}\n`);
      const how = `${r.reviewer}${r.cross_vendor ? "" : ", same vendor as the writer"}`;
      if (r.approved) {
        process.stdout.write(r.text.endsWith("\n") ? r.text : `${r.text}\n`);
        log.ok(`approved by ${how}${r.tagged ? "; tagged" : r.cross_vendor ? "; tag off" : "; not tagged (not cross-vendor)"}`);
      } else {
        log.error(`not approved by ${how}: fix the concerns above and run it again`);
      }
      log.cost(r.cost_usd, {});
    }
    process.exit(r.approved ? 0 : 1);
  });

// ============== review (multi-model adversarial security review) ==============
program
  .command("review [paths...]")
  .description(
    "Adversarial SECURITY review of paths/globs (or --diff) by 2-3 models from " +
    "DIFFERENT providers in parallel (the security_reviewer role in " +
    "config/models.yml), merged + de-duplicated, ALWAYS passed through the " +
    "L4.5 verifier. Writes docs/reviews/security/<date>-<slug>/.",
  )
  .option("--diff [range]", "review the working tree vs HEAD (no value) or a commit range, e.g. main..HEAD")
  .option("--context <text>", "what the code is / threat-model preamble; @path reads it from a file")
  .option("--slug <slug>", "output folder suffix (default: derived from the paths)")
  .option("-m, --models <ids>", "comma-separated model ids to use instead of the security_reviewer role")
  .option("--max-models <n>", "max reviewers (one per provider)", "3")
  .option("--budget <usd>", "abort before any call if the estimate exceeds this", "1.0")
  .option("--max-tokens <n>", "max output tokens per reviewer", "6000")
  .option("--out <dir>", "output root (default: <cwd>/docs/reviews/security)")
  .option("--cwd <path>", "working directory the paths are relative to")
  .option("--dry-run", "collect the material, pick the reviewers, print the estimate; call nobody")
  .option("--json", "emit one JSON object with the result")
  .action(async (paths: string[], opts) => {
    const { runReview } = await import("./review/run.js");
    const { readFileSync } = await import("node:fs");
    let context: string | undefined = opts.context;
    if (context?.startsWith("@")) context = readFileSync(context.slice(1), "utf8");
    const cwd = opts.cwd ?? process.cwd();
    const budgetUsd = Number(opts.budget);
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
      log.error(`--budget must be a positive number (got ${opts.budget})`);
      process.exit(1);
    }
    try {
      const result = await runReview({
        cwd,
        paths,
        diff: opts.diff === undefined ? undefined : opts.diff === true ? true : String(opts.diff),
        context,
        slug: opts.slug,
        models: opts.models ? String(opts.models).split(",").map((s: string) => s.trim()).filter(Boolean) : undefined,
        maxModels: Number(opts.maxModels),
        budgetUsd,
        maxTokens: Number(opts.maxTokens),
        outDir: opts.out,
        dryRun: !!opts.dryRun,
        log: (line) => { if (!opts.json) log.info(line); },
      });
      if (opts.json) {
        process.stdout.write(JSON.stringify({
          session: result.sessionId,
          out_dir: result.outDir,
          dry_run: result.dryRun,
          models: result.models.map((m) => `${m.provider}/${m.id}`),
          files: result.collected.files.map((f) => f.path),
          estimate_usd: result.estimate_usd,
          total_cost_usd: result.total_cost_usd,
          findings: result.merged,
          reviewers: result.reviewers.map((r) => ({ model: r.model, cost_usd: r.cost_usd, error: r.error, findings: r.parsed.findings.length, verifier: r.verifier?.overall ?? null })),
        }) + "\n");
        return;
      }
      if (result.dryRun) {
        console.log(chalk.bold("\nReview plan (dry run):"));
        for (const f of result.collected.files) console.log(`  ${chalk.dim("file")} ${f.path} ${chalk.dim(`(${f.lines} lines${f.truncated ? ", truncated" : ""})`)}`);
        for (const s of result.collected.skipped) console.log(`  ${chalk.yellow("skip")} ${s.path} ${chalk.dim(s.reason)}`);
        console.log(`  ${chalk.dim("reviewers")} ${result.models.map((m) => `${m.provider}/${m.id}`).join(", ")}`);
        console.log(`  ${chalk.dim("estimate")} ~$${result.estimate_usd.toFixed(3)}`);
        console.log(`  ${chalk.dim("would write")} ${result.outDir}\n`);
        return;
      }
      console.log();
      console.log(chalk.bold(`Merged findings: ${result.merged.length}`) + chalk.dim(`  (spend $${result.total_cost_usd.toFixed(4)})`));
      const { findingStatus } = await import("./review/merge.js");
      for (const m of result.merged) {
        const sev = m.severity === "critical" || m.severity === "high" ? chalk.red(m.severity) : m.severity === "medium" ? chalk.yellow(m.severity) : chalk.dim(m.severity);
        console.log(`  ${chalk.cyan(m.key.padEnd(4))} ${sev.padEnd(18)} ${m.title.slice(0, 70)}  ${chalk.dim(`[${m.found_by.join(", ")}] ${findingStatus(m)}`)}`);
      }
      console.log();
      console.log(chalk.dim("  L4.5 — Harness Verifier (each reply vs the material):"));
      const { renderReport } = await import("./verifier/render.js");
      for (const r of result.reviewers) {
        if (!r.verifier) continue;
        console.log(chalk.bold(`  ${r.model}`));
        console.log(renderReport(r.verifier).split("\n").map((l) => `  ${l}`).join("\n"));
      }
      console.log();
      log.ok(`written to ${result.outDir}`);
    } catch (e) {
      log.error((e as Error).message);
      process.exit(1);
    }
  });

// ============== models (catalog + live reachability) ==============
program
  .command("models")
  .description("Show the model catalog (config/models.yml) with price, verification status and LIVE reachability on this machine's keys.")
  .option("--json", "emit JSON")
  .action(async (opts) => {
    const { loadModels } = await import("./config.js");
    const { modelReach } = await import("./providers/availability.js");
    const cfg = loadModels();
    const rows = await Promise.all(
      cfg.models.map(async (m) => ({
        id: m.id,
        provider: m.provider,
        in: m.cost_per_m_in,
        out: m.cost_per_m_out,
        availability: m.availability,
        verified_on: m.verified_on ?? null,
        reach: await modelReach(m),
      })),
    );
    if (opts.json) {
      process.stdout.write(JSON.stringify({ defaults: cfg.defaults, models: rows }) + "\n");
      return;
    }
    const table = new Table({
      head: [chalk.cyan("model"), chalk.cyan("provider"), chalk.cyan("$/M in"), chalk.cyan("$/M out"), chalk.cyan("catalog"), chalk.cyan("live")],
      colWidths: [30, 12, 10, 10, 12, 14],
    });
    const price = (v: number | null) => (v === null ? chalk.yellow("unknown") : v.toFixed(2));
    for (const r of rows) {
      const live = r.reach === "reachable" ? chalk.green("reachable") : r.reach === "unreachable" ? chalk.red("unreachable") : chalk.yellow("unknown");
      table.push([r.id, r.provider, price(r.in), price(r.out), r.availability === "verified" ? chalk.dim(`verified ${r.verified_on ?? ""}`) : chalk.yellow("unverified"), live]);
    }
    console.log(table.toString());
    console.log(chalk.dim(`\n  roles: ${Object.entries(cfg.defaults).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v.join(", ")}]` : v}`).join("  ")}\n`));
  });

program
  .command("one-shot [goal]", { isDefault: true })
  .alias("run")
  .description("Plan and execute a goal end-to-end.")
  .option("--auto", "widen auto-approval (skip prompts for everything below high-risk)")
  .option("--cautious", "narrow auto-approval (prompt for everything above none-risk)")
  .option("--dry-run", "plan only; do not execute")
  .option("-y, --yes", "skip plan-confirmation prompt")
  .option(
    "--budget <usd|auto>",
    "session budget target in USD or 'auto' to let the planner propose",
    "1.0",
  )
  .option("--bedrock <usd>", "ABSOLUTE hard ceiling that is never crossed (default from config/budget.yml)")
  .option(
    "--mode <budget|balanced|unlimited>",
    "spend strategy: budget=cheapest viable, balanced=stick to budget±20%, unlimited=best per step (bedrock-capped)",
    "balanced",
  )
  .option("--cwd <path>", "working directory")
  .option("--json", "emit deterministic NDJSON events to stdout (one per line); suppresses rich output. Pair with --auto for non-interactive use.")
  .option("-u, --unattended", "shortcut for --auto --yes --json (fully non-interactive, machine-readable output)")
  .option("--no-world-view", "disable smart conductor Layer 1 (project awareness packet)")
  .option("--no-lessons", "disable smart conductor Layer 2 (similar past sessions)")
  .option("--no-critic", "disable smart conductor Layer 3 (critic pass on the plan)")
  .option("--context", "OPT IN to memory-spine retrieval before planning (off by default since the 2026-05-27 security audit; only enable when the spine contains content you trust). Also enabled by PATCHWORK_HARNESS_ENABLE_CONTEXT_INJECTION=1.")
  .option("--context-top-k <n>", "how many spine chunks/claims to retrieve before planning (when --context is on)", "5")
  .option("--verify", "REQUESTED L4.5: after the run, pass the answer through the Harness Verifier against the session's own tool outputs (opt-in, never forced)")
  .option("--verify-cmd <cmd>", "ADR-0015 test gate: run this command in cwd after the plan; exit 0 = pass, else the run fails (exit 1). Its output is audited evidence for L4.5")
  .option("--verify-timeout <s>", "seconds before the --verify-cmd is killed (max 600)", "600")
  .option("--attempts <n>", "ADR-0015 bounded repair loop: on a failed --verify-cmd, give the failure to a repair step and re-verify, up to n attempts in total (max 10)", "1")
  .option("--checkpoint", "ADR-0015: git-snapshot the working tree before every step under refs/patchwork-harness/<session>/ (index, HEAD and stash untouched); undo with `patchwork-harness rewind`")
  .option("--guard-loop", "ADR-0015: nudge the model when it repeats an identical tool call 3+ times in a step")
  .option("--time-budget <s>", "ADR-0015: wall-clock budget for the whole run; the model sees time used, steps stop when it runs out")
  .option("--review [model]", "ADR-0016 L5 reviewer: a model from a different vendor reviews the finished work read-only against a rubric, citing evidence; its citations are L4.5-checked. Optional model id overrides the reviewer role")
  .option("--review-strict", "with --review: a verdict other than COMPLETE fails the command (exit 1)")
  .option("--review-fix", "with --review: on an INCOMPLETE verdict, one repair step works from the reviewer's cited concerns, then the gate and the review run again (implies --review)")
  .option("--lane <mode>", "ADR-0018 intent lane: planned (default: world view + planner + critic), direct (no planner: one executor step), auto (intent head at PATCHWORK_HARNESS_INTENT_URL, then the intent_router LLM only if the head is unsure; anything else -> planned). Preview a decision with `patchwork-harness route`", "planned")
  .option("--lane-threshold <p>", "with --lane auto: the intent head's P(no plan needed) that takes the direct lane without asking the LLM", "0.6")
  .option("--guard [p]", "ADR-0019: screen file, shell, search, git and memory output for prompt injection before the model reads it (Jeff guard adapter at PATCHWORK_HARNESS_JEFF_URL); flag at P(attack) >= p", )
  .option("--guard-withhold", "with --guard: withhold a flagged output from the model instead of flagging it (also withholds outputs the guard could not screen)")
  .option("--lane-model <id>", "the direct lane's model (default: the executor role). The planned lane routes small steps to cheaper tiers; the direct lane otherwise always uses the flagship")
  .action(async (goal: string | undefined, opts) => {
    // No goal? Drop into the REPL — `patchwork-harness` should "just work" like `claude`.
    if (!goal) {
      const budget = opts.budget === "auto" ? "auto" : Number(opts.budget);
      await startRepl({
        cwd: opts.cwd,
        mode: opts.mode,
        budget: budget as number | "auto",
        bedrock: opts.bedrock ? Number(opts.bedrock) : undefined,
      });
      return;
    }
    // --unattended is shorthand for --auto --yes --json (machine-readable, non-interactive)
    if (opts.unattended) {
      opts.auto = true;
      opts.yes = true;
      opts.json = true;
    }
    // --json mode: silence rich logger (stderr only) and install JSON reporter
    const reporter = opts.json ? new StdoutJsonReporter() : undefined;
    if (reporter) setSilentStdout(true);
    // The human side: in --json mode questions go out as NDJSON events and
    // answers come back on stdin (the dashboard does this); on a TTY it's
    // readline; headless falls back to safe defaults. The CLI owns the
    // channel so it can release the stdin listener when the run ends.
    const { createHumanChannel } = await import("./permissions/human.js");
    const human = createHumanChannel({ reporter });

    await bootOrExit();
    await loadBuiltIns(opts.cwd ?? process.cwd());
    const permission_mode: "auto" | "default" | "cautious" = opts.auto
      ? "auto"
      : opts.cautious
        ? "cautious"
        : "default";

    const budget_usd: number | "auto" =
      opts.budget === "auto" ? "auto" : Number(opts.budget);
    if (budget_usd !== "auto" && (Number.isNaN(budget_usd) || budget_usd <= 0)) {
      log.error(`--budget must be a positive number or 'auto' (got ${opts.budget})`);
      process.exit(1);
    }

    if (!["planned", "direct", "auto"].includes(opts.lane)) {
      log.error(`--lane must be one of planned|direct|auto (got ${opts.lane})`);
      process.exit(1);
    }
    if (
      opts.laneModel &&
      !(await import("./config.js")).loadModels().models.some((m) => m.id === opts.laneModel)
    ) {
      log.error(`--lane-model: unknown model '${opts.laneModel}' (see \`patchwork-harness models\`)`);
      process.exit(1);
    }
    const laneThreshold = Number(opts.laneThreshold);
    if (!(laneThreshold > 0 && laneThreshold <= 1)) {
      log.error(`--lane-threshold must be in (0, 1] (got ${opts.laneThreshold})`);
      process.exit(1);
    }
    const budget_mode = opts.mode as "budget" | "balanced" | "unlimited";
    if (!["budget", "balanced", "unlimited"].includes(budget_mode)) {
      log.error(`--mode must be one of budget|balanced|unlimited (got ${opts.mode})`);
      process.exit(1);
    }

    try {
      const result = await oneShot({
        goal,
        cwd: opts.cwd ?? process.cwd(),
        permission_mode,
        budget_usd,
        bedrock_usd: opts.bedrock ? Number(opts.bedrock) : undefined,
        budget_mode,
        yes: opts.yes,
        dryRun: opts.dryRun,
        reporter,
        human,
        // commander negates --no-X to opts.X = false; default true
        worldViewEnabled: opts.worldView !== false,
        contextEnabled: opts.context === true,
        contextTopK: opts.contextTopK ? Number(opts.contextTopK) : undefined,
        lessonsEnabled: opts.lessons !== false,
        criticEnabled: opts.critic !== false,
        lane: opts.lane,
        laneThreshold: Number(opts.laneThreshold),
        laneModel: opts.laneModel,
        harness: {
          verifyCmd: opts.verifyCmd,
          verifyTimeoutS: Number(opts.verifyTimeout) || 600,
          attempts: Number(opts.attempts) || 1,
          checkpoint: opts.checkpoint === true,
          loopGuard: opts.guardLoop === true,
          timeBudgetS: opts.timeBudget ? Number(opts.timeBudget) : undefined,
          review: opts.review ?? (opts.reviewFix ? true : undefined),
          reviewStrict: opts.reviewStrict === true,
          reviewFix: opts.reviewFix === true,
          guard:
            opts.guard || opts.guardWithhold
              ? {
                  threshold: typeof opts.guard === "string" ? Number(opts.guard) : undefined,
                  mode: opts.guardWithhold ? "withhold" : "flag",
                }
              : undefined,
        },
      });
      // Bedrock breach exits with status 2 to distinguish from normal failure
      if (result.state.status === "bedrock_aborted") process.exit(2);
      // --verify: the REQUESTED pipeline tail (requested, never forced).
      // L1-L3 ran above inside oneShot; this is L4.5. L5 remains unbuilt.
      if (opts.verify) {
        try {
          const { readFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const { parseAuditJsonl, evidenceFromAuditEvents } = await import(
            "./verifier/session_adapter.js"
          );
          const { verify } = await import("./verifier/grounding.js");
          const { renderReport } = await import("./verifier/render.js");
          const st = result.state as unknown as {
            id?: string;
            sessionId?: string;
            summary?: string;
            results?: Array<{ output_summary?: string }>;
          };
          // the state carries `sessionId` (core/types.ts) - `id` was never
          // set, so --verify opened events/undefined.jsonl (2 Sept 2026)
          const events = parseAuditJsonl(
            readFileSync(join(EVENTS_DIR, `${st.sessionId ?? st.id}.jsonl`), "utf8"),
          );
          const adapted = evidenceFromAuditEvents(events);
          const answer = [st.summary, ...(st.results ?? []).map((r) => r.output_summary)]
            .filter(Boolean)
            .join("\n");
          for (const w of adapted.warnings) log.warn(w);
          if (answer.trim()) {
            console.log(chalk.dim("\n  L4.5 — Harness Verifier (requested):"));
            console.log(renderReport(verify(answer, adapted.evidence)) + "\n");
          } else {
            log.warn("L4.5: the session recorded no answer text to verify");
          }
        } catch (e) {
          log.warn(`L4.5 verify failed (run itself unaffected): ${(e as Error).message}`);
        }
      }
      // ADR-0015: a requested test gate that never passed fails the command
      if (result.state.verification && !result.state.verification.passed) process.exitCode = 1;
      // ADR-0016: --review-strict turns a non-COMPLETE L5 verdict into a failure
      if (opts.reviewStrict && result.state.review && result.state.review.verdict !== "complete")
        process.exitCode = 1;
    } catch (e) {
      const msg = (e as Error).message;
      if (reporter) reporter.emit("error", { message: msg });
      log.error(msg);
      process.exit(1);
    } finally {
      human.close(); // release stdin so the process can exit
    }
  });

// ─── patchwork-harness resume (memory spine Phase 4 — orient-yourself) ──────────────

program
  .command("resume")
  .description(
    "Show the memory-spine resume packet: the last session's next_action, " +
    "recently-touched files, recent active claims, and prior sessions in the " +
    "same project. Read-only — does NOT auto-start work, just orients you.",
  )
  .option("--session <id>", "resume from a specific session id")
  .option("--project <name>", "filter to a project (latest session in it)")
  .option("--prior <n>", "max prior sessions to show", "3")
  .option("--files <n>", "max recently-touched files", "8")
  .option("--claims <n>", "max recent active claims", "8")
  .option("--json", "emit JSON result")
  .action(async (opts) => {
    const { openContextDb } = await import("./context/db.js");
    const { ensureContextSchema } = await import("./context/migrations.js");
    const { buildResumePacket, renderResumePacket } = await import("./context/resume.js");
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const packet = buildResumePacket(db, {
      session_id: opts.session,
      project_name: opts.project,
      prior_limit: Number(opts.prior),
      files_limit: Number(opts.files),
      claims_limit: Number(opts.claims),
    });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(packet, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderResumePacket(packet)}\n`);
    }
  });

// ─── patchwork-harness context (memory spine — Phase 1) ─────────────────────────────

const ctx = program
  .command("context")
  .description("Memory spine: durable local context store (SQLite + FTS5). Stores documents, chunks, claims, projects, file index, sessions log. See DIRECTION.md.");

ctx
  .command("init")
  .description("Initialise the context DB (creates tables, applies migrations)")
  .option("--json", "emit JSON result")
  .action(async (opts) => {
    const { openContextDb, contextDbPath } = await import("./context/db.js");
    const { ensureContextSchema } = await import("./context/migrations.js");
    const path = contextDbPath();
    const db = openContextDb({ fresh: true });
    const result = ensureContextSchema(db);
    const out = { path, applied: result.applied, skipped: result.skipped };
    if (opts.json) process.stdout.write(`${JSON.stringify(out)}\n`);
    else {
      log.info(`context db: ${path}`);
      if (result.applied.length) log.info(`applied migrations: ${result.applied.join(", ")}`);
      else log.info("no new migrations to apply");
    }
  });

ctx
  .command("status")
  .description("Show counts + claim status breakdown")
  .option("--json", "emit JSON result")
  .action(async (opts) => {
    const { openContextDb, contextDbPath } = await import("./context/db.js");
    const { ensureContextSchema } = await import("./context/migrations.js");
    const { status } = await import("./context/repository.js");
    const path = contextDbPath();
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const s = status(db, path);
    if (opts.json) process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    else {
      log.info(`db: ${s.db_path} (schema v${s.schema_version})`);
      for (const [k, v] of Object.entries(s.counts)) log.info(`  ${k.padEnd(14)} ${v}`);
      if (Object.keys(s.claims_by_status).length) {
        log.info("claims by status:");
        for (const [k, v] of Object.entries(s.claims_by_status)) log.info(`  ${k.padEnd(14)} ${v}`);
      }
    }
  });

ctx
  .command("add-document")
  .description("Add a document and its text as one chunk")
  .requiredOption("--title <title>", "document title")
  .requiredOption("--source <source>", "source identifier (path, URL, or 'manual')")
  .requiredOption("--text <text>", "document text (becomes the first chunk)")
  .option("--source-type <type>", "file|web|notebook|pdf|video|note", "note")
  .option("--project <name>", "project name (created if missing)")
  .option("--json", "emit JSON result")
  .action(async (opts) => {
    const { openContextDb } = await import("./context/db.js");
    const { ensureContextSchema } = await import("./context/migrations.js");
    const { insertDocument, insertChunksForDocument, upsertProject } = await import("./context/repository.js");
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    let project_id: number | undefined;
    if (opts.project) project_id = upsertProject(db, { name: opts.project }).id;
    const doc = insertDocument(db, {
      uri: opts.source,
      title: opts.title,
      source_type: opts.sourceType,
      project_id,
    });
    const chunks = insertChunksForDocument(db, doc.id, [opts.text]);
    const out = { document: doc, chunks_inserted: chunks.length };
    if (opts.json) process.stdout.write(`${JSON.stringify(out)}\n`);
    else log.info(`document #${doc.id} '${doc.title ?? doc.uri}' (+${chunks.length} chunk)`);
  });

ctx
  .command("add-claim")
  .description("Record an atomic claim with provenance")
  .requiredOption("--text <text>", "the claim statement")
  .requiredOption("--by <created_by>", "who/what produced the claim (user, model:<id>, tool:<name>)")
  .option("--confidence <n>", "0.0 - 1.0", "0.5")
  .option("--status <s>", "unverified|supported|contradicted|obsolete", "unverified")
  .option("--evidence <uri>", "URL or path to evidence")
  .option("--project <name>", "project name")
  .option("--json", "emit JSON result")
  .action(async (opts) => {
    const { openContextDb } = await import("./context/db.js");
    const { ensureContextSchema } = await import("./context/migrations.js");
    const { insertClaim, upsertProject } = await import("./context/repository.js");
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    let project_id: number | undefined;
    if (opts.project) project_id = upsertProject(db, { name: opts.project }).id;
    const claim = insertClaim(db, {
      statement: opts.text,
      created_by: opts.by,
      confidence: Number(opts.confidence),
      status: opts.status,
      evidence_uri: opts.evidence,
      project_id,
    });
    if (opts.json) process.stdout.write(`${JSON.stringify(claim)}\n`);
    else log.info(`claim #${claim.id} [${claim.status} ${claim.confidence}] by ${claim.created_by}`);
  });

ctx
  .command("search <query>")
  .description("FTS5 search over chunks (returns top-N ranked by BM25)")
  .option("--limit <n>", "max hits", "10")
  .option("--project <name>", "restrict to a project")
  .option("--source-type <t>", "restrict to a source type")
  .option("--json", "emit JSON result")
  .action(async (query: string, opts) => {
    const { openContextDb } = await import("./context/db.js");
    const { ensureContextSchema } = await import("./context/migrations.js");
    const { searchChunks, getProjectByName } = await import("./context/repository.js");
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    let project_id: number | undefined;
    if (opts.project) {
      const p = getProjectByName(db, opts.project);
      if (!p) { log.error(`unknown project: ${opts.project}`); process.exit(1); }
      project_id = p.id;
    }
    const hits = searchChunks(db, query, {
      limit: Number(opts.limit),
      project_id,
      source_type: opts.sourceType,
    });
    if (opts.json) process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
    else {
      if (hits.length === 0) log.info("(no hits)");
      for (const h of hits) {
        log.info(`[bm25=${h.bm25.toFixed(2)}] ${h.document_title ?? h.document_uri}  (chunk #${h.chunk_id})`);
        log.info(`  ${h.text.length > 200 ? `${h.text.slice(0, 200)}…` : h.text}`);
      }
    }
  });

ctx
  .command("list")
  .description("List recent rows from a table (debugging)")
  .argument("<table>", "projects|documents|claims|sessions_log")
  .option("--limit <n>", "max rows", "20")
  .option("--json", "emit JSON result")
  .action(async (table: string, opts) => {
    const { openContextDb } = await import("./context/db.js");
    const { ensureContextSchema } = await import("./context/migrations.js");
    const { listProjects, listDocuments, listClaims } = await import("./context/repository.js");
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const limit = Number(opts.limit);
    let rows: unknown[] = [];
    switch (table) {
      case "projects":     rows = listProjects(db); break;
      case "documents":    rows = listDocuments(db, { limit }); break;
      case "claims":       rows = listClaims(db, { limit }); break;
      case "sessions_log": rows = db.prepare("SELECT * FROM sessions_log ORDER BY started_at DESC LIMIT ?").all(limit); break;
      default:
        log.error(`unknown table: ${table} (use projects|documents|claims|sessions_log)`);
        process.exit(1);
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    else log.info(`${table} (${rows.length} rows): ${JSON.stringify(rows, null, 2)}`);
  });

ctx
  .command("extract-session")
  .description("Extract a session from its audit JSONL and write it to the memory spine. Useful for backfilling existing sessions or recovering after a fail-soft skip.")
  .option("--session <id>", "session id (reads ~/.patchwork-harness/events/<id>.jsonl)")
  .option("--file <path>", "explicit path to an audit JSONL")
  .option("--json", "emit JSON result")
  .action(async (opts) => {
    if (!opts.session && !opts.file) {
      log.error("--session <id> OR --file <path> required");
      process.exit(1);
    }
    const { openContextDb } = await import("./context/db.js");
    const { ensureContextSchema } = await import("./context/migrations.js");
    const { extractFromSession, extractFromFile } = await import("./context/extractor.js");
    const { writeExtractedSession } = await import("./context/session_writer.js");
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const extracted = opts.file
      ? extractFromFile(opts.file)
      : extractFromSession(opts.session);
    const result = writeExtractedSession(db, extracted);
    const out = { extracted_summary: extracted.summary, ...result };
    if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else {
      log.info(`session ${result.session_id} written (${result.files_touched} files, project_id=${result.project_id})`);
      log.info(`summary: ${extracted.summary}`);
    }
  });

ctx
  .command("export-csv")
  .description("Explicit CSV dump of all tables (NOT auto-mirror; runs only when called)")
  .option("--out <dir>", "output directory", `${process.env.HOME ?? ""}/.patchwork-harness/context/csv`)
  .option("--json", "emit JSON result")
  .action(async (opts) => {
    const { openContextDb } = await import("./context/db.js");
    const { ensureContextSchema } = await import("./context/migrations.js");
    const { exportCsv } = await import("./context/export_csv.js");
    const db = openContextDb({ fresh: true });
    ensureContextSchema(db);
    const result = exportCsv(db, opts.out);
    if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      log.info(`exported to ${result.out_dir}`);
      for (const f of result.files) log.info(`  ${f.table.padEnd(14)} ${f.rows} rows  ${f.bytes}b  ${f.path}`);
    }
  });

program
  .command("image [prompt]")
  .description(
    "Generate image(s) from a prompt with OpenAI's GPT Image 2 and save to disk. " +
    "If [prompt] is omitted or '-', reads from stdin.",
  )
  .option("-o, --out <path>", "output file (e.g. hero.png) or directory; defaults to ./images")
  .option("--size <size>", "1024x1024 | 1536x1024 | 1024x1536 | auto", "auto")
  .option("--quality <q>", "low | medium | high | auto", "auto")
  .option("--background <b>", "transparent | opaque | auto", "auto")
  .option("-n, --count <n>", "number of images (1-4)", "1")
  .option("--json", "emit one JSON object {model, files, usage}")
  .action(async (promptArg: string | undefined, opts) => {
    let prompt = promptArg;
    if (!prompt || prompt === "-") {
      prompt = await new Promise<string>((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (c) => { data += c; });
        process.stdin.on("end", () => resolve(data));
      });
      if (!prompt.trim()) {
        log.error("no prompt provided (give as arg or pipe via stdin)");
        process.exit(1);
      }
    }
    if (!process.env.OPENAI_API_KEY) {
      log.error("OPENAI_API_KEY not set — run: patchwork-harness keys set OPENAI_API_KEY sk-...");
      process.exit(1);
    }
    const { imageGenerateTool } = await import("./tools/image_generate.js");
    const input = imageGenerateTool.inputSchema.parse({
      prompt: prompt.trim(),
      out: opts.out,
      size: opts.size,
      quality: opts.quality,
      background: opts.background,
      n: Number(opts.count),
    });
    let result;
    try {
      result = await imageGenerateTool.run(input, { cwd: process.cwd(), sessionId: "cli-image" });
    } catch (e) {
      log.error(`image generation failed: ${(e as Error).message}`);
      process.exit(1);
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      for (const f of result.files) log.info(`saved ${f}`);
      if (result.usage) {
        log.cost(result.cost_usd ?? 0, {
          in: result.usage.input_tokens,
          out: result.usage.output_tokens,
        });
      }
    }
  });

// Bare `patchwork-harness` (no args) in a TTY boots the cockpit — wordmark, power-on
// self test rendered from the REAL boot() results, then the live panes
// (ADR-0012). Piped/scripted bare invocations still get help.
if (process.argv.length <= 2 && process.stdout.isTTY && process.stdin.isTTY) {
  const { startCockpit } = await import("./tui/cockpit.js");
  await startCockpit({});
} else {
  program.parseAsync(process.argv);
}
