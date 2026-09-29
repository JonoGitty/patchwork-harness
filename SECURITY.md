# Security

This document is the threat model and the list of decisions we made to
contain it. If you change the security boundary, you change this doc.

## What this tool does that's risky

Patchwork Harness routes natural-language goals to LLMs and lets those LLMs
execute shell commands and edit files. Every coding agent has the same
risks; we add multi-LLM routing on top. Specific concerns:

1. **Prompt injection from files / web pages** — if the goal or a tool
   result contains hostile instructions, the model may follow them.
2. **Credential exfiltration** — a model could read `.env`, `id_rsa`, etc.
   and emit them in a tool argument or a commit.
3. **Destructive commands** — `rm -rf`, `git push --force`, dropping
   tables, killing processes.
4. **Cost runaway** — an unbounded loop racks up tokens.
5. **Audit gap** — agent runs without leaving a trace.
6. **Multi-provider key exposure** — multiple SDKs reading multiple env
   vars increases the surface for accidental logging.

## What we trust

| Component | Trusted to | Why |
|-----------|------------|-----|
| **Patchwork** | Be running, classify risk, enforce its own policy | It is the audit substrate, hash-chained and tamper-evident; required to start |
| **The OS** | Enforce file permissions and the user's PATH | Standard |
| **The LLM provider's TLS** | Confidentiality of API requests | Standard |

## What we do not trust

- **The LLM's outputs.** Every tool call goes through the permission
  gate; "the model said do it" is never sufficient.
- **Tool inputs.** Shell commands are pattern-matched against deny lists
  *before* execution, not after.
- **Goals.** A goal can include hostile instructions; we still classify
  every derived action.
- **Web fetches.** Treated as untrusted input even if the URL looks safe.

## Concrete defences

### 1. Patchwork is required
`boot.ts` refuses to start unless Patchwork is installed AND a test event
emits successfully. There is no `--skip-patchwork` flag. If you don't
want audit, you are using the wrong tool.

See `DECISIONS/0001-patchwork-required.md`.

### 2. Fail-closed audit
If an audit emit fails mid-run, the run aborts. We don't continue blind.
Patchwork's risk classifier sees every action; if `max_risk` blocks it,
we don't override.

### 3. Permission gate is the intersection of two policies
The agent's effective allowlist = (our policy) ∩ (Patchwork's policy).
Neither layer can grant what the other denies. See
`DECISIONS/0004-permission-model.md`.

### 4. Sensitive paths are blocked at the tool layer
The `read`, `write`, `edit` tools refuse `.env*`, `id_rsa`, `.aws/`,
`.ssh/`, `*secret*`, `*credential*` regardless of LLM output. This
overlaps with Patchwork's policy intentionally — defence in depth.

### 5. Bash allowlist + denylist
Bash denylist: `sudo *`, `rm -rf *`, `git push --force*`, `chmod 777 *`,
`curl * | bash`, `wget * | sh`. Bash allowlist for auto-approval:
`npm/pnpm/yarn/git/node/python/pytest/ls/cat/echo/mkdir/cp/mv` (the last
two only inside cwd). Anything else prompts.

### 6. Cost cap per session
`--max-budget-usd` caps per session (default $1). On hit, the executor
stops mid-loop with a clean message. No silent overspend.

### 7. Provider keys are loaded once, never logged
Keys come from env vars only. Provider clients are constructed once.
The audit emitter explicitly redacts any value that looks like a key
(starts with `sk-`, `xai-`, etc.).

### 8. No automatic git push
Auto-approve stops at `git commit`. `git push` and `gh pr create` always
prompt unless `--auto-push` is set explicitly. There is no env-var
shortcut to defeat this.

## Threat model: what's in scope vs out

**In scope**
- Local single-user use on a developer laptop
- Multiple LLM providers running concurrently for the same user
- Hostile inputs from goals and tool results
- Accidental destructive commands

**Out of scope (M1)**
- Multi-tenant / shared servers
- Network-attached agent execution (e.g. CI/CD running patchwork-harness)
- Sandboxing (no cgroups / seccomp; we rely on policy + Patchwork)
- Defending against a fully compromised Patchwork install

We will revisit sandboxing in M3+ if there's demand. For CI use today,
the right answer is to run patchwork-harness inside a disposable container with its
own scoped tokens.

## Reporting issues

Open a GitHub issue with the `security` label. Critical issues: contact
the repo owner directly before public disclosure.
