# Changelog

All notable changes to Patchwork Harness. Versions follow [SemVer](https://semver.org/); each release's source converts to Apache 2.0 three years after it ships (see [LICENSE](LICENSE)).

## [0.4.2] — 2026-10-15

### Added
- **On-request models.** A new catalog flag, `on_request: true`, keeps a model for the rare job where you name it: `ask -m`, `--lane-model`, `review -m`, or a role list you edit. The planner is never offered it, and fallbacks never pick it.
- **Claude Haiku 4.5** (`claude-haiku-4-5`) is back in the catalog as the first on-request model, verified by a real call on 15 Oct. Haiku 5.5 is ten times cheaper for routine work, so nothing routes to 4.5 on its own.

### Fixed
- **`models` cut every verification date to "verified …".** The column now shows the date in full, and on-request models are marked.

## [0.4.1] — 2026-10-15

A model refresh. Every model below was verified by a real call, and every price comes from the vendor's pricing page.

### Models
- **Gemini 4 Argon** (`gemini-4-argon`) is in the catalog. It costs $2/$10 through 30 Nov 2026, then $4/$20, and the ledger bills the new price from 1 Dec. It takes 1M tokens in and 32,768 out.
  - It leads the Google lane of `security_reviewer` and is the Google pick in `reviewer`, ahead of Gemini 3.1 Pro.
  - On the reviewer calibration suite (once per case) it caught 8/8 planted bugs and passed 4/4 good solutions, at $0.013 a review, with no API errors.
- **Claude Sonnet 5.5** replaces Sonnet 5 as the bulk executor and in `reviewer`. On the same suite it gave the same verdicts as Sonnet 5 (8/8 and 4/4), at $0.023 a review against $0.043.
- **Claude Haiku 5.5** (`claude-haiku-5-5`) is the planner fallback. It costs $0.10/$0.50 up to a 100k-token prompt and $0.50/$2.50 above, and the adapter applies the tier. In a planner head-to-head, the critic approved 5/12 of its first drafts against 1/12 for Haiku 4.5.

### Removed
- **Superseded models**, each replaced by a newer model from the same vendor at the same or a lower price: `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` (back in 0.4.2, on request only), `gpt-5.6-sol`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4-mini`, `o4-mini`, `o3-pro`, `gemini-3.7-flash` and `grok-4.6`. An old id named explicitly still prices from the adapter's table.
- **The `gpt-6` and `gpt-6-pro` placeholders.** They returned 404 on every probe since 3 Sept and never appeared on OpenAI's pricing page. OpenAI ships GPT-6 as Astra, Sol and Luna.

### Fixed
- **Gemini 4 got no thinking headroom,** because only `gemini-3*` ids were treated as thinking models. Both now get headroom, clamped to each model's output cap, so a large request can't exceed Argon's 32,768.
- **Haiku 5.5 had no price,** so its calls would have gone on the ledger at $0. Haiku 5.x and Sonnet 5.5 also rejected `temperature` with a 400; it is no longer sent to them.
- **Gemini 3.8 Flash's promotional price ends on 1 Jan 2027.** The ledger bills $1.50/$7.50 from then.

## [0.4.0] — 2026-10-03

### Added
- **`continue [instruction]`** (also `run --continue`, MCP `harness_continue`): picks up the last run in this directory, or `--session <id>`, where it stopped.
  - **Resume.** A run that stopped part-way re-runs its own plan from the first unfinished step, with no new planning. That covers a failed or refused step, the spend ceiling, a killed process, or a dry run.
  - **Follow up.** A run whose steps all ran gets one direct step on what was left: a step out of tool turns, a failing test gate, or an INCOMPLETE review. An instruction rides along, or is the follow-up itself on a run that finished clean.
  - The earlier run's gate and review apply again.
  - Tested live: a real run was killed after step 1, then continued twice to completion, for about $0.006.

### Fixed
- **A step that used all its tool turns was recorded as completed, with no warning.** It is now flagged (`turn_cap`) and warned about, and a resume gives it more turns.
- **The session file was written only when a run ended,** so a killed run left nothing to pick up. It is now saved after the plan and after every step, atomically.

## [0.3.0] — 2026-10-02

### Added
- **GPT-6.1 Sol** (`gpt-6.1-sol`) is in the catalog.
  - Verified by a real call; priced from OpenAI's pricing page at $2/$10, or $4/$15 above 272k input.
  - Before this it matched the unknown-priced `gpt-6` entry by prefix, so its spend went on the ledger at $0.
  - It leads the `reviewer` role. In a two-trial run on the reviewer calibration suite it passed 8/8 good-case reviews, against 6/8 for GPT-6 Sol. Both flagged all 16 bad-case reviews.
- **`approve [file]`**: a model from another vendor reads a draft issue, PR or commit message against your evidence, then approves it or lists what to fix.
  - A reviewer that approves while listing a high or medium concern is not believed.
  - An unreadable answer is never an approval.
  - stdout carries only the approved text, so it pipes into `gh`.
- **The Patchwork Harness tag**, on by default (`PATCHWORK_HARNESS_TAG=off` or `--no-tag` turns it off).
  - Text that passed `approve` gets "approved". Commits and PRs made during a run get "made with".
  - On commits it is a git trailer, joined to any existing trailer block.

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
