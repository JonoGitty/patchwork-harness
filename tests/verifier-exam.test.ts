/**
 * THE L4.5 GROUNDING-VERIFIER EXAM (ADR-0011, Phase 0).
 *
 * The exam exists BEFORE the implementation — red-first. Each corpus case
 * is a threat-model row made concrete; the constitutional case (fab-001)
 * is a real fabrication that reached a real report.
 *
 * THE LAW under test: never a false VERIFIED. Every atom lands in exactly
 * one of {VERIFIED+proof, UNGROUNDED, MISSED} and the counts reconcile.
 *
 * Modes:
 *   default                     — impl missing => each case SKIPPED with a
 *                                 loud NOT-RUN banner (shared repo stays
 *                                 green; a skipped exam is never a passed
 *                                 exam and says so)
 *   PATCHWORK_HARNESS_VERIFIER_EXAM=strict — impl missing => every case FAILS
 *                                 (the red-first proof, and CI's mode once
 *                                 Phase 1 starts)
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(here, "fixtures", "verifier-corpus");

type Atom = { value: string; kind: string; verdict: string; evidence?: string; note?: string };
type Counts = {
  atoms: number;
  verified: number;
  ungrounded: number;
  missed: number;
  coverage: number;
};
type Case = {
  id: string;
  title: string;
  answer: string;
  evidence: Array<Record<string, unknown>>;
  known_limitation?: boolean;
  expected: { atoms: Atom[]; overall: string; note?: string; counts?: Counts };
};

const cases: Case[] = readdirSync(corpusDir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(corpusDir, f), "utf-8")));

const VERDICTS = new Set(["VERIFIED", "UNGROUNDED", "MISSED"]);

// ---------------------------------------------------------------------------
// Corpus integrity — always runs. The exam paper itself must be well-formed:
// a corpus that violates the law cannot certify an implementation of it.
// ---------------------------------------------------------------------------
describe("verifier corpus integrity (the exam paper is well-formed)", () => {
  it("loads a non-trivial corpus", () => {
    expect(cases.length).toBeGreaterThanOrEqual(21);
  });

  for (const c of cases) {
    describe(`${c.id} — ${c.title}`, () => {
      it("every expected atom has a legal verdict", () => {
        for (const a of c.expected.atoms)
          expect(VERDICTS.has(a.verdict), `${c.id}:${a.value}`).toBe(true);
      });
      it("every VERIFIED carries its proof (the law applies to the exam too)", () => {
        for (const a of c.expected.atoms.filter((x) => x.verdict === "VERIFIED"))
          expect(a.evidence, `${c.id}: VERIFIED '${a.value}' without evidence`).toBeTruthy();
      });
      it("expected partition reconciles: atoms = green + not-green + missed", () => {
        const n = c.expected.atoms.length;
        const v = c.expected.atoms.filter((a) => a.verdict === "VERIFIED").length;
        const u = c.expected.atoms.filter((a) => a.verdict === "UNGROUNDED").length;
        const m = c.expected.atoms.filter((a) => a.verdict === "MISSED").length;
        expect(v + u + m).toBe(n);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// THE EXAM — drives the real implementation when it exists.
// ---------------------------------------------------------------------------
type VerifierFn = (
  answer: string,
  evidence: Array<Record<string, unknown>>,
) => {
  atoms: Atom[];
  verified: number;
  ungrounded: number;
  missed: number;
  coverage: number;
  overall: string;
};

let verify: VerifierFn | null = null;
try {
  const mod = await import("../src/verifier/grounding.js");
  verify = mod.verify as VerifierFn;
} catch {
  verify = null;
}

const strict = process.env.PATCHWORK_HARNESS_VERIFIER_EXAM === "strict";
if (!verify) {
  const msg = `\n${"=".repeat(72)}\n  L4.5 GROUNDING VERIFIER: NOT IMPLEMENTED — EXAM ${
    strict ? "FAILING (strict mode)" : `NOT RUN (${cases.length} cases waiting)`
  }\n  A skipped exam is not a passed exam. Implement src/verifier/grounding.ts\n${"=".repeat(72)}\n`;
  console.warn(msg);
}

describe("L4.5 grounding-verifier exam (ADR-0011)", () => {
  for (const c of cases) {
    const run = verify ? it : strict ? it : it.skip;
    run(`${c.id} — ${c.title}`, () => {
      if (!verify) {
        expect.fail("verifier not implemented — strict mode turns NOT-RUN into RED");
      }
      const got = verify(c.answer, c.evidence);

      // THE LAW, asserted on every single case regardless of scenario:
      // exhaustive partition + reconciliation + proof on every green.
      expect(got.verified + got.ungrounded + got.missed).toBe(got.atoms.length);
      for (const a of got.atoms) {
        expect(VERDICTS.has(a.verdict), `illegal verdict ${a.verdict}`).toBe(true);
        if (a.verdict === "VERIFIED")
          expect(a.evidence, `false-green risk: VERIFIED '${a.value}' with no proof`).toBeTruthy();
      }

      // Scenario expectations: exact verdict per expected atom.
      for (const want of c.expected.atoms) {
        const found = got.atoms.find((a) => a.value === want.value);
        expect(
          found,
          `atom '${want.value}' not extracted — it is in NO bucket, which the law forbids`,
        ).toBeTruthy();
        expect(found!.verdict, `${c.id}: '${want.value}' expected ${want.verdict}`).toBe(
          want.verdict,
        );
      }
      expect(got.overall).toBe(c.expected.overall);
      if (c.expected.counts) {
        expect(got.atoms.length).toBe(c.expected.counts.atoms);
        expect(got.verified).toBe(c.expected.counts.verified);
        expect(got.ungrounded).toBe(c.expected.counts.ungrounded);
        expect(got.missed).toBe(c.expected.counts.missed);
        expect(got.coverage).toBeCloseTo(c.expected.counts.coverage, 3);
      }
    });
  }
});
