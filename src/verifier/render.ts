/**
 * One renderer for grounding-verifier reports (ADR-0012) — CLI, cockpit
 * and web all speak through this so the tri-state law is displayed the
 * same way everywhere: ALL THREE counts always shown, same prominence.
 */
import chalk, { Chalk } from "chalk";
import type { Report } from "./grounding.js";
import type { TriageReport } from "./triage.js";

const GLYPH = { VERIFIED: "✓", UNGROUNDED: "✗", MISSED: "◦" } as const;

export function renderReport(report: Report, opts: { color?: boolean } = {}): string {
  const c = opts.color === false ? new Chalk({ level: 0 }) : chalk;
  const lines: string[] = [];
  for (const a of report.atoms) {
    const paint =
      a.verdict === "VERIFIED" ? c.green : a.verdict === "UNGROUNDED" ? c.red : c.yellow;
    const proof = a.verdict === "VERIFIED" && a.evidence ? c.dim(`  [${a.evidence}]`) : "";
    const note = a.note ? c.dim(`  — ${a.note}`) : "";
    lines.push(
      `  ${paint(`${GLYPH[a.verdict]} ${a.verdict.padEnd(10)}`)} ${a.kind.padEnd(13)} ${a.value}${proof}${note}`,
    );
  }
  const overallPaint =
    report.overall === "GREEN"
      ? c.green
      : report.overall === "GREEN_WITH_MISSED"
        ? c.yellow
        : c.red;
  lines.push("");
  lines.push(
    `  ${overallPaint.bold(report.overall)} — ` +
      `${c.green(`${report.verified} verified`)} · ` +
      `${c.red(`${report.ungrounded} ungrounded`)} · ` +
      `${c.yellow(`${report.missed} missed`)} · ` +
      `coverage ${(report.coverage * 100).toFixed(0)}%`,
  );
  return lines.join("\n");
}

/**
 * ADR-0013 triage, printed BELOW the report and never inside it: these are
 * routes for the review queue, not verdicts, and must never read as green.
 */
export function renderTriage(t: TriageReport, opts: { color?: boolean } = {}): string {
  const c = opts.color === false ? new Chalk({ level: 0 }) : chalk;
  const head = `  classifier triage · ${t.backend} ${t.model}`;
  if (t.error)
    return `${head}\n  ${c.yellow(`unavailable: ${t.error}`)} — MISSED atoms stay untriaged`;
  if (t.items.length === 0) return `${head} · no MISSED atoms to triage`;
  const lat = t.latency_ms !== undefined ? ` · ${t.latency_ms} ms` : "";
  const lines = [`${head} · ${t.items.length} MISSED${lat} — routes, not verdicts`];
  for (const i of t.items) {
    const [glyph, label] =
      i.band === "likely_unsupported"
        ? [c.red("↓"), c.red("likely unsupported")]
        : i.band === "uncertain"
          ? [c.yellow("?"), c.yellow("uncertain         ")]
          : [c.dim("↑"), c.dim("likely supported  ")];
    lines.push(`  ${glyph} ${i.p_supported.toFixed(2)} ${label} ${i.kind.padEnd(13)} ${i.value}`);
  }
  return lines.join("\n");
}

/** GREEN & GREEN_WITH_MISSED exit 0 · NOT_GREEN 1 · UNVERIFIABLE 2 · INVALID 3. */
export function reportExitCode(r: Report): number {
  switch (r.overall) {
    case "GREEN":
    case "GREEN_WITH_MISSED":
      return 0;
    case "NOT_GREEN":
      return 1;
    case "UNVERIFIABLE":
      return 2;
    default:
      return 3;
  }
}
