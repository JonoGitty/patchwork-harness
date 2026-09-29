# ADR-0007: Streaming output + `--json` deterministic mode

**Status:** accepted
**Date:** 2026-04-30

## Context

Two adjacent gaps shipped together because they share the executor's
output path:

1. **Streaming.** Every executor turn called `provider.complete()` and
   waited for the full response. For long Sonnet/Opus turns the user
   sees nothing for tens of seconds. Claude Code streams tokens; the
   orchestrator should too.

2. **Deterministic command surface.** A parent agent (e.g. Claude Code
   driving patchwork-harness via `bash` to delegate sub-tasks) can't reliably
   parse rich/coloured human output. Without an opt-in NDJSON mode the
   only way to know "is the planning done?" is screen-scraping.

## Decision

### Streaming (`Provider.stream()`)

Added `stream(req): AsyncIterable<StreamChunk>` to the `Provider`
interface. `StreamChunk` is one of:

- `{ type: "text_delta", text }` — incremental text
- `{ type: "tool_use_start", id, name }` — tool_use block begins
- `{ type: "tool_use_input_delta", id, partial_json }` — incremental
  tool_use input as JSON fragments
- `{ type: "usage", input_tokens, output_tokens }` — once, near end
- `{ type: "done", final: CompletionResponse }` — terminal chunk
  carrying the full assembled response

Implementations:

- **Anthropic** (`messages.stream()`) — handles `content_block_delta`
  (text + input_json), accumulates via `finalMessage()` for usage and
  stop_reason
- **OpenAI** (`chat.completions.create({stream: true, stream_options:{include_usage: true}})`) —
  reassembles tool_call argument deltas across chunks by `index`
- **Gemini, xAI** — stub that throws `"not implemented in M2"`

The executor uses a `streamingComplete()` wrapper that catches the
"not implemented" error and falls back to `provider.complete()`. Audit
emit semantics are preserved: `provider_call` before the stream,
`provider_response` once `done` arrives with the full content + usage
+ cost.

### `--json` deterministic mode

Added `--json` to the `one-shot` command. When set:

- A `StdoutJsonReporter` is installed and threaded through orchestrator
  → planner → executor
- The logger's `setSilentStdout(true)` redirects rich output to stderr
- One JSON event per line on stdout: `session_start`, `plan_proposed`,
  `plan_ready`, `step_start`, `step_token` (each text delta),
  `step_end`, `permission_required`, `session_end`, `error`

Event shape:

```json
{ "type": "step_token",
  "timestamp": "2026-04-30T21:00:00.000Z",
  "session_id": "01HXYZ…",
  "data": { "step": "Implement validator", "text": "fragment" } }
```

`--json` is **not** a replacement for the audit log. The audit log
(`~/.patchwork-harness/events/<session>.jsonl`) remains the durable hash-chained
record. NDJSON-on-stdout is an ephemeral live observer surface.

Permission prompts in `--json` mode are unsupported in this milestone
— callers must pair `--json` with `--auto` and `--yes`. A
`permission_required` event will fire if a prompt is needed but no
stdin handler is wired; we'll close that gap when we have a parent
caller that wants to handle prompts (likely M3).

### Web dashboard launch form

POST `/api/sessions/new` accepts the same flags via JSON body, spawns
`bin/patchwork-harness.mjs` as a child with `--json --yes --auto`, and returns a
`job_id`. SSE at `/api/jobs/:jobId/stream` tails the child's stdout
(NDJSON) and stderr. The dashboard's HTML adds a "+ New session"
button and modal; on `job_end` it auto-selects the resulting session.

In-memory `jobs` map holds the child reference for the lifetime of the
process plus a 60s drain window for late SSE clients. There's no
persistence — restarting `patchwork-harness web` clears the queue.

## Consequences

**Good**

- Long Sonnet/Opus steps now show progressive output instead of
  hanging silently
- A parent Claude Code session can drive patchwork-harness with reliable parsing:
  `patchwork-harness --json --auto --yes "do X" | jq -c .`
- The web dashboard becomes a real launcher, not just a viewer

**Costs**

- More moving parts in executor.ts (the streaming wrapper) and CLI
  (the silent-stdout flag). Mitigated by tests for both paths.
- Web dashboard now spawns child processes — restart kills running
  jobs. Acceptable for a single-user dashboard; would need a
  daemon-supervisor model for shared use.
- Permission prompts are stubbed in `--json` mode. If a non-`--auto`
  caller sets `--json`, prompts will emit a `permission_required`
  event with no way to respond → step gets denied. Document clearly;
  fix later.

**Open questions**

- Should `step_token` events be coalesced into chunks of N
  characters or shipped as-they-arrive (one-byte deltas would be
  noise)? Currently shipped as-they-arrive — revisit if NDJSON volume
  becomes a problem.
- Should the dashboard launcher persist jobs across restarts? Probably
  yes, but not in this milestone.

## Alternatives considered

- **Add a separate `streamComplete()` method on Provider** — rejected
  in favour of keeping the surface small. `stream()` returns the same
  shape via the `done` chunk, so callers that need both get both from
  one method.
- **Use existing audit JSONL on disk as the parent-agent surface** —
  rejected. Audit format is Patchwork-shaped and verbose; callers
  shouldn't have to know that schema. NDJSON on stdout is the right
  abstraction layer.
- **Make the dashboard launcher use the same Hono process to call
  oneShot() in-process** — rejected. Spawning isolates failures and
  keeps the `patchwork-harness web` process responsive for other clients while
  one job runs hot.
