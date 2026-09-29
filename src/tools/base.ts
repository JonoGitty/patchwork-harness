import type { z } from "zod";
import type { RiskLevel } from "../audit.js";

export interface ToolCtx {
  cwd: string;
  sessionId: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  flags: string[];
}

/**
 * `inputSchema` is intentionally typed as `z.ZodTypeAny` to avoid the
 * input/output mismatch zod produces for `.default(...)` fields. Each
 * tool re-parses the LLM's raw input via this schema and casts to its
 * own typed `I` after parsing — runtime safety, type-friendly callers.
 */
export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  assess(input: I, ctx: ToolCtx): RiskAssessment;
  preview(input: I): { description: string; details?: { path?: string; command?: string } };
  run(input: I, ctx: ToolCtx): Promise<O>;
}
