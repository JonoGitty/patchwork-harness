/**
 * The adversarial-review prompt. Shape taken from the 3 Sept 2026 review
 * that Sol / Opus 5 / Fable answered well (patchwork-security REVIEWS):
 * numbered sections, cite-or-say-you-can't, no padding, a "what is RIGHT"
 * list and "fix first + strongest argument against". Two additions that
 * make the output mergeable and checkable:
 *   - a fenced JSON findings block at the end (deterministic merge/dedupe)
 *   - every ABSENCE claim ("X is missing") must say where the reviewer
 *     looked, and is tagged so the L4.5 verifier can flag it as unverifiable
 *     rather than trusted (on 2 Sept a reviewer reported existing code as
 *     missing because its reads were truncated).
 */
import type { Collected } from "./collect.js";

export const REVIEW_SYSTEM = `You are performing an AUTHORISED security review for the code's own author, on their own machine and their own repositories. Be adversarial and concrete. Do not flatter. If something is fine, say it is fine in one line and move on - do not pad. Cite the actual file, function or line you mean. Do not invent code that is not shown. If you cannot tell from what is shown, say so rather than guessing.`;

export const FINDINGS_SCHEMA = `{
  "findings": [
    {
      "id": "F1",
      "title": "short noun phrase",
      "severity": "critical | high | medium | low | info",
      "category": "threat_model | authorisation | injection | race_toctou | input_coercion | dos | other",
      "location": "path:line or path:function",
      "claim": "one or two sentences",
      "evidence": "the EXACT code fragment (verbatim, copied from the material) the claim rests on",
      "fix": "the smallest correct fix",
      "confidence": 0.0,
      "absence_claim": false
    }
  ],
  "right": ["one line per thing worth keeping"],
  "fix_first": { "id": "F1", "why": "…", "against": "the strongest argument AGAINST your own recommendation" }
}`;

export function renderMaterial(c: Collected): string {
  const parts: string[] = [];
  if (c.diff) {
    parts.push(
      `==================== DIFF${c.diffTruncated ? " (TRUNCATED)" : ""} ====================\n${c.diff}`,
    );
  }
  for (const f of c.files) {
    const head = `==================== FILE: ${f.path} (${f.lines} lines${f.truncated ? `, TRUNCATED at ${f.content.length} chars - the rest is NOT shown` : ""}) ====================`;
    parts.push(`${head}\n${f.content}`);
  }
  if (c.skipped.length) {
    parts.push(
      `==================== NOT SHOWN ====================\n${c.skipped.map((s) => `${s.path} - ${s.reason}`).join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

export function buildReviewPrompt(
  context: string,
  c: Collected,
  opts: { maxWords?: number } = {},
): { system: string; user: string } {
  const maxWords = opts.maxWords ?? 1200;
  const user = `CONTEXT
${context.trim() || "(none given - infer the threat model from the code itself and say what you inferred)"}

WHAT I WANT, in this order. Number the sections exactly like this.
1. THREAT MODEL - who can reach this code, over what channel, with what privileges, and what they would want. State any assumption you had to make.
2. AUTHORISATION - who may do what; where identity/authority is actually checked; where it is assumed. Same predicate gating reads and writes counts double.
3. INJECTION - SQL, shell/argv, path, template, prompt (LLM) and log injection. Cite the sink and the untrusted source that reaches it.
4. RACE / TOCTOU - check-then-act windows, non-atomic compare-and-swap, replay of tokens, symlink swaps, concurrent writers.
5. INPUT COERCION - what the parser accepts that the validator did not mean: NaN/inf/1e400, empty, oversize, unicode, thousands separators, type juggling, case folding.
6. DENIAL OF SERVICE - unbounded growth, missing timeouts, quadratic paths, token/cache accumulation, a small input that causes a large effect.
7. WHAT IT GETS RIGHT - one line each, only things genuinely worth keeping.
8. FIX FIRST - the single most important fix, why it outranks the others, and the STRONGEST argument against your own recommendation.

Rules:
- Cite the actual function or line. Quote the code. Do not invent code that is not shown.
- If you cannot tell from what is shown, say "cannot tell from what is shown" - that is a valid answer.
- ABSENCE CLAIMS ("there is no X", "Y is never validated", "Z is missing"): say exactly where you looked (file and what you searched for). Material marked TRUNCATED or NOT SHOWN cannot support an absence claim - say "not visible in the material" instead.
- OUTPUT ORDER: put the fenced \`\`\`json block FIRST, then the eight prose sections (maximum ${maxWords} words). Thinking is billed inside the output budget, and on 7 Sept 2026 two of three reviewers ran out of tokens before their JSON - findings first means a cut reply loses prose, not the machine-readable part.
- The JSON block must match this schema exactly (it is parsed by a program; every finding's "evidence" must be a verbatim fragment of the material, and "absence_claim" must be true for any claim that something is absent/missing/never done):
${FINDINGS_SCHEMA}

${renderMaterial(c)}`;
  return { system: REVIEW_SYSTEM, user };
}
