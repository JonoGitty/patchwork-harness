# patchwork-harness mod for Claude Code

The patchwork-harness harness inside Claude Code, as a [Claude Code mod](https://code.claude.com/docs/en/plugins/mods/overview). Needs Claude Code 2.1.287 or later, with mods switched on for your account.

## What it does

| | |
|---|---|
| **Injection guard** | The output of `Read`, `Bash`, `Grep`, `WebFetch`, `WebSearch` and MCP tools is screened by Jeff's `guard` adapter before Claude reads it. A hit puts a warning in front of the output (`flag`), or replaces the output with a notice (`withhold`), and shows you a toast. |
| **`/verify`** | Runs patchwork-harness's L4.5 grounding verifier on this session's last answer: each number, path or quote is checked against what the tools actually returned. It never reports a false VERIFIED. `/verify --classify` adds the Jeff triage of claims it could not check. |
| **`/verify auto on`** | Verifies each answer as it lands, until `/verify auto off`. It is **off by default**, because auditing is requested, never forced. |
| **`/guard`** | `/guard off`, `/guard flag`, `/guard withhold`, or `/guard 0.85` to set the threshold. |
| **`/harness`** | Shows what is on, what the guard caught, and the last verification. |

## Measured before it was wired in

All results come from `patchwork-harness eval classifier`, on 1 Oct 2026. See ADR-0019.

- **Test set.** 150 real coding-agent tool outputs, each also with one planted injection.
- **At P ≥ 0.9.** The guard caught 90% of the planted injections, with 1.3% false alarms on the clean outputs.
- **Blind spot.** Instructions framed as legitimate project policy, or as already authorised.
- **Not a security boundary.** Treat it as detection and defence in depth. Claude Code's permission rules stay in charge.

## Run it

1. **Start Jeff** (WSL): `bash scripts/jeff/serve.sh`. It serves on `http://127.0.0.1:8765` with the guard adapter.
2. **Load the mod for one session:** `claude --plugin-dir /path/to/claude-mod`.
   - Or set `CLAUDE_CODE_PLUGIN_DIRS` to load it everywhere.
3. **Set the options** in `/plugin`, or under `pluginConfigs` → `patchwork-harness@inline` in settings:
   - `jeff_url`. Default: `http://127.0.0.1:8765`
   - `guard`: `off`, `flag` or `withhold`. Default: `flag`
   - `guard_threshold`. Default: `0.9`
   - `cli`: the command that `/verify` runs. Use `patchwork-harness` if it is on your PATH. From WSL with Windows node, use a JSON array:
     `["/mnt/c/Program Files/nodejs/node.exe","C:\\AI\\patchwork-harness\\bin\\patchwork-harness.mjs"]`

If Jeff is not running, the guard turns itself off and tells you; the session carries on.

## Develop

- **Check what Claude Code reads.** `claude plugin validate ./claude-mod --strict` lists the hooks and every mods-API call the mod makes. Today that is `$.http.fetch` (to Jeff), `$.process.run` (patchwork-harness, for `/verify`), `$.session.id`, and the toasts and logs.
- **Tests.** `npx vitest run tests/claude_mod.test.ts` drives the real hooks through a fake `on` and `$`. `claude plugin test` cannot run until mods are on for the account.
