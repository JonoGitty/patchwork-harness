/**
 * Cockpit unit tests — all pure, no TTY (ADR-0012). Panes are fed RED
 * fixtures first: a pane that can only render green is a defect.
 */
import { describe, expect, it } from "vitest";
import type { WallSummary } from "../src/testing/test_events.js";
import { fit, stringWidth, stripAnsi } from "../src/tui/ansi.js";
import { computeLayout } from "../src/tui/layout.js";
import { LineEditor } from "../src/tui/line_editor.js";
import { renderEvents, renderSessions, renderTestStrip, renderVerdicts } from "../src/tui/panes.js";
import { Screen } from "../src/tui/screen.js";
import type { ExamBoard } from "../src/verifier/exam_board.js";

describe("layout invariants (sweep)", () => {
  const sizes: Array<[number, number]> = [];
  for (let c = 40; c <= 220; c += 17) for (let r = 12; r <= 60; r += 7) sizes.push([c, r]);
  it("rects never overlap, never exceed the screen, prompt always present", () => {
    for (const [cols, rows] of sizes) {
      const l = computeLayout(cols, rows);
      if (l.mode === "tooSmall") {
        expect(cols < 60 || rows < 20).toBe(true);
        continue;
      }
      const rects = [
        l.header,
        l.sessions,
        l.budget,
        l.verdicts,
        l.events,
        l.tests,
        l.prompt,
      ].filter((r) => r.w > 0 && r.h > 0);
      expect(l.prompt.h).toBeGreaterThan(0);
      const occupied = new Set<string>();
      for (const r of rects) {
        expect(r.x + r.w - 1).toBeLessThanOrEqual(cols);
        expect(r.y + r.h - 1).toBeLessThanOrEqual(rows);
        for (let y = r.y; y < r.y + r.h; y++)
          for (let x = r.x; x < r.x + r.w; x++) {
            const k = `${x},${y}`;
            expect(occupied.has(k), `overlap at ${k} @ ${cols}x${rows}`).toBe(false);
            occupied.add(k);
          }
      }
    }
  });
  it("boundary is exact: 60x20 works, 59x20 and 60x19 do not", () => {
    expect(computeLayout(60, 20).mode).not.toBe("tooSmall");
    expect(computeLayout(59, 20).mode).toBe("tooSmall");
    expect(computeLayout(60, 19).mode).toBe("tooSmall");
    expect(computeLayout(100, 28).mode).toBe("full");
    expect(computeLayout(99, 28).mode).toBe("stacked");
  });
});

describe("LineEditor", () => {
  it("edits, cursors, kills", () => {
    const e = new LineEditor();
    e.feed("hello");
    e.feed("\x1b[D");
    e.feed("\x1b[D"); // left left
    e.feed("X");
    expect(e.buffer).toBe("helXlo");
    e.feed("\x15"); // ctrl-u
    expect(e.buffer).toBe("lo");
    const r = e.feed("\r");
    expect(r.submitted).toBe("lo");
    expect(e.buffer).toBe("");
  });
  it("handles an escape sequence SPLIT across chunks", () => {
    const e = new LineEditor();
    e.feed("ab");
    e.feed("\x1b");
    const r1 = e.feed("[D"); // completes ←
    expect(r1.cancelled).toBeFalsy();
    e.feed("X");
    expect(e.buffer).toBe("aXb");
  });
  it("lone Esc cancels", () => {
    const e = new LineEditor();
    e.feed("abc");
    const r = e.feed("\x1b\x1b"); // Esc then a char that is Esc again
    expect(r.cancelled).toBe(true);
  });
  it("history up/down round-trips", () => {
    const e = new LineEditor();
    e.feed("first\r");
    e.feed("second\r");
    e.feed("\x1b[A");
    expect(e.buffer).toBe("second");
    e.feed("\x1b[A");
    expect(e.buffer).toBe("first");
    e.feed("\x1b[B");
    expect(e.buffer).toBe("second");
  });
});

describe("panes — red fixtures, exact geometry", () => {
  const rect = { x: 1, y: 1, w: 40, h: 6 };
  const wallRed: WallSummary = {
    runId: "r1",
    files: [
      {
        file: "a.test.ts",
        tests: [
          { name: "t1", state: "fail", error: "boom" },
          { name: "t2", state: "pass" },
        ],
        passed: 1,
        failed: 1,
        skipped: 0,
        running: 0,
      },
    ],
    totals: { passed: 1, failed: 1, skipped: 0, todo: 0, running: 0 },
    runComplete: false,
    interrupted: false,
  };
  const boardRed: ExamBoard = {
    cases: [
      { id: "fab-001", title: "x", state: "FAIL", error: "e" },
      { id: "ok-001", title: "y", state: "MISSING" },
    ],
    overall: "NOT_GREEN",
    counts: { pass: 0, fail: 1, skip: 0, running: 0, missing: 1 },
    runComplete: true,
  };
  it("every pane returns exactly rect.h rows of exactly rect.w width", () => {
    for (const rows of [
      renderSessions(rect, [], 0, false),
      renderSessions(rect, [{ id: "s1", goal: "g", status: "failed", cost: 0 }], 0, true),
      renderEvents(rect, ["line one", "line two"], false, "EVENTS"),
      renderTestStrip(rect, wallRed, false),
      renderTestStrip(rect, null, false),
      renderVerdicts(rect, boardRed, false),
      renderVerdicts(rect, null, false),
    ]) {
      expect(rows).toHaveLength(rect.h);
      for (const r of rows) expect(stringWidth(r), stripAnsi(r)).toBe(rect.w);
    }
  });
  it("RED renders red: the fail count and NOT_GREEN are visible", () => {
    const strip = renderTestStrip(rect, wallRed, false).map(stripAnsi).join("\n");
    expect(strip).toContain("1 fail");
    const verd = renderVerdicts(rect, boardRed, false).map(stripAnsi).join("\n");
    expect(verd).toContain("NOT_GREEN");
    expect(verd).toContain("✗ fab-001");
  });
  it("empty states are never blank", () => {
    const s = renderSessions(rect, [], 0, false).map(stripAnsi).join("\n");
    expect(s).toContain("no sessions yet");
  });
});

describe("Screen diff repaint", () => {
  function fake(): { out: NodeJS.WriteStream; writes: string[] } {
    const writes: string[] = [];
    const out = {
      write: (s: string) => {
        writes.push(s);
        return true;
      },
      columns: 80,
      rows: 24,
    } as unknown as NodeJS.WriteStream;
    return { out, writes };
  }
  it("changing ONE row emits exactly one cursor move, in one write", () => {
    const { out, writes } = fake();
    const sc = new Screen(out);
    sc.enter();
    sc.frame(["aaa", "bbb", "ccc"]);
    writes.length = 0;
    sc.frame(["aaa", "BBB", "ccc"]);
    expect(writes).toHaveLength(1);
    const moves = (writes[0] ?? "").match(/\x1b\[\d+;\d+H/g) ?? [];
    // one row repaint + one cursor park
    expect(moves.length).toBeLessThanOrEqual(2);
    expect(writes[0]).toContain("BBB");
    expect(writes[0]).not.toContain("aaa");
  });
  it("invalidate() forces a full repaint", () => {
    const { out, writes } = fake();
    const sc = new Screen(out);
    sc.enter();
    sc.frame(["aaa", "bbb"]);
    sc.invalidate();
    writes.length = 0;
    sc.frame(["aaa", "bbb"]);
    expect(writes[0]).toContain("aaa");
    expect(writes[0]).toContain("bbb");
  });
});
