/**
 * patchwork-harness as an MCP SERVER (ADR-0014; DIRECTION Next-10 item 11) so Claude
 * Code - including Remote Control sessions, which run locally with the
 * user's MCP servers - can drive patchwork-harness with typed tools instead of shell
 * strings. The MCP CLIENT stays on the do-not list; this is the other side.
 *
 * Hand-rolled JSON-RPC 2.0 over newline-delimited stdio (zero new deps,
 * like the cockpit). Every tool shells out to this same CLI, so behaviour,
 * audit and gates are identical to the terminal.
 *
 * Safety:
 *   - read-only tools run freely
 *   - tools that spend money or execute (run, a live review) need
 *     `confirm: true` and carry a budget cap
 *   - runs go to the background with stdin CLOSED: any permission question
 *     resolves to its safe default (deny) at once - nothing is approved
 *     behind the user's back, nothing hangs
 * stdout carries protocol frames only; diagnostics go to stderr.
 */
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stripAnsi } from "../tui/ansi.js";
import { HOME_HARNESS, PROJECT_ROOT } from "../util/paths.js";

const BIN = join(PROJECT_ROOT, "bin", "patchwork-harness.mjs");
const RUNS_DIR = join(HOME_HARNESS, "mcp-runs");
const INDEX = join(RUNS_DIR, "index.json");
const MAX_OUT = 60_000;
const MAX_RUN_BUDGET = 5;

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  call: (args: Json) => Promise<string>;
}

const clip = (s: string) =>
  s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… [${s.length - MAX_OUT} chars clipped]` : s;

class ToolError extends Error {}

/** Run this CLI to completion; resolve with exit code + cleaned output. */
export function cli(args: string[], timeoutMs = 300_000): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out: clip(stripAnsi(out)).trim() });
    });
  });
}

const text = (r: { code: number; out: string }) => `exit ${r.code}\n${r.out}`;
const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new ToolError(`\`${name}\` is required`);
  return v;
};
const flag = (on: unknown, f: string) => (on === true ? [f] : []);

function loadIndex(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(INDEX, "utf8"));
  } catch {
    return {};
  }
}

/** Start a run in the background; wait (briefly) for its session id. */
async function startRun(args: Json): Promise<string> {
  if (args.confirm !== true)
    throw new ToolError(
      "harness_run spends money and executes tools: call it again with confirm: true once the user has agreed (use harness_plan first to show them the plan)",
    );
  const goal = str(args.goal, "goal");
  const cwd = str(args.cwd, "cwd");
  const budget = typeof args.budget_usd === "number" ? args.budget_usd : 0.5;
  if (!(budget > 0 && budget <= MAX_RUN_BUDGET))
    throw new ToolError(`budget_usd must be between 0 and ${MAX_RUN_BUDGET}`);
  mkdirSync(RUNS_DIR, { recursive: true });
  const log = join(RUNS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`);
  const fd = openSync(log, "a");
  const cmd = ["run", goal, "-u", "--cwd", cwd, "--budget", String(budget)];
  if (typeof args.mode === "string") cmd.push("--mode", args.mode);
  if (args.verify !== false) cmd.push("--verify");
  if (typeof args.verify_cmd === "string" && args.verify_cmd.trim())
    cmd.push("--verify-cmd", args.verify_cmd);
  if (typeof args.attempts === "number") cmd.push("--attempts", String(args.attempts));
  if (args.checkpoint === true) cmd.push("--checkpoint");
  if (args.guard_loop === true) cmd.push("--guard-loop");
  if (typeof args.time_budget_s === "number") cmd.push("--time-budget", String(args.time_budget_s));
  if (args.review === true) cmd.push("--review");
  else if (typeof args.review === "string" && args.review.trim()) cmd.push("--review", args.review);
  if (args.review_strict === true) cmd.push("--review-strict");
  if (args.review_fix === true) cmd.push("--review-fix");
  const child = spawn(process.execPath, [BIN, ...cmd], {
    stdio: ["ignore", fd, fd],
    env: process.env,
    detached: true,
    windowsHide: true,
  });
  child.unref();
  closeSync(fd);
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const m = /"session_id":"([^"]+)"/.exec(readFileSync(log, "utf8"));
    if (m?.[1]) {
      const idx = loadIndex();
      idx[m[1]] = log;
      writeFileSync(INDEX, JSON.stringify(idx, null, 2));
      return `started session ${m[1]} (budget $${budget}, pid ${child.pid})\nlog: ${log}\nPoll with harness_run_status { "session_id": "${m[1]}" }.`;
    }
  }
  return `started (pid ${child.pid}) but no session id after 30s - see ${log}`;
}

/** Summarise a background run from its NDJSON log. */
export function summariseRun(ndjson: string): string {
  const events: Array<{ type: string; data?: Json }> = [];
  for (const line of ndjson.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* partial line while the run writes */
    }
  }
  const end = events.find((e) => e.type === "session_end");
  const steps = events.filter((e) => e.type === "step_end");
  const lines = [
    `status: ${end ? String(end.data?.status ?? "ended") : "running"}`,
    `steps finished: ${steps.length}`,
  ];
  for (const s of steps)
    lines.push(`  - ${String(s.data?.title ?? "step")}: ${String(s.data?.status ?? "")}`);
  const asks = events.filter((e) => e.type === "permission_required" || e.type === "human_pause");
  if (asks.length)
    lines.push(`questions raised (answered with safe defaults, stdin closed): ${asks.length}`);
  if (end) lines.push(`end: ${JSON.stringify(end.data).slice(0, 2000)}`);
  const err = events.filter((e) => e.type === "error");
  if (err.length) lines.push(`errors: ${JSON.stringify(err.map((e) => e.data)).slice(0, 2000)}`);
  return lines.join("\n");
}

export const TOOLS: Tool[] = [
  {
    name: "harness_status",
    description:
      "Preflight: Patchwork, config, provider keys, and which classifier (Jev/Kev) is configured. Read-only.",
    inputSchema: { type: "object", properties: {} },
    call: async () => text(await cli(["doctor"])),
  },
  {
    name: "harness_models",
    description:
      "The model catalog with prices, roles (planner/executor/critic/reviewers) and live reachability. Read-only.",
    inputSchema: { type: "object", properties: {} },
    call: async () => text(await cli(["models"])),
  },
  {
    name: "harness_plan",
    description:
      "Plan a goal WITHOUT executing it (L1 world view, L2 lessons, planner, L3 critic). Costs a few cents of planner tokens. Show this to the user before harness_run.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        cwd: { type: "string", description: "Working directory (Windows path)" },
        budget_usd: { type: "number" },
        mode: { type: "string", enum: ["budget", "balanced", "unlimited"] },
      },
      required: ["goal"],
    },
    call: async (a) => {
      const cmd = ["run", str(a.goal, "goal"), "--dry-run", "-y"];
      if (typeof a.cwd === "string") cmd.push("--cwd", a.cwd);
      if (typeof a.budget_usd === "number") cmd.push("--budget", String(a.budget_usd));
      if (typeof a.mode === "string") cmd.push("--mode", a.mode);
      return text(await cli(cmd, 180_000));
    },
  },
  {
    name: "harness_run",
    description: `Execute a goal in the background (plan + tool loop + L4.5 verify). SPENDS MONEY and EXECUTES TOOLS in cwd: requires confirm: true and a budget (default $0.50, max $${MAX_RUN_BUDGET}). Unattended: permission questions are answered with safe defaults (deny). Returns a session id for harness_run_status.`,
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string" },
        cwd: { type: "string", description: "Working directory (Windows path)" },
        budget_usd: { type: "number" },
        mode: { type: "string", enum: ["budget", "balanced", "unlimited"] },
        verify: { type: "boolean", description: "Run the L4.5 verifier at the end (default true)" },
        verify_cmd: {
          type: "string",
          description: 'ADR-0015 test gate, e.g. "npm test": the run fails unless it exits 0',
        },
        attempts: {
          type: "number",
          description: "Repair loop: re-verify up to n attempts on a failed verify_cmd (max 10)",
        },
        checkpoint: {
          type: "boolean",
          description: "git snapshot before every step; undo with harness_rewind",
        },
        guard_loop: {
          type: "boolean",
          description: "Nudge the model when it repeats an identical tool call 3+ times",
        },
        time_budget_s: { type: "number", description: "Wall-clock budget for the run" },
        review: {
          description:
            "L5 reviewer: true, or a model id - a different vendor reviews the work read-only (ADR-0016)",
        },
        review_strict: {
          type: "boolean",
          description: "Fail the run unless the L5 verdict is COMPLETE",
        },
        review_fix: {
          type: "boolean",
          description:
            "On an INCOMPLETE L5 verdict: one repair from its concerns, then re-gate and re-review",
        },
        confirm: {
          type: "boolean",
          description: "Must be true: the user agreed to spend and execute",
        },
      },
      required: ["goal", "cwd", "confirm"],
    },
    call: startRun,
  },
  {
    name: "harness_run_status",
    description: "Progress / result of a background run started with harness_run. Read-only.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
    call: async (a) => {
      const id = str(a.session_id, "session_id");
      const log = loadIndex()[id];
      if (!log || !existsSync(log)) return text(await cli(["show", id]));
      return summariseRun(readFileSync(log, "utf8"));
    },
  },
  {
    name: "harness_sessions",
    description: "Recent patchwork-harness sessions. Read-only.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
    call: async (a) =>
      text(await cli(["ls", "-n", String(typeof a.limit === "number" ? a.limit : 10)])),
  },
  {
    name: "harness_show",
    description: "Full detail of one patchwork-harness session (plan, steps, costs). Read-only.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
    call: async (a) => text(await cli(["show", str(a.session_id, "session_id")])),
  },
  {
    name: "harness_verify_claude",
    description:
      "L4.5 grounding audit of a Claude Code session's final answer against its own tool outputs (newest session if none given - which may be the caller itself). classify: also triage MISSED atoms with the configured decision model (routes only, never green). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session id prefix" },
        classify: { type: "boolean" },
        json: { type: "boolean" },
      },
    },
    call: async (a) =>
      text(
        await cli([
          "verify",
          "claude",
          ...(typeof a.session === "string" ? [a.session] : []),
          ...flag(a.classify, "--classify"),
          ...flag(a.json, "--json"),
        ]),
      ),
  },
  {
    name: "harness_verify_session",
    description:
      "L4.5 grounding audit of an patchwork-harness session against its own audit trail; classify adds decision-model triage. Read-only.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, classify: { type: "boolean" } },
      required: ["session_id"],
    },
    call: async (a) =>
      text(
        await cli([
          "verify",
          "session",
          str(a.session_id, "session_id"),
          ...flag(a.classify, "--classify"),
        ]),
      ),
  },
  {
    name: "harness_verify_file",
    description:
      "L4.5 check of a corpus-shaped JSON file ({answer, evidence}); classify adds triage. Read-only.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, classify: { type: "boolean" } },
      required: ["path"],
    },
    call: async (a) =>
      text(await cli(["verify", "file", str(a.path, "path"), ...flag(a.classify, "--classify")])),
  },
  {
    name: "harness_review",
    description:
      "Cross-vendor adversarial review of files (2-3 reasoning-tier reviewers, merged, always L4.5-verified). Dry run (plan + estimate) unless confirm: true, which SPENDS roughly $0.40.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" } },
        diff: { type: "boolean", description: "Review the working-tree diff instead of paths" },
        confirm: { type: "boolean" },
      },
    },
    call: async (a) => {
      const paths = Array.isArray(a.paths) ? a.paths.map(String) : [];
      if (!paths.length && a.diff !== true) throw new ToolError("give `paths` or diff: true");
      const cmd = ["review", ...paths, ...flag(a.diff, "--diff")];
      if (a.confirm !== true) cmd.push("--dry-run");
      return text(await cli(cmd, 900_000));
    },
  },
  {
    name: "harness_ask",
    description:
      "One call to one provider/model - no planner, no tools. Cheap. search: Gemini grounded web search with cited sources.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        provider: {
          type: "string",
          enum: ["anthropic", "openai", "gemini", "xai", "perplexity", "local"],
        },
        model: { type: "string" },
        search: { type: "boolean" },
      },
      required: ["prompt"],
    },
    call: async (a) => {
      const cmd = ["ask", str(a.prompt, "prompt")];
      if (typeof a.provider === "string") cmd.push("-p", a.provider);
      if (typeof a.model === "string") cmd.push("-m", a.model);
      if (a.search === true) cmd.push("--search");
      return text(await cli(cmd, 300_000));
    },
  },
  {
    name: "harness_checkpoints",
    description: "List the --checkpoint snapshots a run left in a repo. Read-only.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" }, cwd: { type: "string" } },
      required: ["session_id", "cwd"],
    },
    call: async (a) =>
      text(await cli(["rewind", str(a.session_id, "session_id"), "--cwd", str(a.cwd, "cwd")])),
  },
  {
    name: "harness_rewind",
    description:
      "Restore a repo's working tree to a checkpoint (the current state is snapshotted first, so it is undoable). OVERWRITES FILES: requires confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        cwd: { type: "string" },
        to: { type: "string", description: "Checkpoint label, e.g. step-2" },
        confirm: { type: "boolean" },
      },
      required: ["session_id", "cwd", "to", "confirm"],
    },
    call: async (a) => {
      if (a.confirm !== true)
        throw new ToolError(
          "harness_rewind overwrites files: call it again with confirm: true once the user has agreed",
        );
      return text(
        await cli([
          "rewind",
          str(a.session_id, "session_id"),
          "--cwd",
          str(a.cwd, "cwd"),
          "--to",
          str(a.to, "to"),
          "-y",
        ]),
      );
    },
  },
  {
    name: "harness_eval",
    description:
      "Run an eval suite (ADR-0017): every task under each config in a fresh repo, scored by a hidden check. SPENDS MONEY (worst case = task budgets x configs x trials, capped by max_usd): requires confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        suite: { type: "string", description: "Suite name under evals/ (e.g. starter) or a path" },
        configs: {
          type: "string",
          description: "Comma-separated presets, e.g. baseline,gate,gate+review",
        },
        trials: { type: "number" },
        max_usd: { type: "number" },
        confirm: { type: "boolean" },
      },
      required: ["suite", "confirm"],
    },
    call: async (a) => {
      if (a.confirm !== true)
        throw new ToolError(
          "harness_eval spends money: call again with confirm: true once the user agrees",
        );
      const cmd = ["eval", "run", str(a.suite, "suite")];
      if (typeof a.configs === "string") cmd.push("--configs", a.configs);
      if (typeof a.trials === "number") cmd.push("--trials", String(a.trials));
      if (typeof a.max_usd === "number") cmd.push("--max-usd", String(a.max_usd));
      return text(await cli(cmd, 3_600_000));
    },
  },
  {
    name: "harness_exam",
    description: "Run the L4.5 verifier exam; GREEN only when every corpus case passes. Read-only.",
    inputSchema: { type: "object", properties: {} },
    call: async () => text(await cli(["verify", "exam"], 600_000)),
  },
];

const PROTOCOL = "2025-06-18";

export async function handle(msg: Json): Promise<Json | null> {
  const id = msg.id as string | number | undefined;
  const method = String(msg.method ?? "");
  const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  if (id === undefined) return null; // notification (e.g. notifications/initialized)
  switch (method) {
    case "initialize": {
      const asked = (msg.params as Json | undefined)?.protocolVersion;
      return reply({
        protocolVersion: typeof asked === "string" ? asked : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "patchwork-harness", version: "0.3.0" },
        instructions:
          "patchwork-harness is a Patchwork-audited multi-LLM coding harness. Plan with harness_plan and show the user before harness_run (which needs confirm: true and spends money). Use harness_verify_claude to audit a Claude session's answer against its tool outputs.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const p = (msg.params ?? {}) as { name?: string; arguments?: Json };
      const tool = TOOLS.find((t) => t.name === p.name);
      if (!tool) return fail(-32602, `unknown tool ${p.name}`);
      try {
        return reply({ content: [{ type: "text", text: await tool.call(p.arguments ?? {}) }] });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply({ content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return fail(-32601, `method not found: ${method}`);
  }
}

export function serve(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`,
      );
      return;
    }
    void handle(msg).then((res) => {
      if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    });
  });
  rl.on("close", () => process.exit(0));
  process.stderr.write("patchwork-harness MCP server ready (stdio)\n");
}
