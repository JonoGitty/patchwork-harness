# ADR-0013 — Classifier triage (a decision model between L4.5 and L5)

**Status:** accepted (Phase 1: flag-only, opt-in) · 2026-09-28
**Owner:** maintainers · drafted with Claude
**Depends on:** ADR-0011 (L4.5 Grounding Verifier), ADR-0008 (L5 reviewer, deferred)

## Context

L4.5 checks the atoms it can check (numbers, dates, paths, ids, quoted
strings, URLs) and marks the rest MISSED. The biggest MISSED class is the
qualitative claim: "the tests went smoothly", "the refactor is robust", "the
suite is comprehensive". Those are exactly the "was it done well?" claims,
and today nothing looks at them before a human does.

A new class of model fits this gap. **Jev** (TypeSafe AI, Sept 2026) is a
*decision model*: it answers fixed questions (yes/no "noul", multiple
choice, score) with calibrated probabilities instead of generated text,
about 300 ms per call, many questions sharing one state. **Kev**
(github.com/jaredpalmer/kev, Apache-2.0) is an open family that serves the
same System One API locally. Jev's API is `POST https://api.typesafe.ai/v1/systemone`.

The evidence available is limited but useful. Archestra tested Jev on 100
real Claude Code tool calls. It scored 93% zero-shot against a 79% constant
baseline, and made **no errors at confidence ≥0.7**. Only 35–39% of its
probabilities were bit-identical across reruns (max swing 0.17). Option
reordering flipped 5–7 of 100 multi-way answers and **none of the binary
ones**.

## Decision

1. **A System One client** (`src/classifier/systemone.ts`) with one wire
   format and two backends. `PATCHWORK_HARNESS_CLASSIFIER_URL` points at a local Kev
   (or any System One server). Otherwise `TYPESAFE_API_KEY` selects hosted
   Jev. The client retries on 429/529 and rejects any reply that leaves a
   question unanswered or returns a number outside [0,1].
2. **Triage** (`src/verifier/triage.ts`) sends every atom L4.5 marked
   MISSED, and nothing else, as one **binary noul question**. It uses one
   request, one shared state and fixed wording. The state holds untainted
   tool-output lines only (L4.5's own `indexEvidence`), ranked by word
   overlap with the claim, then filled newest-first up to a size cap. The
   cap is 1500 chars for Kev, which was trained on states of 384 tokens or
   less, and 8000 for Jev.
3. **Bands, frozen:** p ≥ 0.7 is *likely supported*, p ≤ 0.3 is *likely
   unsupported*, and everything between is *uncertain*.
4. **Surface:** `patchwork-harness verify file|session|claude --classify` prints a
   separate block under the report, headed "routes, not verdicts". With
   `--json` it adds a `triage` field.

## The law, restated for this layer

> A probability is a route, not proof. **The classifier cannot make
> anything green.** `triage()` reads the Report and returns a separate
> object. It changes no verdict, no count, no `overall` and no exit code.
> A classifier that is down, slow or wrong degrades to exactly today's
> behaviour.

The law is enforced by test. A stub classifier answering p=1.0 to
everything is run over **all 26 corpus cases**, and every report and exit
code must come back identical. The same holds end to end through the CLI:
fab-001 still exits 1 with a certain classifier attached.

## Why these choices

- **Binary only:** Archestra saw zero option-order flips on binary
  questions and 5–7 in 100 on multi-way ones.
- **Tainted text never goes into the state:** otherwise the classifier
  could be talked into "supported" by the model's own writing. This is the
  same laundering defence as L4.5's taint rule (see the poison-002 test).
- **Overlap orders the evidence but never gates it.** Found live on
  28 Sep 2026: with overlap-only selection, a 96%-coverage suite and an
  11%-coverage suite both sent an empty state, and Kev answered 0.34 to
  each. There is a regression test.

## Field results, 28 Sep 2026 (Kev-0.8B, local, RTX 3070 Ti 8 GB)

Four hand-made probes, same claim against opposite evidence:

| Claim | Supporting evidence | Contradicting evidence |
|---|---|---|
| "The deploy went smoothly" | 0.84 ↑ | 0.03 ↓ |
| "The test suite is comprehensive" | 0.73 ↑ | 0.01 ↓ |

Three identical reruns returned identical probabilities (0.7311). The
L4.5 verdict stayed UNVERIFIABLE (exit 2) in every run.
**Four probes are not calibration.** Kev-0.8B scores 0.648 on Kev's own
unseen-source benchmark, well below Jev's 0.857, and only 0.8B fits in this
laptop's VRAM.

## Phase 2 calibration, 28 Sep 2026: Kev-0.8B on real data

**Method.**
- `scripts/calibrate_classifier.ts` walked 543 Claude Code transcripts:
  sessions plus subagent and workflow reports.
- It ran L4.5 on each final answer and sent the MISSED atoms to Kev with
  the exact request `triage()` builds.
- That gave **290 unique atoms**:
  - 229 numbers (supported only by tainted evidence)
  - 46 qualitative claims
  - 7 quoted strings, 4 paths, 1 date
- Two sessions were skipped as too large; 4 calls dropped on the
  Windows→WSL link.
- **Two independent blind judges** (Opus subagents) labelled every atom
  from the same state Kev saw, without seeing Kev's scores.
- Only items both judges agreed on are scored (`scripts/score_calibration.py`).
- The data is kept under `~/.patchwork-harness/calibration/`, outside the repo,
  because it contains transcript excerpts.

**The judges found a bug in `triage()` first.** `sentenceAround()` used
`indexOf`, so "1.2" (from "1.2 ms") landed inside an earlier "1.25 GHz",
and Kev was asked about the wrong sentence.
- Fixed with `locateAtoms()`, which walks the atoms in order and matches
  numbers at L4.5's own token boundaries. There is a regression test,
  confirmed to fail on the old logic.
- The harvest was re-run: 180 items changed and were relabelled blind.
- Judge agreement rose from 91.5% (κ 0.50) to **99.0% (κ 0.92)**.

**Results, corrected set, n = 287 consensus items:**

| Metric | Kev-0.8B | Constant "unsupported" |
|---|---|---|
| Accuracy (threshold 0.5) | **0.861** | **0.934** |
| Brier score (lower is better) | 0.134 | 0.062 |
| AUC | 0.725 | 0.5 |

| Band | n | Actually supported | Actually unsupported |
|---|---|---|---|
| p ≥ 0.7 "likely supported" | 16 | 5 | **11 (69% wrong)** |
| uncertain | 117 | 8 | 109 |
| p ≤ 0.3 "likely unsupported" | 154 | 6 | 148 (96% right; base rate 93%) |

- **Base rate:** only 6.6% of MISSED atoms are supported by the evidence
  shown.
- **Qualitative claims:** 46, and **not one** was supported by the tool
  outputs shown. Agents' "done well" claims in these sessions come with no
  direct evidence, which vindicates L4.5 marking them MISSED.

**Verdict: Phase 2 FAILED for Kev-0.8B. Phase 3 is not earned.**
- It loses to the constant on accuracy and on Brier.
- Its "likely supported" band is wrong 11 times in 16.
- The pattern in those errors is consistent: **topically related evidence
  scores as support.** Examples: a database named but its contents not
  shown; the old README wording shown for a claim about the new one.
- The AUC of 0.73 is real but weak ranking signal.
- The law held throughout. None of this could move a verdict or an exit
  code, and that is exactly why the classifier is triage-only.

**Caveats.**
- The labels come from two model judges, not humans.
- Everything is judged on the capped excerpt (1500 chars for Kev), not the
  whole session.
- The dataset is dominated by tainted-only numbers, where untainted
  support is rare by construction.
- With zero supported qualitative claims, precision on that slice can't be
  measured.
- Jev and Kev-4B/9B are untested.

**Findings for L4.5** (not fixed; its rules are frozen, so they go to the
ADR-0012 field ledger). The number extractor reads these as claims:
- the leading digits of hex ids ("51" from `51b0007`, "202" from `U+202F`)
- `\0` escapes
- bare list markers ("1.")

Separately, `sentenceAround()` splits on the ". " in "incl. ", which
truncated one table-row context.

## Status ledger

- **Phase 1 DONE (28 Sep):**
  - Tests: client, triage, bands, CLI, now 46 tests in
    `tests/classifier_triage.test.ts`.
  - Verifier suites in strict mode: 166/166.
  - `tsc` and biome clean.
- **Phase 2 DONE (28 Sep): Kev-0.8B FAILED** (see above). `--classify`
  stays opt-in and flag-only. Do not act on the "likely supported" band
  with Kev-0.8B.
- **OPEN:** re-run Phase 2 with **Jev** (needs `TYPESAFE_API_KEY`, now a
  recognised key in `patchwork-harness keys`) and with **Kev-4B** (≈10 GB, beyond
  this laptop; README: about $1 on Modal). Same harvest, same labels:
  `PATCHWORK_HARNESS_CALIBRATION_OUT=… npx tsx scripts/calibrate_classifier.ts`, then
  `score_calibration.py`. Kev-4B uses the same 1500-char state, so its
  run reuses these labels. Jev's state cap is 8000, so its evidence
  differs and it needs a fresh blind labelling.
- **Phase 3** only if a model beats the constant **and** its ≥0.7 band is
  clean on this data. It still never grants green. Any change to the bands
  or to the question wording needs a new ADR.

## Running the local Kev

    cd ~/kev                     # WSL; cloned 28 Sep, uv sync --extra serve done
    uv run --extra serve python -m kev.serve --run jaredpalmer/kev-0.8b --port 8009
    PATCHWORK_HARNESS_CLASSIFIER_URL=http://127.0.0.1:8009 patchwork-harness verify claude --classify
