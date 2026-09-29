import type { WallSummary } from "../testing/test_events.js";
import type { ExamBoard } from "../verifier/exam_board.js";
/**
 * Cockpit panes — PURE renderers (ADR-0012). Each returns exactly rect.h
 * rows of exactly rect.w visible width. No I/O, no emoji (width maths),
 * fully unit-testable with red fixtures: a pane that can only render
 * green is a defect.
 */
import { BOLD, FG, RESET, fit, paint } from "./ansi.js";
import type { Rect } from "./layout.js";

const box = (title: string, rect: Rect, body: string[], focused: boolean): string[] => {
  const w = rect.w;
  const tcol = focused ? FG.amber : FG.dim;
  const t = ` ${title} `;
  const topBar = "─".repeat(Math.max(0, w - t.length - 3));
  const rows: string[] = [fit(paint(tcol, `┌─${BOLD}${t}${RESET}${tcol}${topBar}┐`), w)];
  for (let i = 0; i < rect.h - 2; i++) {
    const content = body[i] ?? "";
    rows.push(fit(`${paint(tcol, "│")}${fit(content, w - 2)}${paint(tcol, "│")}`, w));
  }
  rows.push(fit(paint(tcol, `└${"─".repeat(Math.max(0, w - 2))}┘`), w));
  return rows.slice(0, rect.h);
};

export interface SessionRow {
  id: string;
  goal: string;
  status: string;
  cost: number;
}

export function renderSessions(
  rect: Rect,
  sessions: SessionRow[],
  selected: number,
  focused: boolean,
): string[] {
  const body: string[] = [];
  if (sessions.length === 0) {
    body.push(paint(FG.dim, " no sessions yet"));
    body.push(paint(FG.dim, " type a goal below"));
  }
  const visible = rect.h - 2;
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(visible / 2), sessions.length - visible),
  );
  for (let i = start; i < Math.min(sessions.length, start + visible); i++) {
    const s = sessions[i] as SessionRow;
    const mark = i === selected ? paint(FG.amber, "▸") : " ";
    const st =
      s.status === "completed"
        ? paint(FG.green, "●")
        : s.status === "failed"
          ? paint(FG.red, "●")
          : paint(FG.yellow, "●");
    body.push(`${mark}${st} ${paint(FG.dim, s.id.slice(-8))} ${s.goal.slice(0, rect.w - 16)}`);
  }
  return box("SESSIONS", rect, body, focused);
}

export function renderBudget(
  rect: Rect,
  b: { month: number; cap: number | null } | null,
  focused: boolean,
): string[] {
  const body: string[] = [];
  if (!b) body.push(paint(FG.dim, " budget unavailable"));
  else {
    body.push(` month  ${paint(FG.bright, `$${b.month.toFixed(2)}`)}`);
    if (b.cap) {
      const frac = Math.min(1, b.month / b.cap);
      const w = Math.max(4, rect.w - 12);
      const on = Math.round(frac * w);
      const barCol = frac > 0.9 ? FG.red : frac > 0.6 ? FG.yellow : FG.green;
      body.push(` ${paint(barCol, "▮".repeat(on))}${paint(FG.dim, "▯".repeat(w - on))}`);
      body.push(paint(FG.dim, ` cap $${b.cap.toFixed(2)}`));
    }
  }
  return box("BUDGET", rect, body, focused);
}

export function renderEvents(
  rect: Rect,
  lines: string[],
  focused: boolean,
  title: string,
): string[] {
  const visible = rect.h - 2;
  const body = lines.slice(-visible).map((l) => ` ${l}`);
  return box(title, rect, body, focused);
}

export function renderTestStrip(rect: Rect, wall: WallSummary | null, focused: boolean): string[] {
  const body: string[] = [];
  if (!wall || wall.files.length === 0) {
    body.push(paint(FG.dim, " no test run yet — press t to run, e for the exam"));
  } else {
    let cells = " ";
    for (const f of wall.files)
      for (const t of f.tests)
        cells +=
          t.state === "pass"
            ? paint(FG.green, "▮")
            : t.state === "fail"
              ? paint(FG.red, "▮")
              : t.state === "run"
                ? paint(FG.blue, "▮")
                : paint(FG.yellow, "▯");
    body.push(cells);
    const status = wall.runComplete
      ? wall.interrupted
        ? paint(FG.red, "INTERRUPTED — not green")
        : "complete"
      : paint(FG.yellow, "running…");
    body.push(
      ` ${paint(FG.green, `${wall.totals.passed} pass`)} ${paint(FG.red, `${wall.totals.failed} fail`)} ` +
        `${paint(FG.yellow, `${wall.totals.skipped + wall.totals.todo} skip`)} · ${status}`,
    );
  }
  return box("TESTS", rect, body, focused);
}

export function renderVerdicts(rect: Rect, board: ExamBoard | null, focused: boolean): string[] {
  const body: string[] = [];
  if (!board) body.push(paint(FG.dim, " no exam data — press e"));
  else {
    const oc =
      board.overall === "GREEN" ? FG.green : board.overall === "NOT_GREEN" ? FG.red : FG.yellow;
    body.push(` ${paint(oc, `${BOLD}${board.overall}${RESET}`)}`);
    body.push(
      ` ${paint(FG.green, `${board.counts.pass}✓`)} ${paint(FG.red, `${board.counts.fail}✗`)} ` +
        `${paint(FG.yellow, `${board.counts.skip + board.counts.missing}◦`)} of ${board.cases.length}`,
    );
    for (const cse of board.cases.filter((c) => c.state === "FAIL").slice(0, rect.h - 4))
      body.push(paint(FG.red, ` ✗ ${cse.id}`));
  }
  return box("HARNESS VERIFIER", rect, body, focused);
}

export function renderPrompt(
  rect: Rect,
  buffer: string,
  cursor: number,
  mode: "nav" | "prompt" | "running",
  hint: string,
): { rows: string[]; cursorCol: number } {
  const rows: string[] = [];
  rows.push(fit(paint(FG.dim, "─".repeat(rect.w)), rect.w));
  const promptGlyph =
    mode === "running" ? paint(FG.yellow, "… ") : paint(FG.amber, `${BOLD}› ${RESET}`);
  rows.push(fit(`${promptGlyph}${buffer}`, rect.w));
  rows.push(fit(paint(FG.dim, ` ${hint}`), rect.w));
  return { rows, cursorCol: 3 + cursor };
}
