# ADR-0016 — L5 reviewer (`--review`)

**Status:** accepted · 2026-09-28
**Owner:** maintainers · drafted with Claude
**Depends on:** ADR-0008 (Layer 5, designed, never built until now), ADR-0011 (L4.5), ADR-0015 (test gate), `docs/research/2026-09-28-winning-harnesses.md` (shortlist #4)

## Context

The L1–L5 strategy exists "to ensure what's being done is being done
well". L1–L3 shape the plan and L4.5 checks the answer's facts. Nothing
judged whether the **finished work met the goal**, which is the job ADR-0008
gave L5.

The research found an independent verifier in its own context to be a
recurring feature of winning harnesses. Tekton (1st at Opus 4.8 Build Day)
used "independent verifier sub-agents graded each reconstruction in isolated
context windows". The Adversarial Review paper found that 3 agents with
structured, evidence-bound disagreement beat a 5-agent baseline.

## Decision

`patchwork-harness run ... --review [model]`, opt-in, and on MCP `harness_run` as `review`.

- **Independent.** The reviewer is the first reachable model in the new
  `reviewer` role whose vendor did **none** of the work. An explicit model id
  overrides this. The role's order comes from the calibration below:
  gpt-6-sol → claude-sonnet-5 → gemini-3.1-pro-preview.
- **Read-only by construction.** The executor gained `toolAllow`, and the
  review step is offered only `read`, `grep` and `glob`. A write attempt
  finds no such tool (tested).
- **Sees the truth, not the claims.** Its inputs are the goal, what each
  step claimed (labelled as claims), the ADR-0015 gate result, and the real
  change set: a snapshot of the tree (tracked and untracked) diffed against
  the run's first checkpoint, or against HEAD without one. That diff is
  recorded on the audit trail as tool output.
- **Rubric, as JSON:**
  - `goal_met`
  - `tests_passed`, taken from the gate; null when no gate ran, never guessed
  - `destructive`
  - `scope_ok`
  - `concerns[]`, each with **quoted evidence** ("no evidence, no concern")
  - `follow_up`
- **The rubric's rule is enforced in code.** A "complete" with
  `goal_met ≠ true`, a failed gate, or a destructive change is downgraded to
  "incomplete".
- **The reviewer is grounded too.** L4.5 checks the concerns' quoted
  evidence against the session's real tool outputs (the files it read, the
  diff, the gate). Any citation found nowhere is flagged, so the reviewer
  can't invent problems any more than the executor can invent successes.
- **Flag-only by default.** `--review-strict` makes a non-COMPLETE verdict
  fail the command (exit 1).
- **Side effect.** When the review builds its diff it leaves one extra ref
  in git, `refs/patchwork-harness/<session>/review`. HEAD, the index and the branch are
  untouched.

## Consequences

- **Tests.** `tests/reviewer.test.ts` has 6:
  - verdict parsing
  - independent-vendor selection
  - gate truthfulness in the prompt
  - read-only enforcement
  - downgrade of an inconsistent verdict
- **Measured in ADR-0017's eval** (`gate+review` config): whether the L5
  verdict agrees with each task's hidden check.
- **Not built.** Acting on `follow_up` automatically. ADR-0008's "propose ONE
  follow-up step the user can accept" is printed, not run.

## Calibration (28 Sept 2026): `patchwork-harness eval review starter`

The end-to-end eval could only show L5 *agreeing* on passes. Here the
failures are planted:
- 4 tasks, each with 1 good solution and 2 bad ones.
- Every bad solution **passes the visible tests** but breaks the spec, so a
  test gate cannot see it.
- All 12 were validated against the hidden checks first.
- Only the reviewer runs, on a real repo, with a real gate result and diff.

| Reviewer | Caught planted bugs | Passed good work | Accuracy | $/review | Notes |
|---|---|---|---|---|---|
| claude-sonnet-5 | 8/8 | 4/4 | 100% | 0.040 | |
| gpt-6-sol | 8/8 | 3/4 | 92% | 0.014 | its one "false alarm" is arguably right: the reference slugify drops `Ø` instead of mapping it to `o`, which breaks SPEC rule 2 on a strict reading |
| gemini-3.1-pro-preview | 6/6 | 2/2 | 100% of calls served | 0.037 | **4/12 calls errored** (preview API); the executor fell back to claude-fable-5-1, which got 4/4 at 0.115 |
| gpt-6-luna | 7/8 | 3/4 | 83% | 0.0007 | one unparsed reply; one real false alarm, and L4.5 flagged that citation as ungrounded |

**Decision.** The reviewer role is now gpt-6-sol → claude-sonnet-5 →
gemini-3.1-pro-preview.
- With the default Anthropic executor, GPT-6 Sol reviews: it caught every
  planted bug, is the cheapest reliable option, and is independent of the
  executor.
- Sonnet 5 reviews OpenAI work.
- Gemini is last because its preview API was unreliable.
- n = 12 per model is small; re-run `patchwork-harness eval review` when models change.

**L5 catches what a test gate structurally cannot:** 8/8 test-passing bugs
for both GPT-6 Sol and Sonnet 5.

## `--review-fix` (29 Sept 2026)

In live eval runs L5 flagged every real failure as INCOMPLETE, but it only
flagged them, so nothing got fixed. `--review-fix` (implies `--review`)
closes the loop:
- On an INCOMPLETE verdict with concerns, **one** repair step on the
  executor receives the reviewer's evidence-cited concerns and follow-up.
  It is told never to edit or weaken tests, and to explain if a concern is
  wrong.
- The step gets its own checkpoint (`review-fix`), then the gate re-runs,
  then L5 reviews again. All of it stays inside the bedrock.
- Available as an MCP `review_fix` parameter and as the `gate+review+fix`
  eval preset.
- `tests/review_fix.test.ts` drives the whole path through `oneShot` with
  scripted providers: INCOMPLETE, repair writes the missing file, re-gate
  (attempt 2) passes, re-review COMPLETE, run completed.
- A live eval of `gate+review+fix` is **pending**, because the Anthropic
  key ran out of credit on 29 Sept.
