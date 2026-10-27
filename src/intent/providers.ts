/**
 * Model providers behind one interface. Anthropic (SDK) and Gemini (REST).
 * MODEL_PROVIDER picks; default is whichever key is set (Anthropic first).
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
export const diagnostics: { lastError: string | null; lastOkAt: number | null; lastErrorAt: number | null } = { lastError: null, lastOkAt: null, lastErrorAt: null };

export function providerName(): Provider | null {
  const p = config.modelProvider;
  if (p === "anthropic" && config.anthropicKey) return "anthropic";
  if (p === "gemini" && config.geminiKey) return "gemini";
  if (p === "openai" && config.openaiCompatKey) return "openai";
  if (config.anthropicKey) return "anthropic";
  if (config.geminiKey) return "gemini";
  if (config.openaiCompatKey) return "openai";
  return null;
}

export async function complete(opts: CompleteOpts, forceProvider?: Provider): Promise<Completion | null> {
  const p = forceProvider ?? providerName();
  if (!p) return null;
  const run = () => (p === "anthropic" ? anthropic(opts) : p === "gemini" ? gemini(opts) : openaiCompat(opts));
  try {
    const r = await run();
    diagnostics.lastOkAt = Date.now();
    return r;
  } catch (e: any) {
    diagnostics.lastError = `${p}: ${e?.message ?? e}`.slice(0, 300);
    diagnostics.lastErrorAt = Date.now();
    // Many endpoints choke on a large tool list; the conversation must survive that.
    if (opts.tools?.length) {
      try {
        const r = await (p === "anthropic" ? anthropic({ ...opts, tools: undefined }) : p === "gemini" ? gemini({ ...opts, tools: undefined }) : openaiCompat({ ...opts, tools: undefined }));
        diagnostics.lastOkAt = Date.now();
        return r;
      } catch (e2: any) {
        diagnostics.lastError = `${p}: ${e2?.message ?? e2}`.slice(0, 300);
        throw e2;
      }
    }
    throw e;
  }
}

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
  const r = await fetch(`${config.openaiCompatBaseUrl}/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.openaiCompatKey}` }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${config.openaiCompatBaseUrl} ${r.status}: ${(await r.text()).slice(0, 200)}`);
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
  const client = new Anthropic({ apiKey: config.anthropicKey });
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
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
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
