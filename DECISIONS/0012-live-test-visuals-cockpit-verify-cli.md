# ADR-0012 — Live test visuals, the cockpit TUI, and `patchwork-harness verify`

**Status:** accepted · 2026-09-01 · builds on ADR-0011
**Note:** `DECISIONS/` carries a pre-existing numbering collision (two 0011
files: grounding-verifier and local-provider). This ADR is 0012; the next
author should renumber or namespace.

## What landed

1. **One NDJSON test-log contract** (`src/testing/test_events.ts`) written
   by a vitest custom reporter (`src/testing/ndjson_reporter.ts`, registered
   in the new `vitest.config.ts` ALONGSIDE the default reporter — plain
   `npm test` output is unchanged). `~/.patchwork-harness/tests/latest.jsonl` is
   truncated per run and appended per event; per-run archives under
   `runs/`. `PATCHWORK_HARNESS_TEST_LOG_DIR` overrides (paths.TESTS_DIR honours the
   same env). A reporter failure can never fail the suite (per-write
   try/catch) — it is an observer, not a gate.
2. **Web live tests page** — `/api/tests/{latest,stream,exam,run}` +
   a Tests view in the dashboard: suite wall (CSS grid cells) and the
   21-tile verifier exam board. Fed by SSE over the shared tailer.
3. **`patchwork-harness test [filter]`** — passthrough | `--live` terminal wall |
   `--exam` (strict) | `--json`.
4. **`patchwork-harness verify` group** — `file` (corpus-shaped JSON, `--expect`
   checks the answer key) · `session` (audit → evidence adapter; ADR-0011
   Phase 3's missing piece) · `exam` (shared `runExamStrict()`).
5. **The cockpit** (`src/tui/`) — `patchwork-harness cockpit`, and **bare `patchwork-harness` in
   a TTY boots it**: ASCII wordmark + power-on sequence rendered from the
   REAL `boot()` checks (an honest animation — each check lights as it
   actually passes, red halts). Panes: sessions · budget · live audit
   events · test wall strip · verifier verdicts · embedded prompt running
   the SHARED repl brain. Bare `patchwork-harness` non-TTY keeps its pre-existing
   behaviour (classic repl — it was commander's default all along).

## Decisions of record

- **Zero new npm dependencies.** Patchwork gates installs; the repo is
  lean by taste. TUI is hand-rolled ANSI (row-diff repaint, one write per
  frame, DECSET 2026 synchronized output); web charts are hand-rolled
  CSS/SVG. Pane content is ASCII + SGR only — no emoji — so visible-width
  maths stays exact.
- **One tailer** (`src/util/tailer.ts`), extracted from the `tail` action:
  fs.watch PLUS a 1s interval (Windows fs.watch misses appends), leftover
  line buffer, truncation-reset (a shrinking file = a new run), and
  `waitForFile` (fixes the old SSE route's never-attached-watcher gap).
  `tail`, both SSE routes, `--live`, `run_exam` and the cockpit all use it.
- **Audit provenance addition** (the load-bearing one): `AuditEmitter`
  hashes `content` at write time, so historical sessions carry NO tool
  outputs — a session verifier had nothing to check against. The executor
  now also emits `provenance.output` (tool_use_end) and `provenance.input`
  (tool_use_start), verbatim, 16KB-capped, through the existing redaction
  path. **Legacy sessions verify UNVERIFIABLE with a loud warning — never
  falsely green.** (ADR-0011's law applied to our own history.)
- **Exam-board law:** GREEN only when every corpus case passes AND the run
  completed; any FAIL → NOT_GREEN; SKIP/MISSING/incomplete → UNVERIFIABLE.
  A skipped exam is never a passed exam; the staleness watchdog turns a
  silent mid-run crash amber, never green.
- **The cockpit embeds the repl brain, it does not fork it** —
  `createReplState`/`runGoal` extracted from `src/cli/repl.ts` with
  `startRepl` behaviour byte-preserved. Goals run in-process; stray
  stdout/stderr writes are intercepted into the events pane. (`applySlash`
  stayed console-based; the cockpit captures console.log during slash
  handling — less churn than the return-lines refactor the plan sketched,
  same isolation.) Escape hatch if in-process proves leaky: spawn
  `patchwork-harness --json` like the web dashboard does.
- **WSLENV reminder** for anyone driving from WSL against Windows node:
  env vars do NOT cross the interop boundary unless listed, e.g.
  `WSLENV=PATCHWORK_HARNESS_VERIFIER_EXAM:PATCHWORK_HARNESS_TEST_LOG_DIR/p`.

## Verification record (2026-09-01)

- Phase A: 17/17 (tailer, events, exam board, reporter INTEGRATION — a
  real child vitest over a fixture containing a deliberately failing test;
  the failure is asserted to be recorded).
- Phase B: 4/4 route tests on RED fixtures (failing run → NOT_GREEN,
  crashed run → UNVERIFIABLE, malicious filter → 400); real
  `patchwork-harness test --exam` → board GREEN, exit 0.
- Phase C: 9/9 (adapter incl. END-TO-END taint: write-then-read session →
  MISSED; legacy hash-only → warned + UNVERIFIABLE; CLI proves it CAN
  fail: fab-001 → exit 1). Real legacy-session run: warning first, ✗/◦
  verdicts, NOT_GREEN exit 1. ADR-0011 ledger updated.
- Phase D: 11/11 pure unit tests (layout invariant sweep incl. exact
  60×20/100×28 boundaries; split-escape line editing; pane geometry
  contracts on RED fixtures; screen one-write diff repaint). Non-TTY
  fallbacks smoked. **TTY cockpit + boot animation need a human terminal —
  the one thing this session cannot render.**
- Suite-wide: pre-existing 10 failures (env/key_store/memory/lessons/
  world_view) on this Windows checkout predate all of this and are
  documented in ADR-0011; everything new is green.

## Field notes — first live self-audit firing (1 Sep 2026)

The Stop hook's first real firing was against the session that built it.
Verdict NOT_GREEN, three atoms; scored against reality afterwards:

- **`1.8` — TRUE CATCH.** The answer said "~1.8s"; the tool output said
  `real 0m1.781s`. Prose rounding is UNGROUNDED by frozen rule (fmt-002)
  and the assistant was made to correct it. Working as designed.
- **`claude/settings.json.bak` — TRUE BY LAW, ugly atom.** The claim "backup
  at …" was never grounded: `cp` succeeds silently, so no tool OUTPUT ever
  contained the path — asserting it was exactly the unverified-claim class.
  (Grounded after the fact with `ls`: 2,503 bytes.) Separately, the path
  extractor truncates hyphenated suffixes ("…bak-pre-verifier" → "…bak") —
  cosmetic, worth a regex fix.
- **`398.19` — FALSE POSITIVE (the first observed).** The figure was a
  QUOTATION of the verifier's own test output and is literally present in
  4 tool_results. Minimal repro VERIFIES it; in the full 499-output
  session the subject-line restriction narrowed matching to a line-set
  that excluded the quoting line. This is the restriction's designed
  failure direction (false red over false green), now observed in the
  wild. Candidate v1.1 refinement: fall back to the unrestricted match
  when every restricted set excludes an atom that IS present globally —
  but that reopens mis-001, so it needs its own corpus case first, not a
  quiet edit.
- **Meta-correction:** the wiring session claimed "hooks snapshot at
  session start, this session won't audit itself." The hook fired on that
  very session — Stop hooks are evidently read per-stop. An unverified
  claim about hook mechanics, caught by the hook it was about.
- **Second firing, same day (auditing the wiring session again):** `14`
  flagged UNGROUNDED though "started 14d ago" sits in a ListAgents tool
  result — subject-line restriction misfired on the SENTENCE-INITIAL
  capitalised word ("Done,"), which is not in the stoplist. Second FP,
  same rule, new trigger: v1.1 should exempt sentence-initial words that
  appear nowhere else capitalised. And `"nothing checkable was claimed"`
  flagged as an ungrounded quoted string — TRUE by the letter (the phrase
  exists in no tool output; it was the assistant's own coinage in quote
  marks). Rhetorical self-quotation is a new atom-class question: fair
  catch or FP is a corpus-case debate, not a quiet edit.
- **v1.1 (1 Sep, same day): sentence-initial subject exemption.** Three
  live FPs in one morning ("Done,", "Since") — the restriction treated
  grammatical capitalisation as a subject. Corpus case subj-001 written
  and proven RED first; fix = first word of a sentence never restricts;
  mis-001 unaffected (mid-sentence "Alpha" still restricts). Exam 22
  cases, 99/99 with mutation gate. Dist rebuilt — the Stop hook runs the
  fixed verifier from its next firing.
- **forge-a's field scoring (first OTHER-session audit)** — verdict
  NOT_GREEN 21✓/2✗/3◦, and its scoring surfaced: a REAL fabrication
  caught ("paid three reviewers" — invented framing in a draft client
  Slack message; nobody was paid), two citation-precision catches
  (compressed span endpoint "218" never in output; "217.725" misquoted
  vs 217.72370…), plus two candidate FP classes for the ledger:
  (a) genuinely-READ figure later also WRITTEN by the model → content
  taint marks the read copy uncitable (origin-order blind — the taint
  rule's designed red-bias, now with a real cost attached);
  (b) markdown decoration (**world view**) possibly defeating phrase
  matching. Both want corpus cases before any rule change.
- **v1.2 (1 Sep, from forge-a's field fixtures, both proven RED first):**
  (a) **order-aware taint** (taint-001) — a tool_result is tainted only by
  model-authored inputs occurring BEFORE it; you cannot launder into the
  past. Write-then-read (poison-002/003) stays MISSED; read-then-quote
  (the "261" case) is citable again. (b) **subject restriction scoped to
  NUMBER atoms** (subj-002) — a sentence listing filenames hijacked a
  quoted phrase's matching; wrong-subject risk is about figures, and
  mis-001 still goes red. Exam 24 cases, 115/115 across exam + mutation +
  both adapters. Dist rebuilt. Open class, logged not fixed: recursive
  audit-discussion (an answer REPORTING a verdict re-utters the flagged
  atoms and re-fires) — needs a design that is not an exemption-by-name.
- **v1.3 + v1.4 (1 Sep, from the hook's own firing on its author, again):**
  ansi-001 — evidence lines are ANSI-stripped at index time (colour codes
  butt letters against digits and hid a genuine vitest "115"). subj-003 —
  the subject restriction now fires ONLY when the restricted line-set
  holds a COMPETING same-kind figure (mis-001's 12.50-vs-527.22 shape);
  a prose line merely mentioning the token ("the Stop hook writes to the
  log") is a mention, not a rival table, and falls back to global
  membership — which cannot create a false green, because the atom must
  still exist somewhere real. Both proven RED first (ansi-001's first
  draft was NOT red — the "(115)" total grounded it — and was tightened
  until it reproduced the field failure before any rule changed). Exam
  26 cases, 123/123 across exam+mutation+adapters. Also scored this
  firing's OTHER atoms honestly: relayed peer claims (forge-a's 198/219
  span, REPAIR-STATUS.md) were TRUE catches — peer self-report is not
  evidence; REPAIR-STATUS.md was then grounded by an actual `find`.
