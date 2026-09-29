# ADR-0014 — MCP server mode (`patchwork-harness mcp`)

**Status:** accepted · 2026-09-28
**Owner:** maintainers · drafted with Claude
**Depends on:** DIRECTION.md Next-10 item 11 ("MCP SERVER mode is worth adding"), ADR-0010 (human-in-the-loop), ADR-0011/0013 (verify, classify)

## Context

the maintainer wants patchwork-harness "controllable by Claude", including from Claude Code
**Remote Control** sessions. Those run locally, so they see the user's
MCP servers. Until now Claude drove patchwork-harness through Bash strings and the
`patchwork-harness-pipeline` skill: untyped, easy to get wrong, and with nothing to
stop a remote instruction from spending money.

DIRECTION.md keeps an MCP **client** on the do-not list, but names an MCP
**server** as high-leverage (item 11). This ADR builds the server. The
client stays out.

## Decision

- **Command.** `patchwork-harness mcp` serves JSON-RPC 2.0 over newline-delimited
  stdio.
  - Hand-rolled in `src/mcp/server.ts`, with zero new dependencies
    (same approach as the cockpit).
  - Protocol frames only on stdout; diagnostics on stderr.
- **How tools run.** Every tool shells out to this same CLI (`bin/patchwork-harness.mjs`), so
  behaviour, the Patchwork audit and the budget bedrock are identical to
  the terminal.
- **The 13 tools:**
  - Read-only, free: `harness_status`, `harness_models`, `harness_sessions`,
    `harness_show`, `harness_verify_claude`, `harness_verify_session`,
    `harness_verify_file` (each verify takes a `classify` flag),
    `harness_exam`, `harness_run_status`.
  - Costs a few cents: `harness_plan` (dry run: world view, lessons, planner,
    critic) and `harness_ask`.
  - **Gated:**
    - `harness_run` needs `confirm: true` and a budget (default $0.50,
      hard cap $5).
    - `harness_review` is a dry run unless `confirm: true`.
- **Runs go to the background with stdin closed.**
  - They are started with `-u` (`--auto --yes --json`); NDJSON goes to
    `~/.patchwork-harness/mcp-runs/<ts>.ndjson`, indexed by session id.
  - With stdin closed, every permission question or pause resolves at once
    to its **safe default (deny)**, via ADR-0010's `stdin_closed` path.
  - A remote Claude therefore can't approve an off-policy action and can't
    hang a run.
  - Progress: `harness_run_status`.
- **Registration** (user scope):

      claude mcp add patchwork-harness -s user -- "/mnt/c/Program Files/nodejs/node.exe" 'C:\AI\patchwork-harness\bin\patchwork-harness.mjs' mcp

  Registered and **✔ Connected** on 28 Sept 2026. It runs `dist/`, so
  run `npm run build` after source changes.

## Consequences

- **Tests.** 7 in `tests/mcp_server.test.ts`:
  - the handshake echoes the client's protocol version
  - the tool list carries schemas
  - notifications get no reply
  - a run without `confirm` is refused
  - the budget cap is enforced
  - unknown methods and tools return JSON-RPC errors
  - the NDJSON run summariser works
  - one real stdio session, in which every stdout line must parse as JSON
- **Not built.**
  - Read-write memory tools (context claims): DIRECTION says read-only
    first, and write access needs a consent UX.
  - MCP resources and prompts.
  - Streaming progress notifications; `harness_run_status` polling is
    enough for now.
