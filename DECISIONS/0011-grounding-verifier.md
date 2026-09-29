# ADR-0011 — The L4.5 Grounding Verifier

**Status:** accepted (Phase 0) · 2026-08-31
**Owner:** maintainers · drafted with Claude
**Depends on:** ADR-0008 (smart conductor), Patchwork audit chain (ADR-0001)

## Context

patchwork-harness's conductor has plan-time defences (L1-L3) and two deferred layers
(L4 re-planner, L5 LLM reviewer). Nothing checks the FINAL ANSWER against
what the session actually observed. 2026 industry practice and this
estate's own incidents both converge on the same missing layer: a
deterministic check that an answer's factual atoms are supported by the
run's own evidence, BEFORE any model-based review and before the human
reads it. Motivating incident: a report fabricated "£398.19" and "6
conversions" — plausible, fluent, wrong — inside a build whose first rule
forbade exactly that. An LLM judge cannot catch this (the number "sounds
right"); set-membership over the run's tool outputs catches it in
milliseconds.

## THE LAW (2026-08-31 — constitutional, everything else serves it)

> **Never a false VERIFIED.** Every checkable thing lands in exactly one
> of three states:
> 1. **GREEN — with the proof attached.** "It's this, and here's the
>    audit event that says so."
> 2. **NOT GREEN.** Checked; no supporting evidence found. Named, never
>    hidden.
> 3. **MISSED.** No check exists for this. Reported with the SAME
>    prominence as the other two.
>
> The three must RECONCILE: atoms found = green + not-green + missed.
> Nothing may occupy no bucket. State 3 hiding inside state 1 is how
> every prior verification defect happened.

Corollaries:
- All ties, doubts, and errors resolve AWAY from VERIFIED. The verifier
  may be annoying; it may never be falsely reassuring.
- A verdict is itself a claim and carries its own evidence (the matched
  event id, or the derivation it recomputed). The verifier obeys the law
  it enforces.
- An answer whose atoms are mostly MISSED is labelled UNVERIFIABLE —
  a different and honest verdict from VERIFIED. Low coverage can never
  masquerade as high confidence.

## Verdict model

Per atom: `VERIFIED {evidence: event_id | derivation}` ·
`UNGROUNDED {searched: true}` · `MISSED {reason}`.
Per answer: `{atoms, verified, ungrounded, missed, coverage}` — the four
counts MUST reconcile or the verifier itself exits INVALID (never green).
Summary line always shows all three numbers.

## Evidence rules — what counts as ground truth

INDEXED: outputs of world-facing tool results from the session's Patchwork
audit JSONL — bash stdout/stderr, read/grep/glob results, web/API
responses, tool errors.
EXCLUDED: all model-authored text — assistant turns, plans, write/edit
tool INPUTS. The generator must never be able to cite itself. (self-citation incident: model output laundered into an allowlist.)
KNOWN GAP (v1, documented not hidden): write-then-read laundering — the
model writes a file then reads it back; the read output indexes as
evidence. Mitigation deferred to v2 (taint files written this session).
Corpus case poison-002 pins the gap as MISSED, not as VERIFIED.

## Atom tiers

| tier | atoms | check |
|---|---|---|
| 1 | numbers, currency, file paths, URLs, ids, dates, quoted strings | canonicalised set-membership against the evidence index |
| 2 | world-state claims ("file exists", "tests pass") | re-execution (v2) |
| 3 | derived values | recompute from a REQUIRED shown derivation |
| 4 | qualitative prose | never checked deterministically → MISSED, visibly |

Canonicalisation is FROZEN and versioned: strip currency symbols and
thousands separators; ISO-8601 + common date renderings; case-fold paths
on Windows. **The matcher never softens** — every relaxation is its own
ADR. Prose rounding ("about £400") is UNGROUNDED by design; reports quote
figures verbatim (house rule).

## Threat model → corpus case → defence

| attack | case | defence |
|---|---|---|
| fabricated figure | fab-001 | tier-1 membership |
| real figure, wrong subject (misattribution) | mis-001 | v1 LIMITATION — passes membership; documented, v2 = per-claim evidence pointers |
| derived value asserted without working | der-002 | derivation required, else UNGROUNDED |
| vague-prose answer games coverage | empty-001 | coverage floor → UNVERIFIABLE |
| formatting drift dodges match | fmt-001/002 | canonicaliser (frozen) |
| self-citation / evidence poisoning | poison-001/002 | model-authored text excluded from index |
| qualitative claim silently dropped | missed-001 | MISSED is a counted, reported state |
| verifier partition bug | ALL | runner asserts reconciliation on every case |

## Enterprise process (how this ships)

- **Phase 0 (this ADR):** law, threat model, golden corpus, red exam. The
  exam exists before the implementation. DONE when the exam runs RED.
- **Phase 1:** implement `src/verifier/grounding.ts` to pass the exam.
  Mutation pass required: break canonicaliser/matcher/coverage in memory,
  suite must go red each time.
- **Phase 2:** adversarial review by a different mind (Sol cross-vendor,
  per docs/reviews precedent) briefed to FOOL it; new fooling → new
  corpus case, forever.
- **Phase 3:** calibration over historical sessions in ~/.patchwork-harness/events;
  publish FP/FN numbers in this file. One-week FLAG-ONLY soak wired into
  finishSession.
- **Phase 4:** enforcement (block ungrounded tier-1 atoms), runbook,
  telemetry + drift alarm (a sudden 100% green rate is investigated as a
  verifier failure, not celebrated).
- Ongoing: gold set recalibrated monthly · verdict schema semver ·
  overrides logged, named, and EXPIRING (no permanent exemptions — an
  exemption by name survives the fix it would hide).

## Explicit v1 limitations (honest scope)

Misattribution passes membership · write-then-read laundering indexes ·
tier-2 re-execution not yet built · qualitative claims are MISSED by
construction. Anyone reading a verdict reads these in the same file.

---

## Phase 0.5 — Sol adversarial review, 2026-08-31 (cost $0.44, gpt-5.5)

The exam was reviewed by a different vendor BEFORE implementation, briefed
to fool it. 10 findings; 9 accepted, 1 narrowed. The two most severe were
LAW VIOLATIONS IN THE EXAM ITSELF:

1. **mis-001 expected a knowing false green** ("v1 limitation" labelling a
   VERIFIED the law forbids — *"calling it a limitation does not make it
   lawful"*). Fixed: subject-line restriction (below) makes it UNGROUNDED.
2. **poison-002's corpus contradicted this ADR** (ADR said MISSED, corpus
   said VERIFIED). Fixed via content taint (below).
Also accepted: bash-echo laundering (poison-003) · same-number-opposite-
predicate (pred-001) · boundary/sign negatives (fmt-003) · id + quoted-
string coverage (str-id-001) · URL-mentioned≠fetched (url-002) · wrong-
operator derivation (der-003) · explicit counts+coverage pinning
(coverage-001). Narrowed: full predicate/subject claim modelling → v2
(per-claim evidence pointers); v1 ships the deterministic reductions below.
A session (Claude) separately caught empty-001 contradicting missed-001
pre-review. **Corpus: 14 → 21 cases. The exam's author was not its sole
verifier.**

## Frozen v1 rules (each earned by a corpus case; relaxing any = new ADR)

- **Content taint:** a tool_result line whose text appears inside any
  model-authored input this session (write/edit content, bash commands) is
  tainted; tainted-only support → MISSED, never green. [poison-002/003]
- **Subject-line restriction:** capitalised subject tokens from the atom's
  sentence that appear in evidence restrict matching to the most specific
  line-set containing them; a match only outside it → UNGROUNDED. [mis-001]
- **Conflict lexicon (frozen pairs):** passed/failed, pass/fail,
  succeeded/failed, success/failure, created/deleted, enabled/disabled,
  up/down, true/false. Matched line containing the antonym of a sentence
  word → that line cannot support the atom. [pred-001]
- **Boundary + sign:** numbers match as whole tokens with sign; 6≠60,
  -5.00≠5.00, digits inside identifiers (abc16) are not numbers. [fmt-003]
- **URL fetch-class:** a URL verifies only from results of fetching tools
  {web, api, fetch, http, browser}; mention in bash output is not a fetch.
  A curl-in-bash false-red is accepted — it resolves away from green. [url-002]
- **Derivation:** a parenthesised expression beside a total is parsed
  (+ − × * /), operands must each be grounded, and the recompute must equal
  the asserted value; wrong operator/operands → UNGROUNDED. [der-001/002/003]
- **Coverage:** checkable = verified+ungrounded; coverage = checkable/atoms;
  **coverage < 0.25 → overall UNVERIFIABLE** regardless of greens. Overall:
  ungrounded>0 → NOT_GREEN · else missed>0 → GREEN_WITH_MISSED · else
  verified>0 → GREEN · else UNVERIFIABLE. [coverage-001, empty-001]

## v1 limitations (updated post-review)

Relational claims beyond subject-token restriction (v2: per-claim evidence
pointers via constrained output schema) · tier-2 re-execution not built ·
qualitative claims MISSED by construction · antonym lexicon is deliberately
small — unknown predicates pass silently at atom level (the residual of
Sol finding 10, accepted and documented).

## Status ledger

| phase | state | evidence |
|---|---|---|
| 0 — law, threat model, corpus, red exam | **DONE** 2026-08-31 | exam RED in strict mode before implementation (14 fail) |
| 0.5 — adversarial review of the exam | **DONE** 2026-08-31 | Sol/gpt-5.5, $0.44, 10 findings, corpus 14→21; two law violations found IN THE EXAM |
| 1 — implementation + mutation gate | **DONE** 2026-08-31 | `src/verifier/grounding.ts` (389 lines); exam 85/85 strict; mutation 10/10 — all 8 frozen-rule mutants killed, liar-wrapper caught; tsc 0 errors, biome clean |
| 2 — second adversarial round vs the IMPLEMENTATION | open | brief a different mind to fool the running code, not the spec |
| 3 — calibration + flag-only soak | **adapter DONE** 2026-09-01 (ADR-0012): `src/verifier/session_adapter.ts` + executor verbatim provenance; `patchwork-harness verify session` live; legacy hash-only sessions verify UNVERIFIABLE with a loud warning, never falsely green. Calibration + soak remain open | end-to-end taint test (write-then-read → MISSED) in tests/session_adapter.test.ts |
| 4 — enforcement + runbook + drift alarm | open | after soak only |

Implementation notes for the record: two extraction bugs were found by the
exam on first run (a lookahead that rejected any number followed by a full
stop — `100.`, `-5.00`, `3.1x` — and a sentence splitter that broke on
decimal points, silently wrecking derivation lookup). Both are exactly the
class of silent defect the corpus exists to catch, and neither survived to
a green. The full-repo suite has 10 pre-existing failures in env/key_store/
memory/lessons/world_view on this Windows checkout — none touch the
verifier, present before this work, not regressions from it.
