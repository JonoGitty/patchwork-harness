/**
 * Interactive REPL for Patchwork Harness. Same ergonomics as `claude`:
 * type your goal at the prompt, the orchestrator plans + executes.
 * State (cwd, mode, budget, smart conductor toggles) is sticky across
 * prompts. Slash-commands change state without consuming the goal.
 */

import { createInterface } from "node:readline";
import chalk from "chalk";
import { boot } from "../boot.js";
import { loadBudgetConfig, monthSpendUsd } from "../core/budget.js";
import { oneShot } from "../core/orchestrator.js";
import { loadBuiltIns } from "../plugins/manager.js";
import { listKeys } from "../util/key_store.js";

export interface ReplTurn {
  goal: string;
  summary: string;
  sessionId: string;
  cost_usd: number;
  status: string;
}

export interface ReplState {
  cwd: string;
  mode: "budget" | "balanced" | "unlimited";
  budget: number | "auto";
  bedrock?: number;
  permission: "auto" | "default" | "cautious";
  worldView: boolean;
  lessons: boolean;
  critic: boolean;
  dryRun: boolean;
  /** Sliding window of recent turns for "now also do X" context. */
  history: ReplTurn[];
}

const HISTORY_KEEP = 5;

const COMMANDS = [
  "/help",
  "/exit",
  "/quit",
  "/cost",
  "/sessions",
  "/keys",
  "/history",
  "/clear",
  "/cwd",
  "/mode",
  "/budget",
  "/bedrock",
  "/permission",
  "/dry",
  "/no-world-view",
  "/no-lessons",
  "/no-critic",
];

export function header(state: ReplState): string {
  const cap = state.budget === "auto" ? "auto" : `$${state.budget.toFixed(2)}`;
  const bedrock = state.bedrock ? `$${state.bedrock}` : "default";
  const off: string[] = [];
  if (!state.worldView) off.push("no-world-view");
  if (!state.lessons) off.push("no-lessons");
  if (!state.critic) off.push("no-critic");
  const offStr = off.length ? ` · ${chalk.yellow(off.join(", "))}` : "";
  return chalk.dim(
    `${state.cwd} · ${state.mode} mode · ${cap}/session · bedrock ${bedrock} · ${state.permission}${offStr}${state.dryRun ? chalk.yellow(" · dry-run") : ""}`,
  );
}

function showHelp(): void {
  console.log(chalk.bold("\nCommands:"));
  console.log(`  ${chalk.cyan("/help")}             show this`);
  console.log(`  ${chalk.cyan("/exit, /quit")}     leave the REPL (also Ctrl-D)`);
  console.log(`  ${chalk.cyan("/cost")}            spend so far this month`);
  console.log(`  ${chalk.cyan("/sessions")}        recent sessions`);
  console.log(`  ${chalk.cyan("/keys")}            which provider keys are set`);
  console.log(`  ${chalk.cyan("/history")}         show this REPL's prior turns`);
  console.log(`  ${chalk.cyan("/clear")}           forget prior turns (start fresh)`);
  console.log(`  ${chalk.cyan("/cwd <path>")}      change working directory`);
  console.log(`  ${chalk.cyan("/mode <m>")}        budget | balanced | unlimited`);
  console.log(`  ${chalk.cyan("/budget <n|auto>")} set session budget for next prompt`);
  console.log(`  ${chalk.cyan("/bedrock <n>")}     set hard ceiling for next prompt`);
  console.log(`  ${chalk.cyan("/permission <m>")}  auto | default | cautious`);
  console.log(`  ${chalk.cyan("/dry")}             toggle dry-run (plan only, don't execute)`);
  console.log(`  ${chalk.cyan("/no-critic")}       toggle critic pass off/on`);
  console.log(`  ${chalk.cyan("/no-lessons")}      toggle lessons-from-history off/on`);
  console.log(`  ${chalk.cyan("/no-world-view")}   toggle project-awareness packet off/on`);
  console.log(`\nAnything not starting with ${chalk.cyan("/")} is treated as a goal.\n`);
}

function showKeys(): void {
  console.log();
  for (const k of listKeys()) {
    const tag = k.set ? chalk.green("✓") : chalk.red("✗");
    const preview = k.set ? chalk.dim(`(${k.preview})`) : chalk.dim("(not set)");
    console.log(`  ${tag} ${chalk.cyan(k.name.padEnd(22))} ${preview}`);
  }
  console.log(chalk.dim("\nSet with: patchwork-harness keys set <NAME> <value>"));
  console.log();
}

function showCost(): void {
  const cfg = loadBudgetConfig();
  const month = monthSpendUsd();
  const cap = cfg.defaults.monthly_cap_usd;
  const pct = cap > 0 ? Math.round((month / cap) * 100) : 0;
  console.log(
    `\n  ${chalk.bold(`$${month.toFixed(4)}`)} spent this month of ${chalk.dim(`$${cap.toFixed(2)} cap`)} (${pct}%)\n`,
  );
}

export function applySlash(line: string, state: ReplState): boolean {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ").trim();
  switch (cmd) {
    case "/help":
      showHelp();
      return true;
    case "/exit":
    case "/quit":
      console.log(chalk.dim("bye"));
      process.exit(0);
    case "/cost":
      showCost();
      return true;
    case "/sessions": {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { execSync } = require("node:child_process");
      try {
        console.log("\n" + execSync("patchwork-harness ls --limit 10", { encoding: "utf8" }) + "\n");
      } catch {
        console.log(chalk.yellow("(could not list sessions)"));
      }
      return true;
    }
    case "/keys":
      showKeys();
      return true;
    case "/history":
      if (state.history.length === 0) {
        console.log(chalk.dim("\n  no prior turns in this REPL\n"));
      } else {
        console.log();
        for (const [i, h] of state.history.entries()) {
          console.log(
            `  ${chalk.cyan(`#${i + 1}`)} ${chalk.dim(h.sessionId.slice(-12))} ${chalk.dim(`$${h.cost_usd.toFixed(4)} ${h.status}`)}`,
          );
          console.log(`     ${chalk.bold(h.goal.slice(0, 100))}`);
          if (h.summary) console.log(`     ${chalk.dim(h.summary.slice(0, 200))}`);
        }
        console.log();
      }
      return true;
    case "/clear":
      state.history = [];
      console.log(chalk.dim("  history cleared — next prompt starts fresh\n"));
      return true;
    case "/cwd":
      if (!arg) console.log(chalk.dim(`  cwd is ${state.cwd}`));
      else state.cwd = arg;
      return true;
    case "/mode":
      if (!["budget", "balanced", "unlimited"].includes(arg)) {
        console.log(chalk.yellow("  mode must be: budget | balanced | unlimited"));
        return true;
      }
      state.mode = arg as ReplState["mode"];
      return true;
    case "/budget":
      if (arg === "auto") state.budget = "auto";
      else {
        const n = Number(arg);
        if (!Number.isFinite(n) || n <= 0) {
          console.log(chalk.yellow("  budget must be a positive number or 'auto'"));
          return true;
        }
        state.budget = n;
      }
      return true;
    case "/bedrock": {
      const n = Number(arg);
      if (!Number.isFinite(n) || n <= 0) {
        console.log(chalk.yellow("  bedrock must be a positive number"));
        return true;
      }
      state.bedrock = n;
      return true;
    }
    case "/permission":
      if (!["auto", "default", "cautious"].includes(arg)) {
        console.log(chalk.yellow("  permission must be: auto | default | cautious"));
        return true;
      }
      state.permission = arg as ReplState["permission"];
      return true;
    case "/dry":
      state.dryRun = !state.dryRun;
      console.log(chalk.dim(`  dry-run ${state.dryRun ? "on" : "off"}`));
      return true;
    case "/no-critic":
      state.critic = !state.critic;
      console.log(chalk.dim(`  critic ${state.critic ? "on" : "off"}`));
      return true;
    case "/no-lessons":
      state.lessons = !state.lessons;
      console.log(chalk.dim(`  lessons ${state.lessons ? "on" : "off"}`));
      return true;
    case "/no-world-view":
      state.worldView = !state.worldView;
      console.log(chalk.dim(`  world view ${state.worldView ? "on" : "off"}`));
      return true;
    default:
      console.log(chalk.yellow(`  unknown command ${cmd}. /help for the list.`));
      return true;
  }
}

export interface ReplOpts {
  cwd?: string;
  mode?: ReplState["mode"];
  budget?: number | "auto";
  bedrock?: number;
  permission?: ReplState["permission"];
}

export function createReplState(opts: ReplOpts): ReplState {
  return {
    cwd: opts.cwd ?? process.cwd(),
    mode: opts.mode ?? "balanced",
    budget: opts.budget ?? 1.0,
    bedrock: opts.bedrock,
    permission: opts.permission ?? "auto",
    worldView: true,
    lessons: true,
    critic: true,
    dryRun: false,
    history: [],
  };
}

/**
 * Run one goal through the orchestrator with the REPL's sticky state and
 * conversation history — THE shared brain (ADR-0012). The classic REPL
 * and the cockpit both call this; neither forks the oneShot wiring.
 */
export async function runGoal(state: ReplState, goal: string): Promise<void> {
  const { state: sessionState } = await oneShot({
    goal,
    cwd: state.cwd,
    permission_mode: state.permission,
    budget_usd: state.budget,
    bedrock_usd: state.bedrock,
    budget_mode: state.mode,
    yes: true, // interactive use implies consent to the plan
    dryRun: state.dryRun,
    worldViewEnabled: state.worldView,
    lessonsEnabled: state.lessons,
    criticEnabled: state.critic,
    priorContext: renderHistoryContext(state.history),
  });
  pushHistory(state, sessionState, goal);
}

export async function startRepl(opts: ReplOpts): Promise<void> {
  const state: ReplState = createReplState(opts);

  // Boot once up front; any failure exits the process
  const r = await boot();
  if (!r.ok) {
    console.error(chalk.red("Boot failed:"));
    for (const c of r.checks.filter((c) => !c.ok)) {
      console.error(`  ${chalk.red("✖")} ${c.name}: ${c.detail}`);
      if (c.fix) console.error(`     ${chalk.yellow("→")} ${c.fix}`);
    }
    process.exit(1);
  }
  await loadBuiltIns(state.cwd);

  // Friendly banner
  console.log();
  console.log(chalk.bold.cyan("Patchwork Harness") + chalk.dim(" — interactive"));
  console.log(header(state));
  console.log(
    chalk.dim(
      `Type your goal. ${chalk.cyan("/help")} for commands. ${chalk.cyan("Ctrl-D")} to exit.`,
    ),
  );
  console.log();

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.cyan("› "),
    completer: (line: string) => {
      if (!line.startsWith("/")) return [[], line];
      const hits = COMMANDS.filter((c) => c.startsWith(line));
      return [hits, line];
    },
    historySize: 200,
  });

  rl.on("close", () => {
    console.log(chalk.dim("\nbye"));
    process.exit(0);
  });

  rl.prompt();

  // Use an async loop driven by 'line' events so we can await each goal
  rl.on("line", async (raw) => {
    const line = raw.trim();
    if (!line) {
      rl.prompt();
      return;
    }
    if (line.startsWith("/")) {
      applySlash(line, state);
      rl.prompt();
      return;
    }
    // Treat as a goal — pause readline until the orchestrator finishes
    rl.pause();
    try {
      await runGoal(state, line);
    } catch (e) {
      console.log(chalk.red(`✖ ${(e as Error).message}`));
    }
    console.log();
    console.log(header(state));
    rl.resume();
    rl.prompt();
  });
}

function renderHistoryContext(history: ReplTurn[]): string | undefined {
  if (history.length === 0) return undefined;
  const lines = ["## Prior turns in this REPL conversation"];
  lines.push("(The user is iterating — these are previous goals + outcomes in this session.)\n");
  for (const [i, h] of history.entries()) {
    lines.push(`### Turn ${i + 1} (${h.status}, $${h.cost_usd.toFixed(4)})`);
    lines.push(`**Goal:** ${h.goal}`);
    if (h.summary) lines.push(`**Outcome:** ${h.summary.slice(0, 600)}`);
    lines.push("");
  }
  return lines.join("\n");
}

function pushHistory(
  state: ReplState,
  sessionState: {
    id?: string;
    status?: string;
    total_cost_usd?: number;
    results?: Array<{ output_summary?: string }>;
  },
  goal: string,
): void {
  const lastSummary = (sessionState.results ?? [])
    .map((r) => r.output_summary ?? "")
    .filter(Boolean)
    .join(" • ")
    .slice(0, 800);
  state.history.push({
    goal,
    summary: lastSummary,
    sessionId: sessionState.id ?? "?",
    cost_usd: sessionState.total_cost_usd ?? 0,
    status: sessionState.status ?? "?",
  });
  if (state.history.length > HISTORY_KEEP) {
    state.history.splice(0, state.history.length - HISTORY_KEEP);
  }
}
