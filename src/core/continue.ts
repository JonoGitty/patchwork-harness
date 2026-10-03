/**
 * `patchwork-harness continue` (ADR-0022): pick up an earlier run where it stopped.
 *
 * Two kinds, decided from the saved session, never guessed:
 *   resume     the run stopped part-way (a step failed, was refused, hit the
 *              spend ceiling, or the process was killed). The new session
 *              re-runs the parent's plan from the first step that did not
 *              finish - no new planning - with the finished steps' output as
 *              context and the reason it stopped on the first step.
 *   follow_up  every planned step finished, but something was left over (a
 *              step ran out of tool turns, the test gate still failed, the
 *              reviewer said incomplete), or the user gave a new instruction.
 *              The new session gets a goal built from those leftovers and the
 *              earlier run as context.
 * A finished run with nothing left over and no instruction is not continued.
 * The new session records `continued_from`; the parent is never modified.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { SESSIONS_DIR } from "../util/paths.js";
import type { SessionState, Step } from "./types.js";

export type Continuation =
  | {
      kind: "resume";
      from: string;
      goal: string;
      steps: Step[];
      at: number;
      why: string;
      context: string;
    }
  | { kind: "follow_up"; from: string; goal: string; why: string; context: string };

export class ContinueError extends Error {}

const CONTEXT_CHARS = 4000;
/** Most tool turns a resumed, previously out-of-turns step gets (the direct lane's budget). */
const RESUME_TURN_CAP = 20;

/** True when a process with this pid exists (EPERM means it exists but is not ours). */
export function processAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    resolve(p)
      .replace(/[\\/]+$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * The session to continue: `id` (a full id or a unique prefix), else the most
 * recent session started in `cwd`.
 */
export function findSession(opts: { cwd: string; id?: string; dir?: string }): SessionState {
  const dir = opts.dir ?? SESSIONS_DIR;
  const all: SessionState[] = [];
  if (existsSync(dir))
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        all.push(JSON.parse(readFileSync(join(dir, name), "utf8")) as SessionState);
      } catch {
        /* a half-written or foreign file is not a session */
      }
    }
  if (opts.id) {
    const hits = all.filter((s) => s.sessionId?.startsWith(opts.id as string));
    if (hits.length === 0) throw new ContinueError(`no session matches '${opts.id}'`);
    if (hits.length > 1)
      throw new ContinueError(
        `'${opts.id}' matches ${hits.length} sessions; give more of the id (\`patchwork-harness ls\`)`,
      );
    return hits[0] as SessionState;
  }
  const here = all
    .filter((s) => s.cwd && samePath(s.cwd, opts.cwd))
    .sort((a, b) => (b.started_at ?? "").localeCompare(a.started_at ?? ""));
  if (!here[0])
    throw new ContinueError(
      `no earlier session in ${opts.cwd}; pass --session <id> (\`patchwork-harness ls\`)`,
    );
  return here[0];
}

/** What the earlier run did, for the new session's planner and steps. */
export function priorContext(parent: SessionState): string {
  const lines = [
    `This continues an earlier session (${parent.sessionId}, status: ${parent.status}).`,
    `Its goal was: ${parent.goal}`,
  ];
  const steps = parent.plan?.steps ?? [];
  if (steps.length) lines.push("What its planned steps did:");
  steps.forEach((step, i) => {
    const r = parent.results[i];
    const status = r ? `${r.status}${r.turn_cap ? ", ran out of tool turns" : ""}` : "not run";
    const said = r?.output_summary?.trim().slice(0, 300);
    lines.push(`${i + 1}. ${step.title} [${status}]${said ? `: ${said}` : ""}`);
  });
  const extra = parent.results.slice(steps.length);
  if (extra.length) lines.push(`Then ${extra.length} repair step(s) ran.`);
  if (parent.verification)
    lines.push(
      `Test gate \`${parent.verification.cmd}\`: ${parent.verification.passed ? "passed" : `failed (exit ${parent.verification.exit_code})`} after ${parent.verification.attempts} attempt(s).`,
    );
  if (parent.review)
    lines.push(`Independent review (${parent.review.model}): ${parent.review.verdict}.`);
  const text = lines.join("\n");
  return text.length > CONTEXT_CHARS
    ? `${text.slice(0, CONTEXT_CHARS)}\n[earlier session context truncated]`
    : text;
}

function whyStopped(parent: SessionState, i: number, interrupted: boolean): string {
  const r = parent.results[i];
  if (!r)
    return interrupted
      ? "the run was interrupted (the process ended) before this step finished"
      : parent.status === "completed"
        ? "the earlier run was a dry run: the plan was made but not executed"
        : `the run ended (${parent.status}) during this step, before it recorded a result`;
  if (r.status === "failed") return `this step failed: ${r.error ?? "no error recorded"}`;
  if (r.status === "denied")
    return `this step was refused: ${r.error ?? "a permission prompt said no"}`;
  if (r.status === "completed" && r.turn_cap)
    return `this step used all ${r.step.max_tool_turns} of its tool turns without finishing${r.output_summary ? ` (its last output: ${r.output_summary.slice(0, 300)})` : ""}`;
  return `this step hit the spend ceiling: ${r.error ?? "bedrock reached"}`;
}

/** Work a finished-looking run left behind: capped steps, a failing gate, an incomplete review. */
export function leftovers(parent: SessionState): string[] {
  const out: string[] = [];
  const steps = parent.plan?.steps ?? [];
  steps.forEach((step, i) => {
    const r = parent.results[i];
    if (r?.status === "completed" && r.turn_cap)
      out.push(
        `Step ${i + 1} ("${step.title}") ran out of tool turns before it said it was done. Its task was: ${step.description.slice(0, 600)}${r.output_summary ? `\n  Its last output: ${r.output_summary.slice(0, 400)}` : ""}`,
      );
  });
  const v = parent.verification;
  if (v && !v.passed)
    out.push(
      `The test gate \`${v.cmd}\` still fails (exit ${v.exit_code}) after ${v.attempts} attempt(s). Make it pass without weakening the tests. End of its output:\n${v.tail.slice(-1500)}`,
    );
  const rv = parent.review;
  if (rv && rv.verdict === "incomplete") {
    const concerns = rv.concerns
      .map(
        (c) =>
          `  - [${c.severity}] ${c.issue}${c.evidence ? ` (evidence: ${c.evidence.slice(0, 200)})` : ""}`,
      )
      .join("\n");
    out.push(
      `The independent reviewer (${rv.model}) judged the work incomplete:\n${concerns || "  (no concerns listed)"}`,
    );
  }
  return out;
}

const RESUME_NOTE = (why: string) =>
  [
    "",
    `CONTINUING AN EARLIER RUN. It stopped here because ${why}.`,
    "The finished steps' output is in the session context. Files may already be partly changed: look at the current state before you redo anything, and do not undo earlier steps' work.",
  ].join("\n");

/**
 * Decide how to continue `parent`. Throws ContinueError when the run is still
 * going, or when it finished with nothing left over and no instruction.
 */
export function planContinuation(
  parent: SessionState,
  instruction?: string,
  alive: (pid?: number) => boolean = processAlive,
): Continuation {
  const ask = instruction?.trim() || undefined;
  const interrupted = parent.status === "in_progress";
  if (interrupted && alive(parent.pid))
    throw new ContinueError(
      `session ${parent.sessionId} is still running (pid ${parent.pid}); wait for it, or stop it first`,
    );
  const context = priorContext(parent);
  const steps = parent.plan?.steps ?? [];
  // Where the run stopped part-way: the first step with no result, or not completed.
  const stop = steps.findIndex((_, i) => parent.results[i]?.status !== "completed");
  // ...but an earlier step that ran out of tool turns did not finish either, so
  // a resume starts there. (A run whose steps all ran is a follow-up instead.)
  const capped = parent.results.findIndex((r, i) => i < stop && r.turn_cap === true);
  const at = capped >= 0 ? capped : stop;

  // A dry run is "completed" with a plan and no results: continuing executes it.
  const dryRun = parent.status === "completed" && steps.length > 0 && parent.results.length === 0;
  if ((parent.status !== "completed" || dryRun) && at >= 0) {
    const why = whyStopped(parent, at, interrupted);
    const remaining = steps.slice(at).map((s) => ({ ...s }));
    const first = remaining[0] as Step;
    // Re-running a step that ran out of turns with the same turns invites the same end.
    if (parent.results[at]?.turn_cap)
      first.max_tool_turns = Math.min(
        RESUME_TURN_CAP,
        Math.max(first.max_tool_turns * 2, first.max_tool_turns + 5),
      );
    first.description += RESUME_NOTE(why) + (ask ? `\nNote from the user: ${ask}` : "");
    return {
      kind: "resume",
      from: parent.sessionId,
      goal: parent.goal,
      steps: remaining,
      at: at + 1,
      why,
      context,
    };
  }

  if (!parent.plan && parent.status !== "completed")
    return {
      kind: "follow_up",
      from: parent.sessionId,
      goal: ask ? `${parent.goal}\n\nAlso, from the user: ${ask}` : parent.goal,
      why: `the earlier run (${parent.status}) stopped before it had a plan, so the goal runs again`,
      context,
    };

  const left = leftovers(parent);
  if (left.length)
    return {
      kind: "follow_up",
      from: parent.sessionId,
      goal: [
        `Finish the earlier task: ${parent.goal}`,
        "",
        "What is left:",
        ...left.map((l) => `- ${l}`),
        ...(ask ? ["", `Also, from the user: ${ask}`] : []),
      ].join("\n"),
      why: `${left.length} thing(s) were left unfinished`,
      context,
    };

  if (ask)
    return {
      kind: "follow_up",
      from: parent.sessionId,
      goal: ask,
      why: "a new instruction",
      context,
    };
  throw new ContinueError(
    `session ${parent.sessionId} finished with nothing left over; give an instruction: patchwork-harness continue "now also ..."`,
  );
}

/** Whether a finished session has something `patchwork-harness continue` would pick up without an instruction. */
export function isContinuable(state: SessionState): boolean {
  try {
    planContinuation(state, undefined, () => false);
    return true;
  } catch {
    return false;
  }
}
