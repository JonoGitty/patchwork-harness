<!-- Research report, 28 Sept 2026 (Opus subagent, web research, every claim sourced). Drives ADR-0015. -->

## Agent harnesses behind hackathon winners and leaderboard leaders, and what patchwork-harness is missing (research as of 28 Sep 2026)

**Bottom line:** The winning harnesses mostly agree on one thing patchwork-harness doesn't have: a finish gate that actually runs something (tests, a verifier or a selector) and retries a bounded number of times until it passes. Frontier models are absorbing the planning scaffolds. Anthropic and Refact both dropped their planning tools with Claude 4 [18][23], and a 100-line agent with only a bash tool (mini-swe-agent) is now the standard SWE-bench harness [25]. What still moves scores is verification, choosing among several attempts, and small runtime guards. patchwork-harness is already strong on audit, cost caps, deterministic grounding and memory. Its gaps are all at the "did the work actually pass?" end of the loop.

### Part 1a: Hackathon winners

- **Built with Opus 4.6 (Anthropic, Feb 2026):**
  - 1st, CrossBeam: "parallel sub-agents parse the documents, build a spatial index, and assign targeted agents to each discrete correction". Claude wrote the tests.
  - 2nd, Elisa: 39k lines of code and over 1,500 tests in 30 hours [1].
- **Built with Opus 4.7 (Anthropic):**
  - Medkit: four separate Claude Code sessions (one per subsystem), Managed Agents, and "an agentic grader".
  - Wrench Board: a spec, then a plan per responsibility, run as "five or six agents in parallel" with one agent per domain, plus the Superpowers skills framework.
  - MaestrIA: specs, a staged plan and a security model before any code; diff-by-diff review; a "9-dimension eval against 12 real cases with ground truth".
  - ARIA: a full day of planning on a ticket board; Managed Agents for the sandbox, persistence and MCP dispatch [2].
- **Opus 4.8 Build Day (13 Jun 2026):**
  - 1st, Tekton: "Independent verifier sub-agents graded each reconstruction in isolated context windows", and "self-correction loops… until all 20 tests passed".
  - 2nd, Sim Francisco: a builder, a verifier and an adversarial agent, checked against external data [3].
- **OpenAI Codex Hackathon (Cerebral Valley and OpenAI, 5 Feb 2026):** the winner was a continuously running multi-agent system with a separate "decision and evaluation layer" that "did not generate ideas, it evaluated them" [4][37].
- **OpenAI Build Week (Jul–Aug 2026, 8 winners):** the common shape is a deterministic core with a tightly constrained model.
  - Sentinel: "deterministic static analysis, tightly constrained GPT-5.6 review… Docker-isolated probes".
  - AirBridge: "a local policy layer determines which actions are allowed" [5].
- **Google ADK Hackathon (Sep 2025):** SalesShortcut used 34 agents (sequential, parallel and loop), A2A, review/critique loops, fan-out/gather and human-in-the-loop [6].
- **Could not verify:**
  - Gemini 3 Hackathon (Globot, Aegis, Netra) and the AI Engineer World's Fair 2026 hackathon (SplatForge, PodMan, Rote): winners confirmed [7][8], but nothing documents how their harnesses work.
  - AGI House: I found no write-ups of winners.

**Pattern across the winners:** spec or plan first, tests or a ground-truth eval set, a verifier running in its own context, deterministic code owning anything checkable, and a human reviewing diffs.

### Part 1b: Leaderboard harnesses

**Current standings:**
- **Terminal-Bench 2.1:** #1 is Codex CLI with GPT-6 Astra at 87.4% (3 Sep); #2 is Claude Code with Fable 5 at 83.8%. The harness alone moves scores: Fable 5 gets 83.8 in Claude Code but 80.4 in the benchmark's reference agent (Terminus 2); GPT-5.5 gets 83.1 vs 78.0 [9].
- **Terminal-Bench 2.0:** a harness called "vix" with Opus 4.7 reached 89.9% mean and 97.75% pass@5 [10]. Its method is **undocumented**.
- **SWE-bench Verified is saturated:** Vals' bash-only harness puts Opus 5 at 97.0%, and Vals has stopped running it on new models [12].
- **SWE-Bench Pro V2 (Scale):** the top three are Claude Code and Codex runs; the rest use mini-swe-agent [11].
- **OSWorld:** Agent S3 hit 72.6% (human is 72.36%) by summarising each attempt as a "behaviour narrative" and having a judge compare them [24]. The current OSWorld-Verified #1 comes from aggregator sites only, so it is **unverified**.

**What the leaders credit:**
- **Finish gates and runtime guards:**
  - Factory's Droid counts a task resolved only when all post-run tests pass. It also uses short default timeouts, a background-process primitive, environment bootstrapping and a planning tool [13].
  - ForgeCode went from 78.4% to 81.8% on harness changes alone, including an "enforced verification skill" and schema flattening [15].
  - LangChain, with the model held fixed, went from 52.8% to 66.5%. Changes: a self-verify loop, a pre-completion checklist, loop detection, a "reasoning sandwich" (more thinking for planning and verification), environment injection, time-budget warnings and trace analysis [16].
  - LemonHarness credits time-aware execution [17].
- **Several attempts plus a selector:**
  - Anthropic took Opus 4 from 72.5% to 79.4% by sampling parallel attempts, dropping those that break visible regression tests, and picking with a scoring model [18].
  - OpenHands went from 60.6% to 66.4% at 5 attempts using a trained critic [19]. Its 2026 critic gets 73.8% at best-of-8 vs 57.9% for random picks. Used for early stopping, it adds 17.7 points while averaging only 1.35 attempts [20].
  - Trae Agent reached 75.2%. Removing its pruning step costs 5.57 points; removing majority voting costs 4.14 [21].
  - Augment found ensembling worth 3–8%, but "too expensive to use in real-world settings" [22].
- **Planner/executor split:** Warp plans with Opus and executes with Sonnet, keeps a todo list and falls back to another model on errors [14]. Aider's architect/editor split lifts Sonnet from 77.4% to 80.5% [26].
- **Context and safety:**
  - Aider uses a tree-sitter repo map [26]; Anthropic recommends compaction, note-taking and sub-agents [33]; Codex relies on prefix caching and compaction [30, search snippet only].
  - Codex sandboxes commands at the OS level (Seatbelt / Landlock / bubblewrap) [29].
  - Claude Code has checkpoints and rewind, though they don't track edits made through bash [27], and sub-agents with their own model, `maxTurns` and `isolation: worktree` [28].
- **Counter-evidence:**
  - Augment's separate "fix regressions" agent introduced bugs [22].
  - The Holistic Agent Leaderboard study (HAL) found that higher reasoning effort reduced accuracy in most runs [34].
  - Multi-agent setups use about 15× the tokens of a chat, and "most coding tasks involve fewer truly parallelizable tasks" [32].

### Part 2: Gap analysis

Paths are relative to the repo root.

| Technique | Who uses it | Evidence it helps | patchwork-harness status | Effort | Conflicts with do-not list? |
|---|---|---|---|---|---|
| Run tests before calling it done | Droid [13], Anthropic [18], Refact [23], Tekton [3] | Trae: −3.42 without regression filter [21] | **MISSING.** `projects.test_command` is stored (`src/context/schema/001_initial.sql`) but nothing runs it | S | No |
| Pre-completion checklist | LangChain [16], ForgeCode [15], Anthropic feature list [31] | Part of +13.7 / +3.4 harness-only gains | **MISSING.** L4.5 checks the answer's facts, not whether tests ran | S | No |
| Bounded retry until verified (sequential) | Tekton [3], OpenHands early stop [20] | +17.7 points at 1.35 attempts | **MISSING.** A failed step ends the session (`src/core/orchestrator.ts` ~L305) | M | Mild: close to L4. Fine if framed as ADR-0008's "ONE follow-up step" |
| Parallel best-of-N with a selector | [18][19][21][22][24] | +5.8 to +6.9 points; cost ×N | **MISSING** | L | **Yes**, "No parallel step execution" (a sequential version is fine) |
| Independent reviewer on a different vendor (L5) | Tekton, Sim Francisco [3]; Adversarial Review [35] | 3 agents with structured disagreement beat a 5-agent baseline [35] | **PARTIAL.** L3 critic is plan-time only; `patchwork-harness review` is security-only; L5 not built | M | No (Next-10 #4) |
| Planner/executor on different models | Warp [14], Aider [26] | +3.1 points [26] | **HAS.** `config/models.yml`: planner gpt-6-luna, executor opus-5-5, critic gemini | — | No |
| Reasoning effort per phase | LangChain [16], ForgeCode [15] | Mixed; HAL says more effort often hurts [34] | **MISSING.** Fixed `maxTokens: 16_000` (`src/core/executor.ts`) | S | No |
| Loop detection, time budget, mid-run nudges | [16][17][23], Droid [13] | Part of +13.7 | **PARTIAL.** Only the `max_tool_turns` cap; the $ budget is shown to the model, wall-clock time isn't | S | No |
| Environment bootstrap / repo map | Droid [13], LangChain [16], Aider [26] | Credited, no ablation | **PARTIAL.** `src/core/world_view.ts` and the spine's file index; tree-sitter map is parked in DIRECTION | S / L | Parked, not banned |
| Prompt caching | Codex [30] | Near-linear cost | **PARTIAL, probably broken** (see below) | S | No |
| Compaction | [27][30][33] | — | **PARTIAL.** `compactToolResult` and paged reads; no history compaction | S | No |
| Checkpoints and rewind | Claude Code [27], Anthropic git commits [31] | — | **MISSING.** `git_ops` can commit but nothing checkpoints per step | S–M | No |
| Sandbox or worktree isolation | Codex [29], Claude Code [28], Sentinel [5], Codex app [37] | — | **PARTIAL.** Patchwork plus patchwork-harness policy, sensitive-path deny and bash timeout; no OS or container sandbox | M | No |
| Sub-agents inside a step | Claude Code [28], CrossBeam [1] | +90.2% on a research eval, at ~15× tokens [32] | **PARTIAL.** Each plan step is a fresh context; `claude_skill` spawns `claude -p` | M | Parallel fan-out: **yes** |
| L4 live re-planner | Prior reliability research (`docs/research/2026-08-31-agentic-loop-reliability.md`) | — | **MISSING** (deferred) | M | **Yes** |
| MCP client (e.g. Playwright for end-to-end checks) | Anthropic long-running harness [31], ARIA [2] | — | **MISSING** (`src/mcp/client.ts` is a stub) | M | **Yes**, but DIRECTION has a revisit clause |
| Model fallback | Warp [14] | Used on ~2% of Warp's calls | **PARTIAL.** Falls back only when a model isn't found, not on 429/5xx (`src/core/executor.ts` ~L280) | S | No |
| Memory / progress notes | [28][31][33] | — | **HAS.** Memory spine and `patchwork-harness resume` | — | No |
| Skills | Wrench Board [2], ForgeCode [15] | — | **PARTIAL.** Only through `claude -p`; non-Claude executors can't load skills | M | No |
| Trace log and audit | HAL [34], LangChain [16] | — | **HAS.** Patchwork hash-chained JSONL and NDJSON | — | No |
| Eval harness with repeated trials / pass@k | Terminal-Bench reruns [9], HAL [34], MaestrIA [2] | Scores vary ±1–2 points per run [9] | **PARTIAL.** Verifier exam, `scripts/eval_planner.ts`, classifier calibration; no end-to-end task suite (Next-10 #8) | M | No |
| Cost caps | Augment on cost [22] | — | **HAS.** ADR-0006 (a daily cap is still missing) | S | No |
| Human-in-the-loop; deterministic core with constrained model | [5][6] | — | **HAS.** ADR-0010; the L4.5 law; ADR-0013 | — | No |

**Probable cost bug in the prompt caching (inferred from the code, not measured):** in `src/core/executor.ts`, the Anthropic system block carries the only cache breakpoint. That block embeds `budgetLine()` (L126, L688), which shows live spend to 4 decimal places. It therefore changes after every paid turn, so the cache almost certainly never gets read. You can check this against `cache_read_input_tokens`.

### Ranked shortlist (all opt-in, off by default)

1. **Test gate.** `patchwork-harness run "<goal>" --verify-cmd "npm test"`, or `--verify-cmd spine` to use the stored `projects.test_command`. It runs through the audited bash tool, so L4.5 can ground a "tests pass" claim against real output; a failure gives a non-zero exit. This is the most-copied technique, costs little, and delivers the tier-2 re-execution check ADR-0011 lists as unbuilt.
   ```yaml
   # ~/.patchwork-harness/harness.yml
   harness:
     verify: { cmd: "npm test", timeout_s: 600, when: end }   # end | each-step
   ```
2. **Bounded repair loop.** `--attempts 3 [--attempt-budget 0.50]`. When the test gate fails, the failing output goes to one repair step, repeated up to N−1 times, each checkpointed and all inside the bedrock cap. Framed as ADR-0008's "propose ONE follow-up step", not as L4.
3. **Checkpoints and rewind.** `--checkpoint` takes a snapshot per step (`git stash create` stored at `refs/patchwork-harness/<sid>/step-<n>`, leaving your branch alone), and `patchwork-harness rewind <sid> [--step n]` restores one. Unlike Claude Code's checkpoints, this also covers edits made through bash. Options 2 and 7 depend on it.
4. **L5 reviewer.** `--review [auto|<model>] [--review-strict] [--review-critic]`. It runs in its own context on a different vendor from the executor, after L4.5, with a yes/no rubric: goal met, tests run and passed, no destructive commands, memory updated. `--review-critic` adds a critic that must cite evidence when it disagrees, as in the Adversarial Review paper [35].
5. **Runtime guards.** `--guards loop,time,done`:
   ```yaml
   harness:
     guards:
       loop: { same_file_edits: 4, same_cmd_repeats: 3 }  # inject a "reconsider" note
       time_budget_s: 900                                  # show elapsed/remaining time
       done_check: true                                    # one extra "did you verify?" turn
   ```
6. **Effort profile.** Add an optional `effort: low|medium|high|xhigh` field to each step, plus `--effort-profile flat|sandwich` (sandwich = high effort for planner, critic and review, medium for execution). Mark it experimental, since HAL found more effort often hurt.
7. **Best-of-N.** `--best-of 3 --select verify|critic|vote [--sequential]`. Each attempt runs in its own git worktree; attempts that fail the test gate are pruned, then L4.5 plus a cross-vendor judge pick from summaries of each attempt's audit trail. It needs a cost estimate before it starts, as `patchwork-harness review` already does. The parallel version needs a DIRECTION.md edit; `--sequential` doesn't.
8. **Caching fix (a fix, not a flag).** Move `budgetLine` and other per-turn values after the cache breakpoint, and add breakpoints on the tool list and the last message.

None of these can be shown to help on your own tasks without Next-10 #8: an eval suite along the lines of `patchwork-harness eval run <suite> --trials 5 --flags "..."`. Separately, the do-not list in `DIRECTION.md` still says "five providers is enough" (last updated 27 May), but ADR-0011-local added a sixth. That document is out of date.

### Could not verify
- How vix works.
- How the Gemini 3, AI Engineer World's Fair and AGI House winners built their harnesses.
- The current OSWorld-Verified #1 (aggregator sites only).
- OpenAI's "Harness engineering" post (returned 403) and "Unrolling the Codex agent loop" (search snippet only).
- ForgeCode's Forge/Muse/Sage parallel sub-agents (only in a Medium post, not ForgeCode's own).
- The caching bug above, which I read from the code but did not measure.

### Sources
[1] https://claude.com/blog/meet-the-winners-of-our-built-with-opus-4-6-claude-code-hackathon
[2] https://claude.com/blog/meet-the-winners-of-built-with-opus-4-7-claude-code-hackathon
[3] https://claude.com/blog/meet-the-winners-of-our-claude-opus-4-8-build-day-hackathon
[4] https://www.rippletide.com/resources/blog/winning-the-openai-codex-hackathon-moving-from-outputs-to-outcomes-the-decision-layer
[5] https://developers.openai.com/blog/build-week-winners
[6] https://devpost.com/software/salesshortcut · https://cloud.google.com/blog/products/ai-machine-learning/adk-hackathon-results-winners-and-highlights
[7] https://gemini3.devpost.com/updates
[8] https://cerebralvalley.ai/e/aiewf-hackathon-2026/hackathon/gallery.md
[9] https://snorkel.ai/leaderboard/terminal-bench-2-1/
[10] https://huggingface.co/datasets/harborframework/terminal-bench-2-leaderboard/commit/2ded16e99c1365a57a396a7632a4ebc46e304b22
[11] https://labs.scale.com/leaderboard/swe_bench_pro_public_v2
[12] https://www.vals.ai/benchmarks/swebench
[13] https://factory.com/news/terminal-bench
[14] https://www.warp.dev/blog/terminal-bench
[15] https://forgecode.dev/blog/gpt-5-4-agent-improvements/
[16] https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering
[17] https://arxiv.org/abs/2606.24311
[18] https://www.anthropic.com/news/claude-4
[19] https://www.openhands.dev/blog/sota-on-swe-bench-verified-with-inference-time-scaling-and-critic-model
[20] https://www.openhands.dev/blog/20260305-learning-to-verify-ai-generated-code
[21] https://arxiv.org/html/2507.23370
[22] https://www.augmentcode.com/blog/1-open-source-agent-on-swe-bench-verified-by-combining-claude-3-7-and-o1
[23] https://refact.ai/blog/2025/1-agent-on-swe-bench-verified-using-claude-4-sonnet/
[24] https://arxiv.org/abs/2510.02250
[25] https://github.com/SWE-agent/mini-swe-agent
[26] https://aider.chat/docs/repomap.html · https://aider.chat/2024/09/26/architect.html
[27] https://code.claude.com/docs/en/checkpointing
[28] https://code.claude.com/docs/en/sub-agents
[29] https://learn.chatgpt.com/docs/security
[30] https://openai.com/index/unrolling-the-codex-agent-loop/ (search snippet only)
[31] https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
[32] https://www.anthropic.com/engineering/multi-agent-research-system
[33] https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
[34] https://arxiv.org/abs/2510.11977
[35] https://arxiv.org/abs/2608.18167
[37] https://cerebralvalley.ai/e/openai-codex-hackathon
