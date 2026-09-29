/**
 * Web dashboard. Single-process server on :4243 (configurable). Lists
 * sessions, shows a session timeline of Patchwork-shape events, and
 * follows live JSONL appends via Server-Sent Events.
 *
 * Run: patchwork-harness web   (defaults to port 4243)
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { EVENTS_DIR, PROJECT_ROOT, SESSIONS_DIR } from "../util/paths.js";
import { newSessionId } from "../util/ulid.js";
import { reloadEnvFiles } from "../util/env.js";
import { listKeys, setKey, unsetKey, KEY_NAMES } from "../util/key_store.js";

// stdin is piped so the dashboard can answer permission prompts and
// pause_for_human questions: one NDJSON line per answer.
type ChildWithPipedStdout = ChildProcessByStdio<Writable, Readable, Readable>;

interface JobState {
  jobId: string;
  child: ChildWithPipedStdout;
  /** Buffered output lines for clients that connect after spawn. */
  buffer: string[];
  /** Set of active SSE controllers — written to as new lines arrive. */
  listeners: Set<(line: string) => void>;
  /** Detected session id from the first session_start event in NDJSON output. */
  sessionId: string | null;
  exited: boolean;
  exitCode: number | null;
}

const jobs = new Map<string, JobState>();

export const app = new Hono(); // exported for route tests (app.request)

app.get("/", (c) => c.html(HTML_INDEX));

app.get("/api/budget/config", (c) => {
  // Lazy import to avoid hard dependency at startup
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadBudgetConfig, monthSpendUsd } = require("../core/budget.js");
  const cfg = loadBudgetConfig();
  return c.json({
    defaults: cfg.defaults,
    modes: Object.fromEntries(
      Object.entries(cfg.modes).map(([k, v]: [string, any]) => [k, { description: v.description }]),
    ),
    month_total_usd: monthSpendUsd(),
  });
});

/** GET /api/settings — everything the web UI needs to render Settings. */
app.get("/api/settings", (c) => {
  // Re-read ~/.patchwork-harness/.env so keys added externally (or via the UI) show up
  reloadEnvFiles();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadBudgetConfig, monthSpendUsd } = require("../core/budget.js");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadPolicy } = require("../config.js");
  const budget = loadBudgetConfig();
  const policy = loadPolicy();
  const keys = listKeys().map((k) => ({ name: k.name, set: k.set, preview: k.preview }));
  return c.json({
    budget: {
      defaults: budget.defaults,
      mode_descriptions: Object.fromEntries(
        Object.entries(budget.modes).map(([k, v]: [string, any]) => [k, v.description]),
      ),
      month_total_usd: monthSpendUsd(),
    },
    policy: {
      mode: policy.mode,
      sensitive_paths: policy.sensitive_paths,
      bash_allowlist_count: policy.bash_allowlist.length,
      bash_denylist_count: policy.bash_denylist.length,
      prompt_for: policy.prompt_for,
    },
    providers: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      gemini: !!(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY),
      xai: !!process.env.XAI_API_KEY,
    },
    keys,
  });
});

/** POST /api/keys — set or unset a provider API key. */
app.post("/api/keys", async (c) => {
  let body: { name?: string; value?: string; action?: "set" | "unset" };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const name = (body.name ?? "").toUpperCase();
  if (!name) return c.json({ error: "name required" }, 400);
  if (!(KEY_NAMES as readonly string[]).includes(name)) {
    return c.json({ error: `unknown key '${name}'. Allowed: ${KEY_NAMES.join(", ")}` }, 400);
  }
  if (body.action === "unset") {
    unsetKey(name);
    return c.json({ ok: true, name, action: "unset" });
  }
  const value = (body.value ?? "").trim();
  if (!value) return c.json({ error: "value required" }, 400);
  try {
    setKey(name, value);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  // Don't echo the value back over HTTP — clients should re-fetch via
  // GET /api/settings to render the masked preview.
  return c.json({ ok: true, name, action: "set" });
});

/** POST /api/budget/defaults — write changes to ~/.patchwork-harness/budget.yml. */
app.post("/api/budget/defaults", async (c) => {
  let body: {
    bedrock_usd?: number;
    session_usd?: number;
    mode?: string;
    monthly_cap_usd?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { loadBudgetConfig } = require("../core/budget.js");
  const cfg = loadBudgetConfig();
  const next = { ...cfg.defaults };
  if (typeof body.bedrock_usd === "number" && body.bedrock_usd > 0) next.bedrock_usd = body.bedrock_usd;
  if (typeof body.session_usd === "number" && body.session_usd > 0) next.session_usd = body.session_usd;
  if (body.mode && ["budget", "balanced", "unlimited"].includes(body.mode)) {
    next.mode = body.mode as "budget" | "balanced" | "unlimited";
  }
  if (typeof body.monthly_cap_usd === "number" && body.monthly_cap_usd > 0) {
    next.monthly_cap_usd = body.monthly_cap_usd;
  }
  // Bedrock must be >= session
  if (next.bedrock_usd < next.session_usd) {
    return c.json({ error: "bedrock_usd must be >= session_usd" }, 400);
  }
  // Write to ~/.patchwork-harness/budget.yml — preserve modes section by re-emitting full structure
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { dump } = require("js-yaml");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { writeFileSync, mkdirSync, existsSync: ex } = require("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pjoin } = require("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { HOME_HARNESS } = require("../util/paths.js");
  if (!ex(HOME_HARNESS)) mkdirSync(HOME_HARNESS, { recursive: true });
  const out = { defaults: next, modes: cfg.modes };
  writeFileSync(pjoin(HOME_HARNESS, "budget.yml"), dump(out));
  // Bust the in-memory cache so the next call sees the new values
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { invalidateBudgetCache } = require("../core/budget.js");
  invalidateBudgetCache();
  return c.json({ ok: true, defaults: next });
});

app.get("/api/sessions", (c) => {
  if (!existsSync(SESSIONS_DIR)) return c.json([]);
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const st = statSync(join(SESSIONS_DIR, f));
      try {
        const data = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf8"));
        return {
          id: f.replace(".json", ""),
          modified: st.mtime.toISOString(),
          goal: data.goal ?? "",
          status: data.ended_at ? "completed" : "in_progress",
          total_cost_usd: data.total_cost_usd ?? 0,
          step_count: (data.plan?.steps ?? []).length,
        };
      } catch {
        return {
          id: f.replace(".json", ""),
          modified: st.mtime.toISOString(),
          goal: "",
          status: "unknown",
          total_cost_usd: 0,
          step_count: 0,
        };
      }
    })
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, 100);
  return c.json(files);
});

app.get("/api/session/:id", (c) => {
  const id = c.req.param("id");
  const fp = join(SESSIONS_DIR, `${id}.json`);
  if (!existsSync(fp)) return c.json({ error: "not found" }, 404);
  return c.json(JSON.parse(readFileSync(fp, "utf8")));
});

app.get("/api/events/:id", (c) => {
  const id = c.req.param("id");
  const fp = join(EVENTS_DIR, `${id}.jsonl`);
  if (!existsSync(fp)) return c.json([]);
  const events = readFileSync(fp, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return c.json(events);
});

/**
 * POST /api/sessions/new — spawn patchwork-harness as a child process and return a
 * job_id. The child is run with --json so its stdout is NDJSON the
 * dashboard can render directly. Inputs are validated; reasonable
 * defaults applied. Always paired with --auto and --yes for non-
 * interactive UX.
 */
app.post("/api/sessions/new", async (c) => {
  let body: {
    goal?: string;
    budget_mode?: string;
    budget_usd?: string;
    bedrock_usd?: string | number;
    permission_mode?: string;
    use_world_view?: boolean;
    use_lessons?: boolean;
    use_critic?: boolean;
    /** When true the plan is NOT auto-approved — a "Run this plan?" card
     *  appears in the live tail and the run waits for the answer. */
    approve_plan?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const goal = (body.goal ?? "").trim();
  if (!goal) return c.json({ error: "goal required" }, 400);

  const budget_mode = ["budget", "balanced", "unlimited"].includes(body.budget_mode ?? "")
    ? body.budget_mode!
    : "balanced";
  const budget_usd = String(body.budget_usd ?? "1.0");
  const bedrock_usd = String(body.bedrock_usd ?? "");
  const permission_mode = ["auto", "default", "cautious"].includes(body.permission_mode ?? "")
    ? body.permission_mode!
    : "auto";

  const args = [
    join(PROJECT_ROOT, "bin/patchwork-harness.mjs"),
    goal,
    "--json",
    `--mode=${budget_mode}`,
    `--budget=${budget_usd}`,
  ];
  // Without approve_plan the plan auto-runs (the old always---yes behavior).
  if (!body.approve_plan) args.push("--yes");
  if (bedrock_usd) args.push(`--bedrock=${bedrock_usd}`);
  if (permission_mode === "auto") args.push("--auto");
  else if (permission_mode === "cautious") args.push("--cautious");
  if (body.use_world_view === false) args.push("--no-world-view");
  if (body.use_lessons === false) args.push("--no-lessons");
  if (body.use_critic === false) args.push("--no-critic");

  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const jobId = newSessionId();
  const state: JobState = {
    jobId,
    child,
    buffer: [],
    listeners: new Set(),
    sessionId: null,
    exited: false,
    exitCode: null,
  };
  jobs.set(jobId, state);

  const pushLine = (line: string): void => {
    state.buffer.push(line);
    if (state.buffer.length > 5000) state.buffer.splice(0, 1000); // cap
    for (const fn of state.listeners) fn(line);
    // Sniff session_id from the first session_start NDJSON event
    if (state.sessionId == null) {
      try {
        const evt = JSON.parse(line);
        if (evt && typeof evt.session_id === "string" && evt.session_id) {
          state.sessionId = evt.session_id;
        }
      } catch {
        /* not JSON, that's fine — could be stderr */
      }
    }
  };

  let stdoutBuf = "";
  child.stdout.on("data", (data) => {
    stdoutBuf += data.toString();
    let idx: number;
    // eslint-disable-next-line no-cond-assign
    while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, idx);
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) pushLine(line);
    }
  });
  child.stderr.on("data", (data) => {
    for (const line of data.toString().split("\n").filter(Boolean)) {
      pushLine(JSON.stringify({ type: "stderr", line }));
    }
  });
  child.on("exit", (code) => {
    state.exited = true;
    state.exitCode = code;
    pushLine(JSON.stringify({ type: "job_end", exit_code: code, session_id: state.sessionId }));
    // Hold the job state for 60s for late-arriving clients to drain
    setTimeout(() => jobs.delete(jobId), 60_000);
  });

  return c.json({ job_id: jobId });
});

/**
 * POST /api/jobs/:jobId/answer — the human side. Forwards an answer to a
 * waiting question (permission_required / human_pause / plan confirm) as
 * one NDJSON line on the child's stdin.
 */
app.post("/api/jobs/:jobId/answer", async (c) => {
  const jobId = c.req.param("jobId");
  const state = jobs.get(jobId);
  if (!state) return c.json({ error: "no such job" }, 404);
  if (state.exited) return c.json({ error: "job already ended" }, 409);
  let body: { id?: string; answer?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  const id = (body.id ?? "").trim();
  const answer = String(body.answer ?? "").trim();
  if (!id || !answer) return c.json({ error: "id and answer required" }, 400);
  try {
    state.child.stdin.write(JSON.stringify({ type: "human_answer", id, answer }) + "\n");
  } catch (e) {
    return c.json({ error: `stdin write failed: ${(e as Error).message}` }, 500);
  }
  return c.json({ ok: true });
});

/** SSE — child process stdout (NDJSON) + stderr lines for a launched job. */
app.get("/api/jobs/:jobId/stream", (c) => {
  const jobId = c.req.param("jobId");
  const state = jobs.get(jobId);
  if (!state) return c.json({ error: "no such job" }, 404);

  return c.newResponse(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (line: string) => {
          try {
            controller.enqueue(enc.encode(`data: ${line}\n\n`));
          } catch {
            /* closed */
          }
        };
        controller.enqueue(enc.encode(": connected\n\n"));
        // Replay buffered output
        for (const line of state.buffer) send(line);
        // Subscribe to new lines
        const listener = (line: string) => send(line);
        state.listeners.add(listener);
        if (state.exited) {
          // Already exited — close after the buffered drain
          setTimeout(() => {
            try {
              controller.close();
            } catch {
              /* */
            }
          }, 100);
        }
        c.req.raw.signal.addEventListener("abort", () => {
          state.listeners.delete(listener);
          try {
            controller.close();
          } catch {
            /* */
          }
        });
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
});

/** SSE stream of new events for a session as they're appended. */
app.get("/api/stream/:id", (c) => {
  const id = c.req.param("id");
  const fp = join(EVENTS_DIR, `${id}.jsonl`);

  // Shared tailer (ADR-0012): fs.watch + interval belt-and-braces, plus
  // waitForFile so a session whose events file has not been created yet
  // gets a real watcher the moment it appears (the old inline version only
  // ever polled in that case).
  return c.newResponse(
    new ReadableStream({
      async start(controller) {
        const enc = new TextEncoder();
        const send = (data: string) => {
          try {
            controller.enqueue(enc.encode(data));
          } catch {
            /* stream already closed */
          }
        };
        send(": connected\n\n");
        const { tailFile } = await import("../util/tailer.js");
        const tailer = tailFile(
          fp,
          (line) => {
            try {
              send(`data: ${JSON.stringify(JSON.parse(line))}\n\n`);
            } catch {
              /* skip malformed line */
            }
          },
          { tailLines: Number.POSITIVE_INFINITY, waitForFile: true },
        );
        const close = () => {
          tailer.close();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        c.req.raw.signal.addEventListener("abort", close);
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
});

export function startWeb(port: number): Promise<void> {
  return new Promise((res) => {
    // Loopback ONLY. The dashboard exposes API-key writes and budget edits;
    // do NOT serve to the LAN. Override via PATCHWORK_HARNESS_WEB_HOST=0.0.0.0 if you
    // really know what you're doing (and put auth in front).
    const hostname = process.env.PATCHWORK_HARNESS_WEB_HOST ?? "127.0.0.1";
    serve({ fetch: app.fetch, port, hostname }, (info) => {
      console.log(`Patchwork Harness dashboard: http://${hostname}:${info.port}`);
      res();
    });
  });
}


// ============== Live tests (ADR-0012) ==============
// One NDJSON feed (~/.patchwork-harness/tests/latest.jsonl, written by the vitest
// reporter) serves the wall, the exam board, --live and the cockpit.

let testChild: ReturnType<typeof spawn> | null = null;

app.get("/api/tests/latest", async (c) => {
  const { TESTS_DIR } = await import("../util/paths.js");
  const { parseTestLog, summarize } = await import("../testing/test_events.js");
  const fp = join(TESTS_DIR, "latest.jsonl");
  if (!existsSync(fp)) return c.json({ summary: null, runComplete: false, mtime: null });
  const raw = readFileSync(fp, "utf8");
  const { events, runComplete } = parseTestLog(raw.split("\n"));
  return c.json({
    summary: summarize(events),
    runComplete,
    mtime: statSync(fp).mtimeMs,
    running: Boolean(testChild),
  });
});

app.get("/api/tests/exam", async (c) => {
  const { TESTS_DIR, PROJECT_ROOT: root } = await import("../util/paths.js");
  const { parseTestLog } = await import("../testing/test_events.js");
  const { buildExamBoard, corpusCases } = await import("../verifier/exam_board.js");
  const fp = join(TESTS_DIR, "latest.jsonl");
  const raw = existsSync(fp) ? readFileSync(fp, "utf8") : "";
  const { events } = parseTestLog(raw.split("\n"));
  const corpus = corpusCases(join(root, "tests", "fixtures", "verifier-corpus"));
  return c.json(buildExamBoard(events, corpus));
});

app.get("/api/tests/stream", async (c) => {
  const { TESTS_DIR } = await import("../util/paths.js");
  const { tailFile } = await import("../util/tailer.js");
  const fp = join(TESTS_DIR, "latest.jsonl");
  return c.newResponse(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (data: string) => {
          try {
            controller.enqueue(enc.encode(data));
          } catch {
            /* closed */
          }
        };
        send(": connected\n\n");
        const tailer = tailFile(
          fp,
          (line) => send("data: " + line + "\n\n"),
          { tailLines: Number.POSITIVE_INFINITY, waitForFile: true },
        );
        const close = () => {
          tailer.close();
          try {
            controller.close();
          } catch {
            /* closed */
          }
        };
        c.req.raw.signal.addEventListener("abort", close);
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
});

app.post("/api/tests/run", async (c) => {
  if (testChild) return c.json({ error: "a test run is already in progress" }, 409);
  let body: { exam?: boolean; filter?: string };
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const filter = (body.filter ?? "").trim();
  if (filter && !/^[\w./ -]{1,200}$/.test(filter))
    return c.json({ error: "invalid filter" }, 400);
  const args = [join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs"), "run"];
  if (body.exam) args.push("tests/verifier-exam.test.ts");
  else if (filter) args.push(filter);
  const child = spawn(process.execPath, args, {
    cwd: PROJECT_ROOT,
    env: body.exam ? { ...process.env, PATCHWORK_HARNESS_VERIFIER_EXAM: "strict" } : { ...process.env },
    stdio: ["ignore", "ignore", "ignore"], // clients watch /api/tests/stream
  });
  testChild = child;
  child.on("exit", () => {
    testChild = null;
  });
  child.on("error", () => {
    testChild = null;
  });
  return c.json({ ok: true, exam: Boolean(body.exam) });
});

const HTML_INDEX = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Patchwork Harness</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root {
    --bg: #0e0f12; --fg: #e6e8eb; --muted: #8b919a; --line: #20232a;
    --accent: #7aa2f7; --good: #98c379; --bad: #e06c75; --warn: #e5c07b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-monospace,Menlo,monospace; background: var(--bg); color: var(--fg); }
  header { padding: 18px 24px; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; align-items: baseline; }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; }
  header .sub { color: var(--muted); font-size: 12px; }
  main { display: grid; grid-template-columns: 360px 1fr; min-height: calc(100vh - 60px); }
  aside { border-right: 1px solid var(--line); overflow-y: auto; padding: 8px; }
  .session { padding: 10px 12px; border-radius: 6px; cursor: pointer; margin-bottom: 4px; }
  .session:hover { background: #1a1d24; }
  .session.active { background: #1f2530; }
  .session .id { color: var(--muted); font-size: 11px; }
  .session .goal { margin-top: 4px; line-height: 1.4; }
  .session .meta { margin-top: 6px; color: var(--muted); font-size: 11px; }
  section { padding: 24px; overflow-y: auto; }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  h2 { margin: 0 0 8px 0; font-size: 14px; }
  .plan { background: #14171d; border: 1px solid var(--line); border-radius: 6px; padding: 12px; margin: 12px 0; }
  .step { display: grid; grid-template-columns: 30px 1fr 200px; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--line); }
  .step:last-child { border-bottom: none; }
  .step .num { color: var(--muted); }
  .step .model { color: var(--accent); font-size: 12px; }
  .events { margin-top: 12px; }
  .event { display: grid; grid-template-columns: 100px 180px 1fr; gap: 8px; padding: 4px 8px; border-bottom: 1px solid #14171d; font-size: 12px; align-items: start; }
  .diffbox { grid-column: 1 / -1; margin: 6px 0 8px 0; background: #0a0b0d; border: 1px solid var(--line); border-radius: 4px; overflow: hidden; }
  .diffhdr { font-size: 11px; color: var(--muted); padding: 4px 8px; background: #14171d; border-bottom: 1px solid var(--line); }
  .diffbox pre { margin: 0; padding: 8px 12px; font: 11px/1.45 ui-monospace, "SF Mono", Menlo, monospace; max-height: 360px; overflow-y: auto; white-space: pre; }
  .da { color: #98c379; display: block; }
  .dr { color: #e06c75; display: block; }
  .dh { color: #56b6c2; display: block; }
  .dc { color: var(--muted); display: block; }
  .tail .diffbox { margin: 8px 0; }
  .why { grid-column: 2 / -1; margin: 4px 0 4px 0; padding: 4px 8px; background: #14171d; border-left: 2px solid #56b6c2; color: var(--muted); font-size: 11px; line-height: 1.5; border-radius: 0 3px 3px 0; }
  .badge.cost { background: #1c1f26; color: #c8a165; font-variant-numeric: tabular-nums; }
  .event .ts { color: var(--muted); }
  .event .action { color: var(--accent); }
  .event.failed .action { color: var(--bad); }
  .event.denied .action { color: var(--warn); }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 10px; background: #20232a; color: var(--muted); margin-right: 6px; }
  .risk-high { color: var(--warn); }
  .risk-critical { color: var(--bad); }
  .btn { background: var(--accent); color: #0e0f12; border: none; padding: 6px 12px; border-radius: 4px; font: inherit; font-weight: 600; cursor: pointer; }
  .btn:hover { filter: brightness(1.1); }
  .btn-secondary { background: transparent; color: var(--muted); border: 1px solid var(--line); }
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none; align-items: center; justify-content: center; z-index: 100; }
  .modal-backdrop.open { display: flex; }
  .modal { background: #14171d; border: 1px solid var(--line); border-radius: 8px; padding: 24px; min-width: 480px; max-width: 640px; }
  .modal h2 { margin-top: 0; }
  .field { display: block; margin: 14px 0; }
  .field label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
  .field input, .field textarea, .field select { width: 100%; background: #0e0f12; color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 8px; font: inherit; }
  .field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .modal-actions { margin-top: 18px; display: flex; gap: 8px; justify-content: flex-end; }
  .tail { background: #0a0b0d; border: 1px solid var(--line); border-radius: 6px; padding: 12px; max-height: 70vh; overflow-y: auto; font-size: 12px; white-space: pre-wrap; line-height: 1.5; }
  .tail .stderr { color: var(--bad); }
  .tail .meta { color: var(--muted); }
  .tail .tok { color: var(--fg); }
  .tail .step { color: var(--accent); }
  .tail .end { color: var(--good); }
  .ask { background: #1b2130; border: 1px solid #2c3a55; border-left: 3px solid var(--warn); border-radius: 6px; padding: 10px 12px; margin: 8px 0; }
  .ask .askq { margin-bottom: 8px; white-space: pre-wrap; }
  .ask .askbtns { display: flex; gap: 8px; align-items: center; }
  .ask input { flex: 1; background: #0e0f12; color: var(--fg); border: 1px solid var(--line); border-radius: 4px; padding: 6px 8px; font: inherit; }
  .ask.resolved { opacity: .65; border-left-color: var(--good); }
  .hint { color: var(--muted); font-size: 13px; margin: -6px 0 14px 0; }
  .help { color: var(--muted); font-size: 11px; margin: 4px 0 0 0; line-height: 1.45; }
  .help code { background: #0e0f12; padding: 1px 4px; border-radius: 3px; }
  details.advanced { margin: 14px 0 0 0; border-top: 1px solid var(--line); padding-top: 14px; }
  details.advanced summary { cursor: pointer; color: var(--muted); user-select: none; padding: 4px 0; }
  details.advanced summary:hover { color: var(--fg); }
  fieldset.smart-conductor { border: 1px solid var(--line); border-radius: 4px; padding: 10px 12px; margin: 12px 0 4px 0; }
  fieldset.smart-conductor legend { padding: 0 6px; color: var(--muted); font-size: 12px; }
  label.check { display: flex; align-items: baseline; gap: 6px; margin: 6px 0; font-size: 13px; }
  label.check input { margin: 0; }
  label.check em { color: var(--muted); font-style: normal; font-size: 11px; }
  .settings-body { padding: 6px 0; }
  .settings-body .group { margin-bottom: 16px; }
  .settings-body .group h3 { font-size: 13px; margin: 0 0 6px 0; color: var(--accent); }
  .settings-body .row { display: grid; grid-template-columns: 200px 1fr; gap: 8px; padding: 4px 0; font-size: 13px; border-bottom: 1px dashed #14171d; }
  .settings-body .row .k { color: var(--muted); }
  .pill { display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px; }
  .pill.on { background: #1c3a1f; color: var(--good); }
  .pill.off { background: #3a1c1c; color: var(--bad); }

  /* ===== live tests view (ADR-0012) ===== */
  #testsView { display: none; padding: 24px; }
  #testsView.open { display: block; }
  body.tests-open main { display: none; }
  .tests-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; }
  .tests-status { color: var(--muted); font-size: 12px; }
  .tests-banner { padding: 10px 14px; border-radius: 6px; margin: 10px 0; font-weight: 600; display: none; }
  .tests-banner.warn { display: block; background: #3a3320; color: var(--warn); border: 1px solid var(--warn); }
  .tests-banner.bad { display: block; background: #3a2224; color: var(--bad); border: 1px solid var(--bad); }
  .exam-summary { display: flex; gap: 16px; align-items: center; margin: 8px 0 14px; }
  .exam-overall { font-weight: 700; padding: 4px 12px; border-radius: 6px; border: 1px solid var(--line); }
  .exam-overall.GREEN { color: var(--good); border-color: var(--good); }
  .exam-overall.NOT_GREEN { color: var(--bad); border-color: var(--bad); }
  .exam-overall.UNVERIFIABLE { color: var(--warn); border-color: var(--warn); }
  .exam-counts span { margin-right: 12px; font-size: 12px; }
  .exam-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; margin-bottom: 22px; }
  .exam-tile { border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font-size: 12px; }
  .exam-tile .st { float: right; font-weight: 700; }
  .exam-tile.PASS { border-color: var(--good); } .exam-tile.PASS .st { color: var(--good); }
  .exam-tile.FAIL { border-color: var(--bad); background: #2a1c1e; } .exam-tile.FAIL .st { color: var(--bad); }
  .exam-tile.SKIP .st, .exam-tile.MISSING .st { color: var(--warn); }
  .exam-tile.RUNNING .st { color: var(--accent); }
  .wall-file { margin-bottom: 10px; }
  .wall-file .fname { color: var(--muted); font-size: 11px; margin-bottom: 3px; }
  .wall-cells { display: flex; flex-wrap: wrap; gap: 3px; }
  .cell { width: 14px; height: 14px; border-radius: 3px; background: #2a2e37; }
  .cell.pass { background: var(--good); }
  .cell.fail { background: var(--bad); box-shadow: 0 0 6px var(--bad); }
  .cell.skip, .cell.todo { background: var(--warn); opacity: .6; }
  .cell.run { background: var(--accent); animation: pulse 1s infinite; }
  @keyframes pulse { 50% { opacity: .35; } }
  .wall-totals { margin: 12px 0; font-size: 13px; }
  .wall-totals b.p { color: var(--good); } .wall-totals b.f { color: var(--bad); } .wall-totals b.s { color: var(--warn); }
</style>
</head>
<body>
<header>
  <h1>Patchwork Harness</h1>
  <div style="display:flex;align-items:center;gap:14px">
    <div class="sub">Patchwork-audited. <span id="sessionCount">0</span> sessions</div>
    <button class="btn-secondary btn" id="testsBtn" title="Live test results">■ Tests</button>
    <button class="btn-secondary btn" id="settingsBtn" title="Settings">⚙ Settings</button>
    <button class="btn" id="newSessionBtn">+ New session</button>
  </div>
</header>

<div id="testsView">
  <div class="tests-toolbar">
    <button class="btn" id="runTestsBtn">Run tests</button>
    <button class="btn-secondary btn" id="runExamBtn">Run exam (strict)</button>
    <span class="tests-status" id="testsStatus">no run yet</span>
  </div>
  <div class="tests-banner" id="testsBanner"></div>
  <h2>Harness Verifier — exam</h2>
  <div class="exam-summary">
    <span class="exam-overall" id="examOverall">—</span>
    <span class="exam-counts" id="examCounts"></span>
  </div>
  <div class="exam-grid" id="examGrid"></div>
  <h2>Suite wall</h2>
  <div class="wall-totals" id="wallTotals"></div>
  <div id="wall"></div>
</div>

<!-- ============== New Session Modal ============== -->
<div class="modal-backdrop" id="newSessionModal">
  <div class="modal">
    <h2>New session</h2>
    <p class="hint">Tell the orchestrator what you want done. It will plan it, pick the right AI for each step, and run it. You can stop it any time.</p>

    <form id="newSessionForm">
      <div class="field">
        <label for="goal">What do you want to do?</label>
        <textarea id="goal" name="goal" rows="3" required placeholder="e.g. Add a CSV export endpoint to my Flask app at /reports/export"></textarea>
        <p class="help">Plain English. Be specific about files or behavior. The clearer the goal, the better the plan.</p>
      </div>

      <details class="advanced">
        <summary>Advanced settings</summary>

        <div class="field-row">
          <div class="field">
            <label for="mode">Spending strategy</label>
            <select id="mode" name="budget_mode">
              <option value="budget">budget — cheapest models, fewer steps</option>
              <option value="balanced" selected>balanced — best models for serious work (recommended)</option>
              <option value="unlimited">unlimited — best per step, only the bedrock caps you</option>
            </select>
            <p class="help">"Balanced" uses flagship models (Opus, GPT-5.5) for coding and cheaper ones for trivial bits. "Budget" sticks to cheap models throughout.</p>
          </div>
          <div class="field">
            <label for="permission_mode">Permission level</label>
            <select id="permission_mode" name="permission_mode">
              <option value="auto" selected>auto — run without asking (recommended)</option>
              <option value="default">default — ask for risky operations</option>
              <option value="cautious">cautious — ask for almost everything</option>
            </select>
            <p class="help">"Auto" lets the agent run without prompting. "Default" and "cautious" pause on risky operations — an Allow/Deny card appears right here in the live view.</p>
          </div>
        </div>

        <label class="check"><input type="checkbox" id="approvePlan"> <span>Ask me before running the plan</span> <em>— review the proposed steps here, then approve or reject</em></label>

        <div class="field-row">
          <div class="field">
            <label for="budget_usd">Spending target</label>
            <input id="budget_usd" name="budget_usd" type="text" value="1.0">
            <p class="help">In US dollars. Type a number (e.g. <code>0.50</code>) or <code>auto</code> to let the planner propose. The agent will try not to exceed this.</p>
          </div>
          <div class="field">
            <label for="bedrock_usd">Hard ceiling (bedrock)</label>
            <input id="bedrock_usd" name="bedrock_usd" type="number" min="0.01" step="0.5" placeholder="(uses config default)">
            <p class="help">Absolute maximum spend. The agent <strong>cannot</strong> cross this even if it tries. Default is your safety net.</p>
          </div>
        </div>

        <fieldset class="smart-conductor">
          <legend>Smart conductor (all on by default)</legend>
          <p class="help" style="margin-top:0">These layers make the planner smarter by giving it more context. Turn off only when debugging.</p>
          <label class="check"><input type="checkbox" id="useWorldView" checked> <span>Project awareness</span> <em>— give the planner your project memory + git context</em></label>
          <label class="check"><input type="checkbox" id="useLessons" checked> <span>Lessons from history</span> <em>— show similar past sessions and how they went</em></label>
          <label class="check"><input type="checkbox" id="useCritic" checked> <span>Critic pass</span> <em>— a second AI reviews the plan before running it</em></label>
        </fieldset>
      </details>

      <div class="modal-actions">
        <button type="button" class="btn btn-secondary" id="cancelBtn">Cancel</button>
        <button type="submit" class="btn" id="launchBtn">Launch</button>
      </div>
    </form>
  </div>
</div>

<!-- ============== Settings Modal ============== -->
<div class="modal-backdrop" id="settingsModal">
  <div class="modal" style="min-width: 600px; max-height: 85vh; overflow-y: auto">
    <h2>Settings</h2>
    <p class="hint">Most settings can be edited here. Permission rules (sensitive paths, bash allow/deny lists) live in <code>config/policy.yml</code> and need a manual edit + restart.</p>
    <div id="settingsBody" class="settings-body">Loading…</div>
    <div class="modal-actions">
      <button type="button" class="btn btn-secondary" id="settingsCloseBtn">Close</button>
    </div>
  </div>
</div>
<main>
  <aside id="sessions"></aside>
  <section id="detail"><div class="empty">Select a session to view details.</div></section>
</main>
<script>
let activeSession = null;
let eventStream = null;

async function loadSessions() {
  const res = await fetch('/api/sessions');
  const sessions = await res.json();
  document.getElementById('sessionCount').textContent = sessions.length;
  const aside = document.getElementById('sessions');
  aside.innerHTML = sessions.map(s => \`
    <div class="session" data-id="\${s.id}">
      <div class="id">\${s.id.slice(-12)}</div>
      <div class="goal">\${escapeHtml(s.goal).slice(0, 200)}</div>
      <div class="meta">\${s.status} • \${s.step_count} steps • $\${s.total_cost_usd.toFixed(4)} • \${new Date(s.modified).toLocaleString()}</div>
    </div>
  \`).join('');
  aside.querySelectorAll('.session').forEach(el => el.addEventListener('click', () => selectSession(el.dataset.id)));
}

async function selectSession(id) {
  activeSession = id;
  document.querySelectorAll('.session').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  if (eventStream) { eventStream.close(); eventStream = null; }
  const [sess, events] = await Promise.all([
    fetch('/api/session/' + id).then(r => r.json()),
    fetch('/api/events/' + id).then(r => r.json()),
  ]);
  renderDetail(sess, events);
  // Live-stream new events
  eventStream = new EventSource('/api/stream/' + id);
  eventStream.onmessage = (e) => {
    const evt = JSON.parse(e.data);
    appendEvent(evt);
  };
}

function renderDetail(sess, events) {
  const planHtml = (sess.plan?.steps ?? []).map((s, i) => \`
    <div class="step">
      <div class="num">\${i + 1}.</div>
      <div><strong>\${escapeHtml(s.title)}</strong><br><span style="color:var(--muted);font-size:12px">\${escapeHtml(s.reason)}</span></div>
      <div class="model">\${s.provider}/\${s.model}</div>
    </div>
  \`).join('');
  document.getElementById('detail').innerHTML = \`
    <h2>\${escapeHtml(sess.goal ?? '')}</h2>
    <div style="color:var(--muted);font-size:12px">\${sess.sessionId}</div>
    <div style="margin-top:8px">
      <span class="badge">permission: \${sess.permission_mode ?? sess.mode ?? 'default'}</span>
      <span class="badge">mode: \${sess.budget?.mode ?? '?'}</span>
      <span class="badge">cwd: \${escapeHtml(sess.cwd ?? '')}</span>
    </div>
    \${budgetBar(sess)}
    \${sess.plan ? '<div class="plan"><div style="color:var(--muted);margin-bottom:6px">' + escapeHtml(sess.plan.reasoning) + '</div>' + planHtml + '</div>' : ''}
    <h2 style="margin-top:18px">Audit timeline</h2>
    <div class="events" id="events">\${events.map(eventRow).join('')}</div>
  \`;
}

function appendEvent(evt) {
  const events = document.getElementById('events');
  if (events) events.insertAdjacentHTML('beforeend', eventRow(evt));
}

function budgetBar(sess) {
  const b = sess.budget ?? {};
  const spent = sess.total_cost_usd ?? 0;
  const cap = b.session_usd ?? 1;
  const bedrock = b.bedrock_usd ?? cap * 10;
  const sessionPct = Math.min(100, (spent / cap) * 100);
  const bedrockPct = Math.min(100, (spent / bedrock) * 100);
  const sessionColor = spent > cap ? '#e5c07b' : '#7aa2f7';
  return \`
    <div style="margin-top:14px">
      <div style="font-size:12px;color:var(--muted);margin-bottom:4px">
        Spent <strong>$\${spent.toFixed(4)}</strong> /
        session $\${cap.toFixed(2)} (mode \${b.mode ?? '?'}) /
        bedrock $\${bedrock.toFixed(2)}
      </div>
      <div style="background:#14171d;height:8px;border-radius:3px;overflow:hidden;margin-bottom:3px">
        <div style="background:\${sessionColor};height:100%;width:\${sessionPct}%"></div>
      </div>
      <div style="background:#14171d;height:4px;border-radius:2px;overflow:hidden">
        <div style="background:#e06c75;height:100%;width:\${bedrockPct}%"></div>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-top:3px">
        top: session target  •  bottom: bedrock (red = approaching hard ceiling)
      </div>
    </div>
  \`;
}

function eventRow(e) {
  const cls = ['event', e.status === 'failed' ? 'failed' : '', e.status === 'denied' ? 'denied' : ''].join(' ');
  const t = e.timestamp.slice(11, 23);
  const target = e.target ? Object.entries(e.target).map(([k,v]) => \`<span class="badge">\${k}=\${escapeHtml(String(v).slice(0, 40))}</span>\`).join('') : '';
  const riskCls = e.risk?.level === 'high' || e.risk?.level === 'critical' ? 'risk-' + e.risk.level : '';
  const diffBlock = renderInlineDiff(e);
  const reasonBlock = renderReason(e);
  const costBlock = renderCost(e);
  return \`<div class="\${cls}">
    <span class="ts">\${t}</span>
    <span class="action \${riskCls}">\${e.action} <span class="badge">\${e.risk?.level ?? 'none'}</span></span>
    <span>\${target}\${costBlock}</span>
    \${reasonBlock}
    \${diffBlock}
  </div>\`;
}

function renderReason(e) {
  // Surface the planner's routing rationale on step_start so users see WHY
  // a model was picked, not just which one. Same for plan_proposed.
  if (e.action !== 'step_start' && e.action !== 'plan_proposed') return '';
  const reason = e.provenance?.reason ?? e.provenance?.reasoning;
  if (!reason) return '';
  return '<div class="why">why: ' + escapeHtml(String(reason)) + '</div>';
}

function renderCost(e) {
  // Inline mini cost on provider_response so users see spend per turn.
  if (e.action !== 'provider_response') return '';
  const c = e.provenance?.cost_usd;
  if (typeof c !== 'number') return '';
  const tin = e.provenance?.tokens_in ?? 0;
  const tout = e.provenance?.tokens_out ?? 0;
  return \` <span class="badge cost">$\${c.toFixed(4)} • \${tin}↑/\${tout}↓ tok</span>\`;
}

function renderInlineDiff(e) {
  if (e.action !== 'tool_use_end') return '';
  const tool = e.target?.tool;
  if (tool !== 'write' && tool !== 'edit') return '';
  if (!e.content) return '';
  let body;
  try { body = JSON.parse(e.content); } catch { return ''; }
  if (!body || typeof body.diff !== 'string' || !body.diff) return '';
  return diffHtml(body.path, body.added ?? 0, body.removed ?? 0, body.diff);
}

function diffHtml(path, added, removed, diff) {
  const lines = diff.split('\\n').map(line => {
    if (line.startsWith('+++') || line.startsWith('---')) return '';
    if (line.startsWith('@@')) return '<span class="dh">' + escapeHtml(line) + '</span>';
    if (line.startsWith('+')) return '<span class="da">' + escapeHtml(line) + '</span>';
    if (line.startsWith('-')) return '<span class="dr">' + escapeHtml(line) + '</span>';
    return '<span class="dc">' + escapeHtml(line) + '</span>';
  }).filter(Boolean).join('\\n');
  const subtitle = '+' + added + ' −' + removed;
  return '<div class="diffbox"><div class="diffhdr">' + escapeHtml(path) + ' <span class="badge">' + subtitle + '</span></div><pre>' + lines + '</pre></div>';
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
}

// ---- New session modal ----
const modal = document.getElementById('newSessionModal');
document.getElementById('newSessionBtn').addEventListener('click', async () => {
  // Pre-fill bedrock default from /api/budget/config
  try {
    const cfg = await fetch('/api/budget/config').then(r => r.json());
    const bedrock = document.getElementById('bedrock_usd');
    if (bedrock && !bedrock.value) bedrock.placeholder = String(cfg.defaults?.bedrock_usd ?? '');
  } catch { /* ignore */ }
  modal.classList.add('open');
});
document.getElementById('cancelBtn').addEventListener('click', () => modal.classList.remove('open'));
modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

let liveJobStream = null;
let liveJobBuffer = [];
let liveJobSessionId = null;
let liveJobId = null;

document.getElementById('newSessionForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const launchBtn = document.getElementById('launchBtn');
  launchBtn.disabled = true;
  launchBtn.textContent = 'Launching…';

  const payload = {
    goal: document.getElementById('goal').value,
    budget_mode: document.getElementById('mode').value,
    budget_usd: document.getElementById('budget_usd').value,
    bedrock_usd: document.getElementById('bedrock_usd').value || undefined,
    permission_mode: document.getElementById('permission_mode').value,
    use_world_view: document.getElementById('useWorldView').checked,
    use_lessons: document.getElementById('useLessons').checked,
    use_critic: document.getElementById('useCritic').checked,
    approve_plan: document.getElementById('approvePlan').checked,
  };
  let job;
  try {
    job = await fetch('/api/sessions/new', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.json());
  } catch (err) {
    launchBtn.disabled = false;
    launchBtn.textContent = 'Launch';
    alert('Launch failed: ' + err.message);
    return;
  }
  if (!job.job_id) {
    launchBtn.disabled = false;
    launchBtn.textContent = 'Launch';
    alert('Launch failed: ' + (job.error ?? 'unknown'));
    return;
  }

  modal.classList.remove('open');
  launchBtn.disabled = false;
  launchBtn.textContent = 'Launch';
  document.getElementById('goal').value = '';

  // Switch detail pane to live tail
  liveJobBuffer = [];
  liveJobSessionId = null;
  liveJobId = job.job_id;
  document.getElementById('detail').innerHTML = \`
    <h2>Live: \${escapeHtml(payload.goal).slice(0, 200)}</h2>
    <div class="meta" id="liveStatus">job \${escapeHtml(job.job_id)} — connecting…</div>
    <div class="tail" id="liveTail" style="margin-top:12px"></div>
  \`;
  if (liveJobStream) liveJobStream.close();
  liveJobStream = new EventSource('/api/jobs/' + job.job_id + '/stream');
  liveJobStream.onmessage = (ev) => onJobLine(ev.data);
  liveJobStream.onerror = () => {
    const status = document.getElementById('liveStatus');
    if (status) status.textContent = 'stream closed';
  };
  // Keep the session list refreshing so the new session pops up when it lands
  setTimeout(loadSessions, 500);
  setTimeout(loadSessions, 2000);
});

// ---- Settings modal ----
const settingsModal = document.getElementById('settingsModal');
document.getElementById('settingsBtn').addEventListener('click', async () => {
  const body = document.getElementById('settingsBody');
  body.innerHTML = 'Loading…';
  settingsModal.classList.add('open');
  try {
    const s = await fetch('/api/settings').then(r => r.json());
    body.innerHTML = renderSettings(s);
  } catch (e) {
    body.innerHTML = '<div class="help">Failed to load: ' + escapeHtml(e.message) + '</div>';
  }
});
document.getElementById('settingsCloseBtn').addEventListener('click', () => settingsModal.classList.remove('open'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('open'); });

function pill(on) { return on ? '<span class="pill on">set</span>' : '<span class="pill off">not set</span>'; }
function row(k, v) { return '<div class="row"><div class="k">' + escapeHtml(k) + '</div><div>' + v + '</div></div>'; }

function renderSettings(s) {
  const b = s.budget?.defaults ?? {};
  const m = s.budget?.mode_descriptions ?? {};
  const p = s.policy ?? {};
  const keys = s.keys ?? [];

  const keyRows = keys.map(k => {
    const status = k.set
      ? '<span class="pill on">' + escapeHtml(k.preview) + '</span>'
      : '<span class="pill off">not set</span>';
    const action = k.set
      ? '<button class="btn btn-secondary btn-tiny" data-key-clear="' + escapeHtml(k.name) + '">Remove</button>'
      : '';
    return '<div class="key-row">' +
      '<div class="key-name">' + escapeHtml(k.name) + '</div>' +
      '<div class="key-status">' + status + '</div>' +
      '<div class="key-action">' + action + '</div>' +
    '</div>' +
    (!k.set ? '<div class="key-input-row"><input type="password" class="key-input" data-key-input="' + escapeHtml(k.name) + '" placeholder="paste key here" autocomplete="off"><button class="btn btn-tiny" data-key-set="' + escapeHtml(k.name) + '">Save</button></div>' : '');
  }).join('');

  return [
    '<div class="group"><h3>API keys</h3>',
    '<p class="help">Stored at <code>~/.patchwork-harness/.env</code> (mode 0600 — only you can read). Pasted values never leave your machine.</p>',
    '<div class="keys">', keyRows, '</div>',
    '</div>',

    '<div class="group"><h3>Spending defaults</h3>',
    '<p class="help">Defaults applied when no flag is given. Each session can override via <code>--budget</code> / <code>--bedrock</code> / <code>--mode</code> or the launch form.</p>',
    '<form id="budgetForm" class="budget-form">',
      '<div class="field-row">',
        '<div class="field"><label>Session budget ($)</label>',
          '<input type="number" name="session_usd" min="0.01" step="0.1" value="' + (b.session_usd ?? 1) + '">',
          '<p class="help">Soft target. The agent aims for this; mode controls overrun tolerance.</p>',
        '</div>',
        '<div class="field"><label>Bedrock — hard ceiling ($)</label>',
          '<input type="number" name="bedrock_usd" min="0.01" step="0.5" value="' + (b.bedrock_usd ?? 50) + '">',
          '<p class="help">The agent cannot cross this even if it tries.</p>',
        '</div>',
      '</div>',
      '<div class="field-row">',
        '<div class="field"><label>Default mode</label>',
          '<select name="mode">',
            '<option value="budget"' + (b.mode === 'budget' ? ' selected' : '') + '>budget</option>',
            '<option value="balanced"' + (b.mode === 'balanced' ? ' selected' : '') + '>balanced</option>',
            '<option value="unlimited"' + (b.mode === 'unlimited' ? ' selected' : '') + '>unlimited</option>',
          '</select>',
          '<p class="help">' + escapeHtml(m[b.mode] ?? '') + '</p>',
        '</div>',
        '<div class="field"><label>Monthly cap ($)</label>',
          '<input type="number" name="monthly_cap_usd" min="1" step="10" value="' + (b.monthly_cap_usd ?? 200) + '">',
          '<p class="help">If your aggregate spend this month hits this, new sessions are refused.</p>',
        '</div>',
      '</div>',
      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:8px">',
        '<div class="help">Spent this month: <strong>$' + (s.budget?.month_total_usd ?? 0).toFixed(4) + '</strong></div>',
        '<button type="submit" class="btn">Save spending defaults</button>',
      '</div>',
      '<div id="budgetSaveStatus" class="help" style="margin-top:6px"></div>',
    '</form>',
    '</div>',

    '<div class="group"><h3>Permissions <span class="hint" style="font-weight:normal">(read-only — edit <code>config/policy.yml</code>)</span></h3>',
    row('Safety mode', escapeHtml(p.mode ?? '?')),
    row('Sensitive paths protected', String((p.sensitive_paths ?? []).length) + ' patterns (e.g. *.env, id_rsa, .ssh/)'),
    row('Bash allowlist', String(p.bash_allowlist_count ?? 0) + ' commands'),
    row('Bash denylist', String(p.bash_denylist_count ?? 0) + ' commands'),
    row('Prompt before git push?', p.prompt_for?.push ? 'yes' : 'no'),
    row('Prompt before PR?', p.prompt_for?.pr ? 'yes' : 'no'),
    '</div>',
  ].join('');
}

async function reloadSettings() {
  const body = document.getElementById('settingsBody');
  if (!body) return;
  try {
    const s = await fetch('/api/settings').then(r => r.json());
    body.innerHTML = renderSettings(s);
    wireSettings();
  } catch (e) {
    body.innerHTML = '<div class="help">Failed to load: ' + escapeHtml(e.message) + '</div>';
  }
}

function wireSettings() {
  // Per-key Save buttons
  document.querySelectorAll('[data-key-set]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-key-set');
      const input = document.querySelector('[data-key-input="' + name + '"]');
      const value = input?.value?.trim();
      if (!value) { input?.focus(); return; }
      btn.disabled = true; btn.textContent = 'Saving…';
      try {
        const r = await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, value, action: 'set' }),
        }).then(r => r.json());
        if (r.error) { alert('Failed: ' + r.error); btn.disabled = false; btn.textContent = 'Save'; return; }
        await reloadSettings();
      } catch (e) {
        alert('Failed: ' + e.message);
        btn.disabled = false; btn.textContent = 'Save';
      }
    });
  });
  // Per-key Remove buttons
  document.querySelectorAll('[data-key-clear]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.getAttribute('data-key-clear');
      if (!confirm('Remove ' + name + '?')) return;
      btn.disabled = true;
      try {
        await fetch('/api/keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, action: 'unset' }),
        });
        await reloadSettings();
      } catch (e) {
        alert('Failed: ' + e.message);
        btn.disabled = false;
      }
    });
  });
  // Budget form
  const form = document.getElementById('budgetForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const status = document.getElementById('budgetSaveStatus');
      status.textContent = 'Saving…';
      const fd = new FormData(form);
      const payload = {
        session_usd: Number(fd.get('session_usd')),
        bedrock_usd: Number(fd.get('bedrock_usd')),
        mode: String(fd.get('mode')),
        monthly_cap_usd: Number(fd.get('monthly_cap_usd')),
      };
      try {
        const r = await fetch('/api/budget/defaults', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(r => r.json());
        if (r.error) { status.innerHTML = '<span style="color:var(--bad)">' + escapeHtml(r.error) + '</span>'; return; }
        status.innerHTML = '<span style="color:var(--good)">Saved to ~/.patchwork-harness/budget.yml</span>';
        setTimeout(() => { if (status) status.textContent = ''; }, 3000);
      } catch (e) {
        status.innerHTML = '<span style="color:var(--bad)">Failed: ' + escapeHtml(e.message) + '</span>';
      }
    });
  }
}

function onJobLine(rawLine) {
  const tail = document.getElementById('liveTail');
  if (!tail) return;
  let evt;
  try { evt = JSON.parse(rawLine); } catch { evt = null; }

  if (evt && evt.type === 'job_end') {
    const status = document.getElementById('liveStatus');
    if (status) status.textContent = 'job ended (exit ' + evt.exit_code + ')';
    if (evt.session_id) {
      // Auto-select the resulting session
      loadSessions().then(() => selectSession(evt.session_id));
    }
    return;
  }
  if (evt && evt.type === 'stderr') {
    tail.insertAdjacentHTML('beforeend', '<div class="stderr">' + escapeHtml(evt.line) + '</div>');
  } else if (evt && (evt.type === 'permission_required' || evt.type === 'human_pause')) {
    const d = evt.data ?? {};
    const qid = String(d.id ?? '');
    const q = escapeHtml(String(d.question ?? ''));
    let controls;
    if (evt.type === 'permission_required') {
      const yesLabel = d.kind === 'plan' ? 'Run plan' : d.kind === 'budget' ? 'Accept budget' : 'Allow';
      const noLabel = d.kind === 'plan' ? 'Reject' : d.kind === 'budget' ? 'Use fallback' : 'Deny';
      controls = '<button class="btn" data-answer="yes" data-ask-id="' + escapeHtml(qid) + '">' + yesLabel + '</button>'
               + '<button class="btn btn-secondary" data-answer="no" data-ask-id="' + escapeHtml(qid) + '">' + noLabel + '</button>';
    } else {
      controls = '<input type="text" data-ask-input="' + escapeHtml(qid) + '" placeholder="your answer (or: abort)">'
               + '<button class="btn" data-answer="__text__" data-ask-id="' + escapeHtml(qid) + '">Send</button>';
    }
    tail.insertAdjacentHTML('beforeend',
      '<div class="ask" data-ask="' + escapeHtml(qid) + '"><div class="askq">🖐 ' + q + '</div><div class="askbtns">' + controls + '</div></div>');
  } else if (evt && evt.type === 'human_answer') {
    const d = evt.data ?? {};
    const card = tail.querySelector('[data-ask="' + String(d.id ?? '') + '"]');
    if (card) {
      card.classList.add('resolved');
      const note = d.source === 'human'
        ? 'answered: ' + escapeHtml(String(d.answer ?? ''))
        : 'no answer (' + escapeHtml(String(d.source ?? 'unanswered')) + ') — default applied';
      card.querySelector('.askbtns').outerHTML = '<div class="meta">' + note + '</div>';
    }
  } else if (evt && evt.type === 'file_diff') {
    const d = evt.data ?? {};
    tail.insertAdjacentHTML('beforeend', diffHtml(d.path ?? '', d.added ?? 0, d.removed ?? 0, d.diff ?? ''));
  } else if (evt && evt.type === 'plan_ready') {
    const d = evt.data ?? {};
    const steps = (d.steps ?? []).map((s, i) =>
      '<div class="step">' + (i + 1) + '. ' + escapeHtml(s.title ?? '') +
      ' <span class="badge">' + escapeHtml((s.provider ?? '') + '/' + (s.model ?? '')) + '</span></div>'
    ).join('');
    tail.insertAdjacentHTML('beforeend',
      '<div class="meta">plan (est $' + Number(d.estimated_cost_usd ?? 0).toFixed(4) + '): ' +
      escapeHtml(String(d.reasoning ?? '')) + '</div>' + steps);
  } else if (evt && evt.type === 'step_start') {
    if (evt.session_id) liveJobSessionId = evt.session_id;
    const d = evt.data ?? {};
    const reason = d.reason ? '<div class="why">why: ' + escapeHtml(String(d.reason)) + '</div>' : '';
    tail.insertAdjacentHTML('beforeend', '<div class="step">▶ ' + escapeHtml(d.step ?? '') + ' <span class="badge">' + escapeHtml((d.provider ?? '') + '/' + (d.model ?? '')) + '</span></div>' + reason);
  } else if (evt && evt.type) {
    if (evt.type === 'session_start' && evt.session_id) liveJobSessionId = evt.session_id;
    const cls = evt.type === 'step_token' ? 'tok'
              : evt.type === 'session_end' ? 'end'
              : 'meta';
    const summary = evt.type === 'step_token'
      ? (evt.data?.text ?? '')
      : evt.type + ' ' + JSON.stringify(evt.data ?? {}).slice(0, 200);
    tail.insertAdjacentHTML('beforeend', '<span class="' + cls + '">' + escapeHtml(summary) + '</span>' + (evt.type === 'step_token' ? '' : '<br>'));
  } else {
    tail.insertAdjacentHTML('beforeend', '<div class="meta">' + escapeHtml(rawLine) + '</div>');
  }
  tail.scrollTop = tail.scrollHeight;
}

// The human side: answer buttons inside live-tail question cards.
// Delegated because cards stream in dynamically.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-answer]');
  if (!btn || !liveJobId) return;
  const id = btn.getAttribute('data-ask-id');
  let answer = btn.getAttribute('data-answer');
  if (answer === '__text__') {
    const input = document.querySelector('[data-ask-input="' + id + '"]');
    answer = (input && input.value ? input.value : '').trim();
    if (!answer) { if (input) input.focus(); return; }
  }
  btn.disabled = true;
  try {
    const r = await fetch('/api/jobs/' + liveJobId + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, answer }),
    }).then(r => r.json());
    if (r.error) { alert('Answer failed: ' + r.error); btn.disabled = false; }
    // Success: the child echoes a human_answer event which resolves the card.
  } catch (err) {
    alert('Answer failed: ' + err.message);
    btn.disabled = false;
  }
});

// Enter in a pause-card text input sends it.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest ? e.target.closest('[data-ask-input]') : null;
  if (!input) return;
  const id = input.getAttribute('data-ask-input');
  const btn = document.querySelector('[data-answer="__text__"][data-ask-id="' + id + '"]');
  if (btn) btn.click();
});

loadSessions();
setInterval(loadSessions, 5000);

// ===== live tests view (ADR-0012) =====
var testsStream = null, testsEvents = [], testsLastEventAt = 0, testsRunComplete = false;
function testsOpen() { return document.getElementById('testsView').classList.contains('open'); }
document.getElementById('testsBtn').addEventListener('click', function () {
  var v = document.getElementById('testsView');
  v.classList.toggle('open');
  document.body.classList.toggle('tests-open', v.classList.contains('open'));
  if (v.classList.contains('open')) startTestsStream();
});
function startTestsStream() {
  if (testsStream) return;
  testsEvents = [];
  testsStream = new EventSource('/api/tests/stream');
  testsStream.onmessage = function (m) {
    try { var e = JSON.parse(m.data); } catch (err) { return; }
    testsLastEventAt = Date.now();
    if (e.type === 'run_start') { testsEvents = []; testsRunComplete = false; }
    testsEvents.push(e);
    if (e.type === 'run_end') { testsRunComplete = true; refreshExam(); }
    renderTests();
  };
  refreshExam();
  setInterval(testsWatchdog, 3000);
}
function testsWatchdog() {
  if (!testsOpen()) return;
  var b = document.getElementById('testsBanner');
  if (testsEvents.length && !testsRunComplete && Date.now() - testsLastEventAt > 15000) {
    b.className = 'tests-banner bad';
    b.textContent = 'run did not complete — no events for 15s. Treating as NOT GREEN.';
  } else if (b.className.indexOf('bad') !== -1 && testsRunComplete) {
    b.className = 'tests-banner';
  }
}
function renderTests() {
  var byFile = {}, totals = { pass: 0, fail: 0, skip: 0, run: 0 };
  var runId = null, interrupted = false;
  for (var i = 0; i < testsEvents.length; i++) {
    var e = testsEvents[i];
    if (e.type === 'run_start') { byFile = {}; runId = e.run_id; }
    if (e.type === 'run_end') interrupted = e.interrupted;
    if (e.type !== 'task') continue;
    if (!byFile[e.file]) byFile[e.file] = {};
    byFile[e.file][e.name] = e;
  }
  var wall = '', files = Object.keys(byFile).sort();
  for (var fi = 0; fi < files.length; fi++) {
    var cells = '', names = Object.keys(byFile[files[fi]]);
    for (var ni = 0; ni < names.length; ni++) {
      var t = byFile[files[fi]][names[ni]];
      var st = t.state === 'todo' ? 'skip' : t.state;
      if (totals[st] !== undefined) totals[st]++;
      cells += '<span class="cell ' + st + '" title="' +
        (t.name + ' — ' + t.state + (t.error ? ': ' + t.error : '')).replace(/"/g, '&quot;') + '"></span>';
    }
    wall += '<div class="wall-file"><div class="fname">' + files[fi] + '</div><div class="wall-cells">' + cells + '</div></div>';
  }
  document.getElementById('wall').innerHTML = wall || '<div class="empty">no test events yet — hit Run tests</div>';
  document.getElementById('wallTotals').innerHTML =
    '<b class="p">' + totals.pass + ' pass</b> · <b class="f">' + totals.fail + ' fail</b> · ' +
    '<b class="s">' + totals.skip + ' skipped</b> · ' + totals.run + ' running';
  document.getElementById('testsStatus').textContent =
    (runId ? 'run ' + runId : 'no run yet') +
    (testsRunComplete ? (interrupted ? ' — INTERRUPTED' : ' — complete') : (testsEvents.length ? ' — live' : ''));
  var banner = document.getElementById('testsBanner');
  if (interrupted) { banner.className = 'tests-banner bad'; banner.textContent = 'run interrupted — NOT GREEN.'; }
}
function refreshExam() {
  fetch('/api/tests/exam').then(function (r) { return r.json(); }).then(function (b) {
    var overall = document.getElementById('examOverall');
    overall.textContent = b.overall.replace('_', ' ');
    overall.className = 'exam-overall ' + b.overall;
    document.getElementById('examCounts').innerHTML =
      '<span style="color:var(--good)">' + b.counts.pass + ' pass</span>' +
      '<span style="color:var(--bad)">' + b.counts.fail + ' fail</span>' +
      '<span style="color:var(--warn)">' + b.counts.skip + ' skip</span>' +
      '<span style="color:var(--warn)">' + b.counts.missing + ' missing</span>' +
      '<span>' + b.counts.running + ' running</span>';
    var grid = '';
    for (var i = 0; i < b.cases.length; i++) {
      var cse = b.cases[i];
      grid += '<div class="exam-tile ' + cse.state + '" title="' + (cse.title || '').replace(/"/g, '&quot;') + '">' +
        cse.id + '<span class="st">' + cse.state + '</span></div>';
    }
    document.getElementById('examGrid').innerHTML = grid;
  }).catch(function () { /* board endpoint unavailable */ });
}
function runTests(exam) {
  fetch('/api/tests/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exam: exam }),
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j.error) document.getElementById('testsStatus').textContent = j.error;
  });
}
document.getElementById('runTestsBtn').addEventListener('click', function () { runTests(false); });
document.getElementById('runExamBtn').addEventListener('click', function () { runTests(true); });
</script>
</body>
</html>`;
