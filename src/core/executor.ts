/**
 * Step executor. Runs a single step's bounded inner agent loop:
 * provider.complete -> tool_use -> permission -> run tool -> tool_result
 * -> repeat. Bounded by step.max_tool_turns AND the session bedrock.
 */

import type { AuditEmitter } from "../audit.js";
import { loadModels } from "../config.js";
import type { HumanChannel } from "../permissions/human.js";
import { decide } from "../permissions/policy.js";
import { confirm } from "../permissions/prompt.js";
import { systemPromptAddenda } from "../plugins/manager.js";
import {
  fallbackModelFor,
  isAccountWideError,
  isModelNotFoundError,
  markUnreachable,
} from "../providers/availability.js";
import type {
  CompletionRequest,
  CompletionResponse,
  ContentBlock,
  Message,
  Provider,
} from "../providers/base.js";
import { getProvider } from "../providers/registry.js";
import type { Tool } from "../tools/base.js";
import { setBudgetState } from "../tools/budget_status.js";
import { tools as allTools } from "../tools/registry.js";
import type { JsonReporter } from "../util/json_reporter.js";
import { log } from "../util/logger.js";
import { zodToJsonSchema } from "../util/zod-to-json-schema.js";
import {
  BedrockBreachError,
  type BudgetState,
  assertWithinBedrock,
  snapshot,
  withinSessionAllowance,
} from "./budget.js";
import type { Step, StepResult } from "./types.js";

interface RunStepInput {
  step: Step;
  cwd: string;
  sessionId: string;
  audit: AuditEmitter;
  budget: BudgetState; // shared, mutated as spend accumulates
  mode: "auto" | "default" | "cautious";
  systemContext: string;
  /** When set, JSON events go here and stdout text streaming is suppressed. */
  reporter?: JsonReporter;
  /** How to reach the person running the session (permission prompts,
   *  pause_for_human steps). Absent → legacy TTY confirm / safe defaults. */
  human?: HumanChannel;
  /**
   * Nobody is there to answer (`-u` / `--auto`). pause_for_human steps are
   * skipped with an audit event and prompt-class permissions resolve to
   * DENY-and-continue instead of waiting on stdin (a JSON-mode run used to
   * block up to 600s per prompt, 2 Sept 2026). Defaults to mode === "auto".
   */
  unattended?: boolean;
  /** Only these tools are offered (ADR-0016: the L5 reviewer is read-only). */
  toolAllow?: string[];
  /** ADR-0015 runtime guards (opt-in). */
  guards?: {
    /** Nudge the model when it repeats an identical tool call 3+ times. */
    loop?: boolean;
    /** Absolute wall-clock deadline for the whole run (ms since epoch). */
    deadlineMs?: number;
    /** Run start, for the "time used" line the model sees. */
    startedMs?: number;
  };
}

/** Identical calls allowed before the loop guard speaks up. */
export const LOOP_GUARD_REPEATS = 3;

/** LLM-facing tool-result caps (chars of JSON). `read` gets room for a
 *  real page of source; everything else stays compact. The marker tells
 *  the model exactly how to page - an unmarked 8k slice of a 118k file once
 *  read as "the whole file" (2 Sept 2026). */
export const TOOL_RESULT_CAP_DEFAULT = 8_000;
export const TOOL_RESULT_CAP_READ = 60_000;

export function capToolResult(toolName: string, llmResult: unknown): string {
  const full = JSON.stringify(llmResult);
  const cap = toolName === "read" ? TOOL_RESULT_CAP_READ : TOOL_RESULT_CAP_DEFAULT;
  if (full.length <= cap) return full;
  const slice = full.slice(0, cap);
  let how: string;
  if (toolName === "read") {
    const r = llmResult as { start_line?: number };
    const shownLines = (slice.match(/\\n/g) ?? []).length;
    const nextOffset = (typeof r?.start_line === "number" ? r.start_line : 1) + shownLines;
    how = `to continue, call read again with offset=${nextOffset} (and a smaller limit, e.g. 400); never report code you have not seen as absent`;
  } else if (toolName === "grep") {
    how =
      "the matches beyond this point were NOT shown - narrow the pattern/path or lower max_matches, then search again";
  } else {
    how = "narrow the request (smaller range, fewer results) and call again";
  }
  return `${slice} …[TRUNCATED: showing ${cap} of ${full.length} chars - the rest was NOT shown; ${how}]`;
}

/**
 * Streaming wrapper. Yields incremental text via `onText`, returns the
 * final CompletionResponse. Falls back to `complete()` if the provider's
 * stream() is unimplemented (Gemini, xAI). Network errors propagate.
 */
async function streamingComplete(
  provider: Provider,
  req: CompletionRequest,
  onText: (text: string) => void,
): Promise<CompletionResponse> {
  try {
    for await (const chunk of provider.stream(req)) {
      if (chunk.type === "text_delta") onText(chunk.text);
      if (chunk.type === "done") return chunk.final;
    }
    throw new Error("provider stream finished without a 'done' chunk");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("not implemented")) {
      const r = await provider.complete(req);
      // Emit accumulated text in one chunk so downstream consumers see something
      for (const c of r.content) {
        if (c.type === "text") onText(c.text);
      }
      return r;
    }
    throw e;
  }
}

// The live budget line is NOT in this template: it changes after every
// paid turn and would bust the prompt cache (see CompletionRequest.systemDynamic).
const SYSTEM_TEMPLATE = (
  step: Step,
  ctx: string,
  addenda: string,
  unattended: boolean,
) => `You are an executor inside Patchwork Harness.
You handle ONE step of a larger plan: "${step.title}".
Step description: ${step.description}
You have a bounded tool budget (${step.max_tool_turns} tool turns). Use tools to do real work, then stop.
When the step is done, reply with a short summary in plain text and no tool call.
The live budget is stated at the very end of this prompt.

Context from the session:
${ctx}

Constraints:
- Only edit files relevant to this step.
- Don't push or open PRs unless the step explicitly asks.
- If you need information, use the read/grep/glob tools; don't guess.
- read is line-paged: when a result says truncated, call read again with offset = next_offset. Never describe code you have not actually seen as missing.
- You can call budget_status to check your remaining spend at any time.
${unattended ? "- This run is UNATTENDED: no human can approve anything. Off-allowlist bash and outside-cwd paths will be DENIED immediately - prefer read/grep/glob and allowlisted commands, and say so if a step genuinely needs a person.\n" : ""}
${addenda}`;

function toToolDefs(tools: Tool[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.inputSchema) as Record<string, unknown>,
  }));
}

function summarise(content: ContentBlock[]): string {
  return content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .slice(0, 4000);
}

export async function runStep(input: RunStepInput): Promise<StepResult> {
  const { step, cwd, sessionId, audit, mode, systemContext, budget, reporter, human } = input;
  const unattended = input.unattended ?? mode === "auto";
  const t0 = performance.now();

  setBudgetState(sessionId, budget);

  audit.emit({
    action: "step_start",
    target: { step: step.title, provider: step.provider, model: step.model },
    provenance: { reason: step.reason, budget: snapshot(budget) },
  });
  reporter?.emit("step_start", {
    step: step.title,
    provider: step.provider,
    model: step.model,
    reason: step.reason,
  });
  // Surface the planner's routing rationale on the CLI so the user sees
  // WHY this model was picked, not just which one.
  if (!reporter) {
    log.step(`${step.title}  [${step.provider}/${step.model}]`, step.reason);
  }

  // pause_for_human: no provider call — the "model" for this step is the
  // person running the session. Ask the question, record the answer, and
  // feed it forward to later steps via output_summary.
  if (step.pause_for_human) {
    const base = {
      step,
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      tool_calls: 0,
    };
    const endEvent = (status: string, duration_ms: number, error?: string) =>
      reporter?.emit("step_end", {
        step: step.title,
        status,
        cost_usd: 0,
        tokens_in: 0,
        tokens_out: 0,
        duration_ms,
        error,
      });
    if (unattended) {
      // Nobody can answer: skip, on the record, and tell later steps to
      // take the safest default rather than hang or fail the whole run.
      const note = "pause_for_human skipped: unattended run, no human channel";
      audit.emit({
        action: "permission_prompt",
        status: "denied",
        target: { step: step.title, kind: "pause_for_human", skipped: true },
        provenance: { question: step.description, reason: note },
      });
      audit.emit({
        action: "step_end",
        status: "completed",
        target: { step: step.title },
        provenance: { note },
      });
      const duration_ms = Math.round(performance.now() - t0);
      if (!reporter) log.warn(`${note}: "${step.description.slice(0, 120)}"`);
      endEvent("completed", duration_ms);
      return {
        ...base,
        duration_ms,
        status: "completed",
        output_summary: `Human decision SKIPPED (unattended run - nobody to answer): "${step.description}". Proceed with the safest reasonable default and state which default you chose.`,
      };
    }
    audit.emit({
      action: "permission_prompt",
      target: { step: step.title, kind: "pause_for_human" },
      provenance: { question: step.description },
    });
    const answer = human
      ? await human.askText(`${step.title} — ${step.description}`, {
          kind: "pause",
          step: step.title,
        })
      : null;
    const duration_ms = Math.round(performance.now() - t0);
    if (answer == null) {
      const error =
        "pause_for_human step got no answer (headless run, closed dashboard, or timeout)";
      audit.emit({
        action: "step_end",
        status: "failed",
        target: { step: step.title },
        provenance: { error },
      });
      endEvent("failed", duration_ms, error);
      return { ...base, duration_ms, status: "failed", output_summary: "", error };
    }
    if (["abort", "stop", "cancel"].includes(answer.trim().toLowerCase())) {
      audit.emit({
        action: "step_end",
        status: "denied",
        target: { step: step.title },
        content: answer,
      });
      endEvent("denied", duration_ms, "aborted by human");
      return {
        ...base,
        duration_ms,
        status: "denied",
        output_summary: `Human decision: ${answer}`,
        error: "aborted by human",
      };
    }
    audit.emit({
      action: "step_end",
      status: "completed",
      target: { step: step.title },
      content: answer,
    });
    if (!reporter) log.info(`human answered: ${answer}`);
    endEvent("completed", duration_ms);
    return {
      ...base,
      duration_ms,
      status: "completed",
      output_summary: `Human decision: ${answer}`,
    };
  }

  // The model actually used may change mid-step: a model that turns out to
  // be unreachable on this key ("does not exist or you do not have access")
  // is swapped for a same-tier fallback instead of failing the run.
  let current: { provider: Step["provider"]; model: string } = {
    provider: step.provider,
    model: step.model,
  };
  let provider = getProvider(current.provider);
  const fallbacksUsed = new Set<string>();
  let priceWarned = false;
  if (!provider.available()) {
    audit.emit({
      action: "step_end",
      status: "failed",
      target: { step: step.title },
      provenance: { error: `${step.provider} not available` },
    });
    return {
      step,
      status: "failed",
      output_summary: "",
      cost_usd: 0,
      tokens_in: 0,
      tokens_out: 0,
      duration_ms: 0,
      tool_calls: 0,
      error: `${step.provider} provider unavailable (missing API key)`,
    };
  }

  const tools = allTools().filter((t) => !input.toolAllow || input.toolAllow.includes(t.name));
  const toolDefs = toToolDefs(tools);
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: step.description }] },
  ];

  let stepCost = 0;
  let totalIn = 0;
  let totalOut = 0;
  let toolCalls = 0;
  let lastSummary = "";
  const repeats = new Map<string, number>();
  const guards = input.guards ?? {};

  for (let turn = 0; turn < step.max_tool_turns; turn++) {
    if (guards.deadlineMs && Date.now() > guards.deadlineMs) {
      audit.emit({
        action: "step_end",
        status: "failed",
        target: { step: step.title },
        provenance: { error: "time budget exhausted (--time-budget)" },
      });
      return finalize("failed", "time budget exhausted (--time-budget)");
    }
    // Pre-call bedrock check (conservative: assume next call will spend
    // up to typical_cost_per_step, configurable per model).
    try {
      assertWithinBedrock(budget, 0);
    } catch (e) {
      if (e instanceof BedrockBreachError) {
        audit.emit({
          action: "step_end",
          status: "failed",
          target: { step: step.title },
          provenance: { error: e.message, bedrock: budget.bedrock_usd, spent: budget.spent_usd },
        });
        return finalize("bedrock_aborted", e.message);
      }
      throw e;
    }

    audit.emit({
      action: "provider_call",
      risk: { level: "low", flags: [] },
      target: { provider: current.provider, model: current.model, turn },
      provenance: { budget: snapshot(budget) },
    });

    const completionReq: CompletionRequest = {
      model: current.model,
      system: SYSTEM_TEMPLATE(step, systemContext, systemPromptAddenda(), unattended),
      systemDynamic: budgetLine(budget) + timeLine(guards),
      messages,
      // A grounded research step runs with Google Search instead of the local
      // tools (the Gemini adapter swaps them); it returns cited text and ends
      // the loop after one turn since it makes no tool calls.
      tools: step.grounded ? undefined : toolDefs,
      // Thinking is on by default on Opus 5 / Fable and billed INSIDE
      // max_tokens; 4096 was routinely eaten by thinking before the answer.
      // 16k is Anthropic's recommended non-streaming default; the budget
      // checks above bound the spend either way.
      maxTokens: 16_000,
      grounded: step.grounded,
    };

    const onText = (text: string): void => {
      if (reporter) {
        reporter.emit("step_token", { step: step.title, text });
      } else {
        process.stdout.write(text);
      }
    };

    let resp: CompletionResponse;
    try {
      resp = await streamingComplete(provider, completionReq, onText);
    } catch (e) {
      const msg = (e as Error).message;
      // Any provider error - not only "model not found" - gets up to two
      // same-tier fallbacks, then fails THIS STEP cleanly instead of killing
      // the whole run with no session_end (28 Sept 2026: an OpenAI 400 on a
      // GPT-6 tool call crashed eval runs at $0 with nothing recorded).
      const notFound = isModelNotFoundError(e);
      if (notFound) markUnreachable(current.model, msg);
      // no credit / bad key: every model on that provider is out - skip them
      // all, and hide them from the planner for the cache window
      const exclude = new Set(fallbacksUsed);
      if (isAccountWideError(e)) {
        for (const m of loadModels().models.filter((x) => x.provider === current.provider)) {
          exclude.add(m.id);
          markUnreachable(m.id, `account-wide: ${msg.slice(0, 150)}`);
        }
      }
      const alt = fallbacksUsed.size < 2 ? await fallbackModelFor(current.model, exclude) : null;
      if (!alt) {
        const error = `provider error on ${current.provider}/${current.model}: ${msg.slice(0, 300)}`;
        audit.emit({
          action: "step_end",
          status: "failed",
          target: { step: step.title },
          provenance: { error },
        });
        if (!reporter) log.error(error);
        return finalize("failed", error);
      }
      audit.emit({
        action: "route_decision",
        target: {
          step: step.title,
          from: `${current.provider}/${current.model}`,
          to: `${alt.provider}/${alt.id}`,
        },
        provenance: {
          reason: notFound
            ? `model unreachable on this key: ${msg.slice(0, 200)}`
            : `provider error: ${msg.slice(0, 200)}`,
        },
      });
      log.warn(
        `${current.model} ${notFound ? "unreachable on this key" : `failed (${msg.slice(0, 120)})`} - falling back to ${alt.provider}/${alt.id}`,
      );
      fallbacksUsed.add(current.model);
      current = { provider: alt.provider, model: alt.id };
      provider = getProvider(current.provider);
      turn--; // this turn has not been spent
      continue;
    }
    // Newline after streaming so subsequent log output starts cleanly
    if (!reporter) process.stdout.write("\n");
    totalIn += resp.usage.input_tokens;
    totalOut += resp.usage.output_tokens;
    if (resp.cost_usd) {
      stepCost += resp.cost_usd;
      budget.spent_usd += resp.cost_usd;
      setBudgetState(sessionId, budget);
    } else if (resp.cost_usd === undefined && !priceWarned && resp.usage.input_tokens > 0) {
      priceWarned = true;
      log.warn(
        `price unknown for ${current.model}: this step's spend is NOT counted against the budget`,
      );
    }
    if (resp.error && resp.content.every((c) => c.type !== "tool_use")) {
      // billed but blocked (Gemini RECITATION/SAFETY …): a failed step, not
      // an empty answer that later steps would build on
      audit.emit({
        action: "step_end",
        status: "failed",
        target: { step: step.title },
        provenance: { error: resp.error, model: current.model },
      });
      return finalize("failed", resp.error);
    }

    audit.emit({
      action: "provider_response",
      target: { stop_reason: resp.stop_reason, turn },
      provenance: {
        cost_usd: resp.cost_usd,
        tokens_in: resp.usage.input_tokens,
        tokens_out: resp.usage.output_tokens,
        cache_read_tokens: resp.usage.cache_read_tokens,
        cache_write_tokens: resp.usage.cache_write_tokens,
        duration_ms: resp.duration_ms,
        budget: snapshot(budget),
      },
    });

    // Post-call bedrock check — actual spend can exceed conservative estimate.
    try {
      assertWithinBedrock(budget, 0);
    } catch (e) {
      if (e instanceof BedrockBreachError) {
        const text = summarise(resp.content);
        if (text) lastSummary = text;
        audit.emit({
          action: "step_end",
          status: "failed",
          target: { step: step.title },
          provenance: { error: e.message },
        });
        return finalize("bedrock_aborted", e.message);
      }
      throw e;
    }

    // Soft session-cap warning (does not abort except in budget mode).
    if (!withinSessionAllowance(budget) && budget.mode !== "unlimited") {
      log.warn(
        `session cap exceeded ($${budget.spent_usd.toFixed(4)} > $${budget.session_usd.toFixed(2)} + ${budget.mode} allowance) — wrapping up step`,
      );
      const text = summarise(resp.content);
      if (text) lastSummary = text;
      audit.emit({
        action: "step_end",
        status: "completed",
        target: { step: step.title },
        provenance: { note: "session cap reached, wrapping up" },
      });
      return finalize("completed", undefined);
    }

    const text = summarise(resp.content);
    if (text) lastSummary = text;

    const toolUses = resp.content.filter(
      (c): c is Extract<ContentBlock, { type: "tool_use" }> => c.type === "tool_use",
    );

    if (toolUses.length === 0 || resp.stop_reason === "end_turn") {
      audit.emit({ action: "step_end", status: "completed", target: { step: step.title } });
      return finalize("completed", undefined);
    }

    messages.push({ role: "assistant", content: resp.content });

    const toolResults: ContentBlock[] = [];
    for (const tu of toolUses) {
      toolCalls++;
      const tool = tools.find((t) => t.name === tu.name);
      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `unknown tool ${tu.name}`,
          is_error: true,
        });
        continue;
      }
      let parsedInput: unknown;
      try {
        parsedInput = tool.inputSchema.parse(tu.input);
      } catch (e) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `input validation failed: ${(e as Error).message}`,
          is_error: true,
        });
        continue;
      }
      const risk = tool.assess(parsedInput, { cwd, sessionId });
      const preview = tool.preview(parsedInput);
      const decision = decide({
        cwd,
        toolName: tool.name,
        risk,
        description: preview.description,
        details: preview.details,
        mode,
      });

      audit.emit({
        action: "tool_use_start",
        risk,
        target: { tool: tool.name, ...preview.details },
        // ADR-0012: verbatim input (redacted downstream by redactKeys) so
        // the grounding verifier's content-taint rule can see what the
        // model authored. Without this, historical sessions verify
        // UNVERIFIABLE — the hash alone cannot be evidence.
        provenance: { input: JSON.stringify(parsedInput).slice(0, 16000) },
      });

      if (decision.kind === "deny") {
        audit.emit({
          action: "permission_deny",
          status: "denied",
          target: { tool: tool.name },
          provenance: { reason: decision.reason },
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `DENIED: ${decision.reason}`,
          is_error: true,
        });
        log.warn(`denied: ${preview.description} — ${decision.reason}`);
        continue;
      }
      if (decision.kind === "prompt" && unattended) {
        // Never wait: nobody is there. Deny, say so to the model in a way
        // it can route around, and carry on with the step.
        const reason = `unattended run - no human to ask: ${decision.reason}`;
        audit.emit({
          action: "permission_deny",
          status: "denied",
          target: { tool: tool.name, ...preview.details },
          provenance: { reason, unattended: true },
        });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `DENIED (${reason}). This action needs a person's approval, which is unavailable in this run. Take another route (read/grep/glob, an allowlisted command, a path inside the working directory) or state that the step needs human approval.`,
          is_error: true,
        });
        log.warn(`denied (unattended): ${preview.description} — ${decision.reason}`);
        continue;
      }
      if (decision.kind === "prompt") {
        audit.emit({
          action: "permission_prompt",
          target: { tool: tool.name },
          provenance: { reason: decision.reason },
        });
        const ok = human
          ? await human.askYesNo(`Allow: ${preview.description}? (${decision.reason})`, false, {
              kind: "permission",
              tool: tool.name,
              reason: decision.reason,
            })
          : await confirm(`Allow: ${preview.description}? (${decision.reason})`, false);
        if (!ok) {
          audit.emit({ action: "permission_deny", status: "denied", target: { tool: tool.name } });
          toolResults.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: "user denied",
            is_error: true,
          });
          continue;
        }
        audit.emit({ action: "permission_grant", target: { tool: tool.name } });
      }

      try {
        log.step(preview.description, decision.kind === "auto" ? "auto" : "approved");
        const result = await tool.run(parsedInput, { cwd, sessionId });
        // The LLM-facing tool_result keeps a compact summary (no full diff)
        // so we don't bloat the context window every turn. Full diff goes
        // to the user via reporter / stdout / web SSE.
        const llmResult = compactToolResult(tool.name, result);
        // The model must KNOW when it saw only a slice, and HOW to see the
        // rest - see capToolResult.
        const json = capToolResult(tool.name, llmResult);
        // ADR-0015 loop guard: the same call, again and again, is the
        // commonest way a tool loop burns its turns.
        const key = `${tool.name}:${JSON.stringify(parsedInput)}`;
        const n = (repeats.get(key) ?? 0) + 1;
        repeats.set(key, n);
        const nudge =
          guards.loop && n >= LOOP_GUARD_REPEATS
            ? `\n[patchwork-harness loop guard] You have made this exact ${tool.name} call ${n} times in this step. Stop repeating it: change approach, or finish and report what you know.`
            : "";
        if (nudge)
          audit.emit({
            action: "route_decision",
            target: { step: step.title, guard: "loop", tool: tool.name, repeats: n },
          });
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: json + nudge });
        // Audit log keeps the full diff (durable record on disk)
        const auditJson = JSON.stringify(result).slice(0, 16000);
        audit.emit({
          action: "tool_use_end",
          status: "completed",
          target: { tool: tool.name },
          content: auditJson,
          // ADR-0012: the verbatim tool output (16KB cap, redacted by the
          // existing redactKeys path). `content` above becomes a hash at
          // write time — this is what makes a session's answer VERIFIABLE
          // against what its tools actually returned.
          provenance: { output: auditJson },
        });
        // Surface diffs from write/edit so the user sees changes as they happen.
        if ((tool.name === "write" || tool.name === "edit") && isFileChange(result)) {
          const r = result as FileChangeResult;
          if (r.diff) {
            if (reporter) {
              reporter.emit("file_diff", {
                tool: tool.name,
                path: r.path,
                added: r.added,
                removed: r.removed,
                created: tool.name === "write" ? !!r.created : false,
                diff: r.diff,
              });
            } else {
              renderDiffToStdout(r.path, r.added, r.removed, r.diff);
            }
          }
        }
      } catch (e) {
        const err = (e as Error).message;
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: `error: ${err}`,
          is_error: true,
        });
        audit.emit({
          action: "tool_use_end",
          status: "failed",
          target: { tool: tool.name },
          provenance: { error: err },
        });
      }
    }

    messages.push({ role: "tool", content: toolResults });
  }

  audit.emit({
    action: "step_end",
    status: "completed",
    target: { step: step.title },
    provenance: { note: "max_tool_turns reached" },
  });
  return finalize("completed", undefined);

  function finalize(
    status: "completed" | "failed" | "denied" | "bedrock_aborted",
    error: string | undefined,
  ): StepResult {
    const result: StepResult = {
      // record the model that actually ran, not just the one planned
      step: { ...step, provider: current.provider, model: current.model },
      status,
      output_summary: lastSummary,
      cost_usd: stepCost,
      tokens_in: totalIn,
      tokens_out: totalOut,
      duration_ms: Math.round(performance.now() - t0),
      tool_calls: toolCalls,
      error,
    };
    reporter?.emit("step_end", {
      step: step.title,
      status,
      cost_usd: result.cost_usd,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
      duration_ms: result.duration_ms,
      error,
    });
    return result;
  }
}

function timeLine(g: { deadlineMs?: number; startedMs?: number }): string {
  if (!g.deadlineMs) return "";
  const used = Math.round((Date.now() - (g.startedMs ?? Date.now())) / 1000);
  const total = Math.round((g.deadlineMs - (g.startedMs ?? g.deadlineMs)) / 1000);
  return ` Time: ${used}s used of a ${total}s run budget - finish well inside it.`;
}

function budgetLine(b: BudgetState): string {
  const headroom = b.bedrock_usd - b.spent_usd;
  return `Budget: spent $${b.spent_usd.toFixed(4)} of session cap $${b.session_usd.toFixed(2)} (mode=${b.mode}). Bedrock $${b.bedrock_usd.toFixed(2)} (headroom $${headroom.toFixed(2)}).`;
}

interface FileChangeResult {
  path: string;
  added: number;
  removed: number;
  diff: string;
  created?: boolean;
}

function isFileChange(r: unknown): r is FileChangeResult {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  return (
    typeof x.path === "string" &&
    typeof x.diff === "string" &&
    typeof x.added === "number" &&
    typeof x.removed === "number"
  );
}

/**
 * Strip the heavy `diff` blob from write/edit results before they go back
 * to the LLM as a tool_result. The diff is for the user (CLI/web/SSE) —
 * the LLM only needs the summary so it doesn't burn ~2K tokens per write.
 */
function compactToolResult(toolName: string, result: unknown): unknown {
  if ((toolName === "write" || toolName === "edit") && isFileChange(result)) {
    const r = result as FileChangeResult;
    return {
      path: r.path,
      added: r.added,
      removed: r.removed,
      ...(r.created !== undefined ? { created: r.created } : {}),
      // No `diff` field — user sees it in their terminal/web, the LLM
      // doesn't need to re-read its own output back.
    };
  }
  return result;
}

function renderDiffToStdout(path: string, added: number, removed: number, diff: string): void {
  // ANSI: green +, red -, dim @@ headers. Skip in non-TTY (CI/log capture).
  const isTTY = process.stdout.isTTY;
  const green = isTTY ? "\x1b[32m" : "";
  const red = isTTY ? "\x1b[31m" : "";
  const dim = isTTY ? "\x1b[2m" : "";
  const reset = isTTY ? "\x1b[0m" : "";
  process.stdout.write(`${dim}--- ${path} (+${added} -${removed})${reset}\n`);
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@")) process.stdout.write(`${dim}${line}${reset}\n`);
    else if (line.startsWith("+")) process.stdout.write(`${green}${line}${reset}\n`);
    else if (line.startsWith("-")) process.stdout.write(`${red}${line}${reset}\n`);
    else process.stdout.write(`${line}\n`);
  }
}
