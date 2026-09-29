# ADR-0011: Local provider — free, private writing on this laptop

Date: 2026-08-12
Status: accepted

## Context

All five providers were cloud APIs: every word costs money and leaves the
machine. The primary local use case is WRITING — essays, notes, drafts,
personal text — where privacy matters most and flagship reasoning matters
least. The laptop (RTX 3070 Ti 8GB VRAM, 64GB RAM, i9-12900H) can run
good open models via Ollama.

## Decision

A sixth provider, `local` (`src/providers/local.ts`), speaking to Ollama's
OpenAI-compatible endpoint (default `http://127.0.0.1:11434/v1`) through
the existing OpenAI SDK. Overrides: `PATCHWORK_HARNESS_LOCAL_URL` / `OLLAMA_HOST`
(URL), `PATCHWORK_HARNESS_LOCAL_MODEL` (default model), `PATCHWORK_HARNESS_LOCAL_FORCE=1`
(skip probe).

- **Availability = liveness, not a key.** `available()` curl-probes
  `/api/tags` once per process (2s timeout, cached). No server → the
  planner never routes to local.
- **$0 cost.** `cost_usd: 0` on every response; `estimateCost` already
  ignores free models. Budget/bedrock enforcement is unaffected.
- **No-tools degradation.** Models without a tool template (Gemma 3)
  make Ollama reject requests carrying `tools`; the adapter retries once
  without them, so a writing step degrades gracefully to pure text.
  Planner guidance encodes the pattern: local drafts → later step files.
- **Models pulled** (weights on `a data drive` via user env var
  `OLLAMA_MODELS` — C: was nearly full): `gemma3:12b` (best local prose;
  splits GPU/CPU on 8GB VRAM) and `qwen3:8b` (tool-calling, fits VRAM,
  fast). Registered in `models.yml` + capability corpus under a new
  `local` tier with a `writing` domain routing that prefers them.

## Consequences

- `patchwork-harness ask -p local "draft ..."` and planner-routed writing steps are
  free and private; sensitive-text steps are corpus-mandated to local.
- Local tier is explicitly fenced off from serious coding/reasoning in
  heuristics and anti-patterns.
- Ollama itself is a user-level install; its tray app auto-starts at
  login and picks up `OLLAMA_MODELS` from the user environment.
