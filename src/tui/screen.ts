/**
 * Diff-repaint screen driver (ADR-0012). Row-level diffing: keep the
 * previously painted rows; on frame(), emit cursor-move + clear + text
 * for CHANGED rows only, wrapped in DECSET 2026 synchronized output, as
 * EXACTLY ONE write. Flicker-free on Windows Terminal.
 */
import {
  ALT_SCREEN_OFF,
  ALT_SCREEN_ON,
  CLEAR_LINE,
  CLEAR_SCREEN,
  CURSOR_HIDE,
  CURSOR_SHOW,
  SYNC_OFF,
  SYNC_ON,
  moveTo,
} from "./ansi.js";

export class Screen {
  private prev: string[] = [];
  private entered = false;
  private cursorSpot: { row: number; col: number; visible: boolean } = {
    row: 1,
    col: 1,
    visible: false,
  };

  constructor(private out: NodeJS.WriteStream) {}

  enter(): void {
    if (this.entered) return;
    this.entered = true;
    this.out.write(ALT_SCREEN_ON + CURSOR_HIDE + CLEAR_SCREEN);
    this.prev = [];
  }

  leave(): void {
    if (!this.entered) return;
    this.entered = false;
    this.out.write(SYNC_OFF + CURSOR_SHOW + ALT_SCREEN_OFF);
  }

  invalidate(): void {
    this.prev = [];
    if (this.entered) this.out.write(CLEAR_SCREEN);
  }

  setCursor(row: number, col: number, visible: boolean): void {
    this.cursorSpot = { row, col, visible };
  }

  /** Paint the full frame; only changed rows hit the wire. ONE write. */
  frame(rows: string[]): void {
    if (!this.entered) return;
    let buf = "";
    for (let r = 0; r < rows.length; r++) {
      if (this.prev[r] === rows[r]) continue;
      buf += moveTo(r + 1, 1) + CLEAR_LINE + (rows[r] ?? "");
    }
    // rows the new frame no longer has
    for (let r = rows.length; r < this.prev.length; r++) {
      buf += moveTo(r + 1, 1) + CLEAR_LINE;
    }
    this.prev = rows.slice();
    const c = this.cursorSpot;
    buf += c.visible ? moveTo(c.row, c.col) + CURSOR_SHOW : CURSOR_HIDE;
    if (buf) this.out.write(SYNC_ON + buf + SYNC_OFF);
  }
}
