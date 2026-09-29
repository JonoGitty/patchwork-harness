import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadModels, roleList } from "../src/config.js";
import { collectPaths } from "../src/review/collect.js";
import {
  evidenceInMaterial,
  fencedBlocks,
  findingStatus,
  looksLikeAbsenceClaim,
  mergeFindings,
  parseReply,
  sameFinding,
  stripFindingsJson,
} from "../src/review/merge.js";
import { buildReviewPrompt } from "../src/review/prompt.js";
import { evidenceFromMaterial } from "../src/review/run.js";
import { verify } from "../src/verifier/grounding.js";

const FILE = {
  path: "ads/finding_actions.py",
  content:
    "def preview(body):\n    cap_value = float(str(body.get('cap_value') or '').replace(',', '').strip())\n    if cap_value is None or cap_value <= 0:\n        return {'ok': False}, 400\n",
  bytes: 1,
  lines: 4,
  truncated: false,
};

const reply = (findings: unknown[], extra = "") =>
  `## 1. THREAT MODEL\nprose${extra}\n\n\`\`\`json\n${JSON.stringify({ findings, right: ["parameterised SQL"], fix_first: { id: "F1", why: "w", against: "a" } })}\n\`\`\`\n`;

describe("review: parsing replies", () => {
  it("extracts the fenced findings block, fills ids and tags absence claims", () => {
    const p = parseReply(
      reply([
        {
          title: "NaN cap accepted",
          severity: "HIGH",
          category: "input_coercion",
          location: "ads/finding_actions.py:3",
          claim: "float('nan') passes <= 0",
          evidence: "if cap_value is None or cap_value <= 0:",
          fix: "isfinite",
          confidence: 0.9,
        },
        {
          title: "No authentication",
          severity: "medium",
          category: "authorisation",
          location: "chat_server.py",
          claim: "there is no per-user auth",
          evidence: "",
          fix: "",
          confidence: 0.6,
        },
      ]),
    );
    expect(p.parse_error).toBeUndefined();
    expect(p.findings[0]!.id).toBe("F1");
    expect(p.findings[0]!.severity).toBe("high");
    expect(p.findings[0]!.absence_claim).toBe(false);
    expect(p.findings[1]!.absence_claim).toBe(true);
    expect(p.right).toEqual(["parameterised SQL"]);
    expect(p.fix_first?.against).toBe("a");
  });

  it("finds the findings block after earlier python fences and strips it for the verifier (7 Sept regression)", () => {
    const text = [
      "## 2. AUTHORISATION",
      "",
      "```python",
      "if origin == \"null\":",
      "    return True",
      "```",
      "",
      "More prose with `_TOKENS.pop`.",
      "",
      "```python",
      "x = 1",
      "```",
      "",
      "```json",
      JSON.stringify({ findings: [{ title: "Opaque-origin trust", severity: "high", category: "authorisation", location: "chat_server.py:_origin_allowed", claim: "null origin accepted", evidence: "if origin == \"null\":", fix: "reject", confidence: 0.9, absence_claim: false }], right: ["parameterised SQL"], fix_first: { id: "F1", why: "w", against: "a" } }, null, 2),
      "```",
      "",
    ].join("\n");
    const p = parseReply(text);
    expect(p.parse_error).toBeUndefined();
    expect(p.findings).toHaveLength(1);
    expect(p.findings[0]!.title).toBe("Opaque-origin trust");
    const stripped = stripFindingsJson(text);
    expect(stripped).not.toContain("\"findings\"");
    expect(stripped).toContain("More prose with");
    expect(stripped).toContain("x = 1"); // non-findings fences stay
    expect(fencedBlocks(text).map((f) => f.lang)).toEqual(["python", "python", "json"]);
  });

  it("parses an unfenced trailing findings object (a reply cut before the closing fence)", () => {
    const text = "prose\n```json\n" + JSON.stringify({ findings: [{ title: "T", severity: "low" }], right: [] });
    const p = parseReply(text);
    expect(p.parse_error).toBeUndefined();
    expect(p.findings[0]!.title).toBe("T");
  });

  it("reports a missing or invalid block instead of inventing findings", () => {
    expect(parseReply("just prose").parse_error).toMatch(/no ```json findings block/);
    expect(parseReply('```json\n{"findings": [ broken\n```').parse_error).toMatch(/invalid/);
  });

  it("recognises absence wording", () => {
    expect(looksLikeAbsenceClaim("set_by is never populated")).toBe(true);
    expect(looksLikeAbsenceClaim("the token dict is unbounded")).toBe(true);
    expect(looksLikeAbsenceClaim("NaN passes the <= 0 check")).toBe(false);
  });
});

describe("review: evidence grounding and merge", () => {
  it("checks a quoted evidence fragment against the material, whitespace-insensitively", () => {
    expect(evidenceInMaterial("if cap_value is None   or cap_value <= 0:", [FILE])).toBe("found");
    expect(evidenceInMaterial("math.isfinite(cap_value)", [FILE])).toBe("not_found");
    expect(evidenceInMaterial("<= 0", [FILE])).toBe("too_short");
  });

  it("de-duplicates the same finding from different reviewers and keeps the max severity", () => {
    const a = {
      id: "F1",
      title: "NaN / inf cap silently disables the rule",
      severity: "high" as const,
      category: "input_coercion",
      location: "ads/finding_actions.py:3",
      claim: "NaN passes <= 0",
      evidence: "cap_value <= 0",
      fix: "isfinite",
      confidence: 0.9,
      absence_claim: false,
    };
    const b = {
      ...a,
      id: "F4",
      title: "cap_value accepts NaN and infinity",
      severity: "critical" as const,
      location: "finding_actions.py:2 (preview)",
      claim: "float('nan') <= 0 is False so NaN is stored",
      evidence: "if cap_value is None or cap_value <= 0:",
    };
    const c = {
      id: "F2",
      title: "Token dict grows without bound",
      severity: "low" as const,
      category: "dos",
      location: "finding_actions.py:_TOKENS",
      claim: "_TOKENS is only swept in preview",
      evidence: "_TOKENS[token] = (change, now_t + TOKEN_TTL)",
      fix: "cap at 1000",
      confidence: 0.7,
      absence_claim: true,
    };
    expect(sameFinding(a, b)).toBe(true);
    expect(sameFinding(a, c)).toBe(false);
    const merged = mergeFindings(
      [
        { model: "gpt-6-astra", provider: "openai", findings: [a, c] },
        { model: "claude-fable-5-1", provider: "anthropic", findings: [b] },
      ],
      { files: [FILE] },
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]!.severity).toBe("critical");
    expect(merged[0]!.found_by).toEqual(["gpt-6-astra", "claude-fable-5-1"]);
    expect(merged[0]!.agreement).toBe(2);
    expect(merged[0]!.claims.map((x) => x.evidence_status)).toEqual(["found", "found"]);
    expect(findingStatus(merged[0]!)).toMatch(/independent agreement/);
    expect(merged[1]!.absence_claim).toBe(true);
    expect(findingStatus(merged[1]!)).toMatch(/ABSENCE CLAIM/);
  });

  it("flags a finding whose quoted evidence is not in the material", () => {
    const f = {
      id: "F1",
      title: "wildcard CORS",
      severity: "high" as const,
      category: "authorisation",
      location: "chat_server.py:_cors",
      claim: "reflects any origin",
      evidence: "Access-Control-Allow-Origin: *",
      fix: "",
      confidence: 0.8,
      absence_claim: false,
    };
    const merged = mergeFindings([{ model: "m", provider: "p", findings: [f] }], { files: [FILE] });
    expect(findingStatus(merged[0]!)).toMatch(/NOT in material/);
  });
});

describe("review: prompt and material", () => {
  it("collects files from a directory, skipping node_modules and binaries, marking truncation", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "patchwork-harness-review-"));
    mkdirSync(join(cwd, "src"));
    mkdirSync(join(cwd, "node_modules", "x"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.py"), "print(1)\n");
    writeFileSync(join(cwd, "src", "big.py"), "x".repeat(5000));
    writeFileSync(join(cwd, "src", "img.bin"), Buffer.from([0, 1, 2]));
    writeFileSync(join(cwd, "node_modules", "x", "i.js"), "1");
    const c = await collectPaths(cwd, ["src"], { maxFileChars: 1000 });
    expect(c.files.map((f) => f.path)).toEqual(["src/a.py", "src/big.py"]);
    expect(c.files[1]!.truncated).toBe(true);
    expect(c.skipped).toEqual([{ path: "src/img.bin", reason: "binary" }]);
    const { user, system } = buildReviewPrompt("an internal tool", c);
    expect(system).toMatch(/AUTHORISED security review/);
    for (const h of [
      "1. THREAT MODEL",
      "2. AUTHORISATION",
      "3. INJECTION",
      "4. RACE / TOCTOU",
      "5. INPUT COERCION",
      "6. DENIAL OF SERVICE",
      "7. WHAT IT GETS RIGHT",
      "8. FIX FIRST",
    ])
      expect(user).toContain(h);
    expect(user).toContain("FILE: src/big.py (1 lines, TRUNCATED at 1000 chars");
    expect(user).toContain("NOT SHOWN");
    expect(user).toMatch(/"absence_claim"/);
  });

  it("feeds the material to the L4.5 verifier as evidence so invented names come back UNGROUNDED", () => {
    const evidence = evidenceFromMaterial({
      source: "paths",
      files: [FILE],
      totalChars: 1,
      skipped: [],
    });
    const honest = verify(
      "The check `cap_value <= 0` in ads/finding_actions.py lets NaN through.",
      evidence,
    );
    expect(honest.atoms.some((a) => a.kind === "path" && a.verdict === "VERIFIED")).toBe(true);
    const invented = verify(
      "The helper validate_cap42 in ads/validators.py rejects NaN.",
      evidence,
    );
    expect(invented.atoms.some((a) => a.verdict === "UNGROUNDED")).toBe(true);
  });
});

describe("review: the security_reviewer role", () => {
  it("is an ordered list with unverified ids leading and three vendors present", () => {
    const ids = roleList(loadModels().defaults.security_reviewer);
    expect(ids.slice(0, 3)).toEqual(["gpt-6-pro", "gpt-6", "claude-mythos-5-1"]);
    const providers = new Set(
      ids.map((id) => loadModels().models.find((m) => m.id === id)?.provider),
    );
    expect(providers.has("openai") && providers.has("anthropic") && providers.has("gemini")).toBe(
      true,
    );
  });
});
