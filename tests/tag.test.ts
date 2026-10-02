/**
 * The Patchwork Harness tag (src/core/tag.ts): git_ops commits and PRs carry a
 * "made with" tag, and only a draft that passed `patchwork-harness approve` carries
 * "approved". Each claim is checked against what git itself reads back.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { HARNESS_URL, hasTag, tagEnabled, withTag } from "../src/core/tag.js";
import { approve, approveMessage, approvePrompt, parseGate } from "../src/review/approve.js";
import { gitOpsTool } from "../src/tools/git_ops.js";

const made = { level: "made" } as const;

describe("withTag", () => {
  it("puts a commit's tag in a trailer block git reads, joined to an existing one", async () => {
    const msg = "intent: add lanes\n\nWhy it matters.\n\nCo-Authored-By: A <a@example.com>";
    const out = withTag(msg, "commit", made);
    expect(out).toBe(`${msg}\nMade-with: Patchwork Harness (${HARNESS_URL})`);
    const parsed = await execa("git", ["interpret-trailers", "--parse"], { input: out });
    expect(parsed.stdout).toContain("Co-Authored-By: A <a@example.com>");
    expect(parsed.stdout).toContain("Made-with: Patchwork Harness");
  });

  it("does not mistake a one-line subject like 'fix: x' for a trailer block", async () => {
    const out = withTag("fix: x", "commit", made);
    expect(out).toBe(`fix: x\n\nMade-with: Patchwork Harness (${HARNESS_URL})`);
    const parsed = await execa("git", ["interpret-trailers", "--parse"], { input: out });
    expect(parsed.stdout.trim()).toBe(`Made-with: Patchwork Harness (${HARNESS_URL})`);
  });

  it("gives issues and PRs a footer, and an empty PR body just the tag", () => {
    expect(withTag("Body.\n", "issue", made)).toBe(
      `Body.\n\n---\n<sub>Made with [Patchwork Harness](${HARNESS_URL}).</sub>\n`,
    );
    expect(withTag("", "pr", made)).toBe(
      `<sub>Made with [Patchwork Harness](${HARNESS_URL}).</sub>\n`,
    );
    expect(withTag("Body", "issue", { level: "approved", reviewer: "gpt-6.1-sol" })).toContain(
      "✓ Patchwork Harness approved: checked before posting by a cross-vendor review (gpt-6.1-sol)",
    );
  });

  it("never stacks a second tag, but a plain link to the repo is not a tag", () => {
    for (const kind of ["commit", "issue"] as const) {
      const once = withTag("Subject\n\nBody", kind, made);
      expect(hasTag(once)).toBe(true);
      expect(withTag(once, kind, made)).toBe(once);
    }
    const mention = `See ${HARNESS_URL} for the harness.`;
    expect(hasTag(mention)).toBe(false);
    expect(withTag(mention, "issue", made)).toContain("<sub>Made with");
  });

  it("is on by default; PATCHWORK_HARNESS_TAG=off or --no-tag turns it off", () => {
    expect(tagEnabled(undefined, {})).toBe(true);
    expect(tagEnabled(true, { PATCHWORK_HARNESS_TAG: "on" })).toBe(true);
    for (const v of ["off", "0", "false", "NO"])
      expect(tagEnabled(undefined, { PATCHWORK_HARNESS_TAG: v })).toBe(false);
    expect(tagEnabled(false, {})).toBe(false);
  });
});

describe("git_ops carries the tag", () => {
  const dirs: string[] = [];
  const saved = process.env.PATCHWORK_HARNESS_TAG;
  afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "PATCHWORK_HARNESS_TAG");
    else process.env.PATCHWORK_HARNESS_TAG = saved;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  async function repo() {
    const cwd = mkdtempSync(join(tmpdir(), "tag-"));
    dirs.push(cwd);
    const git = (...a: string[]) => execa("git", a, { cwd });
    await git("init", "-q");
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "t");
    await git("commit", "-q", "--allow-empty", "-m", "seed");
    return { cwd, git };
  }
  /** git_ops commits what is staged, as in a run. */
  async function stage(cwd: string, git: (...a: string[]) => Promise<unknown>) {
    writeFileSync(join(cwd, "slug.js"), "export const slug = (s) => s;\n");
    await git("add", "slug.js");
  }

  it("a harness commit has the Made-with trailer in git's own record, and the preview shows it", async () => {
    Reflect.deleteProperty(process.env, "PATCHWORK_HARNESS_TAG");
    const { cwd, git } = await repo();
    const input = { action: "commit" as const, message: "add slugify" };
    expect(gitOpsTool.preview(input).description).toContain("Made-with: Patchwork Harness");
    await stage(cwd, git);
    const r = await gitOpsTool.run({ ...input }, { cwd, sessionId: "s" });
    expect(r.success).toBe(true);
    const trailers = await git("log", "-1", "--format=%(trailers:key=Made-with,valueonly)");
    expect(trailers.stdout.trim()).toBe(`Patchwork Harness (${HARNESS_URL})`);
  });

  it("PATCHWORK_HARNESS_TAG=off: the commit is exactly the message given", async () => {
    process.env.PATCHWORK_HARNESS_TAG = "off";
    const { cwd, git } = await repo();
    await stage(cwd, git);
    const r = await gitOpsTool.run(
      { action: "commit", message: "add slugify" },
      { cwd, sessionId: "s" },
    );
    expect(r.success).toBe(true);
    expect((await git("log", "-1", "--format=%B")).stdout.trim()).toBe("add slugify");
  });
});

describe("patchwork-harness approve", () => {
  const reviewer = { id: "gpt-6.1-sol", provider: "openai" } as never;
  const answer = (text: string) => async () =>
    ({
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 1 },
      cost_usd: 0.01,
    }) as never;
  const draft = "The server returns 529 when busy.";

  it("an approval from another vendor is tagged 'approved', naming the reviewer", async () => {
    const r = await approve({
      draft,
      kind: "issue",
      reviewer,
      writtenBy: ["anthropic"],
      complete: answer('{"approve": true, "concerns": []}'),
    });
    expect(r).toMatchObject({
      approved: true,
      cross_vendor: true,
      tagged: true,
      reviewer: "gpt-6.1-sol",
    });
    expect(r.text).toContain("✓ Patchwork Harness approved");
    expect(r.text).toContain("(gpt-6.1-sol)");
  });

  it("'approve' with a high or medium concern is not believed, and nothing is tagged", async () => {
    const r = await approve({
      draft,
      kind: "issue",
      reviewer,
      writtenBy: ["anthropic"],
      complete: answer(
        '```json\n{"approve": true, "concerns": [{"severity": "medium", "issue": "529 is not what it returns", "quote": "529"}]}\n```',
      ),
    });
    expect(r.approved).toBe(false);
    expect(r.tagged).toBe(false);
    expect(r.text).toBe(draft);
    expect(r.concerns[0]?.issue).toMatch(/529/);
  });

  it("an unreadable answer is never an approval", async () => {
    const r = await approve({
      draft,
      kind: "issue",
      reviewer,
      writtenBy: ["anthropic"],
      complete: answer("Looks good to me!"),
    });
    expect(r.approved).toBe(false);
    expect(r.unparsed).toContain("Looks good");
  });

  it("same vendor as the writer: approved, but not tagged cross-vendor; --no-tag leaves it off", async () => {
    const ok = answer('{"approve": true, "concerns": [{"severity": "low", "issue": "nit"}]}');
    const same = await approve({
      draft,
      kind: "issue",
      reviewer,
      writtenBy: ["openai"],
      complete: ok,
    });
    expect(same).toMatchObject({ approved: true, cross_vendor: false, tagged: false, text: draft });
    const off = await approve({
      draft,
      kind: "commit",
      reviewer,
      writtenBy: ["anthropic"],
      tag: false,
      complete: ok,
    });
    expect(off).toMatchObject({ approved: true, tagged: false, text: draft });
  });

  it("a commit's authorship trailers are vouched for, not evidence-checked, but still screened for leaks", () => {
    expect(approvePrompt("commit")).toMatch(
      /authorship metadata .* do not ask for evidence .* private data/,
    );
    expect(approvePrompt("issue")).not.toMatch(/authorship metadata/);
  });

  it("the reviewer sees the draft and the evidence; the gate JSON parses from a fence", () => {
    const m = approveMessage(draft, "issue", [
      { name: "server.py", text: "raise HTTPException(529)" },
    ]);
    expect(m).toContain(draft);
    expect(m).toContain("### server.py");
    expect(parseGate('noise ```json\n{"approve": false}\n``` more')).toEqual({
      approve: false,
      concerns: [],
    });
  });
});
