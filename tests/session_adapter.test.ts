import { describe, expect, it } from "vitest";
import { verify } from "../src/verifier/grounding.js";
import { evidenceFromAuditEvents, parseAuditJsonl } from "../src/verifier/session_adapter.js";

const modern = (over: object) =>
  JSON.stringify({
    id: "ev_x",
    action: "tool_use_end",
    status: "completed",
    target: { tool: "bash" },
    content: { hash: "sha256:abc", size_bytes: 20 },
    ...over,
  });

describe("evidenceFromAuditEvents", () => {
  it("maps modern events, preserving event ids", () => {
    const events = parseAuditJsonl(
      [
        modern({ id: "ev_1", provenance: { output: "spend=527.22" } }),
        JSON.stringify({
          id: "ev_2",
          action: "tool_use_start",
          target: { tool: "write" },
          provenance: { input: '{"path":"x","content":"limit=250"}' },
        }),
      ].join("\n"),
    );
    const r = evidenceFromAuditEvents(events);
    expect(r.stats).toEqual({ toolResults: 1, toolCalls: 1, hashedOnly: 0 });
    expect(r.evidence[0]).toMatchObject({
      type: "tool_result",
      event_id: "ev_1",
      output: "spend=527.22",
    });
    expect(r.warnings).toEqual([]);
  });

  it("END-TO-END TAINT: a write-then-read session yields MISSED, not VERIFIED", () => {
    // the model writes limit=250, a read returns it — the adapter's
    // tool_call mapping must feed the verifier's content-taint rule
    const events = parseAuditJsonl(
      [
        JSON.stringify({
          id: "ev_w",
          action: "tool_use_start",
          target: { tool: "write" },
          provenance: { input: "write file: limit=250" },
        }),
        modern({ id: "ev_r", target: { tool: "read" }, provenance: { output: "limit=250" } }),
      ].join("\n"),
    );
    const { evidence } = evidenceFromAuditEvents(events);
    const report = verify("Config confirms the limit is 250.", evidence);
    const atom = report.atoms.find((a) => a.value === "250");
    expect(atom?.verdict).toBe("MISSED"); // tainted-only support is never green
    expect(report.overall).toBe("UNVERIFIABLE");
  });

  it("legacy hash-only sessions get zero evidence, a loud warning, and UNVERIFIABLE", () => {
    const events = parseAuditJsonl(
      [modern({ id: "ev_old" }), modern({ id: "ev_old2" })].join("\n"),
    );
    const r = evidenceFromAuditEvents(events);
    expect(r.stats.hashedOnly).toBe(2);
    expect(r.evidence).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/content hash/);
    const report = verify("Spend was 527.22.", r.evidence);
    expect(report.overall).toBe("NOT_GREEN"); // ungrounded claim, zero evidence
    expect(report.atoms[0]?.verdict).toBe("UNGROUNDED"); // never falsely green
  });

  it("skips malformed lines without dying", () => {
    const events = parseAuditJsonl('{"broken\n' + modern({ provenance: { output: "ok=1" } }));
    expect(evidenceFromAuditEvents(events).stats.toolResults).toBe(1);
  });
});
