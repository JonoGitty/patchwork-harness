# ADR-0005: Plugin system and Claude skill backwards compatibility

**Status:** accepted
**Date:** 2026-04-30

## Context

The user has invested a lot in Claude Code skills (~30 of them) and the
broader Claude ecosystem (skills, MCP servers, hooks). Patchwork Harness shouldn't
require throwing those away. Equally, patchwork-harness needs its own plugin
extensibility so the project can grow without forking the core for every
extension.

## Decision

Two layered extension mechanisms:

### 1. First-class plugins (`src/plugins/`)

A plugin is a TypeScript module that exports:

```ts
export interface Plugin {
  name: string;
  description: string;
  version: string;
  init?: (ctx: PluginCtx) => Promise<void> | void;
  tools?: Tool[];
  models?: ModelInfo[];
  hooks?: {
    onSessionStart?: (s: Session) => void | Promise<void>;
    onSessionEnd?: (s: Session) => void | Promise<void>;
    onPlanReady?: (p: Plan) => void | Promise<void>;
    onToolUse?: (t: ToolUse) => void | Promise<void>;
  };
}
```

Plugins are registered in `config/plugins.yml` (M1: built-in only). M2
adds `~/.patchwork-harness/plugins/` discovery and a thin marketplace.

### 2. Claude skill compatibility (built-in plugin: `claude_compat`)

The first plugin shipped is `claude_compat`. It:

- Enumerates `~/.claude/skills/*/SKILL.md`
- Parses their frontmatter (`name`, `description`, `argument-hint`)
- Surfaces them to the planner as a "skills you can call" inventory
- (M2) provides a `SkillCall` tool that invokes a Claude skill by
  spawning `claude --print --skill <name>` with the args

This means the user's existing investment in Claude skills works on day
one — at least at the awareness level (the planner can suggest "use the
/dashboard skill for that"). M2 makes the invocation real.

### 3. ai_time_keep built-in plugin

`ai_time_keep` is the second built-in plugin. It mirrors the existing
ai-time-keep hook on the user's Mac: every planner and executor turn
gets the current wall-clock time injected into the system prompt so the
model never hallucinates dates. The actual time source is Node's
`Date()` plus `process.env.TZ`; the format is the same one the existing
hook uses.

### 4. MCP servers (later)

Treated as a special class of plugin in M2. We define the type interface
in `src/mcp/client.ts` so the rest of the code can compile, but don't
implement protocol exchange in M1.

## Consequences

**Good**
- The user's 30 existing skills are not orphaned.
- New capabilities (memory, search, code review) ship as plugins, not as
  core changes.
- We have a clean extension story to pitch when someone asks "how do I
  add X?".

**Costs**
- We carry two extension models: native plugins and Claude skill compat.
  Mitigation: claude_compat is itself a plugin; the model is one, with
  one of those plugins translating the other ecosystem.
- API surface to keep stable. Mitigation: version the `Plugin` interface
  via the package's own semver; breaking changes go in major bumps.

## Alternatives considered

- **No plugin system in M1** — rejected. The user explicitly asked for
  enterprise-level extensibility from day one.
- **Use Claude Code's plugin marketplace directly** — investigated. It's
  Node-based and would couple us to their format; better to define ours
  and provide compat.
