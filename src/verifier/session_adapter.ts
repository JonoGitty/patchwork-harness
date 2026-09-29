/**
 * Audit events → verifier evidence (ADR-0011 Phase 3 / ADR-0012).
 *
 * Maps a session's audit JSONL into the evidence array the grounding
 * verifier consumes:
 *   tool_use_end + provenance.output  → {type:"tool_result", event_id, tool, output}
 *   tool_use_start + provenance.input → {type:"tool_call", tool, input}
 * The tool_call mapping is what feeds the existing content-taint rule —
 * the model must not be able to cite its own authored text.
 *
 * HONESTY RULE: events from before the provenance capture landed carry
 * only a content hash. A hash cannot be evidence, so those events are
 * COUNTED and WARNED about, never silently mapped — a legacy session
 * verifies UNVERIFIABLE rather than falsely green.
 */

export interface AdapterResult {
  evidence: Array<Record<string, unknown>>;
  warnings: string[];
  stats: { toolResults: number; toolCalls: number; hashedOnly: number };
}

interface LooseEvent {
  id?: string;
  action?: string;
  status?: string;
  target?: { tool?: string };
  content?: unknown;
  provenance?: Record<string, unknown>;
}

/** Tolerant per-line parse — malformed lines are skipped, never fatal. */
export function parseAuditJsonl(raw: string): LooseEvent[] {
  const out: LooseEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e && typeof e === "object") out.push(e as LooseEvent);
    } catch {
      /* skip */
    }
  }
  return out;
}

export function evidenceFromAuditEvents(events: LooseEvent[]): AdapterResult {
  const evidence: Array<Record<string, unknown>> = [];
  const stats = { toolResults: 0, toolCalls: 0, hashedOnly: 0 };
  for (const e of events) {
    if (e.action === "tool_use_end" && e.status === "completed") {
      const output = e.provenance?.output;
      if (typeof output === "string" && output.length > 0) {
        evidence.push({
          event_id: e.id ?? "unknown",
          type: "tool_result",
          tool: e.target?.tool ?? "",
          output,
        });
        stats.toolResults++;
      } else {
        stats.hashedOnly++; // pre-ADR-0012 event: hash only, unusable as evidence
      }
    } else if (e.action === "tool_use_start") {
      const input = e.provenance?.input;
      if (typeof input === "string" && input.length > 0) {
        evidence.push({
          event_id: e.id ?? "unknown",
          type: "tool_call",
          tool: e.target?.tool ?? "",
          input,
        });
        stats.toolCalls++;
      }
    }
  }
  const warnings: string[] = [];
  if (stats.hashedOnly > 0) {
    warnings.push(
      `${stats.hashedOnly} tool_use_end event(s) carry only a content hash ` +
        "(recorded before verbatim provenance landed, ADR-0012) — their " +
        "outputs cannot be indexed as evidence. Claims resting on them " +
        "will read UNGROUNDED/UNVERIFIABLE; that is honesty, not breakage.",
    );
  }
  if (stats.toolResults === 0) {
    warnings.push(
      "no usable tool outputs in this session — the verifier has no " +
        "evidence to check against, so expect UNVERIFIABLE.",
    );
  }
  return { evidence, warnings, stats };
}
