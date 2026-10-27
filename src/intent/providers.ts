/**
 * Model providers behind one interface: Anthropic (SDK), Gemini (REST) and
 * any OpenAI-compatible endpoint (Groq by default). MODEL_PROVIDER picks the
 * first to try; every other configured provider is a fallback.
 * Gemini additionally offers Google Search grounding, used by the scout.
 */
import { z } from "zod";
import { config } from "../core/config.js";

export interface Tool { name: string; description: string; schema: z.ZodTypeAny }
export interface Msg { role: "user" | "assistant"; content: string }
export interface Completion {
  text: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  usage: { input: number; output: number };
  grounding?: { uri: string; title?: string }[];
}
export interface CompleteOpts { system: string; messages: Msg[]; tools?: Tool[]; maxTokens?: number; grounded?: boolean; json?: boolean }

export type Provider = "anthropic" | "gemini" | "openai";

/** Last model outcome, for /doctor and the fallback message. */
export const diagnostics: { lastError: string | null; lastOkAt: number | null; lastErrorAt: number | null; lastProvider: string | null; errors: Record<string, string> } = { lastError: null, lastOkAt: null, lastErrorAt: null, lastProvider: null, errors: {} };

const CALL_TIMEOUT_MS = 15_000;

/** Every provider that has a key, the chosen one first. */
export function providerChain(): Provider[] {
  const has: Record<Provider, boolean> = { anthropic: Boolean(config.anthropicKey), gemini: Boolean(config.geminiKey), openai: Boolean(config.openaiCompatKey) };
  const order: Provider[] = [];
  if (config.modelProvider && has[config.modelProvider]) order.push(config.modelProvider);
  for (const p of ["anthropic", "openai", "gemini"] as Provider[]) if (has[p] && !order.includes(p)) order.push(p);
  return order;
}

export function providerName(): Provider | null {
  return providerChain()[0] ?? null;
}

/**
 * Try each configured provider in turn. Within a provider: the full request,
 * then the same request without tools (many endpoints choke on tool lists),
 * and on Groq a rate limit drops to the lighter model. Every attempt has a
 * time limit, so one slow provider never stalls the conversation.
 */
export async function complete(opts: CompleteOpts, forceProvider?: Provider): Promise<Completion | null> {
  const chain = forceProvider ? [forceProvider] : providerChain();
  if (!chain.length) return null;
  let last: unknown = null;
  for (const p of chain) {
    const attempts: (() => Promise<Completion>)[] = [() => call(p, opts)];
    if (opts.tools?.length) attempts.push(() => call(p, { ...opts, tools: undefined }));
    for (const attempt of attempts) {
      try {
        const r = await attempt();
        diagnostics.lastOkAt = Date.now(); diagnostics.lastProvider = p; delete diagnostics.errors[p];
        return r;
      } catch (e: any) {
        last = e;
        const msg = `${p}: ${e?.name === "TimeoutError" || e?.name === "AbortError" ? `no answer within ${CALL_TIMEOUT_MS / 1000}s` : e?.message ?? e}`.slice(0, 300);
        diagnostics.lastError = msg; diagnostics.lastErrorAt = Date.now(); diagnostics.errors[p] = msg;
        if (/\b(401|403|404)\b/.test(String(e?.message))) break; // bad key or no such model: go straight to the next provider
      }
    }
  }
  throw last;
}

function call(p: Provider, o: CompleteOpts): Promise<Completion> {
  return p === "anthropic" ? anthropic(o) : p === "gemini" ? gemini(o) : openaiCompat(o);
}

const isGroq = () => /groq\.com/.test(config.openaiCompatBaseUrl);

/**
 * Providers retire models every few months (Groq dropped Llama 3.x in August 2026,
 * Google dropped Gemini 2.5 Flash in October). When a provider says a model doesn't
 * exist, ask it which models it has, pick the best current one, and remember it.
 */
const resolved: { openai?: string; gemini?: string } = {};
export const modelsInUse = () => ({ openai: resolved.openai ?? config.openaiCompatModel, gemini: resolved.gemini ?? config.geminiModel });

/** Pick from a provider's own list: the first preference that matches, skipping speech, image, embedding and guard models. */
export function pickModel(ids: string[], prefer: RegExp[]): string | null {
  const usable = ids.filter((id) => !/whisper|tts|audio|image|vision-only|embed|guard|safeguard|moderation|live|transcribe|aqa|imagen|veo|learnlm|robotics|computer-use/i.test(id));
  for (const re of prefer) {
    const hits = usable.filter((id) => re.test(id));
    if (hits.length) return hits.sort((a, b) => versionOf(b) - versionOf(a) || Number(/preview|exp/i.test(a)) - Number(/preview|exp/i.test(b)))[0];
  }
  return usable[0] ?? null;
}
const versionOf = (id: string) => { const m = /(\d+(?:\.\d+)?)/.exec(id.replace(/^.*?(?:gemini|qwen|llama|gpt-oss)[-/]?/i, "")); return m ? Number(m[1]) : 0; };

async function discoverOpenai(): Promise<string | null> {
  const r = await fetch(`${config.openaiCompatBaseUrl}/models`, { headers: { authorization: `Bearer ${config.openaiCompatKey}` }, signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r?.ok) return null;
  const j: any = await r.json().catch(() => ({}));
  const ids: string[] = (j.data ?? []).filter((m: any) => m.active !== false).map((m: any) => m.id);
  return pickModel(ids, [/gpt-oss-120b/i, /gpt-oss-20b/i, /qwen.*\d{2,}b/i, /llama.*70b/i, /llama/i, /mixtral|mistral/i]);
}

async function discoverGemini(): Promise<string | null> {
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${config.geminiKey}`, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!r?.ok) return null;
  const j: any = await r.json().catch(() => ({}));
  const ids: string[] = (j.models ?? []).filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent")).map((m: any) => String(m.name).replace(/^models\//, ""));
  return pickModel(ids, [/^gemini-flash-latest$/, /^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash(?!-lite)/, /^gemini-[\d.]+-pro$/, /^gemini/]);
}

/**
 * Any OpenAI-compatible chat endpoint: Groq, OpenRouter, Cerebras, Mistral,
 * Together, or OpenAI itself. Set OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY
 * + OPENAI_COMPAT_MODEL. Tool calling needs a model that supports it
 * (Groq openai/gpt-oss-120b does; most OpenRouter free models do).
 */
async function openaiCompat(o: CompleteOpts): Promise<Completion> {
  const body: any = {
    model: config.openaiCompatModel,
    max_tokens: o.maxTokens ?? 1500,
    messages: [{ role: "system", content: o.system }, ...o.messages],
    ...(o.json ? { response_format: { type: "json_object" } } : {}),
    // gpt-oss thinks before it answers; for a chat assistant, short thinking keeps replies quick.
    ...(/gpt-oss/.test(resolved.openai ?? config.openaiCompatModel) && isGroq() ? { reasoning_effort: "low" } : {}),
  };
  if (o.tools?.length) {
    body.tools = o.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: geminiSchema(z.toJSONSchema(t.schema, { io: "input" })) } }));
    body.tool_choice = "auto";
  }
  const post = (model: string) => fetch(`${config.openaiCompatBaseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.openaiCompatKey}` }, body: JSON.stringify({ ...body, model }), signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  const main = resolved.openai ?? config.openaiCompatModel;
  let r = await post(main);
  // Rate-limited, too large, or the model was retired: try the second model before giving up on this provider.
  if ((r.status === 429 || r.status === 413 || r.status === 404) && config.openaiCompatFallbackModel && config.openaiCompatFallbackModel !== main) r = await post(config.openaiCompatFallbackModel);
  if (r.status === 404 || r.status === 400 && /model/i.test(await r.clone().text())) {
    const found = await discoverOpenai();
    if (found && found !== main) { r = await post(found); if (r.ok) resolved.openai = found; }
  }
  if (!r.ok) throw new Error(`${config.openaiCompatBaseUrl.replace(/^https?:\/\//, "")} ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const m = j.choices?.[0]?.message ?? {};
  const tc = m.tool_calls?.[0]?.function;
  let args: Record<string, unknown> = {};
  if (tc?.arguments) { try { args = JSON.parse(tc.arguments); } catch { args = {}; } }
  return {
    text: (m.content ?? "").trim(),
    toolCall: tc ? { name: tc.name, args } : undefined,
    usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 },
  };
}

async function anthropic(o: CompleteOpts): Promise<Completion> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.anthropicKey, timeout: CALL_TIMEOUT_MS, maxRetries: 0 });
  const res = await client.messages.create({
    model: config.model,
    max_tokens: o.maxTokens ?? 1500,
    system: o.system,
    tools: o.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: z.toJSONSchema(t.schema, { io: "input" }) as any })),
    messages: o.messages,
  });
  const tool = res.content.find((c) => c.type === "tool_use");
  return {
    text: res.content.filter((c) => c.type === "text").map((c: any) => c.text).join("\n").trim(),
    toolCall: tool && tool.type === "tool_use" ? { name: tool.name, args: tool.input as any } : undefined,
    usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
  };
}

/** Strip JSON-schema keys Gemini's function declarations reject. */
export function geminiSchema(s: any): any {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(geminiSchema);
  const out: any = {};
  for (const [k, v] of Object.entries(s)) {
    if (["$schema", "additionalProperties", "default", "$ref", "title"].includes(k)) continue;
    out[k] = geminiSchema(v);
  }
  if (out.type === "integer") out.type = "integer";
  return out;
}

async function gemini(o: CompleteOpts): Promise<Completion> {
  const body: any = {
    systemInstruction: { parts: [{ text: o.system }] },
    contents: o.messages.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: { maxOutputTokens: o.maxTokens ?? 1500, ...(o.json ? { responseMimeType: "application/json" } : {}) },
  };
  const tools: any[] = [];
  if (o.tools?.length) tools.push({ functionDeclarations: o.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(z.toJSONSchema(t.schema, { io: "input" })) })) });
  if (o.grounded) tools.push({ google_search: {} });
  if (tools.length) body.tools = tools;
  const post = (model: string) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiKey}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(o.grounded ? CALL_TIMEOUT_MS * 3 : CALL_TIMEOUT_MS),
  });
  const main = resolved.gemini ?? config.geminiModel;
  let r = await post(main);
  if (r.status === 404) {
    const found = await discoverGemini();
    if (found && found !== main) { r = await post(found); if (r.ok) resolved.gemini = found; }
  }
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  const parts: any[] = j.candidates?.[0]?.content?.parts ?? [];
  const fc = parts.find((p) => p.functionCall)?.functionCall;
  const chunks = j.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return {
    text: parts.filter((p) => p.text).map((p) => p.text).join("\n").trim(),
    toolCall: fc ? { name: fc.name, args: fc.args ?? {} } : undefined,
    usage: { input: j.usageMetadata?.promptTokenCount ?? 0, output: j.usageMetadata?.candidatesTokenCount ?? 0 },
    grounding: chunks.map((c: any) => ({ uri: c.web?.uri, title: c.web?.title })).filter((c: any) => c.uri),
  };
}
