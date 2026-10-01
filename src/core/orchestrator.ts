/**
 * Top-level orchestrator. plan → confirm → execute steps → finalise.
 * Enforces the multi-tier budget (bedrock + session_usd + mode).
 */

import { createHash } from "node:crypto";
import chalk from "chalk";
import Table from "cli-table3";
import { AuditEmitter } from "../audit.js";
import { loadModels } from "../config.js";
import { type HumanChannel, createHumanChannel } from "../permissions/human.js";
import { pluginCatalogue, runPluginHook } from "../plugins/manager.js";
import { setBudgetState } from "../tools/budget_status.js";
import { reachableModels } from "../providers/availability.js";
import type { JsonReporter } from "../util/json_reporter.js";
import { log } from "../util/logger.js";
import { newSessionId } from "../util/ulid.js";
import {
  type BudgetMode,
  type BudgetState,
  MonthlyCapBreachError,
  assertMonthlyCap,
  snapshot as budgetSnapshot,
  loadBudgetConfig,
} from "./budget.js";
import { runStep } from "./executor.js";
import { type HarnessOptions, checkpoint, repairDescription, runGate } from "./harness.js";
import { DEFAULT_GUARD_THRESHOLD, type InjectionGuard, guardReady } from "./guard.js";
import { type IntentRoute, type Lane, type LaneMode, directPlan, routeIntent } from "./intent.js";
import { findSimilarSessions, renderLessons } from "./lessons.js";
import { enforceReachable, plan as makePlan, scopeProposal } from "./planner.js";
import { persistSession } from "./transcript.js";
import type { Plan, SessionState, SessionStatus, Step, StepResult } from "./types.js";
import { assembleWorldView } from "./world_view.js";

export interface OneShotInput {
  goal: string;
  cwd: string;
  permission_mode: "auto" | "default" | "cautious";
  budget_usd: number | "auto";
  bedrock_usd?: number;
  budget_mode: BudgetMode;
  yes?: boolean; // skip plan confirm AND budget proposal confirm
  dryRun?: boolean;
  /** When set, emits NDJSON events to stdout; suppresses rich rendering. */
  reporter?: JsonReporter;
  /**
   * How to reach the person running the session (permission prompts,
   * plan/budget confirms, pause_for_human steps). The CLI passes one and
   * owns its lifecycle; when absent we create a TTY/headless channel
   * (which holds no resources, so no close bookkeeping is needed here).
   */
  human?: HumanChannel;
  /** Smart conductor toggles — default true, off via --no-* flags. */
  worldViewEnabled?: boolean;
  lessonsEnabled?: boolean;
  criticEnabled?: boolean;
  /** Memory spine retrieval (Phase 5) — default true, off via --no-context. */
  contextEnabled?: boolean;
  /** How many spine chunks to retrieve before planning (default 5). */
  contextTopK?: number;
  /**
   * Optional prior-conversation context. Prepended to the worldView packet
   * so the planner sees what came before in this REPL session ("now also do
   * X" needs to know what X was talking about).
   */
  priorContext?: string;
  /** Opt-in harness options (ADR-0015): test gate, repair loop, checkpoints, guards. */
  harness?: HarnessOptions;
  /** ADR-0018 intent lane: planned (default, unchanged), direct (no planner), auto (classifier picks). */
  lane?: LaneMode;
  /** With lane auto: the intent head's P(no plan needed) that takes the direct lane without asking the LLM (default 0.6). */
  laneThreshold?: number;
  /** The direct lane's model (default: the executor role). */
  laneModel?: string;
}

export async function oneShot(input: OneShotInput): Promise<{
  state: SessionState;
  audit: AuditEmitter;
}> {
  const sessionId = newSessionId();
  const projectName = input.cwd.split("/").pop() || "unknown";
  const audit = new AuditEmitter(sessionId, input.cwd, projectName);
  const reporter = input.reporter;
  reporter?.setSessionId(sessionId);
  // Default deliberately ignores the reporter: only the CLI creates the
  // stdin-listening JSON channel, because it also closes it.
  const human = input.human ?? createHumanChannel({});

  const cfg = loadBudgetConfig();
  const bedrock_usd = input.bedrock_usd ?? cfg.defaults.bedrock_usd;

  // Monthly-cap defence — refuse to start if we're over.
  try {
    assertMonthlyCap();
  } catch (e) {
    if (e instanceof MonthlyCapBreachError) {
      log.error(e.message);
      log.error(`raise the cap in ~/.patchwork-harness/budget.yml (defaults.monthly_cap_usd) to continue`);
      throw e;
    }
    throw e;
  }

  audit.emit({ action: "session_start", target: { goal: input.goal }, content: input.goal });
  reporter?.emit("session_start", {
    goal: input.goal,
    cwd: input.cwd,
    permission_mode: input.permission_mode,
    budget_mode: input.budget_mode,
  });

  // Resolve session_usd — number or planner-proposed
  let session_usd: number;
  if (input.budget_usd === "auto") {
    log.step("Scoping", "letting the planner propose a budget");
    const proposal = await scopeProposal(input.goal, bedrock_usd);
    log.info(
      `proposal: ${chalk.bold("$" + proposal.proposed_usd.toFixed(2))} — ${proposal.reasoning}`,
    );
    if (proposal.proposed_usd > bedrock_usd) {
      log.warn(`proposal exceeds bedrock; capping at bedrock $${bedrock_usd}`);
      session_usd = bedrock_usd;
    } else if (input.yes) {
      session_usd = proposal.proposed_usd;
    } else if (human.interactive) {
      const ok = await human.askYesNo(
        `Use proposed budget $${proposal.proposed_usd.toFixed(2)}? (${proposal.reasoning})`,
        true,
        { kind: "budget" },
      );
      session_usd = ok ? proposal.proposed_usd : bedrock_usd; // fallback to bedrock
    } else {
      session_usd = proposal.proposed_usd;
    }
  } else {
    session_usd = Math.min(input.budget_usd, bedrock_usd);
  }

  const budget: BudgetState = {
    bedrock_usd,
    session_usd,
    mode: input.budget_mode,
    spent_usd: 0,
  };
  setBudgetState(sessionId, budget);

  const state: SessionState = {
    sessionId,
    cwd: input.cwd,
    goal: input.goal,
    results: [],
    total_cost_usd: 0,
    budget: { bedrock_usd, session_usd, mode: input.budget_mode },
    permission_mode: input.permission_mode,
    status: "in_progress",
    started_at: new Date().toISOString(),
  };

  await runPluginHook("onSessionStart", state);

  // Whatever happens below, the session gets an end record (28 Sept 2026:
  // provider errors used to kill runs with no session_end on the audit trail
  // or the NDJSON stream). The error still propagates, so the CLI exits 1.
  try {
    log.info(chalk.dim(`session ${chalk.bold(sessionId)}`));
    log.info(chalk.dim(`cwd     ${input.cwd}`));
    log.info(
      chalk.dim(
        `permission ${input.permission_mode}  budget $${session_usd.toFixed(2)} (${budget.mode})  bedrock $${bedrock_usd.toFixed(2)}`,
      ),
    );

    // INJECTION GUARD (ADR-0019): asked for means required. Checked before any
    // planning spend, so an unreachable guard costs nothing and runs nothing.
    let injection: InjectionGuard | undefined;
    if (input.harness?.guard) {
      const url = process.env.PATCHWORK_HARNESS_JEFF_URL?.trim().replace(/\/+$/, "");
      if (!url)
        throw new Error(
          "--guard needs a Jeff server with the guard adapter: set PATCHWORK_HARNESS_JEFF_URL (ADR-0019)",
        );
      injection = {
        cfg: {
          backend: "jeff",
          url,
          model: "jeff-latest",
          apiKey: process.env.PATCHWORK_HARNESS_JEFF_KEY?.trim() || undefined,
        },
        model: process.env.PATCHWORK_HARNESS_GUARD_MODEL?.trim() || "guard",
        threshold: input.harness.guard.threshold ?? DEFAULT_GUARD_THRESHOLD,
        mode: input.harness.guard.mode ?? "flag",
      };
      const ready = await guardReady(injection);
      if (!ready.ok)
        throw new Error(
          `--guard: the injection guard is not available (${ready.reason}); refusing to run unguarded`,
        );
      audit.emit({
        action: "route_decision",
        target: {
          harness: "guard",
          model: injection.model,
          threshold: injection.threshold,
          mode: injection.mode,
          url,
        },
      });
      log.info(
        chalk.dim(`guard   ${injection.model} at P >= ${injection.threshold} (${injection.mode})`),
      );
    }

    // INTENT LANE (ADR-0018). World view, lessons and the critic only feed
    // the planner, so the direct lane skips all of them with it.
    const laneMode: LaneMode = input.lane ?? "planned";
    let route: IntentRoute | undefined;
    if (laneMode === "auto") {
      route = await routeIntent(input.goal, {
        hi: input.laneThreshold,
        // the LLM router's spend is on the ledger like every other call
        onUsage: (u) => {
          budget.spent_usd += u.cost_usd;
          state.total_cost_usd = budget.spent_usd;
          audit.emit({
            action: "provider_response",
            status: "completed",
            target: { phase: "router", model: u.model },
            provenance: {
              cost_usd: u.cost_usd,
              tokens_in: u.tokens_in,
              tokens_out: u.tokens_out,
              duration_ms: u.duration_ms,
              budget: budgetSnapshot(budget),
            },
          });
        },
      });
    }
    const lane: Lane = laneMode === "auto" ? (route?.lane ?? "planned") : laneMode;
    if (laneMode !== "planned") {
      state.lane = {
        lane,
        mode: laneMode,
        stage: route?.stage,
        p_fast: route?.p_fast,
        label: route?.label,
        llm_label: route?.llm_label,
        latency_ms: (route?.head_latency_ms ?? 0) + (route?.llm_latency_ms ?? 0),
      };
      audit.emit({
        action: "route_decision",
        target: {
          harness: "intent",
          lane,
          mode: laneMode,
          stage: route?.stage,
          p_fast: route?.p_fast,
          label: route?.label,
          head_model: route?.head_model,
          head_latency_ms: route?.head_latency_ms,
          llm_model: route?.llm_model,
          llm_label: route?.llm_label,
          llm_confidence: route?.llm_confidence,
          llm_latency_ms: route?.llm_latency_ms,
        },
        provenance: {
          reason: route?.reason ?? `--lane ${laneMode}`,
          probabilities: route?.probabilities,
        },
      });
      reporter?.emit("harness", {
        kind: "intent",
        lane,
        mode: laneMode,
        stage: route?.stage,
        p_fast: route?.p_fast,
        llm_label: route?.llm_label,
      });
      log.info(chalk.dim(`lane    ${lane}${route ? ` (${route.reason})` : ""}`));
    }

    // SMART CONDUCTOR — Layer 1 + Layer 2: world view + lessons (in parallel)
    const worldViewEnabled = lane === "planned" && input.worldViewEnabled !== false;
    const lessonsEnabled = lane === "planned" && input.lessonsEnabled !== false;
    const criticEnabled = lane === "planned" && input.criticEnabled !== false;

    // Memory spine planner auto-injection is OFF by default after the
    // 2026-05-27 security audit (prompt-injection amplification risk:
    // untrusted retrieved content surfaced as semi-authoritative text, no
    // project scoping, no trusted-signer for 'supported' claims). Opt in
    // explicitly via env PATCHWORK_HARNESS_ENABLE_CONTEXT_INJECTION=1 or the
    // --context flag on `one-shot`. When enabled the retriever now wraps
    // content in an <UNTRUSTED_LOCAL_MEMORY> block with the warning at the
    // top of the data, not the bottom.
    const envOptIn = process.env.PATCHWORK_HARNESS_ENABLE_CONTEXT_INJECTION === "1";
    const contextEnabled =
      lane === "planned" &&
      (input.contextEnabled === true || (input.contextEnabled !== false && envOptIn));
    const [worldViewRaw, similarSessions, contextPacket] = await Promise.all([
      worldViewEnabled ? assembleWorldView(input.cwd, input.goal) : Promise.resolve(""),
      lessonsEnabled ? findSimilarSessions(input.goal) : Promise.resolve([]),
      contextEnabled
        ? import("./../context/retriever.js").then((m) =>
            m.buildContextPacket(input.goal, { top_k: input.contextTopK, cwd: input.cwd }),
          )
        : Promise.resolve(""),
    ]);
    // Compose: prior conversation -> spine memory -> world view. Spine before
    // world view because spine entries are higher-signal (provenance-tagged).
    const parts = [input.priorContext?.trim(), contextPacket, worldViewRaw].filter(
      (s) => s && s.length > 0,
    );
    const worldView = parts.join("\n\n").trim();
    if (contextPacket) {
      audit.emit({
        action: "plan_ready",
        target: { phase: "context_packet_injected", chars: contextPacket.length },
        provenance: { source: "memory_spine", top_k: input.contextTopK ?? 5 },
      });
    }
    if (worldView) {
      audit.emit({
        action: "plan_ready",
        target: { phase: "world_view_assembled", chars: worldView.length },
        provenance: {
          content_hash: "sha256:" + createHash("sha256").update(worldView).digest("hex"),
        },
      });
    }
    const lessonsBlock = renderLessons(similarSessions);
    if (similarSessions.length > 0) {
      audit.emit({
        action: "plan_ready",
        target: { phase: "lessons_loaded", count: similarSessions.length },
        provenance: { top_match: similarSessions[0]?.session_id ?? "" },
      });
    }

    // PLAN (with critic loop if enabled). Unattended = nobody can answer:
    // no pause steps, prompts deny-and-continue (executor).
    const unattended = input.permission_mode === "auto";
    const modelDefaults = loadModels().defaults;
    let plan: Plan;
    if (lane === "direct") {
      log.step("Direct lane", "no planner or critic: one executor step");
      const catalog = loadModels().models;
      const exec = input.laneModel ?? modelDefaults.executor;
      const provider = (catalog.find((m) => m.id === exec)?.provider ??
        "anthropic") as Step["provider"];
      plan = directPlan(input.goal, { id: exec, provider });
      const { reachable } = await reachableModels(catalog);
      plan.steps = await enforceReachable(plan.steps, reachable);
    } else {
      log.step(
        "Planning",
        `with ${modelDefaults.planner}${criticEnabled ? ` + critic pass (${modelDefaults.critic ?? modelDefaults.planner})` : ""}${unattended ? " [unattended]" : ""}`,
      );
      const pluginInfo = await pluginCatalogue();
      plan = await makePlan(input.goal, {
        pluginCatalogue: pluginInfo,
        budget,
        worldView,
        lessons: lessonsBlock,
        criticEnabled,
        audit,
        unattended,
        // planning spend counts toward the session and the bedrock, on the record
        onUsage: (u) => {
          budget.spent_usd += u.cost_usd;
          state.total_cost_usd = budget.spent_usd;
          audit.emit({
            action: "provider_response",
            status: "completed",
            target: { phase: u.phase, model: u.model },
            provenance: {
              cost_usd: u.cost_usd,
              tokens_in: u.tokens_in,
              tokens_out: u.tokens_out,
              duration_ms: u.duration_ms,
              budget: budgetSnapshot(budget),
            },
          });
        },
      });
    }
    state.plan = plan;
    audit.emit({
      action: "plan_ready",
      target: { steps: plan.steps.length },
      provenance: {
        reasoning: plan.reasoning,
        estimated_cost_usd: plan.estimated_cost_usd,
        budget: budgetSnapshot(budget),
      },
    });
    reporter?.emit("plan_ready", {
      reasoning: plan.reasoning,
      estimated_cost_usd: plan.estimated_cost_usd,
      steps: plan.steps.map((s) => ({
        title: s.title,
        provider: s.provider,
        model: s.model,
        reason: s.reason,
      })),
    });
    await runPluginHook("onPlanReady", plan);

    if (!reporter) printPlan(plan, budget);

    if (input.dryRun) {
      log.warn("dry-run — not executing");
      finishSession(state, audit, "completed");
      return { state, audit };
    }

    if (plan.estimated_cost_usd > bedrock_usd) {
      log.error(
        `plan estimated $${plan.estimated_cost_usd.toFixed(4)} exceeds bedrock $${bedrock_usd.toFixed(2)}; refusing`,
      );
      finishSession(state, audit, "denied");
      return { state, audit };
    }

    if (!input.yes && human.interactive) {
      const ok = await human.askYesNo("Run this plan?", true, { kind: "plan" });
      if (!ok) {
        log.warn("aborted by user");
        finishSession(state, audit, "denied");
        return { state, audit };
      }
    }

    // EXECUTE
    const harness = input.harness ?? {};
    const startedMs = Date.now();
    const guards = {
      loop: harness.loopGuard === true,
      deadlineMs: harness.timeBudgetS ? startedMs + harness.timeBudgetS * 1000 : undefined,
      startedMs,
      injection,
    };
    let checkpointing = harness.checkpoint === true;
    const snap = async (label: string) => {
      if (!checkpointing) return;
      const sha = await checkpoint(input.cwd, sessionId, label);
      if (!sha) {
        log.warn(
          "--checkpoint: cwd is not a git repository (or git failed) - checkpoints off for this run",
        );
        checkpointing = false;
        return;
      }
      (state.checkpoints ??= []).push(label);
      audit.emit({ action: "route_decision", target: { harness: "checkpoint", label, sha } });
      reporter?.emit("harness", { kind: "checkpoint", label, sha });
    };
    let i = 0;
    let endStatus: SessionStatus = "completed";
    for (const step of plan.steps) {
      i++;
      await snap(`step-${i}`);
      log.step(`Step ${i}/${plan.steps.length}: ${step.title}`, `${step.provider}/${step.model}`);
      const result = await runStep({
        step,
        cwd: input.cwd,
        sessionId,
        audit,
        budget,
        mode: input.permission_mode,
        // Human decisions carry more weight than step summaries — give them
        // more room before truncation.
        systemContext: state.results
          .map(
            (r) =>
              `${r.step.title}: ${r.output_summary.slice(0, r.step.pause_for_human ? 600 : 200)}`,
          )
          .join("\n"),
        reporter,
        human,
        unattended,
        guards,
      });
      state.results.push(result);
      state.total_cost_usd = budget.spent_usd;
      log.cost(
        result.cost_usd,
        { in: result.tokens_in, out: result.tokens_out },
        result.duration_ms,
      );
      if (result.status === "bedrock_aborted") {
        log.error(`BEDROCK BREACH: ${result.error}`);
        endStatus = "bedrock_aborted";
        break;
      }
      if (result.status !== "completed") {
        log.error(`step ${result.status === "denied" ? "aborted" : "failed"}: ${result.error}`);
        endStatus = result.status === "denied" ? "denied" : "failed";
        break;
      }
    }

    // ADR-0015 test gate + bounded repair loop. Runs only when the plan
    // finished; every repair step spends inside the same bedrock.
    if (endStatus === "completed" && harness.verifyCmd) {
      const attempts = Math.max(1, Math.min(harness.attempts ?? 1, 10));
      log.step(
        "Verify",
        `${harness.verifyCmd}${attempts > 1 ? `  (up to ${attempts} attempts)` : ""}`,
      );
      let gate = await runGate(
        harness.verifyCmd,
        input.cwd,
        sessionId,
        audit,
        harness.verifyTimeoutS,
      );
      let attempt = 1;
      reporter?.emit("harness", {
        kind: "verify",
        attempt,
        passed: gate.passed,
        exit_code: gate.exit_code,
      });
      log.info(
        gate.passed
          ? chalk.green(`verify passed (exit 0)`)
          : chalk.red(`verify FAILED (exit ${gate.exit_code})`),
      );
      while (!gate.passed && attempt < attempts) {
        attempt++;
        await snap(`repair-${attempt}`);
        const exec = modelDefaults.executor;
        const execProvider = (loadModels().models.find((m) => m.id === exec)?.provider ??
          "anthropic") as Step["provider"];
        const repair: Step = {
          title: `Repair (attempt ${attempt}/${attempts})`,
          description: repairDescription(input.goal, gate, attempt, attempts),
          provider: execProvider,
          model: exec,
          max_tool_turns: 12,
          reason: "harness repair loop: --verify-cmd failed (--attempts)",
        };
        log.step(repair.title, `${repair.provider}/${repair.model}`);
        const r = await runStep({
          step: repair,
          cwd: input.cwd,
          sessionId,
          audit,
          budget,
          mode: input.permission_mode,
          systemContext: state.results
            .map((x) => `${x.step.title}: ${x.output_summary.slice(0, 200)}`)
            .join("\n"),
          reporter,
          human,
          unattended,
          guards,
        });
        state.results.push(r);
        state.total_cost_usd = budget.spent_usd;
        log.cost(r.cost_usd, { in: r.tokens_in, out: r.tokens_out }, r.duration_ms);
        if (r.status === "bedrock_aborted") {
          endStatus = "bedrock_aborted";
          break;
        }
        gate = await runGate(
          harness.verifyCmd,
          input.cwd,
          sessionId,
          audit,
          harness.verifyTimeoutS,
        );
        reporter?.emit("harness", {
          kind: "verify",
          attempt,
          passed: gate.passed,
          exit_code: gate.exit_code,
        });
        log.info(
          gate.passed
            ? chalk.green(`verify passed on attempt ${attempt}`)
            : chalk.red(`verify still failing (exit ${gate.exit_code})`),
        );
      }
      state.verification = {
        cmd: gate.cmd,
        passed: gate.passed,
        exit_code: gate.exit_code,
        attempts: attempt,
        tail: gate.tail.slice(-1500),
      };
      if (!gate.passed && endStatus === "completed") endStatus = "failed";
    }

    // ADR-0016 L5 review: an independent vendor, read-only, rubric + evidence,
    // itself grounded by L4.5. Flag-only unless --review-strict.
    if (harness.review && (endStatus === "completed" || endStatus === "failed")) {
      const { runReview, reviewRepairDescription } = await import("./reviewer.js");
      const review = async () => {
        log.step("L5 review", "independent vendor, read-only");
        const rv = await runReview({
          goal: input.goal,
          cwd: input.cwd,
          sessionId,
          audit,
          budget,
          state,
          mode: input.permission_mode,
          reporter,
          human,
          unattended,
          model: typeof harness.review === "string" ? harness.review : undefined,
        });
        state.total_cost_usd = budget.spent_usd;
        if (!rv) log.warn("--review: no reviewer model is reachable - skipped");
        else {
          state.review = rv;
          audit.emit({
            action: "route_decision",
            target: { harness: "l5_review", verdict: rv.verdict, model: rv.model },
            provenance: { concerns: rv.concerns, grounding: rv.grounding },
          });
          reporter?.emit("harness", { kind: "review", ...rv });
          if (!reporter) printReview(rv);
        }
        return rv;
      };
      const first = await review();
      // --review-fix: turn an L5 catch into a fix. One repair step from the
      // reviewer's evidence-cited concerns, then the gate and the review again.
      if (harness.reviewFix && first?.verdict === "incomplete" && first.concerns.length) {
        const gateOnlyFailure = endStatus === "failed" && state.verification?.passed === false;
        const stepFailedBefore = endStatus === "failed" && !gateOnlyFailure;
        await snap("review-fix");
        const exec = modelDefaults.executor;
        const fix: Step = {
          title: "Repair from L5 review",
          description: reviewRepairDescription(input.goal, first),
          provider: (loadModels().models.find((m) => m.id === exec)?.provider ??
            "anthropic") as Step["provider"],
          model: exec,
          max_tool_turns: 12,
          reason: "harness --review-fix: the L5 reviewer found concerns",
        };
        log.step(fix.title, `${fix.provider}/${fix.model}`);
        const r = await runStep({
          step: fix,
          cwd: input.cwd,
          sessionId,
          audit,
          budget,
          mode: input.permission_mode,
          systemContext: state.results
            .map((x) => `${x.step.title}: ${x.output_summary.slice(0, 200)}`)
            .join("\n"),
          reporter,
          human,
          unattended,
          guards,
        });
        state.results.push(r);
        state.total_cost_usd = budget.spent_usd;
        log.cost(r.cost_usd, { in: r.tokens_in, out: r.tokens_out }, r.duration_ms);
        if (r.status === "bedrock_aborted") endStatus = "bedrock_aborted";
        else {
          if (harness.verifyCmd) {
            const g = await runGate(
              harness.verifyCmd,
              input.cwd,
              sessionId,
              audit,
              harness.verifyTimeoutS,
            );
            reporter?.emit("harness", {
              kind: "verify",
              attempt: (state.verification?.attempts ?? 0) + 1,
              passed: g.passed,
              exit_code: g.exit_code,
            });
            state.verification = {
              cmd: g.cmd,
              passed: g.passed,
              exit_code: g.exit_code,
              attempts: (state.verification?.attempts ?? 0) + 1,
              tail: g.tail.slice(-1500),
            };
            endStatus = g.passed && !stepFailedBefore ? "completed" : "failed";
          }
          await review();
        }
      }
    }

    finishSession(state, audit, endStatus);
    await runPluginHook("onSessionEnd", state);
    reporter?.emit("session_end", {
      status: endStatus,
      total_cost_usd: state.total_cost_usd,
      session_usd: budget.session_usd,
      bedrock_usd: budget.bedrock_usd,
      step_count: state.results.length,
      ...(state.verification ? { verification: state.verification } : {}),
      ...(state.checkpoints ? { checkpoints: state.checkpoints } : {}),
      ...(state.review
        ? { review: { verdict: state.review.verdict, model: state.review.model } }
        : {}),
    });
    if (!reporter) printSummary(state.results, state.total_cost_usd, budget, state);
    return { state, audit };
  } catch (e) {
    if (state.status === "in_progress") {
      state.total_cost_usd = budget.spent_usd;
      finishSession(state, audit, "failed");
      reporter?.emit("session_end", {
        status: "failed",
        error: (e as Error).message,
        total_cost_usd: state.total_cost_usd,
        session_usd: budget.session_usd,
        bedrock_usd: budget.bedrock_usd,
        step_count: state.results.length,
      });
    }
    throw e;
  }
}

function finishSession(state: SessionState, audit: AuditEmitter, status: SessionStatus) {
  state.status = status;
  state.ended_at = new Date().toISOString();
  audit.emit({
    action: "session_end",
    status: status === "completed" ? "completed" : "failed",
    provenance: { final_status: status, total_cost_usd: state.total_cost_usd },
  });
  persistSession(state);
  // Memory spine Phase 3: auto-extract session into context.db so future
  // sessions can recall what happened. Fail-soft: any error here must
  // NOT corrupt the session result the user already got.
  void writeSessionToSpine(state.sessionId).catch((err) => {
    log.warn(`memory spine extraction skipped: ${(err as Error).message}`);
  });
}

async function writeSessionToSpine(session_id: string): Promise<void> {
  const { extractFromSession } = await import("./../context/extractor.js");
  const { writeExtractedSession } = await import("./../context/session_writer.js");
  const { getInitialisedContextDb } = await import("./../context/db.js");
  const extracted = extractFromSession(session_id);
  const db = await getInitialisedContextDb();
  writeExtractedSession(db, extracted);
}

function printReview(rv: import("./reviewer.js").ReviewResult): void {
  const tick = (v: boolean | null, good: boolean, label: string) =>
    v === null
      ? chalk.dim(`– ${label}`)
      : v === good
        ? chalk.green(`✓ ${label}`)
        : chalk.red(`✖ ${label}`);
  const head =
    rv.verdict === "complete"
      ? chalk.green.bold("COMPLETE")
      : rv.verdict === "incomplete"
        ? chalk.red.bold("INCOMPLETE")
        : chalk.yellow.bold("UNPARSED");
  console.log();
  console.log(
    `${chalk.bold("L5 review")} ${chalk.dim(`${rv.provider}/${rv.model} · $${rv.cost_usd.toFixed(4)}`)}  ${head}`,
  );
  console.log(
    `  ${tick(rv.goal_met, true, "goal met")}   ${tick(rv.tests_passed, true, "tests passed")}   ${tick(rv.destructive, false, "nothing destructive")}   ${tick(rv.scope_ok, true, "in scope")}`,
  );
  for (const c of rv.concerns) {
    const sev =
      c.severity === "high"
        ? chalk.red(c.severity)
        : c.severity === "medium"
          ? chalk.yellow(c.severity)
          : chalk.dim(c.severity);
    console.log(
      `  ! [${sev}] ${c.issue}${c.evidence ? chalk.dim(`  — "${c.evidence.slice(0, 160)}"`) : ""}`,
    );
  }
  if (rv.follow_up) console.log(chalk.dim(`  follow-up: ${rv.follow_up}`));
  if (rv.grounding)
    console.log(
      rv.grounding.ungrounded
        ? chalk.yellow(
            `  L4.5 on the review: ${rv.grounding.ungrounded} cited value(s) in no tool output (${rv.grounding.ungrounded_values.join(", ")}) - treat those concerns with care`,
          )
        : chalk.dim(
            `  L4.5 on the review: ${rv.grounding.verified} cited value(s) verified against real tool output`,
          ),
    );
  if (rv.verdict === "unparsed" && rv.raw) console.log(chalk.dim(`  raw: ${rv.raw.slice(0, 300)}`));
}

function printPlan(plan: Plan, budget: BudgetState): void {
  console.log();
  const within = plan.estimated_cost_usd <= budget.session_usd;
  const tag = within ? chalk.green("ok") : chalk.yellow("over");
  console.log(
    chalk.bold("Plan:") +
      chalk.dim(
        ` (estimated $${plan.estimated_cost_usd.toFixed(4)} of $${budget.session_usd.toFixed(2)} ${tag}, bedrock $${budget.bedrock_usd.toFixed(2)})`,
      ),
  );
  console.log(chalk.dim(plan.reasoning));
  console.log();
  const table = new Table({
    head: [chalk.cyan("#"), chalk.cyan("step"), chalk.cyan("provider/model"), chalk.cyan("why")],
    colWidths: [4, 36, 26, 40],
    wordWrap: true,
  });
  plan.steps.forEach((s, i) => {
    table.push([i + 1, s.title, `${s.provider}/${s.model}`, s.reason]);
  });
  console.log(table.toString());
  console.log();
}

function printSummary(
  results: StepResult[],
  total: number,
  budget: BudgetState,
  state?: SessionState,
): void {
  console.log();
  console.log(chalk.bold("Summary:"));
  for (const r of results) {
    let tag: string;
    if (r.status === "completed") tag = chalk.green("✓");
    else if (r.status === "bedrock_aborted") tag = chalk.red("⨯ bedrock");
    else tag = chalk.red("✖");
    console.log(
      `  ${tag} ${r.step.title}  ${chalk.dim(`$${r.cost_usd.toFixed(4)} • ${r.duration_ms}ms`)}`,
    );
  }
  const overTag = total > budget.session_usd ? chalk.yellow(" (over session_usd)") : "";
  console.log(
    chalk.dim(
      `  total $${total.toFixed(4)}${overTag} of bedrock $${budget.bedrock_usd.toFixed(2)}`,
    ),
  );
  const v = state?.verification;
  if (v)
    console.log(
      `  ${v.passed ? chalk.green("✓ verify") : chalk.red("✖ verify")} ${chalk.dim(`\`${v.cmd}\` exit ${v.exit_code} after ${v.attempts} attempt(s)`)}`,
    );
  if (state?.checkpoints?.length)
    console.log(
      chalk.dim(
        `  checkpoints: ${state.checkpoints.join(", ")}  (patchwork-harness rewind ${state.sessionId} --to <label>)`,
      ),
    );
}
