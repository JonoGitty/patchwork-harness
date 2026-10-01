# ADR-0018 — Intent lanes: a classifier in front of the planner

**Status:** accepted: `--lane direct` proven; `--lane auto` with Kev NOT recommended; LLM router is the next build · 2026-09-29
**Owner:** maintainers · drafted with Claude
**Depends on:** ADR-0008 (smart conductor), ADR-0013 (System One classifiers), ADR-0017 (eval)

## Question

Can a classifier model read a goal's intent quickly enough, and accurately
enough, that small jobs skip the world view, planner and critic? Would that
make runs faster and use fewer tokens, without costing quality? the maintainer asked
for the idea to be proven good or bad with the harness, not argued.

## What the audit trail said before anything was built

From 68 logged runs that spent money (58 eval runs, 10 real jobs):

- Planning takes a **median 13.8 s** before the first step. That is **24%** of
  a run's wall time.
- The planner made **3 steps in 59 of 68 runs**, even for "create hello.txt
  containing hi" (25 s, $0.12).
- In 3-step runs, steps 2 and 3 carry **79%** of executor input tokens.
  **45%** of all file reads re-read a file that an earlier step had already
  read.
- Input tokens outweigh output tokens **18 : 1**. The saving lies in not
  resending context, not in shorter answers.
- **Found on the way: planner and critic calls were never on the ledger.**
  They recorded no tokens and no cost, so every session total left planning
  out, and so did the bedrock check. Fixed here:
  - `plan()` takes an `onUsage` callback.
  - The orchestrator adds that spend to the budget and emits a
    `provider_response` with `phase: planner|critic`.
  - `tests/intent.test.ts` asserts the planned total includes planner and
    critic spend. It failed with the fix removed.

## Decision

`patchwork-harness run --lane planned|direct|auto` (`src/core/intent.ts`):

- **planned** is the default and is exactly the old pipeline.
- **direct** skips the world view, lessons, context, planner and critic. One
  executor step gets the whole goal and 20 tool turns (a 3-step plan's
  budget in one conversation).
  - `--lane-model <id>` picks that step's model. The default is the executor
    role.
  - The test gate, repair loop, L5 review and L4.5 verifier run exactly as
    on the planned lane.
- **auto** asks a System One model (Jev, or local Kev) one choice question
  over four lanes: answer · direct · planned · unclear.
  - It takes the direct lane only if P(answer) + P(direct) ≥
    `--lane-threshold` (default 0.8).
  - Anything else (unsure, unclear, no classifier, an error, a malformed
    reply) takes the planned lane.
  - The decision, P and latency go on the audit trail as `route_decision`
    `harness: intent`.
- Eval presets: `direct`, `intent`, `gate+direct`.

## Evidence 1: can a classifier read intent? (offline, no executor spend)

**Test set: 247 real requests.**
- 160 of the maintainer's own Claude Code messages
- 66 subagent task briefs
- 21 unique patchwork-harness goals

**Labels.**
- Two blind Opus judges each labelled the cheapest lane that would still do
  the request well, judged from the text alone.
- Agreement: κ **0.85** 3-way (fast / planned / unclear) and κ 0.83 4-way.
- The **224** items they agreed on are the test set.

**What real traffic looks like.** Of the 224 consensus items:

| Source | Fast | Planned | Unclear |
|---|---|---|---|
| All | **15%** | 45% | **40%** |
| the maintainer's messages | 12% | 26% | **62%** |
| Subagent briefs | 10% | 90% | 0% |
| patchwork-harness goals | **48%** | 43% | 10% |

- "Unclear" means the request only makes sense with the earlier
  conversation ("yus go", "1 then 3"). The median unclear message is 45
  characters.
- The patchwork-harness-goal share is skewed upward: that population includes eval and
  smoke-test goals.

| Router | 3-way acc. | Routed fast | Right | Wrong: planned / unclear | Latency |
|---|---|---|---|---|---|
| Constant "planned" (today) | 45.1% | 0 | n/a | 0 / 0 | 0 |
| Kev-0.8B, P ≥ 0.8 (the default) | 46.9% | 0 | n/a | 0 / 0 | 67 ms |
| Kev-0.8B, P ≥ 0.5 | | 21 | 38% | 8 / 5 | 67 ms |
| gpt-6-luna (LLM baseline) | **78.6%** | 32 | 56% | 3 / 11 | 2.1 s |
| gpt-6-luna, patchwork-harness goals only | | 8 | **100%** | 0 / 0 | 2.1 s |

- **Kev-0.8B fails.**
  - Its accuracy is within noise of the constant baseline, and its fast-vs-not
    AUC is 0.61.
  - The median P(fast) is 0.41 on truly fast requests and 0.40 on the rest.
  - At the default threshold it never routes anything, so `--lane auto` with
    Kev is safe but does nothing.
  - This is the second failed task for Kev-0.8B, after grounding triage in
    ADR-0013.
- **A cheap LLM router works, but only on self-contained goals.**
  - On patchwork-harness goals it routed 8, all correctly, and caught 80% of the fast
    ones.
  - All 14 of its misroutes were short chat messages whose meaning lived in
    earlier turns.
  - Its median latency is 2.1 s, against 13.8 s of planning. It cost $0.0475
    for 247 requests.

## Evidence 2: when the route is right, does the direct lane help? (live)

**Setup.**
- Suite: `evals/starter`, 4 small tasks, each scored by a hidden check the
  agent never sees. 4 trials per task per arm.
- Every arm ran on OpenAI and Gemini models, because Anthropic was out of
  credit.

| Arm | Passed | Median time | Before 1st step | Input tokens (median) | of which planning | Output | Billed / run | At GPT-6 Sol prices |
|---|---|---|---|---|---|---|---|---|
| **Eval 2** (one build) · pipeline | 8/16 | 61.5 s | 17.1 s | 43.9K | 9.9K | 4.2K | $0.054 | $0.264 |
| **Eval 2** · `--lane direct --lane-model gpt-6-sol` | **16/16** | **42.2 s** | 0.1 s | **16.3K** | 0 | 1.2K | $0.053 | $0.090 |
| Eval 1 · pipeline | 8/16 | 64.9 s | 16.6 s | 33.2K | not logged (old build) | 2.4K | $0.049 | $0.198 |
| Eval 1 · `--lane direct` (executor fell back to GPT-6 Astra) | **16/16** | **32.9 s** | 0.1 s | **17.8K** | 0 | 1.0K | $0.228 | $0.091 |

**Eval 2 is the fair comparison.**
- Both arms ran in the same build.
- The direct lane used GPT-6 Sol, which is the model the planner itself
  chose for every "implement" step.
- Pass rate: 16/16 against 8/16, one-sided Fisher p = 0.001. Across both
  evals it is 32/32 against 16/32 (p ≈ 1e-6).
- Input tokens: −63%. Wall time: −31%. The bill is the same.
- At equal prices the pipeline costs 2.9× more. The bill hides this because
  the pipeline puts most of its calls on Gemini 3.8 Flash.

**Why the pipeline fails here.**
- The planner split every task into inspect → implement → verify and gave
  each step 5 tool turns.
- 28 of 32 pipeline runs hit that cap in at least one step.
- The implement step (GPT-6 Sol) started from a summary of the spec written
  by a cheaper model.

**The direct lane did not win on budget.**
- It used a median of 6.5 turns out of its 20, and at most 10.
- The pipeline used a median of 13 turns.

**Eval 1 confounds lane with model.** Its direct arm ran on the flagship,
which cost 4.7× more on the bill. That is why `--lane-model` exists.

**What that means on realistic traffic.** This is an estimate, not a
measurement.
- About 48% of patchwork-harness-style goals need no plan, and a Luna router catches
  80% of them. So about 38% of runs would take the direct lane.
- Expected change per run, after paying the ~2 s and ~450 tokens of routing
  on every run: **about −23% input tokens and −9% wall time**.
- On chat traffic (12% fast, 62% unclear) the saving is small, and misroutes
  are likely.

## Verdict

**Good idea, wrong classifier.**

1. **The direct lane is a clear win on one-pass jobs.**
   - It passes more hidden checks, uses about a third of the input tokens,
     and takes about two thirds of the time, at the same bill.
   - Keep `--lane direct` / `--lane-model`, with the planned lane as the
     default.
2. **Kev-0.8B cannot route intent.** It scores no better than a constant
   answer. Do not ship `--lane auto` with Kev as the router, and do not
   make `auto` the default.
3. **A cheap LLM router works for self-contained goals.** Harness and MCP
   goals can be routed this way (gpt-6-luna: 8/8 correct on patchwork-harness goals,
   about 2 s, about $0.0002 a call).
   - The next build is an LLM backend for `--lane auto`, scoped to goals.
     "Unclear" routes to planned.
4. **Never route a chat message on its own.** 62% of the maintainer's own messages
   depend on the conversation around them. Route with context, or not at
   all.
5. **The planner's slicing is a finding in its own right.** It makes 5-turn
   steps and uses 3 steps for everything, whether or not a router exists.
   - Allowing one-step plans and larger step budgets should help the
     planned lane.
   - Test it with the same eval.
6. **The ledger fix stands on its own.** Planning spend is now counted in
   session totals and against the bedrock.

## Method notes and limits

- Anthropic credit was out for the whole live eval. Every arm ran on
  OpenAI and Gemini models, and the planner's routing reflects that. Re-run
  it with Opus 5.5 once credit is back:
  `patchwork-harness eval run starter --configs baseline,direct --trials 4`.
- The starter suite is 4 small tasks, all of them direct-lane candidates.
  It measures the benefit of a correct route, not the cost of a wrong one.
  The cost of routing a planned-class task to the direct lane is not yet
  measured. That needs a suite of multi-part tasks.
- Jev (TypeSafe's hosted model) was not tested: there is no
  `TYPESAFE_API_KEY`. The offline harness above scores it in minutes once
  there is one.
- Data (outside the repo):
  - the labelled set, judges' labels and router outputs are in
    `~/.patchwork-harness/intent/2026-09-29/`
  - the eval files are in `~/.patchwork-harness/evals/`

## Addendum, 29 Sept: custom classifier vs general LLM router

**Question.** Is it better to train your own small classifier, or to ask a
general LLM?

**Method.**
- Features: local embeddings.
- Model: a logistic-regression head.
- Data: the same 224 consensus items.
- Validation: 5-fold CV repeated 10–20 times.
- Scripts: `custom_clf.py` and `custom_route.py` in
  `~/.patchwork-harness/intent/2026-09-29/`.

| Router | 3-way acc. (224) | patchwork-harness goals: routed-fast precision / recall | Latency | Per call | Runs |
|---|---|---|---|---|---|
| Constant "planned" | 45.1% | n/a | 0 | $0 | anywhere |
| Kev-0.8B zero-shot | 46.9% | n/a | 67 ms | $0 | local GPU |
| Kev's own backbone (Qwen3.5-0.8B) + trained head | **75.1%** | n/a | 62 ms | $0 | local GPU |
| bge-small-en-v1.5 + trained head | 72.5% | **100% / 95%** (argmax) | **3.4 ms** | $0 | local GPU |
| gpt-6-luna (general router) | **78.6%** | 100% / 80% | 2,100 ms | ~$0.0002 | OpenAI |

- **Kev's failure was zero-shot use, not the model.** Kev's backbone with a
  trained head jumps from 46.9% to 75.1%.
- **Learning curve (bge-small head).** 40 labels: 68.7%. 80: 71.2%. 120:
  72.5%. 179: 72.5%.
  - The Kev-backbone head reaches 75.1% at 179 labels, so it is still
    climbing slowly.
  - About 200 labels gets within 4–6 points of the LLM router.
- **Distillation.** A head trained on Luna's labels (free labels at any
  scale) scores 66–71%. It learns the teacher's mistakes and stays below
  the teacher.
- **The threshold is tunable.** Over all 224 items at P ≥ 0.6, the custom
  head routes fast with 96% precision and 18% recall. Luna's labels give a
  fixed 56% / 55%.
- **Caveat.** The patchwork-harness-goal subset is only 21 items, so the 100% / 95%
  is optimistic. The 224-item numbers are the solid ones.
- **Neither fixes "unclear".** That is missing input (the conversation), not
  a weak model.

**Implication for the build.** Use a cascade:
1. A local custom head decides when it is confident.
2. Otherwise the LLM router decides.
3. Otherwise the goal takes the planned lane.

Labels come from **outcomes on the audit trail**: the lane taken, and
whether the gate, hidden check and review passed. Retrain behind the eval,
so a new head must beat the old one and the constant before it ships.

## Addendum 2, 29 Sept: the cascade, built and run live

**Built.** `--lane auto` is now the cascade:
1. The intent head decides alone when P(fast) ≥ 0.6 (direct) or < 0.4
   (planned).
2. Between those, `defaults.intent_router` (gpt-6-luna) is asked. Only a
   "no plan needed" at confidence ≥ 0.9 counts.
3. Everything else, including every failure, is planned.

**Supporting pieces.**
- **The head.** `scripts/intent/train_head.py` trains it: bge-small
  embeddings plus logistic regression.
  - It writes `~/.patchwork-harness/intent/head.json`.
  - It refuses to write a head that does not beat the constant baseline.
- **The server.** `scripts/intent/serve_head.py` serves the head over the
  System One wire format.
  - Point `PATCHWORK_HARNESS_INTENT_URL` at it.
  - It is local and not auto-started (see Running it).
- **`patchwork-harness route "<goal>"`** previews a routing decision without running
  anything.
- **The ledger.** The router's LLM spend is recorded as
  `provider_response phase: router`.
- **Tests.** 13 in `tests/intent.test.ts`. The confidence floor was
  mutation-checked.

**Training data.** 220 consensus labels, with the 4 starter goals held out.
Cross-validated accuracy is 72.3%, against 45.9% for the constant.

**Found on the way: a fallback bug.**
- The `workhorse` tier holds only Sonnet. With Anthropic's account out,
  every step the planner gave Sonnet failed outright: no other vendor
  existed in that tier, and the default executor is also Anthropic.
- `fallbackModelFor` now widens to the nearest tiers (`NEAREST_TIERS`).
  The new test in `tests/availability.test.ts` fails without the fix.
- This contaminated the first attempt at eval 3. That attempt was stopped
  and re-run.

**Eval 3.**
- Same build, holdout goals, 4 trials, with `--lane-model gpt-6-sol`.
- Anthropic was still out.

| Arm | Passed | Median time | Before 1st step | Input tokens | of which planning | Billed / run | At Sol prices |
|---|---|---|---|---|---|---|---|
| Pipeline | 12/16 | 68.3 s | 19.4 s | 46.0K | 9.9K | $0.057 | $0.289 |
| `--lane auto` (cascade) | 11/16 | 48.1 s | 1.3 s | 16.8K | 0 | $0.051 | $0.152 |

**Routing, live.**
- 11 of 16 runs went direct:
  - duration 4/4, decided by the head
  - slugify 4/4, decided by the head
  - csv-sum 3/4, decided by the LLM
- 5 went planned:
  - paginate 4/4, where the LLM said "planned" at 0.82
  - csv-sum 1/4
- The head took a median 49 ms.
- The LLM was asked in 8 of 16 runs, at a median 3.2 s. The simulation
  predicted about 17% for goals of this kind; these goal texts sit in the
  uncertain band more often.
- No wrong-fast routes. The paginate routes were a missed saving, and the
  planned runs passed 4/4.

**What eval 3 changes.**
- **Tokens and time: the win is robust.** All three evals agree:
  - −46% to −63% input tokens
  - −30% to −49% wall time
  - −11% billed, −47% at equal prices, in eval 3
- **Quality: the earlier "clear win" does not hold up.**
  - In eval 3 the cascade was one run worse (11/16 against 12/16).
  - Per-task results swung hard between evals, on the same models and the
    same prompts, within one afternoon:
    - the pipeline's slugify went from 0/4 to 4/4
    - the direct lane's slugify went from 4/4 to 0/4
  - The direct-lane slugify failures are GPT-6 Sol adding transliteration
    tables (ß→ss, æ→ae, þ→th), which break SPEC rule 4, "drop every other
    character". Earlier runs of the same model followed the spec literally.
  - Pooled across all three evals: direct-type arms 43/48, pipeline 28/48
    (one-sided p ≈ 0.0005). The arms differ between evals, so read that as
    "no worse, probably better", not as a measured quality gain.
- **Method lesson.** 16 runs per arm cannot carry a pass-rate claim through
  day-to-day model variance. Quality claims need more trials, a bigger
  suite, and arms interleaved in one run. Two runs of the same arm hours
  apart are not interchangeable.

**Running it.**
```bash
# once, after a reboot (WSL):
~/kev/.venv/bin/python scripts/intent/serve_head.py --head ~/.patchwork-harness/intent/head.json --port 8010 &
# then:
PATCHWORK_HARNESS_INTENT_URL=http://127.0.0.1:8010 patchwork-harness run "<goal>" --lane auto --lane-model gpt-6-sol
patchwork-harness route "<goal>"        # preview only
```
With no head running, `auto` falls back to the LLM router alone. With
neither available, it runs the planned lane.

## Addendum 3, 29 Sept: is it providing real use?

**Real use so far: close to none.** patchwork-harness has had 9 real runs (2–28 Sept),
against 156 eval runs.

Replayed through the cascade, 8 of the 9 go to planned. They are
multi-file adversarial and security reviews, and every one was decided by
the head alone (P 0.08–0.23), with no LLM calls. The one direct candidate
was a $0 flag change (P 0.73).

Nothing calls `--lane` by default, MCP `harness_run` does not expose it, and
the head server is not auto-started.

**What does reach real runs:**
- **The planner's step cap.** 4 of the 9 real runs hit the 5-turn cap, on
  5 of 12 steps. One real security review also stopped at the $1 bedrock.
- **The ledger fix.** Every planned run.
- **The fallback fix.** Every run, whenever a vendor is down.

**Next, in order:**
1. Lift the planner's step budget and test it with the same eval.
2. Expose `lane` on MCP and auto-start the head. That is where small
   delegated jobs would use the lane.
3. Retrain the head from outcome labels.
4. Run a bigger, interleaved eval.

## Addendum 4, 1 Oct: lessons from Jeff and its adapter kit

**Jeff base zero-shot on the 224 intent items.**
- 3-way accuracy 72.3%: the same as our trained head with sessions held out
  (70.3%), and far above Kev zero-shot (46.9%).
- Fast-vs-not AUC is only 0.665, so it is weak at the fast/not split.
- "Answer twice" (`orders: 2`, options reversed and averaged) did not help
  (69.6%).

**The kit's checks, run on our head.**
- **Shortcut.** A model that sees only length, punctuation and case scores
  67.4%, against 70.3% for the embedding head. Most of the head's skill is a
  length shortcut: "unclear" messages are short.
- **Group split.** The 156 chat items come from only 20 sessions. Holding
  out whole sessions drops the head from 72.6% to 70.3%.
- **Calibration.** The head's ECE is 0.11. Jeff's adapters run 0.004–0.02.
  The cascade thresholds sit on uncalibrated probabilities.
- The cascade stays safe: under the group split, P ≥ 0.6 is still 98%
  precise. But its recall is the weak, shortcut-heavy part.

**What to adopt.** These are Jeff's practices.
1. Build data in the kit's row format, with a `family` per session. Split by
   family into train, development, calibration and test, then run
   `jeff-kit leak-check` and `shortcut-report` before trusting any score.
2. Fit one temperature on the calibration split, and report ECE next to
   accuracy.
3. Choose each threshold on calibration rows as the fastest that still
   beats the LLM by ≥ 1 point, and freeze it before scoring test rows.
4. For a real intent adapter: train on Jeff v1.3, the long-term-support
   base due about 2–3 Oct. Adapters do not carry across bases; data sets
   do. It needs thousands of rows across many families, not 220, plus
   outcome labels from the audit trail.
