# ADR-0010: Human-in-the-loop — the human side actually works

Date: 2026-08-12
Status: accepted

## Context

The agent side of patchwork-harness was mature; the human side was not. Three gaps:

1. `confirm()` silently returned the default (deny) whenever stdin was not
   a TTY. Every dashboard-launched session therefore auto-denied all
   permission prompts — permission modes `default` and `cautious` were
   decorative in the web UI.
2. The `permission_required` NDJSON event type existed but was never
   emitted, so parent agents / the dashboard could not even see that a
   question had been asked.
3. The roadmap's `pause_for_human` plan action (steps that can't be
   auto-approved, e.g. design decisions) had never been built.

## Decision

One abstraction, `HumanChannel` (`src/permissions/human.ts`), with three
implementations chosen by run shape:

- **TTY** — readline y/n and free-text prompts (previous behavior, kept).
- **JSON mode** — questions go out on stdout as `permission_required` /
  `human_pause` NDJSON events carrying a question id; answers come back on
  stdin as `{"type":"human_answer","id":"q1","answer":"yes"}` lines. A
  timeout (`PATCHWORK_HARNESS_HUMAN_TIMEOUT_S`, default 600s) falls back to the safe
  default so an abandoned dashboard tab cannot hang a session forever.
  Every resolution is echoed as a `human_answer` event with a `source` of
  `human`, `timeout`, or `stdin_closed`.
- **Headless** — immediate safe defaults (deny / no answer), same
  behavior as before but now visible in events rather than silent.

The CLI creates the channel and owns its lifecycle (releases the stdin
listener in a `finally`). The orchestrator uses it for budget and plan
confirmations; the executor uses it for permission prompts and for the
new `pause_for_human` steps.

`pause_for_human` steps make **no provider call** — the step description
is the question, the person's answer becomes `output_summary` (prefixed
`Human decision:`) and feeds all later steps via the session context
(truncated at 600 chars instead of the usual 200, because human decisions
are high-signal). Answering `abort`/`stop`/`cancel` ends the session with
status `denied`. No answer (headless or timeout) fails the step. Pause
steps cost $0 in the plan estimate.

The dashboard spawns children with piped stdin, forwards answers via
`POST /api/jobs/:jobId/answer`, and renders streaming question cards
(Allow/Deny buttons for permissions, a text box for pauses). A launch
option "Ask me before running the plan" drops the previously hardcoded
`--yes` so the plan itself can be approved from the browser.

## Consequences

- Permission modes `default`/`cautious` are now real in every run shape.
- Planner may insert pause steps; prompt tells it to use them sparingly.
- Parent agents driving `patchwork-harness --json` should watch for
  `permission_required`/`human_pause` events and answer over stdin, or
  pass `--yes --auto` as before to stay fully unattended.
- Safe-by-default is preserved: nobody listening → deny / no answer.
