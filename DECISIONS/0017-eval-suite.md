# ADR-0017 — `patchwork-harness eval`: end-to-end task suites

**Status:** accepted · 2026-09-28
**Owner:** maintainers · drafted with Claude
**Depends on:** DIRECTION Next-10 #8, ADR-0015 (harness options), ADR-0016 (L5)

## Context

The research behind ADR-0015 ended on one point: none of the harness options
can be *shown* to help on your own tasks without an eval harness that has
repeated trials and a deployment-aware baseline (Terminal-Bench scores move
±1–2 points per run). The rule behind L4.5 applies to the harness itself:
claims need evidence.

## Decision

`patchwork-harness eval run <suite> --configs baseline,gate,gate+review [--config name="--flags"] [--trials n] [--parallel n] [--max-usd n]`

- **Suite layout.** `evals/<suite>/<task>/` holds:
  - `task.json`: `{goal, verify, check, budget_usd}`
  - `seed/`: the repo the agent starts from
  - `hidden/`: ground truth, copied in **only after** the run, so the agent can't read or game it
- **Each run.** Every (config, task, trial) gets a fresh git repo and a real
  `patchwork-harness run -u` subprocess. Then the hidden check runs through the bash tool.
- **Configs.** Presets are baseline, gate, review, gate+review and
  gate+guards; `name="--flags"` defines a custom one. `{verify}` expands to
  the task's visible test command.
- **Scoring.** Pass rate on the hidden check, mean and total cost, and mean
  time. For configs with `--review`, **L5 agreement** is also scored: how
  often the reviewer's COMPLETE/INCOMPLETE matched the hidden truth.
- **Cost guard.** It refuses to start when the worst case (the sum of task
  budgets × configs × trials) exceeds `--max-usd` (default $5).
- **Output.** Results go to `~/.patchwork-harness/evals/<ts>-<suite>.json`. MCP
  `harness_eval` requires confirm.
- **Starter suite** (`evals/starter`), 4 plain-Node tasks with no installs:
  - `slugify`: rules live in SPEC.md
  - `duration`: an underspecified goal plus SPEC.md
  - `paginate`: a bug report with edge cases
  - `csv-sum`: a CLI with quoted-field data

  Each hidden check was **validated before use**: it passes a reference
  solution and fails the untouched seed.

## The eval found real bugs on its first run (fixed the same day)

1. **No GPT-6 or GPT-5.6 model could run a step with tools.** Chat
   completions reject function tools for gpt-6-astra/sol/luna and
   gpt-5.6-sol/luna ("use /v1/responses"). Every step the planner routed
   there, and any L5 review assigned to GPT-6 Sol, crashed on its first
   turn. Tool-bearing requests for those models now go through the
   Responses API. A full tool round trip is proven live, and
   `tests/openai_sampling.test.ts` covers the routing.
2. **A provider error killed the whole run with no session_end.** The
   executor now tries up to two same-tier fallbacks for **any** provider
   error, not just 404s, and then fails the *step* cleanly
   (`tests/provider_resilience.test.ts`).
   - The planner retries once with the failure fed back, then uses
     `planner_fallback`.
   - `oneShot` always writes session_end, then rethrows, so the CLI still
     exits 1.
   - A run that dies still carries its stderr into the eval row.

## Results (28 Sept 2026, after the fixes; 24 runs, $4.85)

| Config | Passed the hidden check | Mean cost | Mean time |
|---|---|---|---|
| baseline | 7/8 | $0.171 | 52 s |
| gate (`--verify-cmd {verify} --attempts 3`) | 7/8 | $0.194 | 62 s |
| gate+review (+ `--review`) | **8/8** | $0.241 | 82 s |

- **L5 agreed with the hidden check 8/8.** All 8 of those runs were passes,
  so this shows the reviewer does not raise false alarms. It does **not**
  yet show that it catches failures.
- **Baseline failure (paginate, trial 2):** the agent declared the fix done
  without making it; page 1 still returned `[c, d]`. This is exactly what a
  gate on the visible test catches.
- **Gate failure (paginate, trial 2):** the gate passed, but page 0 returned
  `[b, c]`. The visible test only covers page 1, and **a gate can only
  enforce what the visible tests check**. Better visible tests, or L5,
  cover the rest.

**Honest reading.** n = 8 per config: each gap is a single run and not
statistically significant. The direction is consistent with the research;
the evidence is thin. Costs relative to baseline: gate +13% money and +19%
time; gate+review +41% and +58%.

## Next

- More trials (the suite is cheap: ~$0.20 per run).
- Tasks where the visible tests are deliberately incomplete, so the L5
  reviewer is tested on catching failures, not only on confirming passes.
- A Jev/Kev classifier config once `TYPESAFE_API_KEY` exists.

## Second batch plus combined results (29 Sept 2026; 48 runs in total since the fixes, $9.55)

The reviewer role had changed to gpt-6-sol first (ADR-0016 calibration).

| Config | Passed hidden (n=16) | paginate (the discriminating task) | Mean cost | Mean time |
|---|---|---|---|---|
| baseline | 13/16 | 1/4 | $0.173 | 56 s |
| gate | 15/16 | 3/4 | $0.208 | 61 s |
| gate+review | 14/16 | 3/4 | $0.217 | 71 s |

- **L5 agreed with the hidden check 15/16**, and it flagged **both**
  gate+review failures as INCOMPLETE. It catches real failures in the wild,
  not only planted ones, but flag-only means nothing fixed them. That is
  why `--review-fix` was added (ADR-0016).
- One gate+review "failure" was not the harness at all. **patchwork-harness's Anthropic
  key ran out of credit** mid-batch, so every Anthropic call returned "credit
  balance is too low". The executor fell back to Opus 5.5 and then Opus 5 on
  the **same empty account**. Fixed:
  - `isAccountWideError` (no credit, quota, bad key, 401/403) now skips
    **every** model from that provider and hides them from the planner for
    the cache window.
  - The first fallback goes straight to another vendor
    (`tests/provider_resilience.test.ts`).

## L5 calibration on planted bugs

`patchwork-harness eval review` has 12 cases; every bad one passes the visible tests.
GPT-6 Sol and Sonnet 5 each caught 8/8. See ADR-0016 for the table and the
resulting reviewer order.
