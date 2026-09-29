/**
 * Patchwork-shape audit emitter.
 *
 * Every action patchwork-harness takes is appended as one JSON object per line to
 * ~/.patchwork-harness/events/<session>.jsonl with the same shape as Patchwork's
 * native event log. Patchwork can `sync` these once it adds custom-agent
 * ingest; until then the file is the join key for our own dashboard.
 *
 * Schema is documented in ARCHITECTURE.md and mirrors Patchwork v0.6.9.
 */

import { appendFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { EVENTS_DIR, ensureDirs } from "./util/paths.js";
import { newEventId } from "./util/ulid.js";

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";
export type Status = "completed" | "failed" | "denied";

export type Action =
  | "session_start"
  | "session_end"
  | "boot_check"
  | "prompt_submit"
  | "plan_ready"
  | "route_decision"
  | "step_start"
  | "step_end"
  | "tool_use_start"
  | "tool_use_end"
  | "provider_call"
  | "provider_response"
  | "permission_prompt"
  | "permission_grant"
  | "permission_deny"
  | "git_commit"
  | "git_push"
  | "pr_open";

export interface AuditEvent {
  id: string;
  session_id: string;
  timestamp: string;
  agent: "patchwork-harness";
  action: Action;
  status: Status;
  project: { root: string; name: string };
  risk: { level: RiskLevel; flags: string[] };
  target?: Record<string, unknown>;
  content?: { hash: string; size_bytes: number; redacted: boolean };
  provenance?: Record<string, unknown>;
}

export interface EmitInput {
  action: Action;
  status?: Status;
  risk?: { level: RiskLevel; flags?: string[] };
  target?: Record<string, unknown>;
  content?: string | Buffer;
  redactContent?: boolean;
  provenance?: Record<string, unknown>;
}

function isoNow(): string {
  return new Date().toISOString();
}

function sha256(s: string | Buffer): string {
  return "sha256:" + createHash("sha256").update(s).digest("hex");
}

// Expanded after the 2026-05-27 security audit. Covers the modern API-key
// shapes the original three regexes missed: Anthropic explicit, OpenAI
// prefixed, Stripe, Perplexity, Google AI / OAuth, GitHub PAT family,
// Slack, HuggingFace, npm, GitLab PAT, raw JWTs, Bearer tokens, PEM
// private keys.
const KEY_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  /sk-(?:proj|live|test|admin|user|svcacct)-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /rk_(?:live|test)_[A-Za-z0-9]{20,}/g,
  /pplx-[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /ya29\.[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{30,}/g,
  /xox[bpars]-[A-Za-z0-9-]{20,}/g,
  /xai-[A-Za-z0-9_-]{20,}/g,
  /hf_[A-Za-z0-9]{20,}/g,
  /npm_[A-Za-z0-9]{30,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END[^-]+-----/g,
];

/** Field names whose VALUES we redact regardless of value shape. Defends
 *  against provider responses that put secrets in oddly-shaped fields the
 *  regex set wouldn't catch. Compared case-insensitively. */
const SENSITIVE_KEY_NAMES = new Set([
  "apikey", "api_key", "apitoken", "api_token",
  "token", "access_token", "refresh_token", "id_token",
  "authorization", "auth", "auth_token",
  "secret", "client_secret", "password", "passwd", "pwd",
  "private_key", "private_key_pem",
  "session_cookie", "session_token", "cookie",
  "anthropic_api_key", "openai_api_key", "gemini_api_key", "google_api_key",
  "xai_api_key", "perplexity_api_key", "nlm_auth_token", "nlm_cookies",
]);

function redactByName(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redactByName);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEY_NAMES.has(k.toLowerCase())) {
        out[k] = "[REDACTED-KEY]";
      } else {
        out[k] = redactByName(v);
      }
    }
    return out;
  }
  return obj;
}

function redactKeys<T>(obj: T): T {
  if (typeof obj !== "object" || obj == null) return obj;
  // 1. Redact by key NAME (catches `apiKey: "..."` style).
  const nameRedacted = redactByName(obj);
  // 2. Then regex-redact value SHAPES we know about.
  const json = JSON.stringify(nameRedacted);
  let cleaned = json;
  for (const re of KEY_PATTERNS) cleaned = cleaned.replace(re, "[REDACTED-KEY]");
  return JSON.parse(cleaned);
}

export class AuditEmitter {
  private path: string;
  private fd: number | null = null;
  public failed = false;
  public lastError: Error | null = null;

  constructor(
    public readonly sessionId: string,
    public readonly projectRoot: string,
    public readonly projectName: string,
  ) {
    ensureDirs();
    this.path = join(EVENTS_DIR, `${sessionId}.jsonl`);
  }

  /** Open the file with O_APPEND so concurrent writes interleave safely. */
  private ensureOpen(): void {
    if (this.fd == null) this.fd = openSync(this.path, "a");
  }

  /** Append one event. Throws on failure (caller decides to abort). */
  emit(input: EmitInput): AuditEvent {
    this.ensureOpen();
    const event: AuditEvent = {
      id: newEventId(),
      session_id: this.sessionId,
      timestamp: isoNow(),
      agent: "patchwork-harness",
      action: input.action,
      status: input.status ?? "completed",
      project: { root: this.projectRoot, name: this.projectName },
      risk: { level: input.risk?.level ?? "none", flags: input.risk?.flags ?? [] },
    };
    if (input.target) event.target = redactKeys(input.target);
    if (input.content != null) {
      event.content = {
        hash: sha256(input.content),
        size_bytes: typeof input.content === "string"
          ? Buffer.byteLength(input.content, "utf8")
          : input.content.length,
        redacted: input.redactContent ?? true,
      };
    }
    if (input.provenance) event.provenance = redactKeys(input.provenance);

    try {
      appendFileSync(this.path, JSON.stringify(event) + "\n");
    } catch (e) {
      this.failed = true;
      this.lastError = e as Error;
      throw e;
    }
    return event;
  }

  /** A best-effort emit that records failure but does not throw. */
  emitOrMark(input: EmitInput): AuditEvent | null {
    try {
      return this.emit(input);
    } catch {
      return null;
    }
  }

  get pathOnDisk(): string {
    return this.path;
  }
}
