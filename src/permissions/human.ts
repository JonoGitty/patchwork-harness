/**
 * The human side of the orchestrator. A HumanChannel is how the agent
 * reaches a person mid-run: permission prompts ("Allow: write foo.ts?"),
 * plan/budget confirmations, and pause_for_human plan steps (decisions
 * the agent must not make alone). Three channels cover the three run
 * shapes:
 *
 *  - TTY (interactive terminal)       → readline y/n + free text
 *  - JSON mode (dashboard / parent)   → emit a `permission_required` /
 *    `human_pause` NDJSON event on stdout, then wait for an answer line
 *    on stdin: {"type":"human_answer","id":"q1","answer":"yes"}
 *  - headless (no TTY, no JSON mode)  → return safe defaults immediately
 *    (deny permissions, no answer for pauses)
 *
 * See DECISIONS/0010-human-in-the-loop.md.
 */

import readline from "node:readline";
import chalk from "chalk";
import type { JsonReporter } from "../util/json_reporter.js";

export interface QuestionMeta {
  kind?: "permission" | "pause" | "plan" | "budget";
  [key: string]: unknown;
}

export interface HumanChannel {
  /** True when a person can actually answer on this channel right now. */
  readonly interactive: boolean;
  /** Yes/no question. Falls back to `def` when nobody answers. */
  askYesNo(question: string, def: boolean, meta?: QuestionMeta): Promise<boolean>;
  /** Free-text question. Returns null when nobody answers. */
  askText(question: string, meta?: QuestionMeta): Promise<string | null>;
  /** Release any stdin listeners so the process can exit. */
  close(): void;
}

/** How long a JSON-mode question waits for an answer before falling back
 *  to the default. Override with PATCHWORK_HARNESS_HUMAN_TIMEOUT_S. */
const DEFAULT_TIMEOUT_S = 600;

const YES_WORDS = new Set(["y", "yes", "true", "allow", "approve", "ok", "1"]);

// ─── TTY: classic readline prompts ───────────────────────────────────────

class TtyHumanChannel implements HumanChannel {
  get interactive(): boolean {
    return process.stdin.isTTY === true;
  }

  askYesNo(question: string, def: boolean): Promise<boolean> {
    if (!this.interactive) return Promise.resolve(def);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const tag = def ? "[Y/n]" : "[y/N]";
    return new Promise<boolean>((res) => {
      rl.question(`${chalk.yellow("?")} ${question} ${chalk.dim(tag)} `, (answer) => {
        rl.close();
        const a = answer.trim().toLowerCase();
        if (!a) return res(def);
        res(a === "y" || a === "yes");
      });
    });
  }

  askText(question: string): Promise<string | null> {
    if (!this.interactive) return Promise.resolve(null);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string | null>((res) => {
      rl.question(`${chalk.yellow("?")} ${question}\n${chalk.dim(">")} `, (answer) => {
        rl.close();
        const a = answer.trim();
        res(a.length > 0 ? a : null);
      });
    });
  }

  close(): void {
    /* per-question readline interfaces are already closed */
  }
}

// ─── Headless: safe defaults, immediately ────────────────────────────────

class HeadlessHumanChannel implements HumanChannel {
  readonly interactive = false;
  askYesNo(_q: string, def: boolean): Promise<boolean> {
    return Promise.resolve(def);
  }
  askText(): Promise<string | null> {
    return Promise.resolve(null);
  }
  close(): void {
    /* nothing held */
  }
}

// ─── JSON mode: NDJSON question out, NDJSON answer in ────────────────────

export class JsonHumanChannel implements HumanChannel {
  private pending = new Map<string, (answer: string | null) => void>();
  private rl: readline.Interface | null = null;
  private stdinOpen = true;
  private seq = 0;
  private readonly timeoutMs: number;
  private readonly input: NodeJS.ReadableStream;

  constructor(
    private reporter: JsonReporter,
    opts: { timeout_s?: number; input?: NodeJS.ReadableStream } = {},
  ) {
    const env = Number(process.env.PATCHWORK_HARNESS_HUMAN_TIMEOUT_S);
    const fallback = Number.isFinite(env) && env > 0 ? env : DEFAULT_TIMEOUT_S;
    this.timeoutMs = 1000 * (opts.timeout_s ?? fallback);
    this.input = opts.input ?? process.stdin;
  }

  get interactive(): boolean {
    return this.stdinOpen;
  }

  /** Lazy: only touch stdin once a question is actually asked, so runs
   *  that never prompt don't hold the event loop open. */
  private ensureListening(): void {
    if (this.rl) return;
    this.rl = readline.createInterface({ input: this.input, terminal: false });
    this.rl.on("line", (line) => {
      let msg: { type?: string; id?: string; answer?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return; // not for us
      }
      if (msg?.type !== "human_answer" || typeof msg.id !== "string") return;
      const resolve = this.pending.get(msg.id);
      if (resolve) resolve(String(msg.answer ?? ""));
    });
    this.rl.on("close", () => {
      this.stdinOpen = false;
      for (const resolve of [...this.pending.values()]) resolve(null);
    });
  }

  private ask(
    type: "permission_required" | "human_pause",
    question: string,
    meta: QuestionMeta,
  ): Promise<string | null> {
    if (!this.stdinOpen) return Promise.resolve(null);
    this.ensureListening();
    const id = `q${++this.seq}`;
    this.reporter.emit(type, { id, question, ...meta });
    return new Promise<string | null>((res) => {
      let timer: NodeJS.Timeout | null = null;
      const settle = (answer: string | null, source: "human" | "timeout" | "stdin_closed") => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        this.reporter.emit("human_answer", { id, answer, source });
        res(answer);
      };
      this.pending.set(id, (a) => settle(a, a == null ? "stdin_closed" : "human"));
      timer = setTimeout(() => settle(null, "timeout"), this.timeoutMs);
    });
  }

  async askYesNo(question: string, def: boolean, meta: QuestionMeta = {}): Promise<boolean> {
    const a = await this.ask("permission_required", question, { default: def, ...meta });
    if (a == null) return def;
    return YES_WORDS.has(a.trim().toLowerCase());
  }

  askText(question: string, meta: QuestionMeta = {}): Promise<string | null> {
    return this.ask("human_pause", question, meta);
  }

  close(): void {
    this.stdinOpen = false;
    if (this.rl) {
      this.rl.close(); // fires "close" → flushes pending with null
      this.rl = null;
    } else {
      for (const resolve of [...this.pending.values()]) resolve(null);
    }
  }
}

/**
 * Pick the channel for this run. JSON mode (a reporter is present) means
 * a machine is watching stdout and may be able to answer over stdin —
 * the dashboard does. Otherwise a TTY gets readline; headless gets
 * defaults.
 */
export function createHumanChannel(opts: { reporter?: JsonReporter } = {}): HumanChannel {
  if (opts.reporter) return new JsonHumanChannel(opts.reporter);
  if (process.stdin.isTTY) return new TtyHumanChannel();
  return new HeadlessHumanChannel();
}
