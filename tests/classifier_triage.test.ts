/**
 * ADR-0013: a classifier may ORDER the review queue. It may never make
 * anything green. The load-bearing test is the first "law" block: a
 * classifier that says p=1.0 to everything, run over the whole L4.5
 * corpus, must leave every report and every exit code exactly as it was.
 */
import { readFileSync, readdirSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ClassifierConfig,
  ClassifierError,
  askSystemOne,
  classifierConfig,
} from "../src/classifier/systemone.js";
import { PROJECT_ROOT } from "../src/util/paths.js";
import { verify } from "../src/verifier/grounding.js";
import { renderTriage, reportExitCode } from "../src/verifier/render.js";
import { BANDS, STATE_CHARS, bandOf, triage } from "../src/verifier/triage.js";

const CORPUS = join(PROJECT_ROOT, "tests", "fixtures", "verifier-corpus");
const corpus = (id: string) =>
  JSON.parse(readFileSync(join(CORPUS, `${id}.json`), "utf8")) as {
    answer: string;
    evidence: Array<Record<string, unknown>>;
  };
const KEV: ClassifierConfig = { backend: "kev", url: "http://kev.test", model: "kev-latest" };

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: {
    state: { tool_outputs: string[] };
    model: string;
    questions: Record<string, { instructions: string }>;
  };
}
/** A fake System One server: answers every noul with p, records what it was sent. */
function fakeServer(p: number, statuses: number[] = []) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    sent.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    const status = statuses.shift() ?? 200;
    if (status !== 200) return new Response("nope", { status });
    const answers = Object.fromEntries(
      Object.keys(body.questions).map((id) => [id, { type: "noul", noul: p }]),
    );
    return Response.json({ model: body.model, answers, latency_ms: 7 });
  }) as typeof fetch;
  return { sent, fetchImpl };
}

describe("classifierConfig", () => {
  it("is null when nothing is configured", () => {
    expect(classifierConfig({})).toBeNull();
  });
  it("TYPESAFE_API_KEY selects hosted Jev", () => {
    expect(classifierConfig({ TYPESAFE_API_KEY: "ts-1" })).toEqual({
      backend: "jev",
      url: "https://api.typesafe.ai",
      model: "jev-latest",
      apiKey: "ts-1",
    });
  });
  it("PATCHWORK_HARNESS_CLASSIFIER_URL wins and is normalised", () => {
    const c = classifierConfig({
      TYPESAFE_API_KEY: "ts-1",
      PATCHWORK_HARNESS_CLASSIFIER_URL: "http://127.0.0.1:8009/v1/systemone/",
    });
    expect(c).toEqual({
      backend: "kev",
      url: "http://127.0.0.1:8009",
      model: "kev-latest",
      apiKey: undefined,
    });
  });
});

describe("askSystemOne", () => {
  const q = { ok: { type: "noul" as const, instructions: "?" } };

  it("posts state, model and questions to /v1/systemone with the bearer", async () => {
    const s = fakeServer(0.4);
    await askSystemOne({ ...KEV, apiKey: "k" }, "st", q, { fetchImpl: s.fetchImpl });
    expect(s.sent[0]?.url).toBe("http://kev.test/v1/systemone");
    expect(s.sent[0]?.headers.authorization).toBe("Bearer k");
    expect(s.sent[0]?.body).toMatchObject({ state: "st", model: "kev-latest", questions: q });
  });
  it("backs off and retries on 429/529", async () => {
    const s = fakeServer(0.4, [429, 529]);
    const r = await askSystemOne(KEV, "st", q, { fetchImpl: s.fetchImpl, backoffMs: 1 });
    expect(s.sent).toHaveLength(3);
    expect(r.answers.ok).toEqual({ type: "noul", noul: 0.4 });
  });
  it("does not retry a 401", async () => {
    const s = fakeServer(0.4, [401]);
    await expect(askSystemOne(KEV, "st", q, { fetchImpl: s.fetchImpl })).rejects.toMatchObject({
      status: 401,
    });
    expect(s.sent).toHaveLength(1);
  });
  it("rejects a reply that is not a probability", async () => {
    const s = fakeServer(1.5);
    await expect(askSystemOne(KEV, "st", q, { fetchImpl: s.fetchImpl })).rejects.toBeInstanceOf(
      ClassifierError,
    );
  });
  it("rejects a reply that leaves a question unanswered", async () => {
    const fetchImpl = (async () => Response.json({ model: "m", answers: {} })) as typeof fetch;
    await expect(askSystemOne(KEV, "st", q, { fetchImpl })).rejects.toThrow(/unanswered/);
  });
});

describe("triage — the law: never a false VERIFIED", () => {
  const ids = readdirSync(CORPUS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  it.each(ids)(
    "%s: a classifier saying p=1.0 changes no verdict, count or exit code",
    async (id) => {
      const doc = corpus(id);
      const report = verify(doc.answer, doc.evidence);
      const before = structuredClone(report);
      const s = fakeServer(1.0);
      const t = await triage(doc.answer, doc.evidence, report, KEV, { fetchImpl: s.fetchImpl });
      expect(report).toEqual(before);
      expect(reportExitCode(report)).toBe(reportExitCode(before));
      expect(t.items).toHaveLength(report.missed); // only MISSED atoms, all of them
      expect(renderTriage(t, { color: false })).not.toMatch(/VERIFIED|GREEN/);
    },
  );

  it("sends only the MISSED atom, not the verified number (missed-001)", async () => {
    const doc = corpus("missed-001");
    const report = verify(doc.answer, doc.evidence);
    const s = fakeServer(0.9);
    const t = await triage(doc.answer, doc.evidence, report, KEV, { fetchImpl: s.fetchImpl });
    const qs = Object.values(s.sent[0]?.body.questions ?? {});
    expect(qs).toHaveLength(1);
    expect(qs[0]?.instructions).toContain('Claim: "the test suite is comprehensive"');
    expect(s.sent[0]?.body.state.tool_outputs).toEqual(["[ev_01 bash] 42 tests passed"]);
    expect(t.items).toEqual([
      {
        value: "the test suite is comprehensive",
        kind: "qualitative",
        p_supported: 0.9,
        band: "likely_supported",
      },
    ]);
  });

  it("never shows the classifier model-authored text as support (poison-002)", async () => {
    const doc = corpus("poison-002");
    const report = verify(doc.answer, doc.evidence);
    const s = fakeServer(1.0);
    await triage(doc.answer, doc.evidence, report, KEV, { fetchImpl: s.fetchImpl });
    expect(s.sent[0]?.body.state.tool_outputs.join("\n")).not.toContain("limit=250");
  });

  it("makes no call when nothing is MISSED (fab-001)", async () => {
    const doc = corpus("fab-001");
    const report = verify(doc.answer, doc.evidence);
    const s = fakeServer(1.0);
    const t = await triage(doc.answer, doc.evidence, report, KEV, { fetchImpl: s.fetchImpl });
    expect(s.sent).toHaveLength(0);
    expect(t.items).toEqual([]);
  });

  it("a dead classifier leaves the report alone and says so", async () => {
    const doc = corpus("missed-001");
    const report = verify(doc.answer, doc.evidence);
    const before = structuredClone(report);
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const t = await triage(doc.answer, doc.evidence, report, KEV, { fetchImpl });
    expect(report).toEqual(before);
    expect(t.items).toEqual([]);
    expect(t.error).toMatch(/unreachable/);
    expect(renderTriage(t, { color: false })).toContain("MISSED atoms stay untriaged");
  });

  it("asks about the sentence the number is really in (calibration-judge regression)", async () => {
    // 28 Sep 2026: indexOf put "1.2" (from "1.2 ms") inside "1.25 GHz"
    // and the classifier was asked about the clock sentence instead.
    const answer = "The clock runs at 1.25 GHz. Latency fell to 1.2 ms.";
    const evidence = [
      { event_id: "ev_01", type: "tool_call", tool: "write", input: "latency 1.2 ms" },
      { event_id: "ev_02", type: "tool_result", tool: "read", output: "latency 1.2 ms" },
      { event_id: "ev_03", type: "tool_result", tool: "bash", output: "clock 1.25 GHz" },
    ];
    const report = verify(answer, evidence);
    expect(report.atoms.map((a) => [a.value, a.verdict])).toEqual([
      ["1.25", "VERIFIED"],
      ["1.2", "MISSED"],
    ]);
    const s = fakeServer(0.5);
    await triage(answer, evidence, report, KEV, { fetchImpl: s.fetchImpl });
    const qs = Object.values(s.sent[0]?.body.questions ?? {});
    expect(qs).toHaveLength(1);
    expect(qs[0]?.instructions).toContain('(from: "Latency fell to 1.2 ms.")');
  });

  it("sends evidence that shares no word with the claim (live Kev regression)", async () => {
    // 28 Sep 2026: overlap-only selection sent "(no tool output…)" for BOTH a
    // 96%-coverage and an 11%-coverage suite, so Kev answered 0.34 to each.
    const answer = "The test suite is comprehensive.";
    const evidence = [
      {
        event_id: "ev_01",
        type: "tool_result",
        tool: "bash",
        output: "coverage: 11% statements\n57 modules have no specs",
      },
    ];
    const report = verify(answer, evidence);
    const s = fakeServer(0.5);
    await triage(answer, evidence, report, KEV, { fetchImpl: s.fetchImpl });
    expect(s.sent[0]?.body.state.tool_outputs).toEqual([
      "[ev_01 bash] coverage: 11% statements",
      "[ev_01 bash] 57 modules have no specs",
    ]);
  });

  it("caps the state (Kev trained on short states)", async () => {
    expect(STATE_CHARS.kev).toBeLessThan(STATE_CHARS.jev);
    const big = Array.from({ length: 400 }, (_, i) => `suite line ${i} comprehensive coverage`);
    const evidence = [
      { event_id: "ev_01", type: "tool_result", tool: "bash", output: big.join("\n") },
    ];
    const answer = "The test suite is comprehensive.";
    const report = verify(answer, evidence);
    const s = fakeServer(0.5);
    await triage(answer, evidence, report, KEV, { fetchImpl: s.fetchImpl, stateChars: 60 });
    const outs = s.sent[0]?.body.state.tool_outputs ?? [];
    expect(outs).toHaveLength(1);
    expect(outs.join("").length).toBeLessThanOrEqual(60);
  });
});

describe("bands", () => {
  it("are frozen at 0.7 / 0.3", () => {
    expect(BANDS).toEqual({ supported: 0.7, unsupported: 0.3 });
    expect(Object.isFrozen(BANDS)).toBe(true);
  });
  it("split at the edges, doubt in the middle", () => {
    expect(bandOf(0.7)).toBe("likely_supported");
    expect(bandOf(0.69)).toBe("uncertain");
    expect(bandOf(0.31)).toBe("uncertain");
    expect(bandOf(0.3)).toBe("likely_unsupported");
  });
});

describe("patchwork-harness verify --classify (CLI)", () => {
  const tsx = join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const cli = join(PROJECT_ROOT, "src", "cli.ts");
  let server: Server;
  let url = "";

  beforeAll(async () => {
    // a real HTTP System One stand-in that is certain every claim is true
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => {
        const body = JSON.parse(raw);
        const answers = Object.fromEntries(
          Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 1 }]),
        );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ model: "stub", answers }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  const run = (id: string, env: Record<string, string>) =>
    execa(
      process.execPath,
      [tsx, cli, "verify", "file", join(CORPUS, `${id}.json`), "--classify"],
      {
        reject: false,
        timeout: 120_000,
        env,
      },
    );

  it("fab-001 still exits 1 with a certain classifier attached", async () => {
    const r = await run("fab-001", { PATCHWORK_HARNESS_CLASSIFIER_URL: url });
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("NOT_GREEN");
  }, 150_000);

  it("missed-001 prints the triage under the report, exit unchanged", async () => {
    const r = await run("missed-001", { PATCHWORK_HARNESS_CLASSIFIER_URL: url });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("GREEN_WITH_MISSED");
    expect(r.stdout).toMatch(/classifier triage · kev stub[\s\S]*1\.00 likely supported/);
    expect(r.stdout).toContain("routes, not verdicts");
  }, 150_000);

  it("an unreachable classifier only warns (exit unchanged)", async () => {
    const r = await run("missed-001", { PATCHWORK_HARNESS_CLASSIFIER_URL: "http://127.0.0.1:9" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("MISSED atoms stay untriaged");
  }, 150_000);
});
