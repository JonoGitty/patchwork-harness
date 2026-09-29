/**
 * Hand-rolled prompt editor for raw-mode input (ADR-0012). readline's
 * own screen writes cannot coexist with cursor-addressed painting, so
 * the cockpit parses keys itself. Pure: feed(chunk) mutates state and
 * reports submissions — no I/O, fully unit-testable, tolerant of escape
 * sequences split across chunks.
 */

export interface FeedResult {
  submitted?: string;
  cancelled?: boolean; // Esc pressed on its own
  changed: boolean;
}

export class LineEditor {
  buffer = "";
  cursor = 0;
  history: string[] = [];
  private histIdx = -1;
  private pendingEsc = "";

  reset(): void {
    this.buffer = "";
    this.cursor = 0;
    this.histIdx = -1;
  }

  feed(chunk: Buffer | string): FeedResult {
    const s = this.pendingEsc + chunk.toString("utf8");
    this.pendingEsc = "";
    let changed = false;
    let submitted: string | undefined;
    let cancelled = false;
    let i = 0;
    while (i < s.length) {
      const ch = s[i] as string;
      if (ch === "\x1b") {
        const rest = s.slice(i);
        if (rest.length === 1) {
          // might be a lone Esc or the start of a sequence — wait one feed
          this.pendingEsc = rest;
          i = s.length;
          break;
        }
        const m = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
        if (m) {
          const seq = m[2];
          if (seq === "A") this.histPrev(), (changed = true);
          else if (seq === "B") this.histNext(), (changed = true);
          else if (seq === "C")
            (this.cursor = Math.min(this.buffer.length, this.cursor + 1)), (changed = true);
          else if (seq === "D") (this.cursor = Math.max(0, this.cursor - 1)), (changed = true);
          else if (seq === "H") (this.cursor = 0), (changed = true);
          else if (seq === "F") (this.cursor = this.buffer.length), (changed = true);
          else if (seq === "~" && (m[1] === "1" || m[1] === "7"))
            (this.cursor = 0), (changed = true);
          else if (seq === "~" && (m[1] === "4" || m[1] === "8"))
            (this.cursor = this.buffer.length), (changed = true);
          else if (seq === "~" && m[1] === "3") {
            // delete key
            if (this.cursor < this.buffer.length) {
              this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
              changed = true;
            }
          }
          i += m[0].length;
          continue;
        }
        // partial CSI split across chunks?
        if (/^\x1b\[[0-9;]*$/.test(rest)) {
          this.pendingEsc = rest;
          i = s.length;
          break;
        }
        // lone Esc (followed by a non-sequence char): cancel
        cancelled = true;
        i += 1;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        submitted = this.buffer;
        if (submitted.trim()) {
          this.history.push(submitted);
          if (this.history.length > 100) this.history.shift();
        }
        this.reset();
        changed = true;
        i++;
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        if (this.cursor > 0) {
          this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
          this.cursor--;
          changed = true;
        }
        i++;
        continue;
      }
      if (ch === "\x15") {
        // ctrl-u: kill to start
        this.buffer = this.buffer.slice(this.cursor);
        this.cursor = 0;
        changed = true;
        i++;
        continue;
      }
      if (ch === "\x0b") {
        // ctrl-k: kill to end
        this.buffer = this.buffer.slice(0, this.cursor);
        changed = true;
        i++;
        continue;
      }
      if (ch === "\x17") {
        // ctrl-w: kill previous word
        const before = this.buffer.slice(0, this.cursor).replace(/\S+\s*$/, "");
        this.buffer = before + this.buffer.slice(this.cursor);
        this.cursor = before.length;
        changed = true;
        i++;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code >= 32) {
        this.buffer = this.buffer.slice(0, this.cursor) + ch + this.buffer.slice(this.cursor);
        this.cursor++;
        changed = true;
      }
      i++;
    }
    return { submitted, cancelled, changed };
  }

  private histPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) this.histIdx = this.history.length;
    if (this.histIdx > 0) this.histIdx--;
    this.buffer = this.history[this.histIdx] ?? "";
    this.cursor = this.buffer.length;
  }
  private histNext(): void {
    if (this.histIdx === -1) return;
    this.histIdx++;
    if (this.histIdx >= this.history.length) {
      this.histIdx = -1;
      this.buffer = "";
    } else {
      this.buffer = this.history[this.histIdx] ?? "";
    }
    this.cursor = this.buffer.length;
  }
}
