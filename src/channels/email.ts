/**
 * Email as a channel. People email or forward things to the inbound address (Resend gives one free,
 * like lifeline@<id>.resend.app); the reply comes back by email. A forwarded booking, invite or bill
 * is read as information, never as instructions. Linking works like SMS: email "link CODE".
 *
 * Resend posts an email.received webhook (metadata only); the body is fetched from its API.
 * Every webhook is checked against RESEND_WEBHOOK_SECRET (Svix signatures), and mail that fails
 * both SPF and DKIM is ignored, so nobody can write in pretending to be you.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import type { Db } from "../core/db.js";
import { registerSender } from "../core/dispatch.js";
import { buttonsAsText } from "../core/handler.js";
import { canEmail, sendEmail } from "../core/email.js";
import { handleTextChannel, rememberButtons } from "./sms.js";

/** Svix: base64 HMAC-SHA256 of "id.timestamp.body" with the secret after "whsec_", any of the space-separated "v1,…" signatures. */
export function verifySvix(rawBody: string, headers: Record<string, string | undefined>, secret = config.resendWebhookSecret, now = Date.now()): boolean {
  const id = headers["svix-id"], ts = headers["svix-timestamp"], sig = headers["svix-signature"];
  if (!secret || !id || !ts || !sig) return false;
  if (!Number.isFinite(Number(ts)) || Math.abs(now / 1000 - Number(ts)) > 5 * 60) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  return sig.split(" ").some((part) => {
    const [, b64] = part.split(",");
    if (!b64) return false;
    const got = Buffer.from(b64, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** "Ada Obi <ada@x.com>" → "ada@x.com" */
export const bareAddress = (s: string) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim().toLowerCase();

/** The new words in an email: no quoted history, no signature, no "On Tue, X wrote:" trail. Forwarded mail is kept whole. */
export function freshText(text: string, forwarded: boolean): string {
  let t = text.replace(/\r\n/g, "\n");
  if (!forwarded) {
    t = t.split(/\n(?:On .{5,80}wrote:|-{2,} ?Original Message ?-{2,}|From: .+\nSent: )/i)[0];
    t = t.split("\n").filter((l) => !/^>/.test(l)).join("\n");
    t = t.split(/\n-- ?\n|\nSent from my (?:iPhone|Android|phone)/i)[0];
  }
  return t.replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000);
}

export const isForwarded = (subject: string, text: string) => /^\s*(?:fwd?|fw)\s*:/i.test(subject) || /-{3,}\s*Forwarded message\s*-{3,}|Begin forwarded message:/i.test(text);

async function fetchReceived(id: string): Promise<any | null> {
  const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${config.resendKey}` }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) { log.warn({ status: r.status }, "resend fetch failed"); return null; }
  return r.json();
}

/**
 * Is the From address real? SPF alone only proves the envelope sender, not the From line people read,
 * so it never counts. DKIM (Resend reports it aligned with From) or DMARC must pass. No verdicts, no entry.
 */
export const passes = (auth: any) => {
  if (!auth) return false;
  const ok = (v: any) => String(v?.result ?? v?.status ?? v ?? "").toLowerCase() === "pass";
  return ok(auth.dkim) || ok(auth.dmarc);
};

/** Resend retries a webhook it thinks failed; each email is handled once. */
const handled = new Set<string>();
const once = (id: string) => { if (handled.has(id)) return false; handled.add(id); if (handled.size > 2000) handled.delete(handled.values().next().value!); return true; };

/** Newsletters, auto-replies and mailing lists never get an answer, so two robots can't talk forever. */
export function isAutomated(headers: unknown): boolean {
  const h: Record<string, string> = {};
  if (Array.isArray(headers)) for (const x of headers) { if (x?.name) h[String(x.name).toLowerCase()] = String(x.value ?? ""); }
  else if (headers && typeof headers === "object") for (const [k, v] of Object.entries(headers as Record<string, unknown>)) h[k.toLowerCase()] = String(v ?? "");
  return (Boolean(h["auto-submitted"]) && h["auto-submitted"].toLowerCase() !== "no") || /bulk|list|junk/i.test(h["precedence"] ?? "") || Boolean(h["list-unsubscribe"] || h["list-id"]) || Boolean(h["x-autoreply"] || h["x-autorespond"]);
}

/** The whole webhook: verify, fetch, check the sender is real, answer by email. Returns the HTTP status. */
export async function handleInboundEmail(db: Db, rawBody: string, headers: Record<string, string | undefined>): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!verifySvix(rawBody, headers)) return { status: 403, body: { error: "bad signature" } };
  let event: any;
  try { event = JSON.parse(rawBody); } catch { return { status: 400, body: { error: "not json" } }; }
  if (event.type !== "email.received" || !event.data?.email_id) return { status: 200, body: { ignored: true } };
  if (!once(String(event.data.email_id))) return { status: 200, body: { ignored: "already handled" } };
  const mail = await fetchReceived(event.data.email_id);
  if (!mail) return { status: 200, body: { ignored: "unreadable" } };
  const from = bareAddress(String(mail.from ?? event.data.from ?? ""));
  if (!from || from === bareAddress(config.emailFrom) || /no-?reply|mailer-daemon|postmaster/i.test(from)) return { status: 200, body: { ignored: "sender" } };
  if (isAutomated(mail.headers)) return { status: 200, body: { ignored: "automated" } };
  if (!passes(mail.authentication)) { log.warn({ from }, "inbound email failed spf and dkim"); return { status: 200, body: { ignored: "unauthenticated" } }; }
  const subject = String(mail.subject ?? event.data.subject ?? "");
  const body = String(mail.text ?? "").trim() || String(mail.html ?? "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " ");
  const forwarded = isForwarded(subject, body);
  const words = freshText(body, forwarded);
  const message = /^\s*link\s+[a-z0-9]{6}\s*$/i.test(subject) ? subject.trim() : forwarded ? `${subject}\n\n${words}` : (words || subject);
  const reply = await handleTextChannel(db, "email", from, message, { forwarded });
  if (!reply) return { status: 200, body: { ignored: "not linked" } };
  if (canEmail()) await sendEmail(from, subject ? (/^re:/i.test(subject) ? subject : `Re: ${subject.replace(/^(?:fwd?|fw)\s*:\s*/i, "")}`) : "lifeline", reply);
  return { status: 200, body: { ok: true } };
}

export function registerEmail() {
  if (!canEmail()) return;
  registerSender("email", async (to, reply) => { rememberButtons(to, reply.buttons); if (!(await sendEmail(to, "lifeline", buttonsAsText(reply)))) throw new Error("email send failed"); });
}
