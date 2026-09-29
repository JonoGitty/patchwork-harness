# ADR-0002: TypeScript on Node 20+

**Status:** accepted
**Date:** 2026-04-30

## Context

Patchwork Harness needs to:

- Spawn other CLIs (`patchwork`, `gh`, `git`, `claude`, `codex`)
- Talk to multiple LLM SDKs (Anthropic, OpenAI, Gemini, xAI)
- Render rich CLI output and (later) a web dashboard
- Eventually act as an MCP host
- Be writable by AI coding tools without endless type wrangling

## Decision

TypeScript on Node 20+, ESM modules, Biome for lint+format, tsx for dev,
tsup for build, vitest for tests.

## Why TypeScript over Python

- **Closer ergonomics to the agents we're orchestrating.** Claude Code,
  the Anthropic SDK examples, the MCP spec, and Patchwork itself are all
  TypeScript/JavaScript. Less impedance.
- **Web dashboard for free later.** We can serve the dashboard from the
  same process with no second toolchain.
- **First-class async.** Spawning multiple LLM calls in parallel is the
  hot path. Async/await with `Promise.all` is natural here; Python's
  asyncio adds friction.
- **Single binary distribution** later via `pkg`/`bun build`/Node SEA if
  we want it.

## Why not Python (which we tried first)

The patchwork-harness v0.1 Python scaffold worked but had two annoyances: the
multi-LLM async story is awkward in Python (you end up with thread
pools or asyncio adapters per SDK), and shipping a CLI with native deps
to other developers is harder than `npm install -g`.

## Consequences

**Good**
- One language for CLI, web dashboard, MCP host
- Mature LLM SDKs in TS for all four target providers
- Fast dev cycle with tsx; small built artefact with tsup

**Costs**
- Node version drift. Pin >= 20 in `engines.node`.
- TypeScript compile step adds ~2s for cold start in dev. Acceptable.

## Alternatives considered

- **Python** — see above.
- **Rust** — overkill for an orchestrator that mostly waits on network
  IO. We'd ship later than we'd ever benefit.
- **Go** — viable, but less ergonomic for the LLM SDK story; we'd write
  more glue.
