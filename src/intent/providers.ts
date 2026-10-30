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
  /** The person stopped it part way; `text` is what was written by then. */
  stopped?: boolean;
}
export interface CompleteOpts {
  system: string; messages: Msg[]; tools?: Tool[]; maxTokens?: number; grounded?: boolean; json?: boolean;
  /**
   * Stream the answer: called with the text so far as it's written (never with JSON, never with a tool call's
   * arguments). Telegram shows it as a live draft. The finished Completion is the same as without it.
   */
  onText?: (soFar: string) => void;
  /** Stop early (the person pressed Stop): the text written so far is returned, marked `stopped`. */
  signal?: AbortSignal;
}

export type Provider = "anthropic" | "gemini" | "openai";

/** Last model outcome, for /doctor and the fallback message. */
export const diagnostics: { lastError: string | null; lastOkAt: number | null; lastErrorAt: number | null; lastProvider: string | null; errors: Record<string, string> } = { lastError: null, lastOkAt: null, lastErrorAt: null, lastProvider: null, errors: {} };

const CALL_TIMEOUT_MS = 15_000;
/** A streamed answer keeps arriving, so it gets longer overall (the first words still have to come quickly). */
const STREAM_TIMEOUT_MS = 60_000;
const streams = (o: CompleteOpts) => Boolean(o.onText) && !o.json;
const signalFor = (o: CompleteOpts, ms: number) => (o.signal ? AbortSignal.any([AbortSignal.timeout(ms), o.signal]) : AbortSignal.timeout(ms));
const stoppedBy = (o: CompleteOpts) => Boolean(o.signal?.aborted);

/** Server-sent events from a fetch response: each `data:` line, parsed as JSON. */
export async function* sseEvents(r: Response): AsyncGenerator<any> {
  if (!r.body) return;
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (d === "[DONE]") return;
      try { yield JSON.parse(d); } catch { /* a keep-alive or a broken line */ }
    }
  }
}

/** Calls onText at most every `ms`, always with the latest text, and once more at the end. */
export function throttle(fn: (t: string) => void, ms = 450): { push: (t: string) => void; flush: () => void; cancel: () => void } {
  let last = 0, pending: string | null = null, timer: NodeJS.Timeout | null = null;
  const fire = () => { if (pending !== null) { const t = pending; pending = null; last = Date.now(); try { fn(t); } catch { /* the draft is a nicety */ } } };
  return {
    push(t) { pending = t; const wait = ms - (Date.now() - last); if (wait <= 0) { if (timer) { clearTimeout(timer); timer = null; } fire(); } else if (!timer) timer = setTimeout(() => { timer = null; fire(); }, wait); },
    flush() { if (timer) { clearTimeout(timer); timer = null; } fire(); },
    cancel() { if (timer) { clearTimeout(timer); timer = null; } pending = null; },
  };
}

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
        if (opts.signal?.aborted) return { text: "", usage: { input: 0, output: 0 }, stopped: true }; // stopped before a word came
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
  const live = streams(o);
  if (live) body.stream = true;
  const post = (model: string) => fetch(`${config.openaiCompatBaseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.openaiCompatKey}` }, body: JSON.stringify({ ...body, model }), signal: signalFor(o, live ? STREAM_TIMEOUT_MS : CALL_TIMEOUT_MS),
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
  if (live) {
    let text = "", name = "", argText = "", usage = { input: 0, output: 0 }, stopped = false;
    try {
      for await (const ev of sseEvents(r)) {
        const d = ev.choices?.[0]?.delta ?? {};
        if (typeof d.content === "string" && d.content) { text += d.content; if (!name) o.onText!(text); }
        for (const t of d.tool_calls ?? []) { if (t.function?.name) name += t.function.name; if (t.function?.arguments) argText += t.function.arguments; }
        const u = ev.usage ?? ev.x_groq?.usage;
        if (u) usage = { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 };
      }
    } catch (e) { if (!stoppedBy(o)) throw e; stopped = true; }
    let args: Record<string, unknown> = {};
    if (argText) { try { args = JSON.parse(argText); } catch { args = {}; } }
    return { text: text.trim(), toolCall: name && !stopped ? { name, args } : undefined, usage, ...(stopped ? { stopped } : {}) };
  }
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
  const req = {
    model: config.model,
    max_tokens: o.maxTokens ?? 1500,
    system: o.system,
    tools: o.tools?.map((t) => ({ name: t.name, description: t.description, input_schema: z.toJSONSchema(t.schema, { io: "input" }) as any })),
    messages: o.messages,
  };
  if (streams(o)) {
    const live = new Anthropic({ apiKey: config.anthropicKey, timeout: STREAM_TIMEOUT_MS, maxRetries: 0 });
    const st = live.messages.stream(req);
    let text = "";
    st.on("text", (delta: string) => { text += delta; o.onText!(text); });
    const onStop = () => st.abort();
    o.signal?.addEventListener("abort", onStop, { once: true });
    try {
      const res = await st.finalMessage();
      const tool = res.content.find((c) => c.type === "tool_use");
      return {
        text: res.content.filter((c) => c.type === "text").map((c: any) => c.text).join("\n").trim(),
        toolCall: tool && tool.type === "tool_use" ? { name: tool.name, args: tool.input as any } : undefined,
        usage: { input: res.usage.input_tokens, output: res.usage.output_tokens },
      };
    } catch (e) {
      if (!stoppedBy(o)) throw e;
      return { text: text.trim(), usage: { input: 0, output: 0 }, stopped: true };
    } finally { o.signal?.removeEventListener("abort", onStop); }
  }
  const res = await client.messages.create(req);
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
  const live = streams(o);
  const post = (model: string) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:${live ? "streamGenerateContent?alt=sse&" : "generateContent?"}key=${config.geminiKey}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: signalFor(o, live ? STREAM_TIMEOUT_MS : o.grounded ? CALL_TIMEOUT_MS * 3 : CALL_TIMEOUT_MS),
  });
  const main = resolved.gemini ?? config.geminiModel;
  let r = await post(main);
  if (r.status === 404) {
    const found = await discoverGemini();
    if (found && found !== main) { r = await post(found); if (r.ok) resolved.gemini = found; }
  }
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
  if (live) {
    let text = "", fc: any = null, usage = { input: 0, output: 0 }, grounding: { uri: string; title?: string }[] = [], stopped = false;
    try {
      for await (const ev of sseEvents(r)) {
        const c = ev.candidates?.[0];
        for (const p of c?.content?.parts ?? []) {
          if (p.functionCall) fc = p.functionCall;
          else if (typeof p.text === "string" && !p.thought) { text += p.text; if (!fc) o.onText!(text); }
        }
        for (const g of c?.groundingMetadata?.groundingChunks ?? []) if (g.web?.uri) grounding.push({ uri: g.web.uri, title: g.web.title });
        if (ev.usageMetadata) usage = { input: ev.usageMetadata.promptTokenCount ?? 0, output: ev.usageMetadata.candidatesTokenCount ?? 0 };
      }
    } catch (e) { if (!stoppedBy(o)) throw e; stopped = true; }
    return { text: text.trim(), toolCall: fc && !stopped ? { name: fc.name, args: fc.args ?? {} } : undefined, usage, grounding, ...(stopped ? { stopped } : {}) };
  }
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
