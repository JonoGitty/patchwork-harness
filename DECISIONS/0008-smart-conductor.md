# ADR-0008: The smart conductor

**Status:** accepted
**Date:** 2026-04-30

## Context

Today the "conductor" (orchestrator's planning + delegation layer) is
Haiku reading a goal + the static capability corpus and emitting a JSON
plan. That's a thin router, not a smart boss. The component models
(Sonnet, Opus, GPT-4.1) are smart; the conductor sitting above them is
not.

The user's framing: "the boss of all the clever nerdy coding agents.
I just say what I want, and it gets it done with its team."

To meet that, the conductor needs to:

1. Know what's going on (project context, past work, user style)
2. Plan with evidence, not guesses
3. Sanity-check its own plan before committing
4. Adapt when reality diverges from the plan
5. Verify the work was actually done well

## Decision

Five layers, in dependency order. Each is an extension of the existing
planner/executor/orchestrator triad — none replaces them.

### Layer 1: Project Awareness (pre-plan context)

Before the planner runs, the conductor assembles a **world view** packet:

- **User memory** — read `~/.claude/projects/<machine>/memory/MEMORY.md`
  and every linked memory file. Filter by simple keyword overlap with
  the goal so we don't dump everything.
- **Project memory** — if cwd has a `CLAUDE.md`, `README.md`, or
  `ROADMAP.md`, include the first ~2K characters of each.
- **Recent git context** — if in a git repo: branch name, last 5 commit
  subjects, current diff summary.
- **Dashboard signal** — if `~/AI/dashboard/` is reachable, fetch
  recent project activity.

The world view is injected into the planner's system prompt as a
"Context you should know" block, capped at ~6K tokens (Haiku's effective
attention budget for non-goal content). Implementation is a new module
`src/core/world_view.ts` with a function `assembleWorldView(cwd, goal)`
returning a string. The packet is also emitted to audit so we can debug
"why did it pick that plan?".

### Layer 2: Lessons from History (audit-mining)

Before planning, query the Patchwork audit log for past similar
sessions and summarise outcomes:

- **Similarity** — start with simple BM25/TF-IDF over goal text.
  Optionally upgrade to embeddings later (off the critical path).
- **Window** — last 60 days, capped at 10 most-similar matches.
- **Summary shape** —
  ```
  Past similar work (last 60 days):
  - "rename foo to bar in src/" (3 weeks ago) — 3 steps, Sonnet only,
    completed in 2m, $0.04. ✓
  - "refactor auth middleware for OAuth" (2 weeks ago) — 6 steps mixed,
    1 budget overrun, abandoned. Cost so far: $1.20. ✗
  - "add tests for parser.ts" (1 week ago) — 2 steps, Haiku then
    Sonnet, completed, $0.02. ✓
  ```
- **Insertion** — appended to the planner system prompt under "Evidence
  from past sessions like this".

Implementation: a new `src/core/lessons.ts` module that reads
`~/.patchwork-harness/sessions/*.json` (and optionally `patchwork export --format
json` if the user has Patchwork integration on for patchwork-harness's events).
Patchwork is the source of truth for cross-tool evidence; patchwork-harness's own
session files are the fast path. We use the slow path lazily.

### Layer 3: Critic Pass (plan validation)

After Haiku produces a draft plan, a second LLM call (Haiku again,
cheap) plays critic with this prompt:

> You are reviewing a plan another AI just produced. Critique it for:
> (1) budget fit — does the sum of typical_cost stay under bedrock?
> (2) model-task alignment — does each step use the right tier?
> (3) step ordering — could any step fail because a dependency wasn't
>     done first?
> (4) missing steps — is anything obvious left out?
> (5) over-engineering — could this be done in fewer steps?
>
> Verdict: "approve" or "revise" + 1-3 concrete suggestions.

If "approve" → proceed. If "revise" → planner re-runs with the critic's
feedback in the prompt. Cap iterations at 2 (initial + 1 revise) so we
don't loop forever. Audit emits both `plan_proposed` and `plan_critique`
events so the user can see what changed.

### Layer 4: Live Re-planner (mid-flight adaptation)

When a step fails OR budget headroom drops below 30%, the conductor
pauses execution and replans the **remaining** steps with new
constraints. This is implemented as a method on the orchestrator:

```ts
async replan(reason: string, completedSteps: StepResult[], remaining: Step[],
            currentBudget: BudgetState): Promise<Plan>
```

The replanner sees what's already done, what failed (if anything), and
what budget is left. It can drop steps, swap models for cheaper ones,
or merge multiple steps into one. If the replanner can't produce a
viable continuation under the budget, it surfaces a `replan_blocked`
event and ends the session cleanly.

### Layer 5: Reviewer Pass (post-execution quality)

After all steps execute, a "reviewer" LLM (Sonnet — needs to actually
read the work) does a quality pass:

- Reads the final state via the same tools (read, grep, etc.) — this
  IS another bounded inner loop, with its own audit envelope
  (`reviewer_start`, `reviewer_end`)
- Compares against the original goal
- Verdict: "complete" | "incomplete" + reasoning
- If incomplete and budget allows: propose ONE follow-up step the user
  can accept (`--auto` accepts; otherwise prompts)

Reviewer output goes in the session manifest under `review` and is
shown in the CLI summary and on the web dashboard.

## Order of implementation

1. **Layer 1 (project awareness)** — biggest immediate win, no dependencies
2. **Layer 2 (lessons)** — needs no infra change, just a new module
3. **Layer 3 (critic)** — depends on 1+2 to be useful
4. **Layer 4 (live replanner)** — needs orchestrator state refactor
5. **Layer 5 (reviewer)** — independent, can ship anytime

Layers 1 + 2 + 3 together turn the planner from "guesses from corpus"
to "informed proposal with self-check". That alone changes the feel.
Layers 4 + 5 round it out into something that resembles a real
manager — but ship the first three first.

## Consequences

**Good**
- The conductor stops being a thin router and starts being a manager.
- Every plan is grounded in evidence (project + history + critic).
- Mid-flight failures don't kill the session — they replan.
- Quality is verified, not assumed.

**Costs**
- Each layer adds latency: world view assembly ~200ms, lessons ~100ms,
  critic +1 LLM call (~$0.001 per session), reviewer +1 bounded loop
  (~$0.005-0.05 depending on goal). Mitigation: parallelise where
  possible (world view + lessons run concurrently), and turn off via
  flags when not wanted (`--no-critic`, `--no-reviewer`).
- More moving parts. Mitigation: each layer has its own audit envelope
  so debugging is clear ("step 3 failed because critic suggested X but
  planner picked Y").
- The cost estimate per session goes up by ~10-20%. Mitigation: this
  IS the trade-off the user signed up for when they said "make it
  smart" — and the bedrock budget is still the cap.

**Open questions for after first ship**
- Should the world view persist across sessions in `~/.patchwork-harness/world/`
  so we don't re-assemble it every time? Cache invalidation is the
  hard part.
- Should the reviewer have its own budget separate from the session
  budget, or share?
- Should the critic and the reviewer be the same model, or different
  ones? (Different gives second-opinion value.)

## Alternatives considered

- **Fine-tune a "boss" model** — rejected. Too expensive, would lock
  us to one provider, and the foundation models are already good
  enough as the components.
- **Use a single big LLM as the boss with all tools** — rejected. That's
  just Claude Code with extra steps. The orchestration value is in
  *delegating* to specialised cheap fast models, not in one big model
  doing everything.
- **Skip the critic, just trust the planner** — rejected. The user
  explicitly asked for "smart boss." A boss that doesn't review the
  plan before executing isn't a boss.
