/**
 * Everything that isn't plain text: hearing voice notes, speaking replies, looking at
 * photos, drawing pictures and searching the web. Each one tries the providers that
 * have keys, in order, and quietly returns null when none can do it, so the caller
 * can say so in words. Model ids change often; each is configurable and has a fallback.
 *
 *   hearing   OpenAI (OPENAI_API_KEY) → Groq Whisper (the Groq key you already have) → Gemini
 *   speaking  Gemini TTS (Interactions API) → Gemini generateContent audio. ffmpeg makes a Telegram voice note.
 *   seeing    Gemini → Groq Llama 4 Scout
 *   drawing   Cloudflare Workers AI (free daily allowance) → Gemini image (paid) → Pollinations (no key, slow)
 *   search    Gemini with Google Search grounding → Groq compound
 */
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { log } from "./log.js";
import { complete } from "../intent/providers.js";

const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const isGroq = () => /groq\.com/.test(config.openaiCompatBaseUrl);
const gkey = () => config.geminiKey;

/** Per-person daily allowances, so one enthusiastic friend can't spend the circle's free quota. */
const LIMITS = { image: 15, speak: 80, see: 60, search: 60, hear: 200 } as const;
const used = new Map<string, number>();
export function allow(kind: keyof typeof LIMITS, userId: number): boolean {
  const k = `${new Date().toISOString().slice(0, 10)}:${kind}:${userId}`;
  const n = used.get(k) ?? 0;
  if (n >= LIMITS[kind]) return false;
  used.set(k, n + 1);
  if (used.size > 5000) for (const key of used.keys()) if (!key.startsWith(new Date().toISOString().slice(0, 10))) used.delete(key);
  return true;
}

/** What this server can do right now, for /doctor, /everything and the model's instructions. */
export function mediaAbilities() {
  return {
    hear: Boolean(config.openaiKey || (config.openaiCompatKey && isGroq()) || gkey()),
    speak: Boolean(gkey()),
    see: Boolean(gkey() || (config.openaiCompatKey && isGroq())),
    draw: Boolean((config.cfAccountId && config.cfApiToken) || (gkey() && config.geminiImageModel) || config.enablePollinations),
    search: Boolean(gkey() || config.openaiKey || (config.openaiCompatKey && isGroq())),
  };
}

/** For /doctor: each ability, on or off, and which route it takes. */
export function abilityLines(): string[] {
  const groq = Boolean(config.openaiCompatKey && isGroq());
  const on = (b: boolean, how: string, off: string) => (b ? `on (${how})` : `off (${off})`);
  return [
    `Hearing voice notes: ${on(Boolean(config.openaiKey || groq || gkey()), config.openaiKey ? "OpenAI" : groq ? `Groq ${config.groqSttModel}` : "Gemini", "needs a Groq, OpenAI or Gemini key")}.`,
    `Looking at photos: ${on(Boolean(gkey() || groq), gkey() ? "Gemini" : "Groq", "needs a Gemini or Groq key")}.`,
    `Drawing: ${on(mediaAbilities().draw, config.cfAccountId && config.cfApiToken ? "Cloudflare" : config.geminiImageModel ? "Gemini" : "Pollinations, slow", "set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN")}.`,
    `Web search: ${on(Boolean(gkey() || groq || config.openaiKey), gkey() ? "Gemini with Google Search" : config.openaiKey ? "OpenAI web search" : "Groq compound", "needs a Gemini, OpenAI or Groq key")}.`,
  ];
}

/* ---------------- hearing ---------------- */

export async function transcribe(audio: Buffer, filename = "voice.ogg", mime = "audio/ogg"): Promise<string | null> {
  const viaOpenAiShape = async (base: string, key: string, model: string) => {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime }), filename);
    form.append("model", model);
    const r = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(45_000) });
    if (!r.ok) throw new Error(`transcription ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const j: any = await r.json();
    return String(j.text ?? "").trim() || null;
  };
  const tries: [string, () => Promise<string | null>][] = [];
  if (config.openaiKey) tries.push(["openai", () => viaOpenAiShape("https://api.openai.com/v1", config.openaiKey, config.sttModel)]);
  if (config.openaiCompatKey && isGroq()) tries.push(["groq", () => viaOpenAiShape(config.openaiCompatBaseUrl, config.openaiCompatKey, config.groqSttModel)]);
  if (gkey()) tries.push(["gemini", async () => {
    let body = audio, type = mime.split(";")[0];
    if (/webm|mp4|m4a/.test(type)) { const o = await toOgg(audio); if (o) { body = o; type = "audio/ogg"; } }
    const j = await geminiGenerate([{ inline_data: { mime_type: type, data: body.toString("base64") } }, { text: "Transcribe this voice note exactly, in the language it's spoken. Output only the words, nothing else." }]);
    return textOf(j)?.trim() || null;
  }]);
  for (const [name, t] of tries) {
    try { const out = await t(); if (out) return out; } catch (e: any) { log.warn({ provider: name, err: e?.message }, "transcribe failed"); }
  }
  return null;
}

/* ---------------- speaking ---------------- */

/** Voices people can pick by feel. Gemini's names are stars; people shouldn't need to know them. */
export const VOICES: Record<string, string> = { warm: "Sulafat", upbeat: "Puck", calm: "Achernar", deep: "Charon", lively: "Sadachbia", gentle: "Vindemiatrix", bright: "Zephyr", easy: "Callirrhoe" };
const STYLE: Record<string, string> = {
  plain: "warm, natural and unhurried, like a friend", hype: "excited and full of energy", dry: "dry and deadpan", coach: "encouraging and firm",
  butler: "measured and formal, like an old-school butler", degen: "playful and cheeky", mentor: "calm and thoughtful", pidgin: "relaxed and warm, Nigerian English", bestie: "chatty and warm, like a best friend with news", savage: "smirking and teasing", chaos: "dramatic and theatrical", custom: "natural",
};

/** Text written for the eye, made speakable: no marks, no links, no codes read out character by character. */
export function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (the draft is in the message) ")
    .replace(/`([^`]+)`/g, (_, s: string) => (s.length > 14 ? "the code in the message" : s))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/https?:\/\/\S+/g, "the link")
    .replace(/0x[0-9a-fA-F]{8,}/g, "that address").replace(/\*\*|__|^#+\s*|^\s*[-*•]\s+/gm, "")
    .replace(/\n{2,}/g, "\n").trim();
}

export interface Speech { ogg?: Buffer; wav: Buffer; seconds: number }

/**
 * Should a reply be spoken as well? "read that to me" (a string to say) always is. Otherwise the person's
 * setting decides: mirror (the default) talks back to voice notes, always, or off. Hype counts as a
 * reply that would like a voice, but "off" still wins. Confirmations and long replies stay text.
 */
export function wantsVoice(prefs: Record<string, unknown>, r: { text: string; speak?: boolean | string; buttons?: { data: string }[] }, spoken: boolean): boolean {
  if (typeof r.speak === "string") return true;
  const pref = (prefs.voiceReplies as string) ?? "mirror";
  if (pref === "off") return false;
  // Long or waiting-on-a-yes replies still get a voice note when someone spoke: a short spoken version (src/core/spoken.ts).
  if (r.buttons?.some((b) => /^confirm:/.test(b.data)) && !spoken) return false;
  return r.speak === true || pref === "always" || (pref === "mirror" && spoken);
}

/** The last speech outcome, for /doctor: which route works, or exactly what each one said. */
export const voiceDiag: { lastOkAt: number | null; route: string | null; errors: string[] } = { lastOkAt: null, route: null, errors: [] };

type TtsRoute = { kind: "interactions" | "generate"; model: string };
let workingRoute: TtsRoute | null = null;
let discovered: string[] | null = null;

/** Every speech model this key can use, newest flash first, from Google's own model list. */
async function discoverTts(): Promise<string[]> {
  if (discovered) return discovered;
  try {
    const r = await fetch(`${GEMINI}/models?pageSize=200`, { headers: { "x-goog-api-key": gkey() }, signal: AbortSignal.timeout(8000) });
    const j: any = r.ok ? await r.json() : {};
    const ids: string[] = (j.models ?? []).map((m: any) => String(m.name).replace(/^models\//, "")).filter((n: string) => /tts/i.test(n));
    const ver = (n: string) => Number(/(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0);
    discovered = ids.sort((a, b) => Number(/lite|pro/.test(a)) - Number(/lite|pro/.test(b)) || ver(b) - ver(a));
  } catch { discovered = []; }
  return discovered;
}

export async function speak(text: string, opts: { voice?: string; persona?: string; ogg?: boolean } = {}): Promise<Speech | null> {
  if (!gkey()) return null;
  const words = speakable(text).slice(0, 1400);
  if (!words) return null;
  const voice = VOICES[opts.voice ?? ""] ?? opts.voice ?? config.ttsVoice;
  const style = STYLE[opts.persona ?? "plain"] ?? STYLE.plain;
  // The route that worked last time first; then the configured models both ways; then whatever Google lists.
  const routes: TtsRoute[] = [
    ...(workingRoute ? [workingRoute] : []),
    { kind: "interactions", model: config.ttsModel }, { kind: "generate", model: config.ttsModel },
    { kind: "generate", model: config.ttsFallbackModel },
  ];
  const errors: string[] = [];
  let wav: Buffer | null = null;
  const tryRoute = async (rt: TtsRoute) => {
    try {
      wav = rt.kind === "interactions" ? await ttsInteractions(words, voice, style, rt.model) : await ttsGenerate(words, voice, style, rt.model);
      if (wav) { workingRoute = rt; voiceDiag.route = `${rt.model} (${rt.kind === "interactions" ? "Interactions API" : "generateContent"})`; voiceDiag.lastOkAt = Date.now(); voiceDiag.errors = []; }
      else errors.push(`${rt.model} via ${rt.kind}: answered without audio`);
    } catch (e: any) { errors.push(`${rt.model} via ${rt.kind}: ${String(e?.message ?? e).slice(0, 220)}`); }
  };
  const seen = new Set<string>();
  for (const rt of routes) { const k = `${rt.kind}:${rt.model}`; if (seen.has(k)) continue; seen.add(k); await tryRoute(rt); if (wav) break; }
  if (!wav) for (const m of (await discoverTts()).slice(0, 3)) {
    for (const kind of ["generate", "interactions"] as const) { const k = `${kind}:${m}`; if (seen.has(k)) continue; seen.add(k); await tryRoute({ kind, model: m }); if (wav) break; }
    if (wav) break;
  }
  if (!wav) { voiceDiag.errors = errors; log.warn({ errors }, "speech failed on every route"); return null; }
  const w = wav as Buffer;
  const seconds = Math.max(1, Math.round((w.length - 44) / (24000 * 2)));
  return { wav: w, ogg: opts.ogg === false ? undefined : (await toOgg(w)) ?? undefined, seconds };
}

/** /doctor's live check: say one word and report what happened. */
export async function probeVoice(): Promise<string> {
  if (!gkey()) return "Speaking: off (needs GEMINI_API_KEY).";
  const sp = await speak("Testing.", { ogg: true });
  if (!sp) return `Speaking: not working right now. What Google said:\n${voiceDiag.errors.map((e) => `  ${e}`).join("\n")}`;
  return `Speaking: working, via ${voiceDiag.route}. ${sp.ogg ? "Voice bubbles: yes (ffmpeg found)." : "Voice bubbles: no, ffmpeg is missing from the server, so replies come as audio files."}`;
}

async function ttsInteractions(text: string, voice: string, style: string, model: string): Promise<Buffer | null> {
  const r = await fetch(`${GEMINI}/interactions`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": gkey() }, signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model,
      input: [{ type: "user_input", content: [{ type: "text", text, annotations: [{ type: "speech_metadata", style }] }] }],
      response_format: { type: "audio" },
      generation_config: { speech_config: [{ voice }] },
    }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 200)}`);
  const data = findAudio(await r.json());
  return data ? asWav(Buffer.from(data, "base64")) : null;
}

async function ttsGenerate(text: string, voice: string, style: string, model: string): Promise<Buffer | null> {
  const r = await fetch(`${GEMINI}/models/${model}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": gkey() }, signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Say in a ${style} voice: ${text}` }] }],
      generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).replace(/\s+/g, " ").slice(0, 200)}`);
  const data = findAudio(await r.json());
  return data ? asWav(Buffer.from(data, "base64")) : null;
}

/** The base64 audio wherever a response keeps it: Interactions steps[].content[] or generateContent inlineData. */
export function findAudio(j: any): string | null {
  const seen = new Set<any>();
  const walk = (o: any): string | null => {
    if (!o || typeof o !== "object" || seen.has(o)) return null;
    seen.add(o);
    if (typeof o.data === "string" && o.data.length > 200 && (o.type === "audio" || /audio/.test(o.mime_type ?? o.mimeType ?? ""))) return o.data;
    if (o.inlineData?.data && /audio/.test(o.inlineData.mimeType ?? "audio")) return o.inlineData.data;
    if (o.inline_data?.data && /audio/.test(o.inline_data.mime_type ?? "audio")) return o.inline_data.data;
    for (const v of Array.isArray(o) ? o : Object.values(o)) { const f = walk(v); if (f) return f; }
    return null;
  };
  return walk(j);
}

/** Gemini returns WAV for unary calls and raw 24 kHz 16-bit mono PCM elsewhere; always hand back a WAV. */
export function asWav(buf: Buffer, rate = 24000): Buffer {
  if (buf.subarray(0, 4).toString("ascii") === "RIFF") return buf;
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + buf.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(buf.length, 40);
  return Buffer.concat([h, buf]);
}

/** WAV → OGG/Opus, the only thing Telegram shows as a voice bubble. Null if ffmpeg isn't installed. */
export const toOgg = (audio: Buffer) => ffmpeg(audio, ["-c:a", "libopus", "-b:a", "32k", "-ac", "1", "-f", "ogg"]);

/** Run ffmpeg over a buffer, with a time limit so a stuck conversion can't pile up. */
function ffmpeg(input: Buffer, outArgs: string[], ms = 30_000): Promise<Buffer | null> {
  return new Promise((resolve) => {
    let p;
    try { p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", "pipe:0", ...outArgs, "pipe:1"]); }
    catch { return resolve(null); }
    const out: Buffer[] = [];
    const timer = setTimeout(() => { p.kill("SIGKILL"); resolve(null); }, ms);
    p.stdout.on("data", (d) => out.push(d));
    p.on("error", () => { clearTimeout(timer); resolve(null); });
    p.on("close", (code) => { clearTimeout(timer); resolve(code === 0 && out.length ? Buffer.concat(out) : null); });
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

/* ---------------- seeing ---------------- */

export interface Seen { reply: string; suggestion: string | null; label: string | null }

const SEE_PROMPT = (question: string) => `Someone sent this picture to their personal assistant${question ? ` with the words: "${question}"` : ""}.
Reply as JSON with three keys:
"reply": a natural, friendly reply. If they asked something, answer it directly. Otherwise say what it is and pull out anything useful: a receipt's shop and total, an event's name, date, time and place, a medicine's name and how often to take it, a document's key points; if it's mostly text, give the text. Be specific. A few short lines at most. If it's a person, describe what you see, never guess who they are.
"suggestion": one sentence they could have typed to their assistant to keep the useful thing, in their words, e.g. "I spent 42.50 at Tesco on groceries", "Davido concert at Eko Hotel on Sat 14 Nov at 7pm", "I take amoxicillin at 8, 14 and 20". null if there's nothing to keep.
"label": a 2 to 4 word button for that, like "Log the spend", "Add to calendar", "Set the doses". null if suggestion is null.`;

export async function see(image: Buffer, mime: string, question = ""): Promise<Seen | null> {
  const tries: [string, () => Promise<string | null>][] = [];
  if (gkey()) tries.push(["gemini", async () => textOf(await geminiGenerate([{ inline_data: { mime_type: mime, data: image.toString("base64") } }, { text: SEE_PROMPT(question) }], { json: true }))]);
  if (config.openaiCompatKey && isGroq()) tries.push(["groq", async () => {
    const r = await fetch(`${config.openaiCompatBaseUrl}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.openaiCompatKey}` }, signal: AbortSignal.timeout(40_000),
      body: JSON.stringify({ model: config.groqVisionModel, response_format: { type: "json_object" }, max_tokens: 800, messages: [{ role: "user", content: [{ type: "text", text: SEE_PROMPT(question) }, { type: "image_url", image_url: { url: `data:${mime};base64,${image.toString("base64")}` } }] }] }),
    });
    if (!r.ok) throw new Error(`groq vision ${r.status}: ${(await r.text()).slice(0, 160)}`);
    return (await r.json() as any).choices?.[0]?.message?.content ?? null;
  }]);
  for (const [name, t] of tries) {
    try {
      const raw = await t();
      if (!raw) continue;
      const j = parseJson(raw);
      if (j?.reply) return { reply: String(j.reply), suggestion: j.suggestion ? String(j.suggestion) : null, label: j.label ? String(j.label).slice(0, 30) : null };
      return { reply: raw.trim(), suggestion: null, label: null };
    } catch (e: any) { log.warn({ provider: name, err: e?.message }, "see failed"); }
  }
  return null;
}

/* ---------------- drawing ---------------- */

export interface Picture { data: Buffer; mime: string; via: string }

/** The few things no picture is drawn for, whatever the voice. Checked against the whole prompt, style included. */
const MINOR = /\b(?:child(?:ren)?|kids?|minors?|teen(?:s|age|ager|agers)?|tween|underage|under ?18|schoolgirls?|schoolboys?|school ?uniform|loli\w*|shota\w*|toddlers?|bab(?:y|ies)|infants?|young (?:girl|boy)s?|little (?:girl|boy)s?|\b1[0-7] ?(?:yo|y\/o|years? old))\b/i;
const SEXUAL = /\b(?:sex\w*|nud(?:e|es|ity)|naked|nsfw|porn\w*|explicit|lingerie|topless|bottomless|erotic\w*|seduc\w*|sensual|fetish\w*|hentai|boobs?|breasts?|nipples?|genital\w*|thong|g-?string|strip(?:per|tease|ping)?|xxx|onlyfans|lewd|horny|aroused)\b/i;
const SUGGESTIVE = /\b(?:bikini|swimsuit|underwear|panties|bra|lingerie|kiss\w*|romantic|dating|in bed|bedroom|body|curvy|hot|attractive|pin-?up|pose|posing|short skirt|tight)\b/i;
export function refuseDrawing(prompt: string): string | null {
  if (MINOR.test(prompt) && (SEXUAL.test(prompt) || SUGGESTIVE.test(prompt))) return "I won't draw that.";
  if (SEXUAL.test(prompt)) return "I keep pictures non-explicit. Want something else?";
  return null;
}

/** Only real picture types reach a page or a chat. */
const IMAGE_TYPES = /^image\/(?:png|jpeg|webp)$/;
const cleanType = (t: string | null | undefined) => { const m = String(t ?? "").split(";")[0].trim().toLowerCase(); return IMAGE_TYPES.test(m) ? m : "image/jpeg"; };

export async function draw(prompt: string): Promise<Picture | null> {
  const tries: [string, () => Promise<Picture | null>][] = [];
  if (config.cfAccountId && config.cfApiToken) tries.push(["cloudflare", async () => {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.cfAccountId}/ai/run/${config.cfImageModel}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.cfApiToken}` }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ prompt, steps: 6 }),
    });
    if (!r.ok) throw new Error(`cloudflare ${r.status}: ${(await r.text()).slice(0, 160)}`);
    if ((r.headers.get("content-type") ?? "").startsWith("image/")) return { data: Buffer.from(await r.arrayBuffer()), mime: cleanType(r.headers.get("content-type")), via: "cloudflare" };
    const j: any = await r.json();
    const b64 = j.result?.image ?? j.image;
    return b64 ? { data: Buffer.from(b64, "base64"), mime: "image/jpeg", via: "cloudflare" } : null;
  }]);
  if (gkey() && config.geminiImageModel) tries.push(["gemini", async () => {
    const r = await fetch(`${GEMINI}/models/${config.geminiImageModel}:generateContent`, {
      method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": gkey() }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }),
    });
    if (!r.ok) throw new Error(`gemini image ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const parts: any[] = (await r.json() as any).candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => (p.inlineData ?? p.inline_data)?.data);
    const d = img?.inlineData ?? img?.inline_data;
    return d ? { data: Buffer.from(d.data, "base64"), mime: cleanType(d.mimeType ?? d.mime_type ?? "image/png"), via: "gemini" } : null;
  }]);
  if (config.enablePollinations) tries.push(["pollinations", async () => {
    const seed = Math.floor(Math.random() * 1e9);
    const r = await fetch(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 900))}?width=1024&height=1024&nologo=true&seed=${seed}`, { signal: AbortSignal.timeout(90_000) });
    if (!r.ok || !(r.headers.get("content-type") ?? "").startsWith("image/")) throw new Error(`pollinations ${r.status}`);
    return { data: Buffer.from(await r.arrayBuffer()), mime: cleanType(r.headers.get("content-type")), via: "pollinations" };
  }]);
  for (const [name, t] of tries) {
    try { const p = await t(); if (p && p.data.length > 1000) return p; } catch (e: any) { log.warn({ provider: name, err: e?.message }, "draw failed"); }
  }
  return null;
}

/* ---------------- searching ---------------- */

export interface Found { answer: string; sources: { uri: string; title?: string }[] }

export async function search(question: string, tz: string): Promise<Found | null> {
  const system = `Answer from a live web search. Today is ${new Date().toLocaleDateString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric" })}. Be direct and specific: names, numbers, dates, prices with currency. A few short lines; a short "- " list if there are several items. Say plainly if results are thin or conflicting. No preamble.`;
  if (gkey()) {
    try {
      const c = await complete({ system, messages: [{ role: "user", content: question }], grounded: true, maxTokens: 900 }, "gemini");
      if (c?.text) return { answer: c.text, sources: dedupe(c.grounding ?? []) };
    } catch (e: any) { log.warn({ err: e?.message }, "search (gemini) failed"); }
  }
  // OpenAI's own web search (Responses API, tool "web_search"), when there's an OpenAI key: answers with real citations.
  if (config.openaiKey) {
    try {
      const r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.openaiKey}` }, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ model: config.openaiSearchModel, tools: [{ type: "web_search" }], instructions: system, input: question, max_output_tokens: 1200 }),
      });
      if (r.ok) {
        const j: any = await r.json();
        const parts = (j.output ?? []).filter((o: any) => o.type === "message").flatMap((o: any) => o.content ?? []).filter((c: any) => c.type === "output_text");
        const text = parts.map((c: any) => c.text).join("\n").trim();
        const sources = parts.flatMap((c: any) => c.annotations ?? []).filter((a: any) => a.type === "url_citation" && /^https?:/.test(a.url)).map((a: any) => ({ uri: String(a.url), title: a.title ? String(a.title) : undefined }));
        if (text) return { answer: text, sources: dedupe(sources) };
      } else log.warn({ status: r.status }, "search (openai) failed");
    } catch (e: any) { log.warn({ err: e?.message }, "search (openai) failed"); }
  }
  if (config.openaiCompatKey && isGroq()) {
    try {
      const r = await fetch(`${config.openaiCompatBaseUrl}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.openaiCompatKey}` }, signal: AbortSignal.timeout(60_000),
        body: JSON.stringify({ model: config.groqSearchModel, max_tokens: 900, messages: [{ role: "system", content: system }, { role: "user", content: question }] }),
      });
      if (r.ok) {
        const j: any = await r.json();
        const msg = j.choices?.[0]?.message ?? {};
        const text = msg.content;
        // Groq's compound model reports the searches it ran, with each result's title and address: those are the sources.
        const found = (msg.executed_tools ?? []).flatMap((t: any) => t?.search_results?.results ?? []);
        const sources = found.filter((x: any) => /^https?:/.test(String(x?.url ?? ""))).map((x: any) => ({ uri: String(x.url), title: x.title ? String(x.title) : undefined }));
        if (text) return { answer: String(text).trim(), sources: dedupe(sources) };
      } else log.warn({ status: r.status }, "search (groq) failed");
    } catch (e: any) { log.warn({ err: e?.message }, "search (groq) failed"); }
  }
  return null;
}

const dedupe = (s: { uri: string; title?: string }[]) => s.filter((x, i, a) => a.findIndex((y) => (y.title ?? y.uri) === (x.title ?? x.uri)) === i).slice(0, 4);

/* ---------------- shared ---------------- */

async function geminiGenerate(parts: any[], o: { json?: boolean } = {}): Promise<any> {
  const model = config.geminiModel;
  const r = await fetch(`${GEMINI}/models/${model}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": gkey() }, signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { maxOutputTokens: 1200, ...(o.json ? { responseMimeType: "application/json" } : {}) } }),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
const textOf = (j: any): string | null => (j?.candidates?.[0]?.content?.parts ?? []).filter((p: any) => p.text).map((p: any) => p.text).join("\n") || null;
export function parseJson(s: string): any {
  try { return JSON.parse(s); } catch {}
  const m = /\{[\s\S]*\}/.exec(s);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
