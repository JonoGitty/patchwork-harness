# ADR-0009 — Memory spine is the load-bearing direction

**Status:** Accepted
**Date:** 2026-05-27
**Supersedes:** parts of ADR-0008 (Smart Conductor L4) and roadmap items in `ROADMAP.md` (M2 calendar integration, plugin marketplace, parallel steps)

## Context

After the May 2026 capability sprint (5 providers, Gemini multimodal, grounded search, autonomous grounded research steps), the next planned work was: build an in-patchwork-harness context store and integrate NotebookLM as both a provider and a tool. Before committing to that scope, Claude Opus 4.7 (acting as the working agent for the user) commissioned an independent cross-vendor review by GPT-5.5 via the patchwork-harness gateway. No shared context, no prior knowledge of the project.

GPT-5.5's diagnosis (full text in `docs/reviews/2026-05-27-gpt-5.5-direction-review.md`):

> You're at risk of building a beautiful multi-provider orchestration platform instead of a brutally useful local Claude power tool.

Both reviewing agents converged on the same conclusion. The mission ("make Claude more powerful on my machine, remember where and what everything is") is not served by more providers, streaming, or Conductor L4. It is served by durable memory, session resume, retrieval quality, and trust.

## Decision

**Memory is the spine.** Future work plugs into it. Concretely:

1. The next-3 priorities are: (a) memory spine + auto-extraction, (b) session resume, (c) NotebookLM as tool only.
2. NotebookLM does NOT become a provider. The earlier "provider + tool" plan is revised to "tool only" because NotebookLM is not a chat-completion model and the provider interface would leak abstraction.
3. The context-store schema bakes provenance and confidence in from day one. FTS lives over a `chunks` table, not whole documents. Claims have `created_by`, `confidence`, `status`. See `DIRECTION.md` for the schema.
4. CSV export is an explicit command, not an auto-mirror.
5. A `L5-lite` reviewer (post-session checker) is in scope; Conductor `L4` (live re-planner) is deferred indefinitely as YAGNI for the current failure modes.
6. Bash hardening, lower-cost defaults, daily cap, audit-log secret scanning, and prompt-injection source-boundary discipline ship as part of operational hardening alongside the spine.

A binding do-not list lives in `DIRECTION.md` to prevent drift back to platform building. Future scope proposals get checked against it before any code starts.

## Consequences

Positive:

- The orchestrator becomes useful at the thing it was always supposed to do: helping one person on one Mac get more done across sessions without losing context.
- Other capabilities (NotebookLM, Perplexity, grounded Gemini) all write into the same memory layer instead of being siloed integrations.
- Honest prioritisation removes the temptation to ship "platform" work that doesn't compound.

Negative / accepted trade-offs:

- Calendar integration is dropped from the near-term roadmap.
- MCP client execution stays stubbed for now. nlm exposes its own MCP server; we may revisit consuming it later.
- Conductor L4 (live re-planner) is deferred indefinitely. If failure modes change (e.g. steps fail mid-flight more often), this returns.
- Plugin marketplace is dropped from M2.
- Provider count is capped at 5 for now. No new model vendors until they unlock a workflow we can't already serve.

## Process note

This is the first ADR taken after a deliberate cross-vendor sanity check using patchwork-harness's own gateway. Treat the pattern as repeatable: when the next significant scope decision comes up, run it past the other vendor first.
