# Architecture

This document explains how Patchwork Harness's pieces fit together. Keep it
current — every meaningful change to the system shape lands here.

## Top-level shape

```
┌────────────────────────────────────────────────────────────────────┐
│                              CLI                                    │
│  patchwork-harness [boot|one-shot|doctor|ls|show|version]                     │
└────────────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼──────────────────┐
            ▼                 ▼                  ▼
        ┌──────┐        ┌──────────┐       ┌────────┐
        │ boot │        │ session  │       │ doctor │
        └──┬───┘        └────┬─────┘       └────────┘
           │                 │
   patchwork required   ┌────▼─────┐
   audit sink test      │planner   │  Anthropic Haiku by default
   policy load          └────┬─────┘
                             │ steps[]
                        ┌────▼─────┐
                        │executor  │  per step:
                        └────┬─────┘    pick provider+model
                             │           bounded agent loop
                  ┌──────────┼──────────────────┐
                  ▼          ▼                  ▼
              ┌───────┐  ┌─────────┐       ┌──────────┐
              │ tools │  │providers│       │ plugins  │
              └───┬───┘  └────┬────┘       └────┬─────┘
                  │           │                 │
       bash/read/write/    anthropic /     claude_compat /
       edit/grep/glob/     openai /        ai_time_keep
       git_ops/todo/       gemini /
       budget_status/      xai /
       claude_skill/       perplexity
       context_search/     (research-only)
       context_query/
       context_write

                       every action ──► audit ──► Patchwork
                                                   (REQUIRED — fail-closed)

   ┌──────────────────────────────────────────────────────────┐
   │ memory spine — ~/.patchwork-harness/context.db (SQLite + FTS5)      │
   │  read by:  planner (auto top-k injection before plan),   │
   │            executor (context_* tools), `patchwork-harness resume`   │
   │  written by: session-end auto-extraction, explicit       │
   │             context_write / `patchwork-harness context add-*`       │
   └──────────────────────────────────────────────────────────┘
```

## Modules

### `src/boot.ts`
Ensures the world is sane before anything else runs. Order:
1. `patchwork --version` works
2. `~/.patchwork/` is reachable (Patchwork's own data dir)
3. A test event can be appended to our audit JSONL
4. Active policy loads (config + Patchwork's merged policy)

If any step fails, the CLI exits with a clear actionable message. This is
the single non-negotiable check.

### `src/audit.ts`
Append-only writer of Patchwork-shape JSON events. Schema matches the
events Patchwork produces natively (see `patchwork-events.json`):

```json
{
  "id":"evt_<ULID>", "session_id":"ses_<ULID>",
  "timestamp":"ISO8601-Z", "agent":"patchwork-harness",
  "action":"...", "status":"completed|failed|denied",
  "project":{"root":"...","name":"..."},
  "risk":{"level":"none|low|medium|high|critical","flags":[...]},
  "target":{...}, "content":{"hash":"sha256:...","size_bytes":N,"redacted":true},
  "provenance":{"executor":"anthropic","model":"...","cost_usd":0.0012,...}
}
```

Events live at `~/.patchwork-harness/events/<session>.jsonl`. Patchwork can `sync`
these once it adds custom-agent ingest; until then the file is the join
key for the dashboard.

### `src/permissions/`
Reads our `config/policy.yml` AND the merged Patchwork policy
(`patchwork policy show`). The agent's auto-approval boundary is the
**intersection** of the two — neither layer can grant what the other
blocks. Default boundary:

| Action class                              | Auto | Prompt | Refuse |
|-------------------------------------------|------|--------|--------|
| Read in cwd, glob, grep                   |  ✔   |        |        |
| Edit/write inside cwd                     |  ✔   |        |        |
| Edit/write outside cwd                    |      |   ✔    |        |
| `npm/pnpm/yarn/git/node/python` commands  |  ✔   |        |        |
| Other bash from allowlist                 |  ✔   |        |        |
| Other bash off allowlist                  |      |   ✔    |        |
| `git push`                                |      |   ✔    |        |
| `gh pr create/merge`                      |      |   ✔    |        |
| Anything Patchwork classifies `critical`  |      |        |   ✔    |

The `--auto` flag widens this; `--cautious` narrows it.

### `src/providers/`
A `Provider` is a thing that takes `Message[]` and returns either text
or a sequence of tool-use calls. Each provider normalises its native API
to a common shape so the agent loop is provider-agnostic. **Five
providers** are live for `complete()`: Anthropic, OpenAI, Gemini, xAI,
and **Perplexity** (research-only, no tool calling, returns cited text
with Sources appended).

**Gemini extras** (live as of 2026-05): `CompletionRequest.media`
attaches images, video URLs (incl. YouTube), and PDFs via `fileData` for
remote URIs or `inlineData` (base64) for local files. `CompletionRequest.grounded`
swaps function tools for the `googleSearch` tool and surfaces the
returned `groundingMetadata` as a Sources list. The `patchwork-harness ask` CLI
exposes both via `--image/--video/--pdf` and `--search`.

**Streaming** (`stream()`): Anthropic + OpenAI implement
`AsyncIterable<StreamChunk>` for incremental output. Chunks carry text
deltas, tool_use deltas, usage tallies, and a final `done` chunk with
the full assembled response. Gemini, xAI, and Perplexity fall through
to `complete()`; see ADR-0007. Streaming for Gemini/xAI is parked in
`DIRECTION.md` (do-not list) until there's a demonstrated user need.

### `src/tools/`
A `Tool` declares: name, description, input schema (zod), risk flags,
and a `run(input, ctx)` function. Tools never bypass the audit emitter
or the permission gate — both are called from the executor before `run`.

Twelve built-in tools, registered in `src/tools/registry.ts`:

| Tool | Purpose |
|---|---|
| `read` / `write` / `edit` | File I/O with sensitive-path refusal and diff preview |
| `bash` | Shell commands (gated by Patchwork taint rules + per-step allowlist) |
| `grep` / `glob` | Search and find within the cwd |
| `git_ops` | git status/diff/add/commit/push, gh pr_create |
| `todo` | Per-session sub-task tracker the planner uses |
| `budget_status` | Lets the executor query its own spend mid-run |
| `claude_skill` | Invokes a user `~/.claude/skills/<name>` skill via `claude -p` |
| `context_search` | FTS5 over the memory spine; obsolete claims auto-filtered |
| `context_query` | Structured reads from spine tables (column allowlist, no raw SQL) |
| `context_write` | Discriminated insert: project / document+chunks / claim / file_index / session_log |

### `src/context/` — memory spine
Local SQLite (via `better-sqlite3`) + FTS5 at `~/.patchwork-harness/context.db`.
Schema is in `src/context/schema/001_initial.sql`: projects, documents,
chunks (FTS-indexed), claims (provenance: `created_by` + `confidence` +
`status` + `depends_on_json` for cascade lineage), file_index,
sessions_log. Migration runner in `migrations.ts` is idempotent.
`extractor.ts` + `session_writer.ts` parse audit JSONL and write a
session into the spine at `finishSession` time, fail-soft. `retriever.ts`
builds a goal-relevant top-k packet that the planner auto-injects
before planning (`PATCHWORK_HARNESS_CONTEXT_MAX_TOKENS` caps it). `resume.ts`
backs `patchwork-harness resume`. See `DIRECTION.md` for the rationale and
ADR-0009 for the formal decision.

### `src/core/orchestrator.ts`
The conductor. For a one-shot goal:
1. **Smart conductor — Layer 1 + Layer 2 (parallel):** assemble a world
   view packet (`world_view.ts`) from user memory + project memory + git
   context + dashboard signal; mine `~/.patchwork-harness/sessions/*.json` for
   similar past sessions (`lessons.ts`, TF-IDF over goal text)
2. **Plans** with `planner.ts` (Anthropic Haiku → ordered list of steps),
   prompt-injected with the world view + lessons
3. **Smart conductor — Layer 3:** Haiku critic pass; if "revise", re-run
   plan once with critic feedback (max 1 revision)
4. Validates the plan against policy (no critical-only-step)
5. For each step, calls `executor.ts` which runs a bounded inner loop
6. After the last step, optionally commits + opens a PR

Each smart conductor layer is on by default and can be disabled with
`--no-world-view`, `--no-lessons`, `--no-critic`. Layers 4-5 (live
re-planner, reviewer pass) from ADR-0008 remain deferred.

### `src/plugins/`
Plugins extend the orchestrator. They can register tools, register
provider models, or hook into session lifecycle events. M1 ships:

- **`claude_compat`** — enumerates `~/.claude/skills/*/SKILL.md` and
  exposes their descriptions to the planner so it can reuse your
  existing 30+ skills' "I do X" knowledge. M2 will let plugins actually
  invoke skills as subroutines.
- **`ai_time_keep`** — injects the current wall-clock time into every
  planner/executor turn so models never hallucinate dates. Mirrors the
  ai-time-keep hook used in Claude Code.

### `src/mcp/`
Stub interface for MCP (Model Context Protocol) servers. M1 only
defines the types so other code can compile; M2 lights up real client
calls.

### `src/cli.ts`
The user surface. Built on `commander`. Subcommands:
- `patchwork-harness [goal]` (default = `one-shot <goal>`)
- `patchwork-harness boot` — preflight checks
- `patchwork-harness doctor` — same as boot but verbose
- `patchwork-harness ls` — recent sessions
- `patchwork-harness show <session>` — full transcript
- `patchwork-harness web` — start the dashboard at :4243
- `patchwork-harness version`

**`--json` deterministic mode** (one-shot only): emits NDJSON events to
stdout (one event per line: `session_start`, `plan_ready`, `step_start`,
`step_token`, `step_end`, `session_end`, `error`) and silences rich
output (logger writes to stderr). Designed for parent agents to drive
patchwork-harness and parse progress reliably. Pair with `--auto --yes` for fully
non-interactive use. See ADR-0007 and `src/util/json_reporter.ts`.

### `src/web/app.ts` — dashboard + launcher
Hono server on `:4243`. Read endpoints (`/api/sessions`,
`/api/session/:id`, `/api/events/:id`) plus an SSE feed for live event
tail. **Launch surface:** POST `/api/sessions/new` accepts a goal +
budget + mode + permission, spawns `patchwork-harness --json --yes --auto` as a
child, returns a `job_id`. SSE at `/api/jobs/:jobId/stream` tails the
child's NDJSON stdout (and stderr, line-by-line). The HTML page has a
"+ New session" button that opens a modal form; on `job_end` the
new session auto-selects in the left pane.

## Storage

| Path | Purpose |
|------|---------|
| `~/.patchwork-harness/events/<sid>.jsonl` | per-session audit (Patchwork-shape) |
| `~/.patchwork-harness/sessions/<sid>.json` | session manifest (goal, plan, transcript ref) |
| `~/.patchwork-harness/cache/` | provider-side ephemeral state |

We do **not** keep a SQLite mirror of Patchwork's store. Patchwork is the
source of truth; we keep just enough local state to render `ls`/`show`
when offline.

## Build and run

- `npm run dev` — `tsx src/cli.ts ...` for hot iteration
- `npm run build` — `tsup` produces a single `dist/cli.js`
- `npm link` exposes `patchwork-harness` on PATH

Node 20+. macOS / Linux. Windows works in WSL.
