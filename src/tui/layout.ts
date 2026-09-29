/**
 * Cockpit layout — PURE maths (ADR-0012). Given a terminal size, return
 * the exact rectangles for every pane. Tested by invariant sweep: rects
 * never overlap, never exceed the screen, and the prompt is always
 * present in any usable mode.
 */

export interface Rect {
  x: number; // 1-based column
  y: number; // 1-based row
  w: number;
  h: number;
}

export interface CockpitLayout {
  mode: "full" | "stacked" | "tooSmall";
  header: Rect;
  sessions: Rect;
  budget: Rect;
  verdicts: Rect;
  events: Rect;
  tests: Rect;
  prompt: Rect;
}

const MIN_FULL_COLS = 100;
const MIN_FULL_ROWS = 28;
const MIN_COLS = 60;
const MIN_ROWS = 20;
const LEFT_W = 32;
const PROMPT_H = 3;
const TESTS_H = 3;
const BUDGET_H = 5;

const empty: Rect = { x: 1, y: 1, w: 0, h: 0 };

export function computeLayout(cols: number, rows: number): CockpitLayout {
  if (cols < MIN_COLS || rows < MIN_ROWS) {
    return {
      mode: "tooSmall",
      header: empty,
      sessions: empty,
      budget: empty,
      verdicts: empty,
      events: empty,
      tests: empty,
      prompt: empty,
    };
  }
  const header: Rect = { x: 1, y: 1, w: cols, h: 1 };
  const prompt: Rect = { x: 1, y: rows - PROMPT_H + 1, w: cols, h: PROMPT_H };
  const bodyTop = 2;
  const bodyH = rows - 1 - PROMPT_H; // between header and prompt

  if (cols >= MIN_FULL_COLS && rows >= MIN_FULL_ROWS) {
    const rightX = LEFT_W + 2; // one column separator
    const rightW = cols - LEFT_W - 1;
    const verdictsH = 8;
    const sessionsH = bodyH - BUDGET_H - verdictsH;
    return {
      mode: "full",
      header,
      sessions: { x: 1, y: bodyTop, w: LEFT_W, h: sessionsH },
      budget: { x: 1, y: bodyTop + sessionsH, w: LEFT_W, h: BUDGET_H },
      verdicts: { x: 1, y: bodyTop + sessionsH + BUDGET_H, w: LEFT_W, h: verdictsH },
      events: { x: rightX, y: bodyTop, w: rightW, h: bodyH - TESTS_H },
      tests: { x: rightX, y: bodyTop + bodyH - TESTS_H, w: rightW, h: TESTS_H },
      prompt,
    };
  }
  // stacked
  return {
    mode: "stacked",
    header,
    sessions: empty,
    budget: empty,
    verdicts: empty,
    events: { x: 1, y: bodyTop, w: cols, h: bodyH - TESTS_H },
    tests: { x: 1, y: bodyTop + bodyH - TESTS_H, w: cols, h: TESTS_H },
    prompt,
  };
}
