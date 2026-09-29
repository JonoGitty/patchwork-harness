/**
 * MUTATION PASS (ADR-0011 Phase 1 gate).
 *
 * A green exam proves nothing until you have watched it fail. Each frozen
 * rule is disabled via config injection (verifyWith — the only reason that
 * hook exists) and AT LEAST ONE corpus case must stop matching its expected
 * verdicts. A mutant surviving = the exam cannot see that rule = the rule
 * is decoration. Guards: the DEFAULT config must produce ZERO mismatches
 * (a red baseline invalidates every mutant), and every mutant must actually
 * differ from DEFAULTS (a no-op mutant measures nothing).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type Config, DEFAULTS, verifyWith } from "../src/verifier/grounding.js";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "fixtures", "verifier-corpus");
const cases = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(corpusDir, f), "utf-8")));

/** Mismatched case ids for a given verifier function. */
function mismatches(fn: ReturnType<typeof verifyWith>): string[] {
  const bad: string[] = [];
  for (const c of cases) {
    const got = fn(c.answer, c.evidence);
    let ok = got.overall === c.expected.overall;
    for (const want of c.expected.atoms) {
      const g = got.atoms.find((a: { value: string }) => a.value === want.value);
      if (!g || g.verdict !== want.verdict) ok = false;
    }
    if (!ok) bad.push(c.id);
  }
  return bad;
}

it("baseline: DEFAULT config matches the whole corpus (else no mutant means anything)", () => {
  expect(mismatches(verifyWith(DEFAULTS))).toEqual([]);
});

const MUTANTS: Array<[string, Partial<Config>, string]> = [
  ["disable content taint", { taint: false }, "poison-002/003 should catch"],
  ["disable subject restriction", { subjectRestriction: false }, "mis-001 should catch"],
  ["disable conflict lexicon", { conflictLexicon: false }, "pred-001 should catch"],
  ["substring matching (no boundary/sign)", { boundarySign: false }, "fmt-003 should catch"],
  ["any tool verifies a URL", { urlFetchClass: false }, "url-002 should catch"],
  ["disable derivation checking", { derivation: false }, "der-001 should catch"],
  ["remove the coverage floor", { coverageFloor: 0 }, "coverage-001/empty-001 should catch"],
  ["drop qualitative extraction", { qualitative: false }, "missed-001 should catch"],
];

describe("every frozen rule is load-bearing (mutant must be caught)", () => {
  for (const [name, patch, why] of MUTANTS) {
    it(`KILLS: ${name}`, () => {
      // guard: the mutant must actually change the config
      expect(JSON.stringify({ ...DEFAULTS, ...patch })).not.toBe(JSON.stringify(DEFAULTS));
      const caught = mismatches(verifyWith({ ...DEFAULTS, ...patch }));
      expect(caught.length, `mutant '${name}' SURVIVED the whole corpus (${why})`).toBeGreaterThan(
        0,
      );
    });
  }
});

it("the exam's own law-assertions catch a verifier that lies (UNGROUNDED -> green, no proof)", () => {
  const liar = (answer: string, evidence: Array<Record<string, unknown>>) => {
    const r = verifyWith(DEFAULTS)(answer, evidence);
    for (const a of r.atoms)
      if (a.verdict === "UNGROUNDED") {
        a.verdict = "VERIFIED";
        a.evidence = undefined;
      }
    return r;
  };
  // fab-001 through the liar: the law says every VERIFIED carries proof.
  const fab = cases.find((c) => c.id === "fab-001")!;
  const out = liar(fab.answer, fab.evidence);
  const uncovered = out.atoms.filter((a) => a.verdict === "VERIFIED" && !a.evidence);
  expect(uncovered.length, "a proofless green must be detectable").toBeGreaterThan(0);
});
