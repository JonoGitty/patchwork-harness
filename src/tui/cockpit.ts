/**
 * The cockpit (ADR-0012): full-screen live panes over the estate's own
 * feeds — sessions, budget, audit events, test wall, verifier verdicts —
 * with the classic REPL's brain embedded at the bottom.
 *
 * Zero deps, raw ANSI, row-diff repaint. Non-TTY callers never get here
 * (cli falls back to the classic repl).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { boot } from "../boot.js";
import {
  type ReplOpts,
  type ReplState,
  applySlash,
  createReplState,
  runGoal,
} from "../cli/repl.js";
import { loadBudgetConfig, monthSpendUsd } from "../core/budget.js";
import { loadBuiltIns } from "../plugins/manager.js";
import { type WallSummary, parseTestLog, summarize } from "../testing/test_events.js";
import { EVENTS_DIR, PROJECT_ROOT, SESSIONS_DIR, TESTS_DIR } from "../util/paths.js";
import { type Tailer, tailFile } from "../util/tailer.js";
import { type ExamBoard, buildExamBoard, corpusCases } from "../verifier/exam_board.js";
import { FG, paint, stripAnsi } from "./ansi.js";
import { playBoot } from "./boot.js";
import { computeLayout } from "./layout.js";
import { LineEditor } from "./line_editor.js";
import {
  type SessionRow,
  renderBudget,
  renderEvents,
  renderPrompt,
  renderSessions,
  renderTestStrip,
  renderVerdicts,
} from "./panes.js";
import { Screen } from "./screen.js";

type Focus = "sessions" | "events" | "tests" | "verdicts";
const FOCI: Focus[] = ["sessions", "events", "tests", "verdicts"];

interface CockpitState {
  sessions: SessionRow[];
  selected: number;
  eventLines: string[];
  eventSession: string | null;
  testLines: string[];
  wall: WallSummary | null;
  board: ExamBoard | null;
  budget: { month: number; cap: number | null } | null;
  focus: Focus;
  mode: "nav" | "prompt" | "running";
  status: string;
}

function scanSessions(): SessionRow[] {
  try {
    return readdirSync(SESSIONS_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const p = join(SESSIONS_DIR, f);
        const m = statSync(p).mtimeMs;
        try {
          const d = JSON.parse(readFileSync(p, "utf8"));
          return {
            id: f.replace(/\.json$/, ""),
            goal: String(d.goal ?? ""),
            status: d.ended_at ? (d.status === "failed" ? "failed" : "completed") : "in_progress",
            cost: Number(d.total_cost_usd ?? 0),
            m,
          };
        } catch {
          return { id: f.replace(/\.json$/, ""), goal: "", status: "unknown", cost: 0, m };
        }
      })
      .sort((a, b) => b.m - a.m)
      .slice(0, 50)
      .map(({ m: _m, ...r }) => r);
  } catch {
    return [];
  }
}

function eventToLine(raw: string): string {
  try {
    const e = JSON.parse(raw);
    const t = String(e.timestamp ?? "").slice(11, 19);
    const act = String(e.action ?? "?");
    const tool = e.target?.tool ? ` ${e.target.tool}` : "";
    const st = e.status ? ` ${e.status}` : "";
    const col =
      e.status === "failed" || e.status === "denied"
        ? FG.red
        : act === "session_end"
          ? FG.amber
          : FG.dim;
    return `${paint(FG.dim, t)} ${paint(col, act + tool + st)}`;
  } catch {
    return stripAnsi(raw).slice(0, 200);
  }
}

export async function startCockpit(opts: ReplOpts): Promise<void> {
  const out = process.stdout;
  const replState: ReplState = createReplState(opts);
  const bootResult = await playBoot(out, () => boot());
  if (!bootResult.ok) {
    // BOOT HALTED is already painted red with fix hints — leave it on
    // screen and exit non-zero. Never open the cockpit over a failed boot.
    out.write("\n\n");
    process.exit(1);
  }
  await loadBuiltIns(replState.cwd);

  const screen = new Screen(out);
  const editor = new LineEditor();
  const st: CockpitState = {
    sessions: scanSessions(),
    selected: 0,
    eventLines: [],
    eventSession: null,
    testLines: [],
    wall: null,
    board: null,
    budget: null,
    focus: "sessions",
    mode: "nav",
    status: "",
  };
  let dirty = true;
  let eventTailer: Tailer | null = null;
  let testTailer: Tailer | null = null;
  const mark = () => {
    dirty = true;
  };

  const retargetEvents = (id: string | null): void => {
    if (!id || id === st.eventSession) return;
    st.eventSession = id;
    st.eventLines = [];
    eventTailer?.close();
    eventTailer = tailFile(
      join(EVENTS_DIR, `${id}.jsonl`),
      (line) => {
        st.eventLines.push(eventToLine(line));
        if (st.eventLines.length > 500) st.eventLines.splice(0, 100);
        mark();
      },
      { tailLines: 200, waitForFile: true },
    );
    mark();
  };

  const refreshBoard = (): void => {
    try {
      const { events } = parseTestLog(st.testLines);
      st.board = buildExamBoard(
        events,
        corpusCases(join(PROJECT_ROOT, "tests", "fixtures", "verifier-corpus")),
      );
    } catch {
      /* corpus unreadable — board stays as-is */
    }
  };

  testTailer = tailFile(
    join(TESTS_DIR, "latest.jsonl"),
    (line) => {
      st.testLines.push(line);
      if (st.testLines.length > 5000) st.testLines.splice(0, 1000);
      const { events } = parseTestLog(st.testLines);
      st.wall = summarize(events);
      if (line.includes('"run_end"')) refreshBoard();
      mark();
    },
    { tailLines: Number.POSITIVE_INFINITY, waitForFile: true },
  );

  const refreshBudget = (): void => {
    try {
      const cfg = loadBudgetConfig() as { month_usd?: number };
      st.budget = { month: monthSpendUsd(), cap: cfg.month_usd ?? null };
    } catch {
      st.budget = null;
    }
    mark();
  };
  refreshBudget();
  const sessionsPoll = setInterval(() => {
    st.sessions = scanSessions();
    refreshBudget();
    mark();
  }, 5000);
  sessionsPoll.unref?.();
  if (st.sessions[0]) retargetEvents(st.sessions[0].id);

  const spawnTests = async (exam: boolean): Promise<void> => {
    const { spawn } = await import("node:child_process");
    const args = [
      join(PROJECT_ROOT, "node_modules", "vitest", "vitest.mjs"),
      "run",
      ...(exam ? ["tests/verifier-exam.test.ts"] : []),
    ];
    st.testLines = [];
    st.status = exam ? "running exam (strict)…" : "running tests…";
    mark();
    const child = spawn(process.execPath, args, {
      cwd: PROJECT_ROOT,
      env: exam ? { ...process.env, PATCHWORK_HARNESS_VERIFIER_EXAM: "strict" } : { ...process.env },
      stdio: "ignore",
    });
    child.on("exit", () => {
      st.status = "";
      refreshBoard();
      mark();
    });
  };

  const verifySelected = async (): Promise<void> => {
    const sel = st.sessions[st.selected];
    if (!sel) return;
    st.status = `verifying ${sel.id.slice(-8)}…`;
    mark();
    try {
      const { readFileSync: rf } = await import("node:fs");
      const { parseAuditJsonl, evidenceFromAuditEvents } = await import(
        "../verifier/session_adapter.js"
      );
      const { verify } = await import("../verifier/grounding.js");
      const { renderReport } = await import("../verifier/render.js");
      const events = parseAuditJsonl(rf(join(EVENTS_DIR, `${sel.id}.jsonl`), "utf8"));
      const adapted = evidenceFromAuditEvents(events);
      let answer = "";
      try {
        const sess = JSON.parse(rf(join(SESSIONS_DIR, `${sel.id}.json`), "utf8"));
        answer = [
          sess.summary,
          ...(sess.results ?? []).map((r: { output_summary?: string }) => r.output_summary),
        ]
          .filter(Boolean)
          .join("\n");
      } catch {
        /* no session record */
      }
      for (const w of adapted.warnings) st.eventLines.push(paint(FG.yellow, `⚠ ${w}`));
      if (!answer.trim()) {
        st.eventLines.push(paint(FG.yellow, "⚠ session has no recorded answer text to verify"));
      } else {
        const report = verify(answer, adapted.evidence);
        for (const l of renderReport(report).split("\n")) st.eventLines.push(l);
      }
    } catch (err) {
      st.eventLines.push(
        paint(FG.red, `verify failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }
    st.status = "";
    mark();
  };

  const runPromptGoal = async (goal: string): Promise<void> => {
    st.mode = "running";
    st.status = "orchestrating — output streams into EVENTS";
    mark();
    // stray writes become pane content, never screen corruption
    const origOut = out.write.bind(out);
    const origErr = process.stderr.write.bind(process.stderr);
    const intercept =
      (label: string) =>
      (chunk: unknown): boolean => {
        for (const l of String(chunk).split("\n"))
          if (l.trim()) st.eventLines.push(`${paint(FG.dim, label)} ${stripAnsi(l).slice(0, 300)}`);
        mark();
        return true;
      };
    (out as { write: unknown }).write = intercept("·");
    (process.stderr as { write: unknown }).write = intercept("!");
    try {
      await runGoal(replState, goal);
    } catch (err) {
      st.eventLines.push(paint(FG.red, `✖ ${err instanceof Error ? err.message : String(err)}`));
    } finally {
      (out as { write: unknown }).write = origOut;
      (process.stderr as { write: unknown }).write = origErr;
    }
    st.sessions = scanSessions();
    if (st.sessions[0]) retargetEvents(st.sessions[0].id);
    refreshBudget();
    st.mode = "nav";
    st.status = "";
    mark();
  };

  // ---- painting ----
  const frame = (): void => {
    const layout = computeLayout(out.columns ?? 80, out.rows ?? 24);
    if (layout.mode === "tooSmall") {
      screen.frame([
        "",
        paint(FG.yellow, "  terminal too small — 60×20 minimum"),
        paint(FG.dim, "  resize to resume"),
      ]);
      return;
    }
    const rows: string[] = new Array((out.rows ?? 24) as number).fill("");
    const put = (rect: { x: number; y: number }, lines: string[]): void => {
      for (let i = 0; i < lines.length; i++) {
        const r = rect.y - 1 + i;
        if (rect.x === 1) rows[r] = lines[i] ?? "";
        else {
          const pad = (rows[r] ?? "").length ? rows[r] : "";
          // left column already wrote this row; append at x with spacer
          rows[r] = `${pad}${" "}${lines[i] ?? ""}`;
        }
      }
    };
    const spend = st.budget ? `$${st.budget.month.toFixed(2)} this month` : "";
    rows[0] =
      paint(FG.amber, " HARNESS ") +
      paint(FG.dim, `· ${replState.mode} · ${replState.permission} · ${spend} · `) +
      paint(FG.dim, st.status || "tab panes · t tests · e exam · v verify · q quit");
    if (layout.mode === "full") {
      put(
        layout.sessions,
        renderSessions(layout.sessions, st.sessions, st.selected, st.focus === "sessions"),
      );
      put(layout.budget, renderBudget(layout.budget, st.budget, false));
      put(layout.verdicts, renderVerdicts(layout.verdicts, st.board, st.focus === "verdicts"));
    }
    const evTitle = st.eventSession ? `EVENTS · ${st.eventSession.slice(-10)}` : "EVENTS";
    put(layout.events, renderEvents(layout.events, st.eventLines, st.focus === "events", evTitle));
    put(layout.tests, renderTestStrip(layout.tests, st.wall, st.focus === "tests"));
    const hint =
      st.mode === "prompt"
        ? "Enter run · Esc back · ↑↓ history"
        : st.mode === "running"
          ? "goal running — watch EVENTS"
          : "type to enter a goal · Enter focuses prompt";
    const pr = renderPrompt(layout.prompt, editor.buffer, editor.cursor, st.mode, hint);
    put(layout.prompt, pr.rows);
    screen.setCursor(layout.prompt.y + 1, pr.cursorCol, st.mode === "prompt");
    screen.frame(rows);
  };

  const safeFrame = (): void => {
    try {
      frame();
    } catch (err) {
      // a pane bug must never take the cockpit down — show it and carry on
      st.status = `render error: ${err instanceof Error ? err.message : String(err)}`.slice(0, 80);
    }
  };
  const loop = setInterval(() => {
    if (dirty) {
      dirty = false;
      safeFrame();
    }
  }, 100);

  // RESIZE: recompute layout, full repaint. Debounced — Windows Terminal
  // fires a burst of resize events while dragging.
  let resizeTimer: NodeJS.Timeout | null = null;
  out.on("resize", () => {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      screen.invalidate();
      mark();
    }, 50);
  });

  // ---- teardown (ALWAYS restore the terminal) ----
  const teardown = (code: number): void => {
    clearInterval(loop);
    clearInterval(sessionsPoll);
    eventTailer?.close();
    testTailer?.close();
    try {
      process.stdin.setRawMode?.(false);
    } catch {
      /* ignore */
    }
    screen.leave();
    process.exit(code);
  };
  process.on("uncaughtException", (err) => {
    screen.leave();
    console.error(err);
    process.exit(1);
  });
  process.on("unhandledRejection", (err) => {
    screen.leave();
    console.error(err);
    process.exit(1);
  });
  process.stdin.on("error", () => teardown(1));
  process.on("SIGINT", () => teardown(0));
  process.on("SIGTERM", () => teardown(0));

  // ---- input ----
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf8");
    if (s === "\x03") return teardown(0); // Ctrl-C
    if (st.mode === "running") return; // input parked while a goal runs
    if (st.mode === "nav") {
      if (s === "q") return teardown(0);
      if (s === "\t") {
        st.focus = FOCI[(FOCI.indexOf(st.focus) + 1) % FOCI.length] as Focus;
        return mark();
      }
      if (s === "t") return void spawnTests(false);
      if (s === "e") return void spawnTests(true);
      if (s === "v") return void verifySelected();
      if (s === "\x1b[A" || s === "\x1b[B") {
        if (st.focus === "sessions" && st.sessions.length) {
          st.selected = Math.max(
            0,
            Math.min(st.sessions.length - 1, st.selected + (s === "\x1b[B" ? 1 : -1)),
          );
          const sel = st.sessions[st.selected];
          if (sel) retargetEvents(sel.id);
        }
        return mark();
      }
      if (s === "\r" || s === "\n") {
        st.mode = "prompt";
        return mark();
      }
      if (s.length === 1 && s >= " " && s !== "q") {
        st.mode = "prompt";
        editor.feed(s);
        return mark();
      }
      return;
    }
    // prompt mode
    const r = editor.feed(chunk);
    if (r.cancelled) {
      st.mode = "nav";
      editor.reset();
      return mark();
    }
    if (r.submitted !== undefined) {
      const line = r.submitted.trim();
      if (!line) {
        st.mode = "nav";
        return mark();
      }
      if (line.startsWith("/")) {
        // slash output is console-based in the shared brain — capture it
        const orig = console.log;
        const captured: string[] = [];
        console.log = (...a: unknown[]) => captured.push(a.map(String).join(" "));
        try {
          applySlash(line, replState);
        } finally {
          console.log = orig;
        }
        for (const l of captured)
          for (const seg of l.split("\n")) st.eventLines.push(stripAnsi(seg));
        st.mode = "nav";
        return mark();
      }
      void runPromptGoal(line);
      return;
    }
    if (r.changed) mark();
  });

  screen.enter();
  mark();
  safeFrame();
}
