/**
 * Claude Code transcript → verifier evidence (ADR-0012 follow-on).
 *
 * Audits a Claude Code SESSION with the L4.5 grounding verifier: did the
 * assistant's final answer stay grounded in what its tools actually
 * returned? Mapping (measured against real transcripts, not guessed):
 *
 *   tool_result blocks (user entries)  → {type:"tool_result", output}
 *       — world-facing: what commands/files/APIs actually said
 *   tool_use blocks (assistant)        → {type:"tool_call", input}
 *       — model-authored: feeds the content-taint rule, so Claude writing
 *         a value into a file and reading it back cannot self-certify
 *   ANSWER = the LAST assistant message's text blocks (thinking excluded —
 *       model-internal, neither answer nor evidence)
 *
 * Transcripts live in ~/.claude/projects/<project>/<session>.jsonl —
 * Windows-side and/or inside WSL (reachable via \\wsl.localhost UNC).
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeAdapterResult {
  evidence: Array<Record<string, unknown>>;
  answer: string;
  warnings: string[];
  stats: { toolResults: number; toolCalls: number; assistantTurns: number };
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b) =>
        b && typeof b === "object" && "text" in b ? String((b as Block).text ?? "") : "",
      )
      .filter(Boolean)
      .join("\n");
  return "";
}

export function adaptClaudeTranscript(raw: string): ClaudeAdapterResult {
  const evidence: Array<Record<string, unknown>> = [];
  const stats = { toolResults: 0, toolCalls: 0, assistantTurns: 0 };
  const toolNameById = new Map<string, string>();
  let lastAnswer = "";
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; message?: { content?: unknown } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = Array.isArray(e.message?.content) ? (e.message?.content as Block[]) : [];
    if (e.type === "assistant") {
      stats.assistantTurns++;
      const texts = blocks.filter((b) => b.type === "text" && b.text?.trim());
      if (texts.length) lastAnswer = texts.map((b) => b.text).join("\n");
      for (const b of blocks) {
        if (b.type !== "tool_use") continue;
        if (b.id && b.name) toolNameById.set(b.id, b.name);
        evidence.push({
          event_id: b.id ?? "tool_use",
          type: "tool_call",
          tool: b.name ?? "",
          input: JSON.stringify(b.input ?? "").slice(0, 16000),
        });
        stats.toolCalls++;
      }
    } else if (e.type === "user") {
      for (const b of blocks) {
        if (b.type !== "tool_result") continue;
        const output = resultText(b.content).slice(0, 16000);
        if (!output) continue;
        evidence.push({
          event_id: b.tool_use_id ?? "tool_result",
          type: "tool_result",
          tool: b.tool_use_id ? (toolNameById.get(b.tool_use_id) ?? "") : "",
          output,
        });
        stats.toolResults++;
      }
    }
  }
  const warnings: string[] = [];
  if (!lastAnswer.trim())
    warnings.push(
      "no assistant text found — the session may have ended mid-tool-call; pass --answer",
    );
  if (stats.toolResults === 0)
    warnings.push(
      "no tool results in this transcript — nothing to ground against; expect UNVERIFIABLE",
    );
  return { evidence, answer: lastAnswer, warnings, stats };
}

/** Search dirs for Claude Code transcripts: Windows home + WSL homes via UNC. */
export function claudeProjectDirs(): string[] {
  const dirs: string[] = [];
  const env = process.env.PATCHWORK_HARNESS_CLAUDE_PROJECTS;
  if (env) for (const d of env.split(";")) if (d.trim()) dirs.push(d.trim());
  dirs.push(join(homedir(), ".claude", "projects"));
  const wslHomes = "\\\\wsl.localhost\\Ubuntu\\home";
  try {
    for (const user of readdirSync(wslHomes))
      dirs.push(join(wslHomes, user, ".claude", "projects"));
  } catch {
    /* no WSL */
  }
  return dirs.filter((d) => {
    try {
      return existsSync(d);
    } catch {
      return false;
    }
  });
}

export interface FoundTranscript {
  path: string;
  project: string;
  session: string;
  mtimeMs: number;
}

/** All transcripts across all project dirs, newest first. */
export function listTranscripts(dirs = claudeProjectDirs()): FoundTranscript[] {
  const out: FoundTranscript[] = [];
  for (const dir of dirs) {
    let projects: string[];
    try {
      projects = readdirSync(dir);
    } catch {
      continue;
    }
    for (const proj of projects) {
      const pd = join(dir, proj);
      let files: string[];
      try {
        files = readdirSync(pd).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          out.push({
            path: join(pd, f),
            project: proj,
            session: f.replace(/\.jsonl$/, ""),
            mtimeMs: statSync(join(pd, f)).mtimeMs,
          });
        } catch {
          /* races with active sessions are fine */
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Resolve an argument: explicit path, session-id prefix/substring, or newest. */
export function resolveTranscript(arg?: string): FoundTranscript {
  if (arg?.endsWith(".jsonl") && existsSync(arg)) {
    return {
      path: arg,
      project: "(path)",
      session: arg.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, ""),
      mtimeMs: statSync(arg).mtimeMs,
    };
  }
  const all = listTranscripts();
  if (all.length === 0) throw new Error("no Claude Code transcripts found in any known location");
  if (!arg) return all[0] as FoundTranscript;
  const hit =
    all.find((t) => t.session.startsWith(arg)) ?? all.find((t) => t.session.includes(arg));
  if (!hit) throw new Error(`no Claude session matching ${arg}`);
  return hit;
}

export function readTranscript(t: FoundTranscript): string {
  return readFileSync(t.path, "utf8");
}
