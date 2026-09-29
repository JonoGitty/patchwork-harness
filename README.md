<p align="center">
  <img src="assets/banner.svg" alt="Patchwork Harness — the verifying harness for AI coding agents" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: BUSL-1.1" src="https://img.shields.io/badge/license-BUSL--1.1-2d6a73"></a>
  <img alt="Node 20+" src="https://img.shields.io/badge/node-%3E%3D20-e0a93b">
  <a href="https://github.com/JonoGitty/patchwork-harness/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/JonoGitty/patchwork-harness/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Part of the Patchwork suite" src="https://img.shields.io/badge/suite-Patchwork-c8553d">
</p>

# Patchwork Harness

**The verifying harness for AI coding agents.**

AI coding agents are confident. *"Done — all tests pass"* is the most common thing they say, and it is a claim, not a proof. Agents declare bugs fixed that are not fixed, quote numbers no tool ever returned, and pass the tests they were shown while breaking the spec they were not. The better the model, the more convincing the claim.

Patchwork Harness runs your coding agent inside a loop that **checks the work instead of believing it**:

- **Test gate.** Your tests run after the plan; the run fails unless they pass, and a bounded repair loop gets the failure output.
- **Independent review.** A model from a *different vendor* reviews the finished diff read-only against a rubric — every concern must quote evidence.
- **Grounded answers.** A deterministic verifier checks every number, path and quote in the agent's final answer against what its tools actually returned. Its law: **never a false VERIFIED.**
- **Multi-vendor routing.** Plans are routed step by step across Claude, GPT, Gemini, Grok and local models, by tier and evidence — not by brand.
- **Audited, budgeted, undoable.** Every action lands on the [Patchwork](https://github.com/JonoGitty/patchwork-audit) audit trail, a hard spend ceiling is never crossed, and `--checkpoint` makes any run rewindable.

Part of the **Patchwork suite**: [patchwork-audit](https://github.com/JonoGitty/patchwork-audit) records what agents do; **patchwork-harness** makes sure what they do is done well.

---

## What it catches

A real run (28 Sept 2026). The goal was a README; a test in the repo exposed a bug the agent was never told about:

```
▸ Step 1/1: Inspect add.sh and add README.md  — anthropic/claude-haiku-4-5
▸ write README.md (54 bytes)  — auto
▸ Verify  — sh test.sh  (up to 3 attempts)
› verify FAILED (exit 1)
▸ Repair (attempt 2/3)  — anthropic/claude-opus-5-5
▸ bash: cat add.sh; cat test.sh; cat README.md; ls  — auto
▸ edit add.sh: replace "$1 - $2"…  — auto
› verify passed on attempt 2
  ✓ verify `sh test.sh` exit 0 after 2 attempt(s)
  checkpoints: step-1, repair-2  (patchwork-harness rewind <session> --to <label>)
  ✓ VERIFIED   number   5   [evt_01M3MFGAN6…]
```

The repair fixed the code and **left the test untouched** — the repair prompt forbids weakening checks. In a second run the check demanded a file the goal never mentioned; the model **refused to fabricate it** and the run correctly failed.

And the independent reviewer, in a real eval run, on work that **passed its visible tests** but broke the spec:

```
L5 review  openai/gpt-6-sol  INCOMPLETE
  ! [high] Negative pages can return items instead of the required empty array.
           For example, page -1 with size 2 slices a five-item array from -4 to -2.
           — "Asking for page 0, a negative page, or a page past the end must return `[]`, never throw."
  ! [low]  The added tests cover pages 1–3 but not the invalid-page requirement.
  L4.5 on the review: 8 cited value(s) verified against real tool output
```

The hidden check agreed: the work was wrong. `--review-fix` hands those concerns to a repair step.

---

## Does it help? Measured, not claimed

`patchwork-harness eval` runs a task suite in fresh repos and scores each run with a **hidden check the agent never sees**. Starter suite, 16 runs per config:

| Config | Passed hidden check | Mean cost | Mean time |
|---|---|---|---|
| baseline | 13 / 16 | $0.17 | 56 s |
| `--verify-cmd … --attempts 3` | 15 / 16 | $0.21 | 61 s |
| `… --review` | 14 / 16 | $0.22 | 71 s |

The independent reviewer agreed with the hidden check on **15 / 16** runs and flagged **both** real failures. `patchwork-harness eval review` calibrates reviewers on planted bugs that *pass the visible tests* (so no test gate can see them):

| Reviewer | Caught planted bugs | Passed good work | $ / review |
|---|---|---|---|
| claude-sonnet-5 | 8 / 8 | 4 / 4 | 0.040 |
| gpt-6-sol | 8 / 8 | 3 / 4 | 0.014 |
| gpt-6-luna | 7 / 8 | 3 / 4 | 0.0007 |

Small samples — the direction matches published harness research, the evidence is honestly thin. Run your own: `patchwork-harness eval run starter --configs baseline,gate,gate+review --trials 4`.

---

## Quickstart

```bash
# 1. Patchwork is a hard requirement (boot is fail-closed, there is no skip flag)
npm install -g patchwork-audit && patchwork init

# 2. Install the harness
git clone https://github.com/JonoGitty/patchwork-harness.git
cd patchwork-harness
npm ci && npm run build && npm link          # installs `patchwork-harness` and `pwh`

# 3. Keys (stored in ~/.patchwork-harness/.env, mode 0600) — any subset works
pwh keys set ANTHROPIC_API_KEY sk-ant-...
pwh keys set OPENAI_API_KEY sk-...
pwh keys set GEMINI_API_KEY ...

# 4. Check, then run
pwh doctor
pwh run "fix the flaky test in tests/parser.test.ts" \
  --verify-cmd "npm test" --attempts 3 --checkpoint --review
```

Requirements: Node 20+, git, [Patchwork](https://github.com/JonoGitty/patchwork-audit). On Windows the bash tool uses Git Bash.

---

## The trust stack

Every layer is opt-in beyond L1–L3, and **no layer can mark anything green without proof**.

| Layer | What it does |
|---|---|
| **L1** Project awareness | A ~6K-token world view before planning: your memory notes, README/CLAUDE files, git state |
| **L2** Lessons | Similar past sessions and how they went |
| **L3** Critic | A second model, from a different vendor, critiques the plan once |
| **Planner guard** | Any step naming a model the key can't reach is swapped for a reachable one — deterministically |
| **Test gate** `--verify-cmd` | Runs your tests; output becomes audited evidence |
| **Repair loop** `--attempts` | Failure output → one repair step → re-gate, inside the budget |
| **L4.5 Verifier** `--verify` | Deterministic answer-vs-evidence check. VERIFIED (with proof) · UNGROUNDED · MISSED — reported at equal prominence |
| **Classifier triage** `--classify` | Sends L4.5's MISSED atoms to a decision model (TypeSafe Jev or local Kev). Routes only — can never grant green |
| **L5 Reviewer** `--review` | Different vendor, read-only (read/grep/glob), rubric + quoted evidence; its citations are L4.5-checked |
| **Review repair** `--review-fix` | An INCOMPLETE verdict → one repair from the reviewer's concerns → re-gate → re-review |

Decision records for every layer live in [`DECISIONS/`](DECISIONS).

## Harness options

| Flag | What it does |
|---|---|
| `--verify-cmd "<cmd>"` | Test gate; the run exits 1 unless it passes |
| `--attempts <n>` | Bounded repair loop (max 10); the repair step may not edit the tests |
| `--checkpoint` | Git snapshot of the tree before every step (`refs/patchwork-harness/…`), your index/HEAD/branch untouched |
| `pwh rewind <session> [--to <label>]` | List or restore checkpoints; a rewind snapshots first, so it is undoable |
| `--guard-loop` | Nudge when the model repeats an identical call 3+ times |
| `--time-budget <s>` | Wall-clock cap the model can see |
| `--review [model]` / `--review-strict` / `--review-fix` | L5 review, fail on a non-COMPLETE verdict, repair from its concerns |
| `--budget <usd>` / `--bedrock <usd>` | Soft session target / hard ceiling that is never crossed |

## Use it from Claude Code (MCP)

`patchwork-harness mcp` serves the harness over MCP, so Claude Code — including Remote Control sessions — drives it with typed tools:

```bash
claude mcp add patchwork-harness -s user -- node /path/to/patchwork-harness/bin/patchwork-harness.mjs mcp
```

16 tools: `harness_plan`, `harness_run` (+ `harness_run_status`), `harness_verify_claude` / `_session` / `_file`, `harness_review`, `harness_ask`, `harness_eval`, `harness_checkpoints`, `harness_rewind`, `harness_models`, `harness_status`, `harness_sessions`, `harness_show`, `harness_exam`. Anything that spends money or changes files requires `confirm: true`; background runs close stdin, so every permission prompt resolves to **deny**.

Audit a Claude Code session's own answer against its tool outputs: `pwh verify claude --classify`.

## Models

Six providers — Anthropic, OpenAI, Google, xAI, Perplexity (research-only) and local Ollama. The catalog in [`config/models.yml`](config/models.yml) only marks a model *verified* after a real call succeeds (`node scripts/probe_models.mjs`); prices come from vendor pricing pages or say `unknown`. Roles are chosen by evidence — e.g. the planner (`gpt-6-luna`) won a head-to-head where the critic approved 9/12 of its first drafts vs 1/12 for the previous planner (`scripts/eval_planner.ts`).

Routing is by **tier**, not brand: flagship coders for hard steps, workhorses for bulk, cheap models for coordination, reasoning models for review, local models for private writing. See [`config/model_capabilities.yml`](config/model_capabilities.yml).

## Commands

| | |
|---|---|
| `run "<goal>"` | Plan and execute (`--dry-run`, `--json`, `-u` unattended, all harness flags) |
| `ask "<prompt>"` | One call to one model (`-p`, `-m`, `--search` for cited web results) |
| `review <paths>` | Cross-vendor adversarial review, merged and L4.5-checked |
| `verify file\|session\|claude\|exam` | The L4.5 verifier (`--classify` for triage) |
| `eval run\|review\|list` | Task suites and reviewer calibration |
| `rewind <session>` | Checkpoints |
| `mcp` | MCP server |
| `models` · `doctor` · `keys` · `ls` · `show` · `tail` · `web` · `cockpit` · `resume` | Everything else |

Everything is also available as `pwh`.

## Configuration

State lives in `~/.patchwork-harness/` (sessions, events, cache, evals, keys). Put your own `models.yml`, `model_capabilities.yml`, `budget.yml` or `policy.yml` there to override the bundled [`config/`](config). Environment variables use the `PATCHWORK_HARNESS_` prefix, e.g. `PATCHWORK_HARNESS_CLASSIFIER_URL`, `PATCHWORK_HARNESS_SHELL`, `PATCHWORK_HARNESS_ENABLE_CONTEXT_INJECTION`.

## Architecture

```mermaid
flowchart TD
  A["boot: Patchwork check (fail-closed)"] --> B["L1 world view + L2 lessons"]
  B --> C["Planner → JSON plan (unreachable models swapped out)"]
  C --> D["L3 critic (different vendor)"]
  D --> E["Budget bedrock check"]
  E --> F["Executor: bounded tool loop per step (checkpoints, loop + time guards)"]
  F --> T["Test gate --verify-cmd → repair loop --attempts"]
  T --> R["L5 review --review → --review-fix"]
  R --> V["L4.5 verifier --verify → classifier triage --classify"]
  F -. "every action" .-> P[("Patchwork audit trail")]
```

More in [`ARCHITECTURE.md`](ARCHITECTURE.md) and [`SECURITY.md`](SECURITY.md).

## Status

**v0.1.0 — early and honest.** It works end to end, the test suite is large (480+ tests), and every number above came from real runs. Known limits:

- The live re-planner (L4) is designed, not built.
- The local Kev-0.8B classifier *failed* its calibration (it loses to a constant baseline); `--classify` stays flag-only — see [`DECISIONS/0013`](DECISIONS/0013-classifier-triage.md).
- Two tests fail on Windows only (POSIX file modes and a path-matching test).
- Eval sample sizes are small; the suite is cheap (~$0.20/run) — run more.

See [`CHANGELOG.md`](CHANGELOG.md).

## License

[Business Source License 1.1](LICENSE), matching the rest of the Patchwork suite: free for internal and non-competing commercial use; each version converts to **Apache 2.0** three years after release.
