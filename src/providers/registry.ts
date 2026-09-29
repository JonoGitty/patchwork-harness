import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { LocalProvider } from "./local.js";
import { OpenAIProvider } from "./openai.js";
import { PerplexityProvider } from "./perplexity.js";
import { XAIProvider } from "./xai.js";
import type { Provider } from "./base.js";

let cached: Map<string, Provider> | null = null;

export function providers(): Map<string, Provider> {
  if (cached) return cached;
  const m = new Map<string, Provider>();
  m.set("anthropic", new AnthropicProvider());
  m.set("openai", new OpenAIProvider());
  m.set("gemini", new GeminiProvider());
  m.set("xai", new XAIProvider());
  m.set("perplexity", new PerplexityProvider());
  m.set("local", new LocalProvider());
  cached = m;
  return m;
}

export function getProvider(name: string): Provider {
  const p = providers().get(name);
  if (!p) throw new Error(`unknown provider: ${name}`);
  return p;
}
