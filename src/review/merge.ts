/**
 * Parse each reviewer's fenced JSON findings, merge across reviewers with
 * fuzzy de-duplication, and check two things deterministically:
 *   - is the quoted "evidence" actually in the material? (a reviewer that
 *     quotes code that is not there is caught here, no model involved)
 *   - is it an ABSENCE claim? Absence cannot be proven from a slice, so it
 *     is flagged for human verification rather than trusted.
 */
import { z } from "zod";
import type { ReviewFile } from "./collect.js";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];

const FindingSchema = z.object({
  id: z.string().default(""),
  title: z.string().default("(untitled)"),
  severity: z
    .string()
    .default("info")
    .transform((s) =>
      SEVERITIES.includes(s.toLowerCase() as Severity) ? (s.toLowerCase() as Severity) : "info",
    ),
  category: z.string().default("other"),
  location: z.string().default(""),
  claim: z.string().default(""),
  evidence: z.string().default(""),
  fix: z.string().default(""),
  confidence: z.coerce.number().min(0).max(1).catch(0.5),
  absence_claim: z.boolean().catch(false),
});
export type Finding = z.infer<typeof FindingSchema>;

const ReplySchema = z.object({
  findings: z.array(FindingSchema).default([]),
  right: z.array(z.string()).default([]),
  fix_first: z
    .object({
      id: z.string().default(""),
      why: z.string().default(""),
      against: z.string().default(""),
    })
    .optional(),
});
export type ParsedReply = z.infer<typeof ReplySchema> & { parse_error?: string };

const ABSENCE_RE =
  /\b(no|not|never|missing|absent|lacks?|lacking|without|does ?n[o']t|is ?n[o']t|are ?n[o']t|unbounded|unchecked|unvalidated|unauthenticated|unescaped|unsanitised|unsanitized|nowhere)\b/i;

export function looksLikeAbsenceClaim(text: string): boolean {
  return ABSENCE_RE.test(text);
}

export interface Fence {
  lang: string;
  body: string;
  /** Character offsets of the whole fence (opener line to closer line) in the source. */
  start: number;
  end: number;
}

/**
 * Line-based fence scanner. A regex that only recognises "```json" as an
 * opener mis-pairs everything after a "```python" block (its closer reads
 * as an opener), which is exactly how all three reviewers' findings went
 * unparsed on 7 Sept 2026.
 */
export function fencedBlocks(text: string): Fence[] {
  const out: Fence[] = [];
  const lines = text.split("\n");
  let open: { lang: string; start: number; bodyStart: number } | null = null;
  let pos = 0;
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/);
    const lineEnd = pos + line.length;
    if (m) {
      if (!open) open = { lang: (m[2] ?? "").toLowerCase(), start: pos, bodyStart: lineEnd + 1 };
      else {
        out.push({
          lang: open.lang,
          body: text.slice(open.bodyStart, Math.max(open.bodyStart, pos - 1)),
          start: open.start,
          end: lineEnd,
        });
        open = null;
      }
    }
    pos = lineEnd + 1;
  }
  return out;
}

/** Text with every fenced block that looks like the findings JSON removed
 *  (the verifier should ground the PROSE, not the reviewer's own JSON). */
export function stripFindingsJson(text: string): string {
  const blocks = fencedBlocks(text).filter((f) => f.lang === "json" || /"findings"\s*:/.test(f.body));
  let out = "";
  let cursor = 0;
  for (const b of blocks) {
    out += text.slice(cursor, b.start);
    cursor = b.end;
  }
  return out + text.slice(cursor);
}

function tryParse(body: string): ParsedReply | { error: string } {
  try {
    const parsed = ReplySchema.parse(JSON.parse(body));
    parsed.findings = parsed.findings.map((f, idx) => ({
      ...f,
      id: f.id || `F${idx + 1}`,
      absence_claim: f.absence_claim || looksLikeAbsenceClaim(`${f.title} ${f.claim}`),
    }));
    return parsed;
  } catch (e) {
    return { error: (e as Error).message.slice(0, 200) };
  }
}

/** The last balanced {...} object that contains a "findings" key, fence or not. */
function lastFindingsObject(text: string): string | null {
  const idx = text.lastIndexOf('"findings"');
  if (idx < 0) return null;
  const start = text.lastIndexOf("{", idx);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Pull the findings JSON out of a reply (last fenced block that has it,
 *  else the last balanced object that has it) and validate it. */
export function parseReply(text: string): ParsedReply {
  const fences = fencedBlocks(text).filter((f) => /"findings"\s*:/.test(f.body));
  const last = fences[fences.length - 1];
  if (last) {
    const r = tryParse(last.body);
    if (!("error" in r)) return r;
    // a fenced block that fails to parse is usually a truncated reply
    const unfenced = lastFindingsObject(text);
    const r2 = unfenced ? tryParse(unfenced) : null;
    if (r2 && !("error" in r2)) return r2;
    return { findings: [], right: [], parse_error: `findings JSON invalid: ${r.error}` };
  }
  const unfenced = lastFindingsObject(text);
  if (unfenced) {
    const r = tryParse(unfenced);
    if (!("error" in r)) return r;
    return { findings: [], right: [], parse_error: `findings JSON invalid: ${r.error}` };
  }
  return { findings: [], right: [], parse_error: "no ```json findings block in the reply" };
}

// ─── evidence grounding ──────────────────────────────────────────────────

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Is the reviewer's quoted evidence really in the material? Whitespace-
 * insensitive substring; a quote shorter than 12 chars is too weak to count.
 */
export function evidenceInMaterial(
  evidence: string,
  files: ReviewFile[],
  diff?: string,
): "found" | "not_found" | "too_short" {
  const q = squash(evidence);
  if (q.length < 12) return "too_short";
  const hay = [diff ?? "", ...files.map((f) => f.content)].map(squash);
  // try the whole quote, then its longest line (reviewers often quote 2-3 lines with edits)
  if (hay.some((h) => h.includes(q))) return "found";
  const longest = evidence
    .split(/\r?\n/)
    .map(squash)
    .filter((l) => l.length >= 12)
    .sort((a, b) => b.length - a.length)[0];
  if (longest && hay.some((h) => h.includes(longest))) return "found";
  return "not_found";
}

// ─── merge ───────────────────────────────────────────────────────────────

export interface ReviewerFindings {
  model: string;
  provider: string;
  findings: Finding[];
}

export interface MergedClaim {
  model: string;
  claim: string;
  evidence: string;
  fix: string;
  confidence: number;
  evidence_status: "found" | "not_found" | "too_short";
}

export interface MergedFinding {
  key: string;
  title: string;
  severity: Severity;
  category: string;
  location: string;
  found_by: string[];
  agreement: number;
  absence_claim: boolean;
  claims: MergedClaim[];
}

const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "in",
  "on",
  "to",
  "is",
  "are",
  "and",
  "or",
  "for",
  "with",
  "by",
  "at",
  "as",
  "be",
  "can",
  "via",
  "from",
  "that",
  "this",
  "it",
  "its",
  "into",
  "not",
  "no",
]);

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9_./-]+/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

function locParts(loc: string): { file: string; line: number | null } {
  const m = loc.match(/([\w.\-/\\]+?)(?::(\d+))?(?:\s|$|\)|,)/);
  const file = (m?.[1] ?? loc).split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const line = m?.[2] ? Number(m[2]) : null;
  return { file, line };
}

export function sameFinding(a: Finding, b: Finding): boolean {
  const la = locParts(a.location);
  const lb = locParts(b.location);
  const titleSim = jaccard(tokens(`${a.title} ${a.claim}`), tokens(`${b.title} ${b.claim}`));
  const sameFile = la.file !== "" && la.file === lb.file;
  const nearLine = la.line !== null && lb.line !== null && Math.abs(la.line - lb.line) <= 10;
  if (a.category === b.category && sameFile && (nearLine || titleSim >= 0.25)) return true;
  return titleSim >= 0.5;
}

function sevRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function mergeFindings(
  replies: ReviewerFindings[],
  material: { files: ReviewFile[]; diff?: string },
): MergedFinding[] {
  const merged: Array<MergedFinding & { rep: Finding }> = [];
  for (const r of replies) {
    for (const f of r.findings) {
      const claim: MergedClaim = {
        model: r.model,
        claim: f.claim,
        evidence: f.evidence,
        fix: f.fix,
        confidence: f.confidence,
        evidence_status: evidenceInMaterial(f.evidence, material.files, material.diff),
      };
      const hit = merged.find((m) => sameFinding(m.rep, f));
      if (hit) {
        if (!hit.found_by.includes(r.model)) hit.found_by.push(r.model);
        hit.agreement = hit.found_by.length;
        if (sevRank(f.severity) < sevRank(hit.severity)) hit.severity = f.severity;
        hit.absence_claim = hit.absence_claim || f.absence_claim;
        hit.claims.push(claim);
        continue;
      }
      merged.push({
        key: `M${merged.length + 1}`,
        title: f.title,
        severity: f.severity,
        category: f.category,
        location: f.location,
        found_by: [r.model],
        agreement: 1,
        absence_claim: f.absence_claim,
        claims: [claim],
        rep: f,
      });
    }
  }
  merged.sort((a, b) => sevRank(a.severity) - sevRank(b.severity) || b.agreement - a.agreement);
  return merged.map(({ rep: _rep, ...m }, i) => ({ ...m, key: `M${i + 1}` }));
}

/** One-line status for the table. */
export function findingStatus(m: MergedFinding): string {
  const anyFound = m.claims.some((c) => c.evidence_status === "found");
  const allMissing = m.claims.every((c) => c.evidence_status === "not_found");
  if (m.absence_claim) return "ABSENCE CLAIM - unverifiable from a slice; check by hand";
  if (allMissing) return "quoted evidence NOT in material - treat as suspect";
  if (anyFound && m.agreement >= 2) return "evidence found; independent agreement";
  if (anyFound) return "evidence found; single reviewer";
  return "evidence too short to check";
}
