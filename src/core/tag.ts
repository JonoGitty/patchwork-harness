/**
 * The Patchwork Harness tag: one line on a commit, PR or issue saying how the
 * harness was involved. On by default; PATCHWORK_HARNESS_TAG=off (in the environment or
 * ~/.patchwork-harness/.env) or a command's --no-tag turns it off.
 *
 * The tag never claims more than happened. It comes in two strengths:
 *   approved - the text passed a cross-vendor review (`patchwork-harness approve`)
 *   made     - made inside a harness run, before any review had run; git_ops
 *              commits and PRs land mid-run, ahead of the gate and L5 review
 */
export const HARNESS_URL = "https://github.com/JonoGitty/patchwork-harness";

export type TagKind = "commit" | "pr" | "issue" | "text";

export type TagEvidence = { level: "made" } | { level: "approved"; reviewer: string };

const OFF = new Set(["0", "off", "false", "no"]);

/** On unless a command passed --no-tag or PATCHWORK_HARNESS_TAG says off. */
export function tagEnabled(flag?: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (flag === false) return false;
  return !OFF.has((env.PATCHWORK_HARNESS_TAG ?? "").trim().toLowerCase());
}

export function commitTrailer(ev: TagEvidence): string {
  return ev.level === "approved"
    ? `Approved-by: Patchwork Harness, cross-vendor review by ${ev.reviewer} (${HARNESS_URL})`
    : `Made-with: Patchwork Harness (${HARNESS_URL})`;
}

export function markdownTag(ev: TagEvidence): string {
  return ev.level === "approved"
    ? `<sub>✓ Patchwork Harness approved: checked before posting by a cross-vendor review (${ev.reviewer}) in [Patchwork Harness](${HARNESS_URL}).</sub>`
    : `<sub>Made with [Patchwork Harness](${HARNESS_URL}).</sub>`;
}

/** True when the text already carries a harness tag of either strength. */
export function hasTag(text: string): boolean {
  return (
    /^(Made-with|Approved-by): Patchwork Harness/m.test(text) ||
    text.includes(`](${HARNESS_URL}).</sub>`)
  );
}

/** A `Token: value` line, the shape git reads as a trailer. */
const TRAILER = /^[A-Za-z][A-Za-z0-9-]*: \S/;

/**
 * Adds the tag once. A commit gets a git trailer, joined to an existing
 * trailer block (e.g. Co-Authored-By) so git still reads them all; anything
 * else gets a small footer. Text that already carries a harness tag is left
 * alone, so a re-run or a retried commit does not stack them.
 */
export function withTag(text: string, kind: TagKind, ev: TagEvidence): string {
  if (hasTag(text)) return text;
  const body = text.replace(/\s+$/, "");
  if (kind !== "commit")
    return body ? `${body}\n\n---\n${markdownTag(ev)}\n` : `${markdownTag(ev)}\n`;
  const paras = body.split(/\n\s*\n/);
  const inTrailers =
    paras.length > 1 && (paras.at(-1) ?? "").split("\n").every((l) => TRAILER.test(l));
  return `${body}${inTrailers ? "\n" : "\n\n"}${commitTrailer(ev)}`;
}
