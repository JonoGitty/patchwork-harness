# ADR-0022 — `patchwork-harness continue`: pick up a run where it stopped

**Status:** accepted · 2026-10-03
**Owner:** maintainers · drafted with Claude
**Depends on:** ADR-0015 (harness options), ADR-0016 (L5 reviewer), ADR-0018 (direct lane)

## Context

A run that stopped part-way had no way back in. The only option was to run
the goal again: new planning, and every finished step done twice. Three
things made this worse than it looked:

- **The session file was written only at the end.** A killed or crashed run
  left nothing to pick up; its plan and finished steps were lost.
- **A step that used all its tool turns was recorded as `completed`.** The
  executor's own audit note said "max_tool_turns reached", but the result
  did not. On 29 Sept, 4 of 9 real runs had hit that cap without anyone
  being told.
- **A failing test gate or an INCOMPLETE review ended the run.** Nothing
  carried their findings into the next attempt.

## Decision

`patchwork-harness continue [instruction]`, the same as `patchwork-harness run --continue`, takes
every run flag. It continues the latest session in the current directory,
or the one given by `--session <id|prefix>`. It reads the saved session and
decides one of two things (`src/core/continue.ts`):

| The earlier run | What continue does |
|---|---|
| **Stopped part-way:** a step failed, was refused or hit the spend ceiling; the process was killed (`in_progress` with a dead pid); or it was a `--dry-run` | **Resume.** Its plan re-runs from the first unfinished step, with no lane decision, world view, planner or critic. The first resumed step is told why the run stopped, and that files may already be partly changed. |
| **Every step ran**, but something was left over: a step ran out of tool turns, the `--verify-cmd` gate still failed, or the L5 review said INCOMPLETE | **Follow-up.** One direct-lane step (unless `--lane` says otherwise) with a goal built from the leftovers: the capped step's task, the gate's output tail ("without weakening the tests"), or the reviewer's concerns. |
| Finished clean | Nothing to continue, unless an instruction is given; then that instruction is the follow-up. |

- **What carries over:**
  - The earlier run's goal and per-step summaries reach the planner and every step.
  - Its test gate and its review apply again unless overridden.
  - An instruction rides along on a resume ("Note from the user").
- **A step that ran out of tool turns counts as unfinished.**
  - On a resume, an earlier capped step is where the resume starts, and it gets more turns: `min(20, max(2×, +5))`.
  - The executor now flags such steps (`turn_cap: true`) and warns. The status stays `completed`, so later steps still run as before.
- **The session file is saved after the plan and after every step,**
  atomically (temp file plus rename). It records the pid, so a killed run
  is detectable, and a live one is refused.
- **The new session records `continued_from`.** The parent is never modified.
- **Discoverability.**
  - A run that leaves work unfinished ends with a hint: "`patchwork-harness continue` picks it up".
  - JSON `session_end` carries `continuable`.
  - A dry run says `patchwork-harness continue` executes the plan.
  - A plan the user declined gets no hint.
- **MCP.** `harness_continue` (needs `confirm: true`, budget capped like `harness_run`).

## Evidence (3 Oct 2026)

- **`tests/continue.test.ts`, 15 tests.**
  - The rules: failed, killed, live, dry run, capped, gate, review, clean, no plan, instruction.
  - `findSession`: latest in this directory, prefix, ambiguous, broken files.
  - Two full `oneShot` runs on a scripted provider:
    - **Resume.** A failed run resumes from the failed step with **zero** planner calls. The session file held step 1's result while step 2 was running, and the parent's record is unchanged.
    - **Follow-up.** A capped step is flagged and followed up in one direct step.
  - The real CLI: `patchwork-harness continue` is not run as a goal called "continue".
  - `harness_continue` in the MCP test.
- **Mutation-checked: 9 of 9 caught.** Each of these was removed in turn, and a test failed every time:
  - the turn-cap flag
  - the per-step save
  - the resume branch
  - the context hand-off
  - capped-step leftovers
  - the live-pid check
  - the resume note
  - the argv rewrite
  - the dry-run case
- **Live, about $0.006 on GPT-6 Luna.** A real two-step run was killed after step 1. That step had, in fact, run out of its planner-given 2 turns without writing its file, which the new warning showed. Then:
  1. `continue` resumed at step 1 with 7 turns, with no new plan, and wrote the file.
  2. Step 2 then ran out of its 2 turns too. A second `continue` followed up in one direct step and wrote it.
  3. A third `continue` correctly said there was nothing left.

## Consequences

- **The live run is more evidence that the planner's tool-turn budgets are too small.** It gave 2 turns to "create a file", and the model spent both looking around. `continue` recovers from that; lifting the budget would prevent it.
- **Spend limits are per session.** Each continuation has its own session budget and bedrock, so a chain of continuations is not capped as a whole.
- **Evidence for verification is per session.** `--verify` on a continuation checks against that session's own tool output; the earlier session's evidence is not merged in.
