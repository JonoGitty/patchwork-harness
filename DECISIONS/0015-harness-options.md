# ADR-0015 — Opt-in harness options: test gate, repair loop, checkpoints, guards

**Status:** accepted · 2026-09-28
**Owner:** maintainers · drafted with Claude
**Evidence:** `docs/research/2026-09-28-winning-harnesses.md`, which covers hackathon winners and leaderboard harnesses, every claim sourced
**Depends on:** ADR-0008 (the "propose ONE follow-up step" clause), ADR-0011/0012 (L4.5, verbatim provenance), ADR-0014 (MCP)

## Context

the maintainer asked for patchwork-harness to have "the options" that top hackathon-winning and
leaderboard harnesses use. The research found one shared shape that patchwork-harness
lacked: a finish gate that **runs something** (tests, a verifier), plus a
**bounded retry** until it passes. Examples:
- Factory Droid counts a task resolved only when its tests pass.
- Anthropic filters parallel attempts on regression tests.
- Using OpenHands' critic to stop early is worth +17.7 points.
- Tekton (1st at Opus 4.8 Build Day) loops "until all 20 tests passed".

Cheap runtime guards also helped: loop detection and time budgets; LangChain
gained +13.7 points from harness changes alone. patchwork-harness was already strong on
audit, cost caps, deterministic grounding and memory. Its gaps were all at
the "did it actually pass?" end.

## Decision

Every option is **opt-in** and off by default, on `patchwork-harness run` and on the
MCP `harness_run` tool:

| Flag | What it does |
|---|---|
| `--verify-cmd <cmd>` | **Test gate.** Runs after the plan, in cwd, through the bash tool. Exit 0 passes; anything else fails the run (CLI exit 1). Its verbatim output is recorded as a completed tool result, so **L4.5 can ground or refute a "tests pass" claim**. No model-authored input is recorded, so it cannot taint evidence. |
| `--verify-timeout <s>` | Kill the gate after s seconds (max 600). |
| `--attempts <n>` | **Bounded repair loop** (max 10). On a failed gate, one repair step on the executor model gets the goal plus the failure tail, then the gate re-runs. The instruction forbids weakening, skipping or editing the tests or check. All attempts spend inside the same bedrock. This is ADR-0008's "propose ONE follow-up step", repeated at most n−1 times. It is not L4, which stays deferred. |
| `--checkpoint` | Snapshots the whole working tree before every step and repair: tracked plus untracked files, with .gitignore honoured. It uses a throwaway index, so **your index, HEAD, branch and stash are never touched**. The commit sits under `refs/patchwork-harness/<session>/<label>`. Unlike Claude Code's checkpoints, this also captures edits made through bash. |
| `patchwork-harness rewind <session> [--to <label>] [--cwd] [-y]` | Lists or restores checkpoints. It snapshots the current state first (`pre-rewind-<ts>`), so a rewind is undoable. Files created after the checkpoint are removed. |
| `--guard-loop` | When a step makes the same tool call 3+ times, a note telling the model to change approach is appended to the tool result. |
| `--time-budget <s>` | Wall-clock budget for the whole run. The model sees time used in its per-turn system text; steps stop when it runs out. |

## Found and fixed while building this (pre-existing, not options)

- **The bash tool never worked on Windows.** It spawned `/bin/sh`, which
  doesn't exist under Windows node, so every command returned exit −1 with
  no output. Any step that "ran the tests", built or used git silently got
  nothing. `resolveShell()` now picks Git Bash on Windows (POSIX semantics,
  which is what models assume), then cmd.exe; `PATCHWORK_HARNESS_SHELL` overrides.
  Spawn failures now report their real error.
- **Prompt caching never hit, and cached tokens were unbilled** (measured on
  the live API, fixed the same day). The live budget line sat inside the
  cached system block, so every paid turn re-wrote ~4.3k tokens at 1.25×
  and read none. Anthropic's `input_tokens` also excludes cache writes and
  reads, so the bedrock never saw most input spend.
  - The budget line now travels as `systemDynamic`, after the breakpoint.
  - A second breakpoint sits on the newest message.
  - Pricing counts writes at 1.25× and reads at the model's rate.
  - Turns 2+ are now ~87% cheaper, and the ledger is honest.

## Live evidence (28 Sept 2026, installed CLI)

1. **Gate failure plus refusal to game.** The gate demanded a `NOTES.md` the
   goal never asked for. Two repair attempts on Opus 5.5 inspected with
   bash, explained, and **declined to fabricate the file**. Exit 1. Three
   checkpoints were taken, and rewind worked both ways.
2. **Real repair.** A seeded bug (`add.sh` subtracted) and a test that
   catches it; the goal was an unrelated README.
   - The gate failed.
   - The repair fixed `-` → `+` and left `test.sh` unchanged.
   - The gate passed on attempt 2; exit 0, $0.154.
   - L4.5 grounded the "5" / "-1" claims against the gate's output.

Tests: `tests/harness.test.ts` (7, including rewind to an empty snapshot) and
`tests/prompt_cache.test.ts` (6, including a mutation-checked executor test).

## Not built (from the research shortlist)

- **L5 reviewer** (`--review`): an independent, different-vendor rubric
  check after L4.5.
- **Per-phase effort profile.** The evidence is mixed: HAL found more effort
  often hurt.
- **Best-of-N with a selector.** Its parallel form conflicts with DIRECTION's
  "no parallel step execution"; a sequential form would not.
- **Retry the model fallback on 429/5xx** as well as 404.
- **An end-to-end eval suite** (`patchwork-harness eval`, Next-10 #8). Without it, none
  of these options can be proven to help on your own tasks.
