#!/usr/bin/env node
/**
 * Evidence-based model probe. For every provider whose key is present:
 *   1. GET the provider's model-list endpoint (a listing is NOT proof)
 *   2. make a real ~16-token call to every candidate id
 * and write one JSON report. A 404 "does not exist or you do not have
 * access" is recorded as unreachable-on-this-key, never as nonexistent.
 *
 * Raw fetch only (no SDKs) so it runs anywhere node 20+ does:
 *   node scripts/probe_models.mjs [--out <file>] [--only openai,anthropic,...]
 * Keys: process env, then ~/.patchwork-harness/.env, then ./.env (same order as patchwork-harness).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function loadEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined && v) process.env[k] = v;
  }
}
loadEnv(join(process.env.HOME || homedir(), ".patchwork-harness", ".env"));
loadEnv(join(process.cwd(), ".env"));

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(tmpdir(), "patchwork-harness-model-probe.json");
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1].split(",") : null;

const PROMPT = "Reply with the single word OK.";
const TIMEOUT_MS = 120_000;

async function timed(fn) {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { ...r, ms: Date.now() - t0 };
  } catch (e) {
    return { status: "error", error: String(e && e.message || e).slice(0, 200), ms: Date.now() - t0 };
  }
}

async function http(url, init) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { code: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

function classify(code, json, text) {
  if (code >= 200 && code < 300) return "ok";
  const msg = (json && (json.error?.message || json.error?.type || json.message)) || text || "";
  if (code === 404 || /does not exist|not found|not_found_error|NOT_FOUND/i.test(msg)) return "unreachable_on_key";
  if (code === 401 || code === 403) return "auth";
  if (code === 429) return "rate_limited";
  if (/credit|balance|quota|billing/i.test(msg)) return "billing";
  return "error";
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const uniq = (xs) => [...new Set(xs)];

// ───────────────────────── OpenAI ─────────────────────────
async function probeOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { skipped: "no OPENAI_API_KEY" };
  const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const list = await http("https://api.openai.com/v1/models", { headers: H });
  const listed = (list.json?.data ?? []).map((m) => m.id).sort();
  const explicit = [
    "gpt-6-sol", "gpt-6-luna", "gpt-6-terra", "gpt-6-astra", "gpt-6", "gpt-6-pro", "gpt-6-mini", "gpt-6-nano", "gpt-6-chat-latest", "gpt-6-codex", "o6", "o5", "o5-pro",
    "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-pro", "gpt-5.6-mini",
    "gpt-5.5", "gpt-5.5-pro", "gpt-5.5-mini", "gpt-5.5-nano", "gpt-5.5-codex",
    "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro",
    "o3-pro", "o4-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
  ];
  const fromList = listed.filter((id) => /^(gpt-5|gpt-6|o[3-9])/.test(id) && !/realtime|audio|transcribe|tts|search|image|embed|moderation|instruct/.test(id));
  const candidates = uniq([...explicit, ...fromList]).slice(0, 60);
  const results = await pool(candidates, 5, async (model) => {
    const chat = await timed(async () => {
      const r = await http("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: H,
        body: JSON.stringify({ model, messages: [{ role: "user", content: PROMPT }], max_completion_tokens: 16 }),
      });
      const status = classify(r.code, r.json, r.text);
      return {
        status, code: r.code, api: "chat",
        error: status === "ok" ? undefined : (r.json?.error?.message ?? r.text).slice(0, 200),
        usage: r.json?.usage, text: r.json?.choices?.[0]?.message?.content?.slice(0, 40),
      };
    });
    if (chat.status === "ok" || chat.status === "unreachable_on_key" || chat.status === "auth") {
      // a 404 on chat may still be a Responses-only model; try once more there
      if (chat.status !== "unreachable_on_key" || !/pro|gpt-6/.test(model)) return { model, listed: listed.includes(model), ...chat };
    }
    const resp = await timed(async () => {
      const r = await http("https://api.openai.com/v1/responses", {
        method: "POST", headers: H,
        body: JSON.stringify({ model, input: PROMPT, max_output_tokens: 16 }),
      });
      const status = classify(r.code, r.json, r.text);
      return {
        status, code: r.code, api: "responses",
        error: status === "ok" ? undefined : (r.json?.error?.message ?? r.text).slice(0, 200),
        usage: r.json?.usage, text: r.json?.output_text?.slice(0, 40),
      };
    });
    return { model, listed: listed.includes(model), ...(resp.status === "ok" ? resp : chat), responses_try: resp.status, chat_try: chat.status };
  });
  return { list_code: list.code, listed, results };
}

// ───────────────────────── Anthropic ─────────────────────────
async function probeAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { skipped: "no ANTHROPIC_API_KEY" };
  const H = { "x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json" };
  const list = await http("https://api.anthropic.com/v1/models?limit=100", { headers: H });
  const listed = (list.json?.data ?? []).map((m) => m.id).sort();
  const explicit = [
    "claude-opus-5-5", "claude-sonnet-5-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-5", "claude-fable-5-1", "claude-fable-5",
    "claude-mythos-5-1", "claude-mythos-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6",
    "claude-haiku-4-5", "claude-haiku-4-5-20251001",
  ];
  const candidates = uniq([...explicit, ...listed]).slice(0, 40);
  const results = await pool(candidates, 4, async (model) => {
    const r = await timed(async () => {
      const res = await http("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: H,
        body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: "user", content: PROMPT }] }),
      });
      const status = classify(res.code, res.json, res.text);
      return {
        status, code: res.code,
        error: status === "ok" ? undefined : (res.json?.error?.message ?? res.text).slice(0, 200),
        usage: res.json?.usage, text: res.json?.content?.[0]?.text?.slice(0, 40),
      };
    });
    return { model, listed: listed.includes(model), ...r };
  });
  return { list_code: list.code, listed, results };
}

// ───────────────────────── Gemini ─────────────────────────
async function probeGemini() {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return { skipped: "no GEMINI_API_KEY" };
  const list = await http(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`, {});
  const listedFull = (list.json?.models ?? []);
  const listed = listedFull.map((m) => m.name.replace(/^models\//, "")).sort();
  const genCapable = listedFull.filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
  const explicit = [
    "gemini-3.8-flash", "gemini-3.8-pro", "gemini-3.8-flash-lite", "gemini-3.5-flash", "gemini-3.5-pro", "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview", "gemini-3.1-pro", "gemini-3.1-flash-lite", "gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash",
  ];
  const fromList = genCapable.filter((id) => /^gemini-3/.test(id) && !/tts|image|embedding|live|audio|native/.test(id));
  const candidates = uniq([...explicit, ...fromList]).slice(0, 40);
  const results = await pool(candidates, 4, async (model) => {
    const r = await timed(async () => {
      const res = await http(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 16 } }),
      });
      const status = classify(res.code, res.json, res.text);
      return {
        status, code: res.code,
        error: status === "ok" ? undefined : (res.json?.error?.message ?? res.text).slice(0, 200),
        usage: res.json?.usageMetadata, text: res.json?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").slice(0, 40),
      };
    });
    return { model, listed: listed.includes(model), ...r };
  });
  return { list_code: list.code, listed, results };
}

// ───────────────────────── xAI ─────────────────────────
async function probeXAI() {
  const key = process.env.XAI_API_KEY || process.env.GROK_API_KEY;
  if (!key) return { skipped: "no XAI_API_KEY / GROK_API_KEY" };
  const H = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const list = await http("https://api.x.ai/v1/models", { headers: H });
  const listed = (list.json?.data ?? []).map((m) => m.id).sort();
  const explicit = ["grok-4.7", "grok-build-0.1", "grok-5", "grok-4.1", "grok-4", "grok-4-fast", "grok-4-fast-reasoning", "grok-code-fast-1"];
  const candidates = uniq([...explicit, ...listed]).slice(0, 20);
  const results = await pool(candidates, 3, async (model) => {
    const r = await timed(async () => {
      const res = await http("https://api.x.ai/v1/chat/completions", {
        method: "POST", headers: H,
        body: JSON.stringify({ model, messages: [{ role: "user", content: PROMPT }], max_tokens: 16 }),
      });
      const status = classify(res.code, res.json, res.text);
      return {
        status, code: res.code,
        error: status === "ok" ? undefined : (res.json?.error ?? res.json?.msg ?? res.text).toString().slice(0, 200),
        usage: res.json?.usage, text: res.json?.choices?.[0]?.message?.content?.slice(0, 40),
      };
    });
    return { model, listed: listed.includes(model), ...r };
  });
  return { list_code: list.code, listed, results };
}

const providers = { openai: probeOpenAI, anthropic: probeAnthropic, gemini: probeGemini, xai: probeXAI };
const report = { probed_at: new Date().toISOString(), key_env_source: "env > ~/.patchwork-harness/.env > ./.env", providers: {} };
const jobs = Object.entries(providers).filter(([n]) => !ONLY || ONLY.includes(n));
await Promise.all(jobs.map(async ([name, fn]) => { report.providers[name] = await fn(); }));
writeFileSync(OUT, JSON.stringify(report, null, 2));

for (const [name, p] of Object.entries(report.providers)) {
  console.log(`\n== ${name} ==${p.skipped ? ` skipped: ${p.skipped}` : ` (list HTTP ${p.list_code}, ${p.listed?.length ?? 0} listed)`}`);
  for (const r of p.results ?? []) {
    const u = r.usage ? JSON.stringify(r.usage).slice(0, 80) : "";
    console.log(`  ${r.status.padEnd(18)} ${String(r.code).padEnd(4)} ${r.model.padEnd(32)} listed=${r.listed} ${r.ms}ms ${r.api ?? ""} ${r.error ? "| " + r.error : u}`);
  }
}
console.log(`\nreport: ${OUT}`);
