/**
 * L4.5 Grounding Verifier — ADR-0011.
 *
 * THE LAW: never a false VERIFIED. Every atom lands in exactly one of
 * {VERIFIED+evidence, UNGROUNDED, MISSED}; counts reconcile; all doubt
 * resolves AWAY from green.
 *
 * Deterministic by construction: no model calls, no randomness, no clock.
 * Config is injectable ONLY so the mutation suite can break each frozen
 * rule and prove the exam notices (verifyWith); production uses DEFAULTS.
 */

export type Verdict = "VERIFIED" | "UNGROUNDED" | "MISSED";
export interface AtomResult {
  value: string;
  kind: string;
  verdict: Verdict;
  evidence?: string;
  note?: string;
}
export interface Report {
  atoms: AtomResult[];
  verified: number;
  ungrounded: number;
  missed: number;
  coverage: number;
  overall: "GREEN" | "GREEN_WITH_MISSED" | "NOT_GREEN" | "UNVERIFIABLE" | "INVALID";
}

export interface Config {
  taint: boolean; // content taint of model-authored text
  subjectRestriction: boolean; // mis-001
  conflictLexicon: boolean; // pred-001
  boundarySign: boolean; // fmt-003 (false => substring matching)
  urlFetchClass: boolean; // url-002
  derivation: boolean; // der-001/002/003
  coverageFloor: number; // 0.25, frozen
  qualitative: boolean; // missed-001 extraction
}
export const DEFAULTS: Config = Object.freeze({
  taint: true,
  subjectRestriction: true,
  conflictLexicon: true,
  boundarySign: true,
  urlFetchClass: true,
  derivation: true,
  coverageFloor: 0.25,
  qualitative: true,
});

const FETCH_TOOLS = new Set(["web", "api", "fetch", "http", "browser"]);
const CONFLICTS: Array<[string, string]> = [
  ["passed", "failed"],
  ["pass", "fail"],
  ["succeeded", "failed"],
  ["success", "failure"],
  ["created", "deleted"],
  ["enabled", "disabled"],
  ["up", "down"],
  ["true", "false"],
];
const QUAL_WORDS = new Set([
  "smooth",
  "smoothly",
  "great",
  "good",
  "high",
  "comprehensive",
  "robust",
  "safe",
  "elegant",
  "low-risk",
  "scalable",
  "ready",
  "fine",
  "healthy",
  "excellent",
  "solid",
  "well",
]);
const SUBJECT_STOP = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "per",
  "see",
  "all",
  "everything",
  "total",
  "as",
  "we",
  "there",
  "it",
  "our",
  "a",
  "an",
]);
const MONTHS: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

export interface Line {
  eventId: string;
  tool: string;
  text: string;
  tainted: boolean;
}

export function indexEvidence(evidence: Array<Record<string, unknown>>, cfg: Config): Line[] {
  // ORDER-AWARE TAINT (v1.2, corpus taint-001 — forge-a field fixture):
  // a tool_result line is tainted only by model-authored inputs that
  // occur BEFORE it in the event sequence. Write-then-read laundering
  // (poison-002/003) stays MISSED; a figure genuinely READ FIRST and
  // only later quoted into a doc stays citable — you cannot launder
  // into the past.
  const lines: Line[] = [];
  const authoredSoFar: string[] = [];
  for (const e of evidence) {
    if (e.type === "tool_call" && typeof e.input === "string") {
      authoredSoFar.push(e.input);
      continue;
    }
    if (e.type !== "tool_result") continue;
    const out = String(e.output ?? "");
    for (const rawText of out.split(/\r?\n/)) {
      // v1.3 (corpus ansi-001): strip ANSI colour codes at index time —
      // "\x1b[32m115" butts the escape's letter against digits and
      // defeats number extraction in vitest/chalk/git output.
      const text = rawText.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
      if (!text.trim()) continue;
      const tainted = cfg.taint && authoredSoFar.some((m) => m.includes(text.trim()));
      lines.push({ eventId: String(e.event_id), tool: String(e.tool ?? ""), text, tainted });
    }
  }
  return lines;
}

// ---------------------------------------------------------------- extraction
interface Span {
  start: number;
  end: number;
  value: string;
  kind: string;
  sentence: string;
}

const RE_URL = /https?:\/\/[^\s)"'\]]+/g;
const RE_ISO = /\b\d{4}-\d{2}-\d{2}\b/g;
const RE_DMY = /\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+(\d{4})\b/g;
const RE_PATH = /(?<![\w/])(?:[\w.-]+\/)+[\w.-]+\.\w+/g;
const RE_QUOTED = /"([^"\n]{2,})"/g;
const RE_ID = /\b(?=[a-z0-9]*\d)(?=\d*[a-z])[a-z][a-z0-9]{3,}\b/g;
const RE_NUM = /(?<![\w.\-])[-−]?[£$€]?\d[\d,]*(?:\.\d+)?(?!\d)/g; // (?!\d) only: '100.', '3.1x', '42ms' are numbers followed by prose;
// digits inside identifiers stay blocked by the lookbehind (abc16)

function sentencesOf(answer: string): Array<{ text: string; start: number }> {
  // '.' before a digit is a decimal point (0.0050), never a sentence end
  const re = /(?:[^.!?]|\.(?=\d))+[.!?]?/g;
  const out: Array<{ text: string; start: number }> = [];
  for (const m of answer.matchAll(re)) if (m[0].trim()) out.push({ text: m[0], start: m.index });
  return out;
}

function extract(answer: string, cfg: Config): Span[] {
  const spans: Span[] = [];
  const taken: Array<[number, number]> = [];
  const sents = sentencesOf(answer);
  const sentenceAt = (i: number) =>
    sents.find((s) => i >= s.start && i < s.start + s.text.length)?.text ?? answer;
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x);
  const claim = (m: RegExpMatchArray, value: string, kind: string) => {
    const a = m.index ?? 0;
    const b = a + m[0].length;
    if (!free(a, b)) return;
    taken.push([a, b]);
    spans.push({ start: a, end: b, value, kind, sentence: sentenceAt(a) });
  };
  for (const m of answer.matchAll(RE_URL)) claim(m, m[0].replace(/[.,;]+$/, ""), "url");
  for (const m of answer.matchAll(RE_ISO)) claim(m, m[0], "date");
  for (const m of answer.matchAll(RE_DMY)) claim(m, m[0], "date");
  for (const m of answer.matchAll(RE_PATH)) claim(m, m[0], "path");
  for (const m of answer.matchAll(RE_QUOTED)) if (m[1]) claim(m, m[1], "quoted_string");
  for (const m of answer.matchAll(RE_ID)) claim(m, m[0], "id");
  for (const m of answer.matchAll(RE_NUM)) claim(m, m[0], "number");
  if (cfg.qualitative) {
    for (const s of sents) {
      const clauses = s.text.split(/,\s*(?:and\s+)?|\s+and\s+/);
      const headQual = /\b(is|are|was|were|went|looks?|feels?)\b/i.test(clauses[0] ?? "");
      for (let ci = 0; ci < clauses.length; ci++) {
        const raw = (clauses[ci] ?? "")
          .replace(/^and\s+/i, "")
          .replace(/[.!?]\s*$/, "")
          .trim();
        if (!raw) continue;
        const abs = answer.indexOf(raw, s.start);
        if (abs >= 0 && !free(abs, abs + raw.length)) continue; // has a checkable atom inside
        const words = raw.toLowerCase().split(/\s+/);
        const hasQualWord = words.some((w) => QUAL_WORDS.has(w.replace(/[^\w-]/g, "")));
        if (!hasQualWord) continue;
        const isClause = /\b(is|are|was|were|went|looks?|feels?)\b/i.test(raw);
        const isBareAdjInList = ci > 0 && headQual && words.length <= 2;
        if (isClause || isBareAdjInList)
          spans.push({
            start: abs,
            end: abs + raw.length,
            value: raw,
            kind: "qualitative",
            sentence: s.text,
          });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

// ---------------------------------------------------------------- matching
function canonNum(v: string): number | null {
  const s = v.replace(/[£$€,]/g, "").replace("−", "-");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function numbersIn(text: string): number[] {
  const out: number[] = [];
  // consume dates first so 2026-08-31 doesn't yield 2026, 08, 31
  const scrub = text.replace(RE_ISO, " ").replace(RE_DMY, " ");
  for (const m of scrub.matchAll(RE_NUM)) {
    const n = canonNum(m[0]);
    if (n !== null) out.push(n);
  }
  return out;
}
function datesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(RE_ISO)) out.push(m[0]);
  for (const m of text.matchAll(RE_DMY)) {
    const [, d, mon, y] = m;
    if (d && mon && y)
      out.push(`${y}-${MONTHS[mon.toLowerCase().slice(0, 3)]}-${d.padStart(2, "0")}`);
  }
  return out;
}
function canonDate(v: string): string {
  const d = datesIn(v);
  return d[0] ?? v;
}
function subjectTokens(sentence: string): string[] {
  const toks = sentence.match(/\b[A-Z][A-Za-z]{2,}\b/g) ?? [];
  // SENTENCE-INITIAL EXEMPTION (v1.1, corpus subj-001): the first word of
  // a sentence is capitalised by grammar, not by being a subject. Three
  // live false positives on 1 Sep 2026 ("Done,", "Since") restricted
  // matching to lines that excluded genuinely present evidence. Real
  // subjects mid-sentence (mis-001's "Alpha") still restrict.
  const first = /^\W*([A-Z][A-Za-z]{2,})\b/.exec(sentence)?.[1];
  return toks.filter(
    (t) => !SUBJECT_STOP.has(t.toLowerCase()) && t !== first,
  );
}
function lineSupports(line: Line, span: Span, cfg: Config): boolean {
  if (span.kind === "number") {
    const want = canonNum(span.value);
    if (want === null) return false;
    if (!cfg.boundarySign) return line.text.includes(span.value.replace(/^[£$€]/, ""));
    return numbersIn(line.text).some((n) => Object.is(n, want) || n === want);
  }
  if (span.kind === "date") return datesIn(line.text).includes(canonDate(span.value));
  if (span.kind === "url")
    return line.text.includes(span.value) && (!cfg.urlFetchClass || FETCH_TOOLS.has(line.tool));
  // path / id / quoted_string: case-insensitive token presence
  return line.text.toLowerCase().includes(span.value.toLowerCase());
}
function conflicted(line: Line, sentence: string, cfg: Config): boolean {
  if (!cfg.conflictLexicon) return false;
  const lt = ` ${line.text.toLowerCase()} `;
  const st = ` ${sentence.toLowerCase()} `;
  return CONFLICTS.some(
    ([a, b]) =>
      (lt.includes(` ${a} `) && st.includes(` ${b}`)) ||
      (lt.includes(` ${b} `) && st.includes(` ${a}`)),
  );
}

function tryDerivation(span: Span, spans: Span[], lines: Line[], cfg: Config): AtomResult | null {
  if (!cfg.derivation || span.kind !== "number") return null;
  const after = span.sentence.slice(span.sentence.indexOf(span.value) + span.value.length);
  const par = after.match(/\(([^)]+)\)/);
  if (!par?.[1]) return null;
  const expr = par[1].trim();
  const em = expr.match(/^([£$€]?[\d.,]+)\s*([+\-−×*/])\s*([£$€]?[\d.,]+)$/);
  if (!em?.[1] || !em[2] || !em[3]) return null;
  const a = canonNum(em[1]);
  const b = canonNum(em[3]);
  const want = canonNum(span.value);
  if (a === null || b === null || want === null) return null;
  const op = em[2];
  const got =
    op === "+"
      ? a + b
      : op === "-" || op === "−"
        ? a - b
        : op === "×" || op === "*"
          ? a * b
          : a / b;
  if (Math.abs(got - want) < 1e-9)
    return {
      value: span.value,
      kind: span.kind,
      verdict: "VERIFIED",
      evidence: `derivation:${expr}`,
    };
  return {
    value: span.value,
    kind: span.kind,
    verdict: "UNGROUNDED",
    note: "derivation shown but does not recompute to the asserted value",
  };
}

// ---------------------------------------------------------------- verify
export function verifyWith(cfg: Config) {
  return function verify(answer: string, evidence: Array<Record<string, unknown>>): Report {
    const lines = indexEvidence(evidence, cfg);
    const spans = extract(answer, cfg);
    const atoms: AtomResult[] = [];

    for (const span of spans) {
      if (span.kind === "qualitative") {
        atoms.push({
          value: span.value,
          kind: span.kind,
          verdict: "MISSED",
          note: "no deterministic check exists for qualitative claims",
        });
        continue;
      }
      const der = tryDerivation(span, spans, lines, cfg);
      if (der) {
        atoms.push(der);
        continue;
      }

      // subject restriction: most specific line-set containing subject
      // tokens — NUMBER atoms only (v1.2, corpus subj-002): a sentence
      // listing filenames (CLAUDE/README/ROADMAP) hijacked a quoted
      // phrase's matching away from its genuine evidence. Wrong-subject
      // risk is about figures (mis-001); phrases carry their own words.
      let candidates = lines;
      if (cfg.subjectRestriction && span.kind === "number") {
        let best: Line[] | null = null;
        for (const tok of subjectTokens(span.sentence)) {
          const set = lines.filter((l) => l.text.toLowerCase().includes(tok.toLowerCase()));
          if (set.length > 0 && (best === null || set.length < best.length)) best = set;
        }
        // v1.4 (corpus subj-003, field FP #4): a subject line-set may only
        // RESTRICT when it contains a COMPETING same-kind figure — the
        // mis-001 shape is "Alpha's line says 12.50, not 527.22". A prose
        // line that merely mentions the token and holds no numbers is a
        // mention, not a rival subject table; falling back to global
        // matching there cannot create a false green because membership
        // still has to find the atom somewhere real.
        if (best) {
          const want = canonNum(span.value);
          const hasCompetitor = best.some((l) =>
            numbersIn(l.text).some((n) => want === null || n !== want),
          );
          if (hasCompetitor) candidates = best;
        }
      }
      const clean = candidates.filter(
        (l) => !l.tainted && lineSupports(l, span, cfg) && !conflicted(l, span.sentence, cfg),
      );
      if (clean.length > 0) {
        atoms.push({
          value: span.value,
          kind: span.kind,
          verdict: "VERIFIED",
          evidence: clean[0]?.eventId,
        });
        continue;
      }
      const taintedOnly = lines.filter((l) => l.tainted && lineSupports(l, span, cfg));
      if (taintedOnly.length > 0) {
        atoms.push({
          value: span.value,
          kind: span.kind,
          verdict: "MISSED",
          note: "supported only by content-tainted evidence (model-authored this session)",
        });
        continue;
      }
      atoms.push({ value: span.value, kind: span.kind, verdict: "UNGROUNDED" });
    }

    const verified = atoms.filter((a) => a.verdict === "VERIFIED").length;
    const ungrounded = atoms.filter((a) => a.verdict === "UNGROUNDED").length;
    const missed = atoms.filter((a) => a.verdict === "MISSED").length;
    // THE LAW: partition must reconcile or the verifier itself is INVALID.
    const overallInvalid = verified + ungrounded + missed !== atoms.length;
    const checkable = verified + ungrounded;
    const coverage = atoms.length === 0 ? 0 : checkable / atoms.length;
    let overall: Report["overall"];
    if (overallInvalid) overall = "INVALID";
    else if (coverage < cfg.coverageFloor) overall = "UNVERIFIABLE";
    else if (ungrounded > 0) overall = "NOT_GREEN";
    else if (missed > 0) overall = "GREEN_WITH_MISSED";
    else if (verified > 0) overall = "GREEN";
    else overall = "UNVERIFIABLE";
    return { atoms, verified, ungrounded, missed, coverage, overall };
  };
}

export const verify = verifyWith(DEFAULTS);
