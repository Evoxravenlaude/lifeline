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
        if (/\b(401|403)\b/.test(String(e?.message))) break; // bad key: no point retrying this provider
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
 * Any OpenAI-compatible chat endpoint: Groq, OpenRouter, Cerebras, Mistral,
 * Together, or OpenAI itself. Set OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY
 * + OPENAI_COMPAT_MODEL. Tool calling needs a model that supports it
 * (Groq llama-3.3-70b-versatile does; most OpenRouter free models do).
 */
async function openaiCompat(o: CompleteOpts): Promise<Completion> {
  const body: any = {
    model: config.openaiCompatModel,
    max_tokens: o.maxTokens ?? 1500,
    messages: [{ role: "system", content: o.system }, ...o.messages],
    ...(o.json ? { response_format: { type: "json_object" } } : {}),
  };
  if (o.tools?.length) {
    body.tools = o.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: geminiSchema(z.toJSONSchema(t.schema, { io: "input" })) } }));
    body.tool_choice = "auto";
  }
  const post = (model: string) => fetch(`${config.openaiCompatBaseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.openaiCompatKey}` }, body: JSON.stringify({ ...body, model }), signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  let r = await post(config.openaiCompatModel);
  // Groq's free tier limits tokens per minute per model; the small model has far more room.
  if ((r.status === 429 || r.status === 413) && isGroq() && config.openaiCompatFallbackModel && config.openaiCompatFallbackModel !== config.openaiCompatModel) r = await post(config.openaiCompatFallbackModel);
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
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiKey}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(o.grounded ? CALL_TIMEOUT_MS * 3 : CALL_TIMEOUT_MS),
  });
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
