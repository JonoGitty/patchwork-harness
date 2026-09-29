/**
 * Shared JSONL tailing — ONE implementation of "follow a growing log".
 *
 * Extracted from the `tail` CLI action (ADR-0012): the same mechanics now
 * serve `patchwork-harness tail`, the web dashboard's SSE routes, the live test wall
 * and the cockpit panes. The mechanics are the proven ones: incremental
 * readSync with a leftover-line buffer, truncation reset (a file that got
 * SMALLER means rotation/new run — re-read from zero), and fs.watch PLUS a
 * polling interval as belt-and-braces, because fs.watch on Windows misses
 * appends often enough that the web route always carried both.
 */
import {
  type FSWatcher,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  watch,
} from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface TailerOptions {
  /** Replay the last N complete lines before following (default 0; Infinity = whole file). */
  tailLines?: number;
  /** Poll interval alongside fs.watch (default 1000ms). */
  intervalMs?: number;
  /** If the file doesn't exist yet, poll for it instead of throwing. */
  waitForFile?: boolean;
}

export interface Tailer {
  readonly path: string;
  close(): void;
}

/**
 * Follow `path`, invoking `onLine` for every complete line (replayed tail
 * first when `tailLines` is set). Never throws from the follow loop; a
 * vanished file simply goes quiet until it reappears (waitForFile) or the
 * tailer is closed.
 */
export function tailFile(
  path: string,
  onLine: (line: string) => void,
  opts: TailerOptions = {},
): Tailer {
  const intervalMs = opts.intervalMs ?? 1000;
  let fd: number | null = null;
  let pos = 0;
  let leftover = "";
  let watcher: FSWatcher | null = null;
  let closed = false;

  const emitChunk = (chunk: string): void => {
    const lines = (leftover + chunk).split("\n");
    leftover = lines.pop() ?? "";
    for (const line of lines) if (line) onLine(line);
  };

  const openIfNeeded = (): boolean => {
    if (fd !== null) return true;
    if (!existsSync(path)) return false;
    try {
      fd = openSync(path, "r");
    } catch {
      return false;
    }
    // replay tail on first open
    if (opts.tailLines && opts.tailLines > 0) {
      try {
        const raw = readFileSync(path, "utf8");
        const all = raw.split("\n").filter(Boolean);
        const initial =
          opts.tailLines === Number.POSITIVE_INFINITY ? all : all.slice(-opts.tailLines);
        for (const line of initial) onLine(line);
        pos = Buffer.byteLength(raw, "utf8");
        leftover = "";
      } catch {
        /* replay is best-effort; follow still works from 0 */
      }
    }
    if (!watcher) {
      try {
        watcher = watch(path, { persistent: false }, () => flush());
      } catch {
        watcher = null; // interval alone still covers us
      }
    }
    return true;
  };

  const flush = (): void => {
    if (closed) return;
    if (!openIfNeeded() || fd === null) return;
    let stat: ReturnType<typeof fstatSync>;
    try {
      stat = fstatSync(fd);
    } catch {
      return;
    }
    if (stat.size === pos) return;
    if (stat.size < pos) {
      // truncation / rotation: a new run started — re-read from the top
      pos = 0;
      leftover = "";
    }
    const len = stat.size - pos;
    const buf = Buffer.alloc(len);
    try {
      readSync(fd, buf, 0, len, pos);
    } catch {
      return;
    }
    pos = stat.size;
    emitChunk(buf.toString("utf8"));
  };

  if (!openIfNeeded() && !opts.waitForFile) {
    throw new Error(`tailFile: ${path} does not exist (pass waitForFile to poll for it)`);
  }
  flush();
  const interval = setInterval(flush, intervalMs);
  interval.unref?.();

  return {
    path,
    close(): void {
      closed = true;
      clearInterval(interval);
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
        fd = null;
      }
    },
  };
}

export class NoMatchError extends Error {}
export class AmbiguousMatchError extends Error {
  candidates: string[];
  constructor(arg: string, candidates: string[]) {
    super(
      `ambiguous match for ${arg} — ${candidates.length} candidates: ` +
        `${candidates.slice(0, 3).join(", ")}…`,
    );
    this.candidates = candidates;
  }
}

export interface Resolution {
  path: string;
  id: string;
}

/**
 * Resolve a session-ish argument to a .jsonl file in `dir`.
 * Prefix-match preferred (ULIDs are stable left-to-right), then suffix
 * (the friendly last-12-chars rendering), then substring. No arg = the
 * most recently modified file. Ambiguity and no-match throw typed errors
 * so callers can render them their own way.
 */
export function resolveJsonl(dir: string, arg?: string): Resolution {
  if (!existsSync(dir)) throw new NoMatchError(`no directory at ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  if (files.length === 0) throw new NoMatchError(`no .jsonl files in ${dir}`);
  let target: string | undefined;
  if (arg) {
    const prefix = files.filter((f) => f.startsWith(arg));
    const suffix = files.filter((f) => f.replace(/\.jsonl$/, "").endsWith(arg));
    const sub = files.filter((f) => f.includes(arg));
    const candidates = prefix.length ? prefix : suffix.length ? suffix : sub;
    if (candidates.length === 0) throw new NoMatchError(`no session matching ${arg}`);
    if (candidates.length > 1) throw new AmbiguousMatchError(arg, candidates);
    target = candidates[0];
  } else {
    target = files
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0]?.f;
  }
  if (!target) throw new NoMatchError(`no resolvable file in ${dir}`);
  return { path: join(dir, target), id: target.replace(/\.jsonl$/, "") };
}
