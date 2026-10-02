/**
 * `patchwork-harness approve` - the check before something goes out under your name: an
 * issue, a PR body, a commit message. A model from a different vendor than
 * the one that wrote the draft reads it against the evidence you give it,
 * then approves it or lists what to fix. Only an approved draft gets the
 * "Patchwork Harness approved" tag (src/core/tag.ts), so the tag always means
 * a real cross-vendor check happened.
 *
 * Approved means the reviewer said so AND raised no high or medium concern;
 * a reviewer that approves while listing a serious problem is not believed.
 */
import { z } from "zod";
import { type ModelInfo, loadModels } from "../config.js";
import { pickReviewer } from "../core/reviewer.js";
import { type TagKind, tagEnabled, withTag } from "../core/tag.js";
import type { CompletionRequest, CompletionResponse } from "../providers/base.js";

const Concern = z.object({
  severity: z.enum(["high", "medium", "low"]).catch("medium"),
  issue: z.string(),
  quote: z.string().default(""),
});
const Gate = z.object({
  approve: z.boolean(),
  concerns: z.array(Concern).catch([]).default([]),
});
export type GateConcern = z.infer<typeof Concern>;

export interface ApproveResult {
  approved: boolean;
  concerns: GateConcern[];
  reviewer: string;
  provider: string;
  /** The reviewer is from a vendor that did not write the draft. */
  cross_vendor: boolean;
  /** The draft, with the tag when it was approved, cross-vendor and tagging is on. */
  text: string;
  tagged: boolean;
  cost_usd: number;
  /** Set when the reviewer's answer could not be read; never counts as approval. */
  unparsed?: string;
}

const KIND_NAME: Record<TagKind, string> = {
  issue: "GitHub issue",
  pr: "pull request description",
  commit: "commit message",
  text: "piece of writing",
};

export function approvePrompt(kind: TagKind): string {
  return [
    `You are the last check before a ${KIND_NAME[kind]} is published under the author's name. You did not write it. Check it against the evidence given, if any.`,
    "Raise a concern for:",
    "- a factual claim the evidence does not support, or one stated more strongly than the evidence allows",
    "- a number, name, path, version or quote that is wrong",
    "- anything private that should not be public: local paths, keys or tokens, private people or clients",
    "- anything discourteous to the reader, or misleading",
    "Do not raise a concern for style alone.",
    ...(kind === "commit"
      ? [
          "Trailer lines at the end (such as Co-Authored-By) are authorship metadata the author vouches for: do not ask for evidence of them, but do flag one that would make private data public.",
        ]
      : []),
    'Answer with JSON only: {"approve": true|false, "concerns": [{"severity": "high|medium|low", "issue": "...", "quote": "the exact words in the draft"}]}.',
    "Approve only when there is no high or medium concern.",
  ].join("\n");
}

export function approveMessage(
  draft: string,
  kind: TagKind,
  evidence: Array<{ name: string; text: string }>,
): string {
  const ev = evidence.length
    ? evidence.map((e) => `### ${e.name}\n\n\`\`\`\n${e.text}\n\`\`\``).join("\n\n")
    : "(none given: judge the draft on its own, and treat unsupported specifics as unsupported)";
  return `## The draft (${KIND_NAME[kind]})\n\n${draft}\n\n## Evidence\n\n${ev}`;
}

/** The reviewer's JSON: the last fenced block that validates, else the outermost braces. */
export function parseGate(text: string): z.infer<typeof Gate> | null {
  const tries: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) if (m[1]) tries.unshift(m[1]);
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(text.slice(a, b + 1));
  for (const t of tries) {
    try {
      const g = Gate.safeParse(JSON.parse(t));
      if (g.success) return g.data;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

export async function approve(opts: {
  draft: string;
  kind: TagKind;
  evidence?: Array<{ name: string; text: string }>;
  /** Reviewer model id; default the first reachable `reviewer` from another vendor. */
  model?: string;
  /** Vendor(s) that wrote the draft; default the executor's. */
  writtenBy?: string[];
  /** false = --no-tag. */
  tag?: boolean;
  /** Test seams. */
  reviewer?: ModelInfo;
  complete?: (m: ModelInfo, req: CompletionRequest) => Promise<CompletionResponse>;
}): Promise<ApproveResult> {
  const cfg = loadModels();
  const writers = new Set(
    opts.writtenBy?.length
      ? opts.writtenBy
      : [cfg.models.find((m) => m.id === cfg.defaults.executor)?.provider ?? "anthropic"],
  );
  const reviewer = opts.reviewer ?? (await pickReviewer(writers, opts.model));
  if (!reviewer)
    throw new Error(
      opts.model ? `${opts.model} is not reachable on this key` : "no reviewer model is reachable",
    );
  const complete =
    opts.complete ??
    (async (m: ModelInfo, req: CompletionRequest) => {
      const { getProvider } = await import("../providers/registry.js");
      return getProvider(m.provider).complete(req);
    });
  const resp = await complete(reviewer, {
    model: reviewer.id,
    system: approvePrompt(opts.kind),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: approveMessage(opts.draft, opts.kind, opts.evidence ?? []) },
        ],
      },
    ],
    maxTokens: 8000,
  });
  const raw = resp.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  const gate = parseGate(raw);
  const concerns = gate?.concerns ?? [];
  const approved =
    gate?.approve === true &&
    !concerns.some((c) => c.severity === "high" || c.severity === "medium");
  const crossVendor = !writers.has(reviewer.provider);
  const tagged = approved && crossVendor && tagEnabled(opts.tag);
  return {
    approved,
    concerns,
    reviewer: reviewer.id,
    provider: reviewer.provider,
    cross_vendor: crossVendor,
    text: tagged
      ? withTag(opts.draft, opts.kind, { level: "approved", reviewer: reviewer.id })
      : opts.draft,
    tagged,
    cost_usd: resp.cost_usd ?? 0,
    ...(gate ? {} : { unparsed: raw.slice(0, 2000) }),
  };
}
