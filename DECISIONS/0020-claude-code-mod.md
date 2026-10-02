# ADR-0020 — patchwork-harness as a Claude Code mod

**Status:** built and statically validated; shipped in Patchwork Harness v0.2.0; NOT yet run live (mods are switched off remotely for this account) · 2026-10-01
**Owner:** maintainers · drafted with Claude
**Depends on:** ADR-0011/0012 (L4.5 verify), ADR-0013 (classifiers, Jeff), ADR-0019 (injection guard)

## Context

**Claude Mods shipped in Claude Code 2.1.287** (1 Oct 2026). A mod is a plugin
whose TypeScript event handlers run inside Claude Code. It can:
- wrap every tool call, observe it, and rewrite its result
- follow turns
- add `/commands` and tools
- draw panes
- reach files, processes and the network through a traced `$` API

Yesterday's real-use check found that the harness barely touched real work:
9 real patchwork-harness runs, against everyday work in Claude Code. A mod puts the
harness's measured pieces inside the tool the maintainer actually uses.

## Decision

`claude-mod/` is a plugin named `patchwork-harness`, v0.1.0. It has one hooks module,
`hooks/register.ts`.

- **Injection guard (`tool.call`).**
  - **What is screened:** after `Read`, `Bash`, `Grep`, `WebFetch`,
    `WebSearch`, `NotebookRead` and MCP tools run, their output (200+ chars,
    up to 4 windows from head to tail) goes to Jeff's `guard` adapter over
    `$.http.fetch`. Time spent inside a mods-API call does not count against
    a hook's 10 s budget.
  - **On a hit:** `flag` (the default) puts a warning in front of what
    Claude reads; `withhold` replaces the output with a notice. Either way
    the user gets a toast.
  - **If Jeff is down at session start:** the guard turns itself off and
    says so, and the session carries on.
- **`/verify [--classify]`.** Runs `patchwork-harness verify claude <this session> --json`
  through `$.process.run` and prints an honest summary: counts, overall
  verdict, coverage, the ungrounded claims, and the triage.
  - `/verify auto on` verifies each answer at `turn.complete`. It is **off
    by default**: auditing is requested, never forced (project rule).
- **`/guard`** sets the mode and threshold. **`/harness`** shows the status:
  what was screened, what was caught, and the last verification.
- **Settings** come from manifest `userConfig`: `jeff_url`, `guard`,
  `guard_threshold`, and `patchwork-harness` (a command, or a JSON argv for WSL to
  Windows node).
- **The mod does not change any global setting.** It loads only when asked:
  `claude --plugin-dir …`, `CLAUDE_CODE_PLUGIN_DIRS`, or an install.

## Evidence

- **`claude plugin validate ./claude-mod --strict` passes.** Claude Code's
  own static analysis lists 6 hooks (`session.start`, `tool.call`, 3 ×
  `command.run`, `turn.complete`) and these calls: `$.command.register`,
  `$.http.fetch` (via checkJeff, screenResult), `$.process.run` and
  `$.session.id` (via runVerify), `$.ui.log` and `$.ui.toast`.
- **Validator rule learned.** `$` may only be passed to functions declared at
  the top of the file, so that every call can be traced. The mod's state
  therefore travels as an object.
- **Tests.** `tests/claude_mod.test.ts` has 13 tests. They drive the real
  handlers through a fake `on` and `$`: the guard flags and withholds, and
  clean, short, refused and unscreened output passes untouched with no call
  to Jeff. Mutation-checked: disabling flagging fails 4 tests.
- **Bug caught before it shipped.** The first `/verify` summary read a
  `status` field. patchwork-harness's report uses per-atom `verdict` and top-level
  counts, so it would have shown "0 ungrounded" for every session, a false
  all-clear. It is now tested on the real shape. Run on a real report, it
  matches the CLI: 14 verified, 3 ungrounded, 2 missed.
- **Full suite:** 521 pass, plus the 2 known Windows failures.

## Not yet

- **A live run.** `claude plugin test` reports "hooks modules are turned off
  in this process: the rollout switch served off". The docs say that means
  Anthropic has turned mods off remotely for this account, and no local
  setting changes it.
  - When it flips, test with `claude --plugin-dir ./claude-mod`, then
    `claude plugin test`.
  - The `tool.call` result's exact field (`result` vs `content`) is handled
    both ways until the generated types confirm it.
- **Publishing.** It could ship with Patchwork Harness, where the export
  renames it to `patchwork-harness`. That needs the maintainer's OK.
- **Ideas, not built:**
  - an `AbovePrompt` band showing guard hits live
  - intent lanes per turn (`turn.step` → model/effort), which is parked
    because chat intent routes poorly without context (ADR-0018)
