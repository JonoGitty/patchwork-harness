# ADR-0004: Permission model

**Status:** accepted
**Date:** 2026-04-30

## Context

A coding agent runs untrusted instructions (the LLM's tool calls) on the
user's machine. We need to decide what runs without asking, what asks,
and what is refused outright. The constraints:

1. Patchwork is required (ADR-0001) and already classifies every action
   into 5 risk levels with named flags. We should not duplicate that
   work.
2. The user has explicitly said they want minimal interruption — "with
   patchwork installed I feel less concerned by the approvals."
3. We still need to refuse things that would silently harm the user.

## Decision

The effective allowlist for any action is the **intersection of two
policies**:

- **Patchwork's merged policy** (system + user + project, with
  `max_risk` ceiling and explicit allow/deny rules — see Patchwork's
  policy schema).
- **Patchwork Harness's own policy** at `config/policy.yml` and (later) at
  `~/.patchwork-harness/policy.yml`.

If either layer denies, the action is denied. If either layer requires a
prompt, the action prompts. Auto-approval requires both layers to
auto-approve. This is "fail-closed both ways" and removes the temptation
to weaken patchwork-harness's policy as a workaround.

### Default boundary (M1)

| Class                                   | Default       |
|-----------------------------------------|---------------|
| Read inside cwd                         | auto          |
| Glob / grep inside cwd                  | auto          |
| Read outside cwd                        | prompt        |
| Edit / write inside cwd                 | auto          |
| Edit / write outside cwd                | prompt        |
| Read sensitive paths (`.env`, `id_rsa`) | refuse (tool layer) |
| Bash from allowlist                     | auto          |
| Bash off allowlist                      | prompt        |
| Bash matching denylist                  | refuse        |
| `git status/diff/log/add/commit`        | auto          |
| `git push`                              | prompt        |
| `gh pr create / merge`                  | prompt        |
| Any action Patchwork rates `critical`   | refuse        |

### Flags

- `--auto` widens prompts → auto for everything below `high`. Refuses
  remain refuses.
- `--cautious` narrows auto → prompts for everything above `none`.
- `--dry-run` skips all execution after planning; still emits the plan
  to audit.
- `--max-budget-usd <n>` caps spend per session; default $1.

### Where the gate lives

In `src/permissions/policy.ts`. Tools never decide their own risk
ceiling; the executor checks the gate before calling `tool.run`.
Sensitive-path refusal is duplicated in the tool layer (defence in
depth — see SECURITY.md).

## Consequences

**Good**
- Clear, predictable behaviour: same goal → same prompts every time.
- One file to read to understand what patchwork-harness will do without asking.
- Patchwork remains the canonical risk classifier. Patchwork Harness is the
  user-facing UX layer.

**Costs**
- Two policies to keep coherent. Mitigation: `patchwork-harness doctor` shows the
  effective intersection. We'll add `patchwork-harness policy show` in M2.
- "Why did it ask me?" → answer is one of two layers. Mitigation: the
  prompt message names the layer that triggered it.

## Alternatives considered

- **Patchwork Harness defines the only policy, ignores Patchwork's** — rejected.
  Two systems would drift; users would set Patchwork's deny rules and
  be surprised when patchwork-harness ignores them.
- **Reuse Patchwork's policy as our own (no patchwork-harness policy at all)** —
  tempting, but Patchwork's policy is about risk, not orchestration UX
  (e.g. "ask before pushing" is a UX decision, not a security
  classification).
