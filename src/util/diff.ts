/**
 * Tiny line-based unified-diff producer. Self-contained — avoids pulling
 * in the `diff` npm package. Output is capped so a single huge file edit
 * doesn't blow up tool_result tokens or web SSE payloads.
 *
 * Algorithm: classic LCS table (O(n*m)). Fine for files up to ~5K lines;
 * we cap input at MAX_LINES_PER_SIDE before computing to bound runtime.
 */

const MAX_LINES_PER_SIDE = 4000;
const MAX_OUTPUT_BYTES = 8000;
const HUNK_CONTEXT = 3;

export interface UnifiedDiffOptions {
  oldPath?: string;
  newPath?: string;
  /** Include the `--- a/... / +++ b/...` header. Default true. */
  header?: boolean;
}

export function unifiedDiff(
  before: string,
  after: string,
  opts: UnifiedDiffOptions = {},
): string {
  if (before === after) return "";
  const a = splitLinesBounded(before);
  const b = splitLinesBounded(after);
  const ops = diffLines(a.lines, b.lines);
  const hunks = groupHunks(ops);
  if (hunks.length === 0) return "";

  const out: string[] = [];
  if (opts.header !== false) {
    out.push(`--- ${opts.oldPath ?? "a"}`);
    out.push(`+++ ${opts.newPath ?? "b"}`);
  }
  if (a.truncated || b.truncated) {
    out.push(`# diff truncated to first ${MAX_LINES_PER_SIDE} lines per side`);
  }

  let aLine = 1;
  let bLine = 1;
  let aPos = 0;
  let bPos = 0;
  for (const hunk of hunks) {
    // Advance line counters to the hunk start
    while (aPos < hunk.aStart) { aLine++; aPos++; }
    while (bPos < hunk.bStart) { bLine++; bPos++; }
    const header = `@@ -${aLine},${hunk.aLen} +${bLine},${hunk.bLen} @@`;
    out.push(header);
    for (const op of hunk.ops) {
      if (op.kind === "eq") {
        out.push(` ${op.line}`);
        aLine++;
        bLine++;
        aPos++;
        bPos++;
      } else if (op.kind === "del") {
        out.push(`-${op.line}`);
        aLine++;
        aPos++;
      } else {
        out.push(`+${op.line}`);
        bLine++;
        bPos++;
      }
    }
  }

  let result = out.join("\n");
  if (result.length > MAX_OUTPUT_BYTES) {
    result = result.slice(0, MAX_OUTPUT_BYTES) + "\n# diff truncated";
  }
  return result;
}

function splitLinesBounded(s: string): { lines: string[]; truncated: boolean } {
  if (!s) return { lines: [], truncated: false };
  const all = s.split("\n");
  if (all.length > MAX_LINES_PER_SIDE) {
    return { lines: all.slice(0, MAX_LINES_PER_SIDE), truncated: true };
  }
  return { lines: all, truncated: false };
}

type Op = { kind: "eq" | "del" | "add"; line: string };

function diffLines(a: string[], b: string[]): Op[] {
  const m = a.length;
  const n = b.length;
  // LCS length table
  const dp: Uint32Array = new Uint32Array((m + 1) * (n + 1));
  const w = n + 1;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i * w + j] = (dp[(i + 1) * w + (j + 1)] ?? 0) + 1;
      } else {
        const down = dp[(i + 1) * w + j] ?? 0;
        const right = dp[i * w + (j + 1)] ?? 0;
        dp[i * w + j] = down > right ? down : right;
      }
    }
  }
  // Walk to produce ops
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const ai = a[i] as string;
    const bj = b[j] as string;
    if (ai === bj) {
      ops.push({ kind: "eq", line: ai });
      i++;
      j++;
    } else if ((dp[(i + 1) * w + j] ?? 0) >= (dp[i * w + (j + 1)] ?? 0)) {
      ops.push({ kind: "del", line: ai });
      i++;
    } else {
      ops.push({ kind: "add", line: bj });
      j++;
    }
  }
  while (i < m) ops.push({ kind: "del", line: a[i++] as string });
  while (j < n) ops.push({ kind: "add", line: b[j++] as string });
  return ops;
}

interface Hunk {
  aStart: number; // 0-indexed line in `a` where this hunk begins
  bStart: number;
  aLen: number;
  bLen: number;
  ops: Op[];
}

function groupHunks(ops: Op[]): Hunk[] {
  const hunks: Hunk[] = [];
  let aIdx = 0;
  let bIdx = 0;
  let i = 0;
  while (i < ops.length) {
    // Skip equal runs that aren't adjacent to a change
    while (i < ops.length && (ops[i] as Op).kind === "eq") {
      // Look ahead: is there a change within HUNK_CONTEXT lines?
      let lookahead = 0;
      let foundChange = false;
      for (let k = i; k < ops.length && lookahead <= HUNK_CONTEXT; k++) {
        if ((ops[k] as Op).kind !== "eq") { foundChange = true; break; }
        lookahead++;
      }
      if (foundChange) break;
      aIdx++;
      bIdx++;
      i++;
    }
    if (i >= ops.length) break;

    // Build a hunk
    const hunkOps: Op[] = [];
    const hunkAStart = aIdx;
    const hunkBStart = bIdx;
    let aLen = 0;
    let bLen = 0;
    let trailingEq = 0;
    while (i < ops.length) {
      const op = ops[i] as Op;
      hunkOps.push(op);
      if (op.kind === "eq") {
        aLen++;
        bLen++;
        aIdx++;
        bIdx++;
        trailingEq++;
        if (trailingEq > HUNK_CONTEXT * 2) {
          // Far enough past the last change — close the hunk
          for (let drop = 0; drop < HUNK_CONTEXT; drop++) hunkOps.pop();
          aLen -= HUNK_CONTEXT;
          bLen -= HUNK_CONTEXT;
          aIdx -= HUNK_CONTEXT;
          bIdx -= HUNK_CONTEXT;
          break;
        }
      } else {
        trailingEq = 0;
        if (op.kind === "del") { aLen++; aIdx++; }
        else { bLen++; bIdx++; }
      }
      i++;
    }
    hunks.push({ aStart: hunkAStart, bStart: hunkBStart, aLen, bLen, ops: hunkOps });
  }
  return hunks;
}

/** Quick before/after summary for tool_result content (compact). */
export function diffSummary(before: string, after: string): { added: number; removed: number } {
  if (before === after) return { added: 0, removed: 0 };
  const a = splitLinesBounded(before).lines;
  const b = splitLinesBounded(after).lines;
  const ops = diffLines(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added++;
    else if (op.kind === "del") removed++;
  }
  return { added, removed };
}
