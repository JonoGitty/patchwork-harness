# ADR-0003: Tool protocol

**Status:** accepted
**Date:** 2026-04-30

## Context

Multiple LLM providers expose function/tool calling differently:

- Anthropic: `tools: [{name, description, input_schema}]`, model returns
  `tool_use` content blocks; user replies with `tool_result`.
- OpenAI: `tools: [{type:"function", function:{name, description, parameters}}]`,
  model returns `tool_calls`; user replies with `role:"tool"`.
- Gemini: function declarations + function calls in `parts`.
- xAI / Grok: OpenAI-compatible.

The orchestrator needs one tool definition that works across all
providers, and one execution path so audit/permission checks are not
duplicated per provider.

## Decision

We define `Tool` once and adapt per provider at call time.

```ts
interface Tool<I = any, O = any> {
  name: string;
  description: string;
  inputSchema: ZodSchema<I>;          // canonical
  riskClass: (input: I, ctx: ToolCtx) => RiskAssessment;
  run: (input: I, ctx: ToolCtx) => Promise<O>;
}
```

A `ProviderAdapter` translates `Tool[]` into the provider's tool spec
and translates the provider's tool-call response back into our `ToolUse`
shape:

```ts
interface ToolUse { id: string; name: string; input: unknown; }
interface ToolResult { toolUseId: string; content: string; isError?: boolean; }
```

The agent loop runs in `executor.ts` and is provider-agnostic:

```
loop:
  msg = provider.complete(messages, tools)
  for each tool_use in msg:
    risk = tool.riskClass(input, ctx)
    permission.check(risk)         // may throw, prompt, or auto-allow
    audit.emit("tool_use_start", risk)
    result = tool.run(input, ctx)
    audit.emit("tool_use_end", status)
    messages.append(tool_result)
  break if no tool_use or budget exhausted or step done
```

The audit and permission gates live exactly once. Adding a new provider
means writing one `ProviderAdapter`, not duplicating the gating logic.

## Consequences

**Good**
- One source of truth for what a tool does and how risky it is.
- Adding Gemini/xAI in M2 is a small adapter, not a refactor.
- Plugins register tools via the same interface; no second tool model.

**Costs**
- Adapter complexity scales linearly with provider count. Acceptable.
- Schema translation: zod ↔ JSON Schema for Anthropic/OpenAI is well
  supported but loses some nuance (e.g. zod refinements). Mitigation:
  validate on the receiving side too.

## Alternatives considered

- **Use one provider's native tool format and translate inwards** —
  rejected. Locks us to that provider's quirks (e.g. OpenAI's nested
  `function` envelope) in our own type system.
- **Tool-per-provider** — rejected. Combinatorial explosion + audit
  duplication risk.
