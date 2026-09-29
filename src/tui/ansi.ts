/**
 * Raw ANSI/VT primitives for the cockpit (ADR-0012). Zero deps.
 *
 * Windows Terminal + node >=16 auto-enable VT processing on TTY stdout,
 * so plain escape sequences work; DECSET 2026 (synchronized output) is
 * supported there and harmless elsewhere.
 */

export const ALT_SCREEN_ON = "\x1b[?1049h";
export const ALT_SCREEN_OFF = "\x1b[?1049l";
export const CURSOR_HIDE = "\x1b[?25l";
export const CURSOR_SHOW = "\x1b[?25h";
export const CLEAR_SCREEN = "\x1b[2J";
export const CLEAR_LINE = "\x1b[2K";
export const SYNC_ON = "\x1b[?2026h";
export const SYNC_OFF = "\x1b[?2026l";
export const RESET = "\x1b[0m";

export const moveTo = (row: number, col: number): string => `\x1b[${row};${col}H`;

/** The cockpit's VFD-leaning palette (256-colour SGR). */
export const FG = {
  amber: "\x1b[38;5;214m",
  amberDim: "\x1b[38;5;130m",
  green: "\x1b[38;5;114m",
  red: "\x1b[38;5;167m",
  yellow: "\x1b[38;5;179m",
  blue: "\x1b[38;5;110m",
  dim: "\x1b[38;5;242m",
  bright: "\x1b[38;5;255m",
} as const;
export const BOLD = "\x1b[1m";

export const paint = (code: string, text: string): string => `${code}${text}${RESET}`;

const SGR_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * Visible width of a styled string. Pane content is plain ASCII + SGR by
 * contract (no emoji/wide glyphs — ADR-0012), so char count after
 * stripping escapes IS the width.
 */
export function stringWidth(s: string): number {
  return s.replace(SGR_RE, "").length;
}

/** Strip all escape sequences (for tests and logs). */
export function stripAnsi(s: string): string {
  return s.replace(SGR_RE, "");
}

/** Pad/clip a styled string to an exact VISIBLE width. */
export function fit(s: string, width: number): string {
  const w = stringWidth(s);
  if (w === width) return s;
  if (w < width) return s + " ".repeat(width - w);
  // clip: walk the string keeping escapes, counting visible chars
  let out = "";
  let seen = 0;
  let i = 0;
  while (i < s.length && seen < width) {
    const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
    } else {
      out += s[i];
      seen++;
      i++;
    }
  }
  return out + RESET;
}
