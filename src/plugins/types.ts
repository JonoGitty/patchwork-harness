import type { Tool } from "../tools/base.js";
import type { ModelInfo } from "../config.js";
import type { Plan, SessionState } from "../core/types.js";

export interface PluginCtx {
  cwd: string;
  registerTool: (t: Tool) => void;
  registerModel: (m: ModelInfo) => void;
}

export interface PluginHooks {
  onSessionStart?: (s: SessionState) => void | Promise<void>;
  onSessionEnd?: (s: SessionState) => void | Promise<void>;
  onPlanReady?: (p: Plan) => void | Promise<void>;
  /** Lets plugins inject text into the executor's system prompt. */
  systemPromptAddendum?: () => string;
  /** Lets plugins surface "I do X" entries to the planner. */
  catalogueEntries?: () => Promise<string[]> | string[];
}

export interface Plugin {
  name: string;
  description: string;
  version: string;
  init?: (ctx: PluginCtx) => void | Promise<void>;
  hooks?: PluginHooks;
}
