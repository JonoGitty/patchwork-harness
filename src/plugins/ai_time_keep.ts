/**
 * ai-time-keep plugin.
 *
 * Mirrors the existing ai-time-keep hook on the maintainer's machine: every executor
 * turn gets the current wall-clock time injected so the model never
 * hallucinates dates. We expose it via systemPromptAddendum so it's
 * appended to whichever provider is being used.
 */

import type { Plugin } from "./types.js";

function nowBlock(): string {
  const now = new Date();
  const iso = now.toISOString();
  const tz = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const human = now.toLocaleString("en-GB", { dateStyle: "full", timeStyle: "long" });
  return [
    "<current-time source=\"patchwork-harness/ai_time_keep\">",
    `ISO 8601: ${iso}`,
    `Human:    ${human}`,
    `Timezone: ${tz}`,
    `Unix:     ${Math.floor(now.getTime() / 1000)}`,
    "</current-time>",
  ].join("\n");
}

export const aiTimeKeepPlugin: Plugin = {
  name: "ai_time_keep",
  description: "Injects accurate wall-clock time into every model turn so dates are never hallucinated.",
  version: "0.1.0",
  hooks: {
    systemPromptAddendum: () => nowBlock(),
  },
};
