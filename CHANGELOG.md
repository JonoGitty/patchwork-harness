# Changelog

All notable changes to Patchwork Harness. Versions follow [SemVer](https://semver.org/); each release's source converts to Apache 2.0 three years after it ships (see [LICENSE](LICENSE)).

## [0.2.0] — 2026-10-01

### Classifiers in the harness, measured first
- **`eval classifier <rows.jsonl>`** scores any System One classifier (Jeff, Kev or Jev) on labelled rows in Jeff's adapter-kit format.
  - It reports accuracy against the constant baseline, plus ECE, Brier, AUC and confidence bands.
  - A failed call counts as wrong, never as right.
- **Jeff backend** (`PATCHWORK_HARNESS_JEFF_URL`): a per-call adapter and answer-twice.
  - Calls to a local server are queued, and the server's Retry-After is honoured. Jeff answers an overlapping request with 529 instead of queueing it.
  - On grounding triage, Jeff is the first classifier to beat the constant (93.7% vs 93.4%, AUC 0.87). Kev scored 86.1% and AUC 0.73.
- **Injection guard** `--guard [p]` / `--guard-withhold`: Jeff's `guard` adapter screens file, shell, search, git and memory output before the model reads it.
  - The raw output stays on the audit trail.
  - If the guard was asked for but can't run, the run refuses to start.
  - Measured on 150 real tool outputs, each also with a planted injection: 90% caught, 1.3% false alarms at P ≥ 0.9.
- **Intent lanes** `--lane planned|direct|auto`, plus `--lane-model` and `route "<goal>"`.
  - The direct lane skips planning for one-pass jobs: −63% input tokens and −31% time on the same model.
  - `auto` is a cascade: a small trained head, then a cheap LLM only in its uncertain band.
- **Claude Code mod** (`claude-mod/`): the guard, `/verify`, `/guard` and `/harness` inside Claude Code 2.1.287+. It is statically validated and tested offline.

### Fixed
- Planner and critic spend was never on the ledger, so session totals and the spend ceiling left planning out.
- A tier held by a single vendor had no fallback, so a dead account failed every step routed to it. Fallback now widens to the nearest tier.

## [0.1.0] — 2026-09-29

First public release.

### The harness
- **Test gate** `--verify-cmd`, whose output is audited evidence the verifier can check claims against.
- **Bounded repair loop** `--attempts`; the repair step is forbidden to edit or weaken tests.
- **Checkpoints** `--checkpoint` plus `rewind`. The whole-tree git snapshots also capture bash edits, leave your index and HEAD alone, and every rewind can itself be undone.
- **Runtime guards:** `--guard-loop`, which nudges on repeated identical calls, and `--time-budget`.
- **L5 independent reviewer** `--review`: a different vendor reads the work read-only against a rubric, every concern must cite evidence, and those citations are grounded by L4.5. It also supports `--review-strict` and `--review-fix`.
- **Evals:** `eval run` scores task suites with hidden checks; `eval review` calibrates reviewers on planted bugs that pass the visible tests. The starter suite has 4 validated tasks.

### Verification
- **L4.5 grounding verifier:** a deterministic check of the answer against the evidence, with a tri-state verdict and **never a false VERIFIED**. It has a 26-case exam and a mutation gate.
- **Classifier triage** `--classify`: sends L4.5's MISSED atoms to a System One decision model (TypeSafe Jev, or local Kev). It routes only; it never grants green.

### Platform
- Six providers, tier-based routing, and an evidence-based model catalog in which a model is marked verified only after a real call succeeds. Current catalog: Opus 5.5, Sonnet 5.5 (pending verification), GPT-6 Astra/Sol/Luna, Gemini 3.8 Flash, Grok 4.7 and others.
- **MCP server** `mcp`: 16 typed tools for Claude Code. Spending and file changes need `confirm`; background runs resolve every prompt to deny.
- Hard spend ceiling (bedrock), Patchwork-audited actions, human-in-the-loop, and a local memory spine.

### Fixed on the way to release (all found by the harness's own evals and live runs)
- The bash tool never started on Windows; it now uses Git Bash.
- The Anthropic prompt cache never hit, and cache tokens were left off the ledger. Turns after the first are now ~87% cheaper.
- GPT-6 and GPT-5.6 tool calls failed on chat completions; they are now routed via the Responses API.
- A single provider error could kill a run with no end record. There are now fallbacks for any error, an account-wide error leaves that provider entirely, the planner retries, and the session end is always written.
- The planner could pick models the key can't reach; a deterministic guard now swaps them out.
- On machines without ripgrep, the grep tool fell back to GNU grep in *basic* regex mode, so `alpha|beta` or `(a|b)` silently returned zero matches. It now uses `-E`, and routes syntax grep cannot express (`\d`, `(?…)`, lazy quantifiers) to the built-in JS engine. The first public CI run on Linux caught this.
