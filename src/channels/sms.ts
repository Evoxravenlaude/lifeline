/**
 * SMS. Three routes, one behaviour:
 *
 *  twilio   Twilio number. Inbound: form-encoded webhook to /webhooks/twilio (signature-verified),
 *           reply in the TwiML response. Outbound: Twilio REST.
 *  httpsms  An Android phone with a local SIM running httpSMS (open source). Inbound: JSON
 *           CloudEvent to /webhooks/sms/httpsms, signed as an HS256 JWT in the Authorization
 *           header with the webhook's signing key. Outbound: POST /v1/messages/send.
 *  textbee  An Android phone running TextBee (open source). Inbound: JSON to /webhooks/sms/textbee
 *           with X-Signature = hex HMAC-SHA256 of the body. Outbound: POST /gateway/send-sms.
 *
 * Docs used (Oct 2026):
 *  https://docs.httpsms.com/webhooks/introduction   (JWT HS256 Authorization header, X-Event-Type)
 *  https://docs.httpsms.com/webhooks/events         (message.phone.received: data.contact, data.owner, data.content)
 *  https://github.com/caronc/apprise/wiki/Notify_httpsms (send endpoint and x-api-key)
 *  https://textbee.dev/quickstart                   (send-sms endpoint, x-api-key, recipients/message)
 *  https://textbee.dev/blog/receive-sms-webhook-android-gateway (MESSAGE_RECEIVED payload, X-Signature)
 *
 * Buttons are rendered as "1) Confirm  2) Cancel" and the person replies with the number.
 * A phone links to an account by texting "link <code>" (code from Telegram or the web app);
 * unknown numbers get one instruction and nothing else.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { pluginTextReplyHandlers } from "../core/plugins.js";
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import { registerSender } from "../core/dispatch.js";
import { buttonsAsText, findUserByIdentity, handleCallback, handleMessage, redeemLinkCode, type Reply } from "../core/handler.js";
import type { Db } from "../core/db.js";

export type SmsProvider = "twilio" | "httpsms" | "textbee";

const lastButtons = new Map<string, { label: string; data: string }[]>(); // phone, Apple ID or email → buttons of the last message we sent it
/** Every text channel records what its last message offered, so "1" means what the person was looking at. */
export function rememberButtons(to: string, buttons: { label: string; data: string }[] | undefined) {
  lastButtons.set(to, buttons ?? []);
  if (lastButtons.size > 2000) lastButtons.delete(lastButtons.keys().next().value!);
}

/** The live SMS route: SMS_PROVIDER if set and configured, else whichever is configured. */
export function smsProvider(): SmsProvider | null {
  const twilio = Boolean(config.twilioSid && config.twilioToken && config.twilioFrom);
  const gateway = Boolean(config.smsGatewayKey);
  const p = config.smsProvider;
  if (p === "twilio") return twilio ? "twilio" : null;
  if (p === "httpsms" || p === "textbee") return gateway ? p : null;
  if (twilio) return "twilio";
  if (gateway) return "httpsms";
  return null;
}

/** E.164 for numbers gateways report in local form: 0801 234 5678 → +2348012345678. Already-international numbers pass through. */
export function normalisePhone(raw: string, country = config.smsDefaultCountry): string {
  const s = String(raw ?? "").trim();
  if (!s) return s;
  const plus = s.startsWith("+");
  const digits = s.replace(/\D/g, "");
  if (plus) return `+${digits}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (country && digits.startsWith(country) && digits.length > country.length + 7) return `+${digits}`;
  if (digits.startsWith("0") && country) return `+${country}${digits.slice(1)}`;
  return `+${digits}`;
}

export async function sendSms(to: string, body: string, via?: SmsProvider): Promise<void> {
  const p = via ?? smsProvider();
  if (!p) throw new Error("sms not configured");
  const text = body.slice(0, 1500);
  if (p === "twilio") {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`, {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: config.twilioFrom, Body: text }),
    });
    if (!r.ok) throw new Error(`twilio ${r.status}`);
    return;
  }
  if (p === "httpsms") {
    const r = await fetch("https://api.httpsms.com/v1/messages/send", {
      method: "POST",
      headers: { "x-api-key": config.smsGatewayKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ from: normalisePhone(config.smsGatewayFrom), to, content: text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) throw new Error(`httpsms ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return;
  }
  const r = await fetch("https://api.textbee.dev/api/v1/gateway/send-sms", {
    method: "POST",
    headers: { "x-api-key": config.smsGatewayKey, "content-type": "application/json" },
    body: JSON.stringify({ recipients: [to], message: text, ...(config.smsGatewayFrom ? { deviceId: config.smsGatewayFrom } : {}) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`textbee ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

export function registerSms() {
  const p = smsProvider();
  if (!p) return;
  registerSender("sms", async (phone, reply) => {
    rememberButtons(phone, reply.buttons);
    await sendSms(phone, buttonsAsText(reply));
  });
}

/** Twilio request signature: HMAC-SHA1 of URL + sorted POST params, base64. */
export function verifyTwilio(url: string, params: Record<string, string>, signature: string): boolean {
  if (!config.twilioToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", config.twilioToken).update(data).digest("base64");
  return expected === signature;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** httpSMS: "Authorization: Bearer <JWT>" signed HS256 with the webhook signing key. Checks alg, signature, exp and nbf. */
export function verifyHttpSmsJwt(authorization: string, secret = config.smsWebhookSecret, now = Date.now()): boolean {
  if (!secret) return false;
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  let header: any, claims: any;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch { return false; }
  if (header?.alg !== "HS256") return false;
  const expected = b64url(createHmac("sha256", secret).update(`${parts[0]}.${parts[1]}`).digest());
  if (!safeEq(expected, parts[2])) return false;
  const sec = Math.floor(now / 1000);
  if (typeof claims?.exp === "number" && sec > claims.exp + 60) return false;
  if (typeof claims?.nbf === "number" && sec + 60 < claims.nbf) return false;
  return true;
}

/** TextBee: X-Signature is a hex HMAC-SHA256 of the JSON body. We check the raw bytes and, failing that, the compact re-serialisation. */
export function verifyTextBee(rawBody: string, signature: string, secret = config.smsWebhookSecret): boolean {
  if (!secret || !signature) return false;
  const sig = signature.replace(/^sha256=/i, "").trim().toLowerCase();
  const candidates = [rawBody];
  try { candidates.push(JSON.stringify(JSON.parse(rawBody))); } catch { /* not JSON */ }
  return candidates.some((body) => safeEq(createHmac("sha256", secret).update(body).digest("hex"), sig));
}

export interface InboundSms { from: string; text: string; self: boolean }

/** Pull sender and text out of a gateway webhook body. Returns null for events that aren't incoming texts. */
export function parseGatewayInbound(provider: "httpsms" | "textbee", body: any, eventHeader = ""): InboundSms | null {
  const own = config.smsGatewayFrom ? normalisePhone(config.smsGatewayFrom) : "";
  if (provider === "httpsms") {
    const type = body?.type ?? eventHeader;
    if (type !== "message.phone.received") return null;
    const d = body?.data ?? {};
    if (!d.contact || typeof d.content !== "string") return null;
    const from = normalisePhone(d.contact);
    return { from, text: d.content, self: Boolean(own && from === own) };
  }
  const event = body?.webhookEvent ?? eventHeader;
  if (event && event !== "MESSAGE_RECEIVED") return null;
  if (!body?.sender || typeof body?.message !== "string") return null;
  const from = normalisePhone(body.sender);
  return { from, text: body.message, self: Boolean(own && /^\+/.test(own) && from === own) };
}

/**
 * Wrong link codes by text, iMessage or email: five per sender an hour, sixty across everyone, like /auth/link on the
 * web. A sender with their own mail domain could otherwise try codes cheaply until one lands on someone's account.
 */
const misses = new Map<string, number[]>();
const HOUR = 3_600_000;
function tooManyMisses(from: string, now = Date.now()): boolean {
  const recent = (k: string) => (misses.get(k) ?? []).filter((t) => now - t < HOUR);
  return recent(from).length >= 5 || recent("*").length >= 60;
}
function missed(from: string, now = Date.now()) {
  for (const k of [from, "*"]) misses.set(k, [...(misses.get(k) ?? []).filter((t) => now - t < HOUR), now]);
}
export const _linkMisses = misses; // tests

/** Shared by SMS and iMessage: text in → reply text out. */
export async function handleTextChannel(db: Db, channel: "sms" | "imessage" | "email", from: string, text: string, opts: { forwarded?: boolean } = {}): Promise<string> {
  const t = text.trim();
  for (const h of pluginTextReplyHandlers()) {
    const said = await h(db, channel, from, t).catch(() => null);
    if (said) return said;
  }
  const link = /^link\s+([a-z0-9]{6})\b/i.exec(t);
  const user = await findUserByIdentity(db, channel, from);
  const thing = channel === "email" ? "address" : "number";
  const verb = channel === "email" ? "email" : "text";
  if (link) {
    if (tooManyMisses(from)) return "Too many codes that didn't work. Wait an hour, then get a fresh one: say \"link\" on Telegram or the web app.";
    const u = await redeemLinkCode(db, link[1], channel, from);
    if (!u) missed(from);
    return u ? `Linked. This is the same me${u.name ? `, ${u.name.split(" ")[0]}` : ""}: ${verb} me here like you would on Telegram, and reply 1 or 2 where I'd show buttons.${channel === "email" ? " You can forward me emails too, and I'll pull out what matters." : ""}` : "That code didn't work; it may have expired, they last fifteen minutes. Say \"link\" on Telegram or the web app for a fresh one.";
  }
  // Strangers get silence unless they're clearly trying to reach lifeline. The relay may sit on someone's own
  // phone or Mac, and their friends shouldn't get bot replies.
  if (!user && !(channel === "email" ? /^\s*link\b|\blifeline\b/i : /\b(?:lifeline|link)\b/i).test(t)) return "";
  if (!user) return `This ${thing} isn't linked to anyone yet. Say "link" to me on Telegram or the web app, then ${verb} me "link" and the code you get.`;
  const buttons = lastButtons.get(from) ?? [];
  const n = /^\d$/.test(t) ? Number(t) : 0;
  let reply: Reply;
  if (n && buttons[n - 1]) reply = await handleCallback(db, user, buttons[n - 1].data);
  else if (n) reply = { text: `Those numbers were for an earlier message. Say what you'd like in words, or "yes" or "no" for anything waiting.` };
  else reply = await handleMessage(db, user, t, { channel, forwarded: opts.forwarded });
  rememberButtons(from, reply.buttons?.filter((b) => !b.data.startsWith("url:") && !b.data.startsWith("webapp:")));
  return buttonsAsText(reply);
}

/**
 * A gateway webhook end to end: verify, parse, answer through the gateway.
 * Returns the HTTP status to send back. The reply goes out by API, not in the response.
 */
export async function handleGatewayWebhook(db: Db, provider: string, rawBody: string, headers: Record<string, string | undefined>): Promise<{ status: number; body: Record<string, unknown> }> {
  if (provider !== "httpsms" && provider !== "textbee") return { status: 404, body: { error: "unknown provider" } };
  const ok = provider === "httpsms" ? verifyHttpSmsJwt(headers.authorization ?? "") : verifyTextBee(rawBody, headers["x-signature"] ?? "");
  if (!ok) return { status: 403, body: { error: "bad signature" } };
  let body: any;
  try { body = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "not json" } }; }
  const msg = parseGatewayInbound(provider, body, headers["x-event-type"] ?? "");
  if (!msg) return { status: 200, body: { ignored: true } };
  if (msg.self) return { status: 200, body: { ignored: "own number" } };
  const reply = await handleTextChannel(db, "sms", msg.from, msg.text);
  if (!reply) return { status: 200, body: { ignored: "not linked" } };
  try { await sendSms(msg.from, reply, provider); }
  catch (e: any) { log.warn({ err: e?.message, provider }, "sms reply failed"); }
  return { status: 200, body: { ok: true } };
}
