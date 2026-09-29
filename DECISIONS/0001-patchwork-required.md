# ADR-0001: Patchwork is a hard requirement

**Status:** accepted
**Date:** 2026-04-30

## Context

Coding agents that act on the user's machine — read files, run commands,
push to git — produce a stream of consequential actions. When something
goes wrong (a destructive command, a leaked secret, an unintended
overwrite) you need to be able to answer two questions instantly:
**what happened?** and **why did it happen?**

Most coding agents log to stdout or to a transient cache. That is not
audit; it is residue. We chose to build on
[Patchwork](https://github.com/JonoGitty/patchwork-audit) which provides:

- A 5-layer tamper-evident audit log (hash-chained + HMAC seals + relay)
- Risk classification per action (none → critical)
- Policy enforcement (allow/deny rules + max_risk ceiling)
- A CLI for inspection (`patchwork log`, `show`, `replay`, `diff`)

## Decision

**Patchwork Harness will not start without Patchwork.** The boot sequence
does the following before the CLI accepts any goal:

1. `patchwork --version` succeeds
2. `~/.patchwork/` exists and is readable
3. A test event can be appended to our session JSONL (write path is
   alive and policy doesn't block startup events)

If any check fails, the process exits with a clear actionable message
pointing to the install instructions. There is no `--skip-patchwork`,
no env var, no config flag that bypasses this. If you want an unaudited
agent, use a different tool.

## Consequences

**Good**
- The trust story is simple: the audit and risk-classification layer is
  always present, so we can build the rest of the system assuming it.
- Users who care about audit get it without having to enable anything.
- Multi-LLM orchestration becomes possible to reason about — every
  provider's actions land in the same timeline.

**Costs**
- Higher install friction. Patchwork must be installed first.
  Mitigation: `patchwork-harness doctor` produces the exact npm command to run.
- Coupling. Patchwork's schema and policy semantics are now part of our
  contract. We mirror its event shape and respect its risk taxonomy.
  Mitigation: we own one schema document and update it together.
- Patchwork outages = patchwork-harness outages. Acceptable. The whole point of
  fail-closed is that "agent runs with no audit" is not a state we want
  to be in even temporarily.

## Alternatives considered

- **Optional audit (default on, opt-out via flag)** — rejected. The opt-out
  becomes the path of least resistance the first time something is
  inconvenient.
- **Embed our own audit instead of using Patchwork** — rejected. Patchwork
  exists, is hardened, has a relay daemon and seal protocol we'd have to
  rebuild. We use what's there.
- **Optional Patchwork with degraded mode** — rejected. "Degraded" tends
  to mean "off" in practice.
