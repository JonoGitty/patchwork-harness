# Changelog

All notable changes to Patchwork Harness. Versions follow [SemVer](https://semver.org/); each release's source converts to Apache 2.0 three years after it ships (see [LICENSE](LICENSE)).

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
