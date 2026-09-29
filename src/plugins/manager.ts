/**
 * Plugin manager. Holds the loaded plugin list, dispatches hooks, and
 * exposes the catalogue used by the planner.
 */

import { registerTool } from "../tools/registry.js";
import type { Plugin, PluginCtx } from "./types.js";
import { claudeCompatPlugin } from "./claude_compat.js";
import { aiTimeKeepPlugin } from "./ai_time_keep.js";

const loaded: Plugin[] = [];

export async function loadBuiltIns(cwd: string): Promise<void> {
  if (loaded.length > 0) return;
  const ctx: PluginCtx = {
    cwd,
    registerTool,
    registerModel: () => {
      /* M1: plugins do not register models yet */
    },
  };
  for (const p of [claudeCompatPlugin, aiTimeKeepPlugin]) {
    if (p.init) await p.init(ctx);
    loaded.push(p);
  }
}

export function loadedPlugins(): Plugin[] {
  return [...loaded];
}

export async function runPluginHook<K extends keyof NonNullable<Plugin["hooks"]>>(
  hook: K,
  arg: Parameters<NonNullable<NonNullable<Plugin["hooks"]>[K]>>[0],
): Promise<void> {
  for (const p of loaded) {
    const fn = p.hooks?.[hook];
    if (typeof fn === "function") {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic hook dispatch
      await (fn as any)(arg);
    }
  }
}

export async function pluginCatalogue(): Promise<string> {
  const lines: string[] = [];
  for (const p of loaded) {
    if (p.hooks?.catalogueEntries) {
      const entries = await p.hooks.catalogueEntries();
      for (const e of entries) lines.push(`  - [${p.name}] ${e}`);
    }
  }
  return lines.join("\n") || "  (none)";
}

export function systemPromptAddenda(): string {
  const parts: string[] = [];
  for (const p of loaded) {
    if (p.hooks?.systemPromptAddendum) {
      parts.push(p.hooks.systemPromptAddendum());
    }
  }
  return parts.join("\n\n");
}
