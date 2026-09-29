# ADR-0006: Multi-tier budget with hard bedrock

**Status:** accepted
**Date:** 2026-04-30

## Context

A multi-LLM coding agent can spend a lot of money quickly. The most
common failure modes:

1. The model picks an expensive option ("Opus everything") and costs
   blow up.
2. A bug or runaway loop spends 10x what was intended.
3. The user wants different trade-offs on different runs (cheap vs.
   "no expense spared").
4. There's no absolute floor — soft caps get raised the moment they're
   inconvenient.

We need a budget system that is enforceable, ergonomic, and intelligible.

## Decision

Three tiers, plus a strategy mode. Each tier is enforced by a different
mechanism.

### Tier 1: Bedrock — hard ceiling

`bedrock_usd` is an absolute cap. It is checked **before every
provider call** (with conservative cost estimate) AND **after every
provider call** (with actuals). If exceeded, the session terminates
with status `bedrock_aborted`, the transcript is persisted, and the CLI
exits with code 2 (distinct from regular failure code 1).

There is no flag, env var, or config that bypasses bedrock at runtime.
Raising bedrock requires editing `~/.patchwork-harness/budget.yml` or passing
`--bedrock <usd>` explicitly per invocation. This is intentional
friction.

### Tier 2: Session target — soft cap

`session_usd` is what the planner targets. It is set per-session via
`--budget`. Whether the executor lets it slip is governed by the mode.

### Tier 3: Monthly cap — defence in depth

`monthly_cap_usd` aggregates spend across all sessions in the current
calendar month. If hit, new sessions refuse to start until the month
rolls over or the cap is raised. Defends against "you ran patchwork-harness in a
loop overnight."

### Modes

| Mode | Planner bias | Executor behaviour |
|---|---|---|
| `budget` | cheapest viable models, fewer steps | wraps up if `session_usd` reached |
| `balanced` (default) | session_usd target, mix providers | allows up to 20% overrun |
| `unlimited` | best model per step | session_usd ignored; bedrock is the cap |

The mode is read by the planner (which alters its model choice) AND by
the executor (which decides whether to wrap up early on overrun).

### Auto-budget proposal

`--budget auto` triggers a tiny "scope" call (Haiku, <$0.01) before
planning. The planner returns a proposed budget with reasoning ("I
think this needs $7 because…"). The user confirms (or `--yes` accepts).
The proposal is **always capped at bedrock** regardless of what was
proposed.

### budget_status tool

Every executor can call `budget_status` (read-only) at any time to get
`{spent_usd, session_cap_usd, bedrock_usd, mode, headroom_usd, percent_used}`.
The current state is also injected into each step's system prompt so
the model knows without calling.

## Consequences

**Good**
- Bedrock is unbypassable in the running process. No hot path to
  "just this once".
- Mode lets the user dial cost vs. quality without rewriting policy.
- Auto-budget removes the need to guess for one-off goals.
- Monthly cap catches the worst-case "what happened overnight?".

**Costs**
- More flags (`--bedrock`, `--budget`, `--mode`). Mitigation: defaults
  in `config/budget.yml` cover the common case.
- Planner has more to fit in its prompt. Mitigation: capability corpus
  makes its job easier; mode profile explicitly tells it which models
  to prefer/avoid.
- LLM cost estimation is rough; bedrock-as-only-hard-cap means a single
  badly-mispriced model could bite us. Mitigation: the executor checks
  bedrock after every call, not just at the end.

## Alternatives considered

- **Single hard cap, no soft budget** — rejected. Doesn't capture the
  "I want enterprise polish" use case where the user is willing to
  spend more than the default for one run.
- **Cost cap per-step instead of per-session** — rejected. A 10-step
  plan with $0.10/step would cap at $1; a 3-step plan with $0.50/step
  would cap at $1.50. Per-session caps are clearer to reason about.
- **Trust the planner's estimate as the cap** — rejected. LLMs are
  notoriously bad at estimating their own cost.
