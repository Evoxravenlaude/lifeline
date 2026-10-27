/**
 * SMS via Twilio. Inbound: Twilio posts form-encoded webhooks to
 * /webhooks/twilio (signature-verified). Outbound: REST API. Buttons are
 * rendered as "1) Confirm  2) Cancel" and the user replies with the number.
 * A phone links to an account by texting "link <code>" (code from Telegram
 * or the web app); unknown numbers get one instruction and nothing else.
 */
import { createHmac } from "node:crypto";
import { config } from "../core/config.js";
import { registerSender } from "../core/dispatch.js";
import { buttonsAsText, findUserByIdentity, handleCallback, handleMessage, redeemLinkCode, type Reply } from "../core/handler.js";
import type { Db } from "../core/db.js";

const lastButtons = new Map<string, { label: string; data: string }[]>(); // phone → buttons of last message

export async function sendSms(to: string, body: string): Promise<void> {
  if (!config.twilioSid || !config.twilioToken || !config.twilioFrom) throw new Error("twilio not configured");
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: config.twilioFrom, Body: body }),
  });
  if (!r.ok) throw new Error(`twilio ${r.status}`);
}

export function registerSms() {
  if (!config.twilioSid) return;
  registerSender("sms", async (phone, reply) => {
    lastButtons.set(phone, reply.buttons ?? []);
    await sendSms(phone, buttonsAsText(reply).slice(0, 1500));
  });
}

/** Twilio request signature: HMAC-SHA1 of URL + sorted POST params, base64. */
export function verifyTwilio(url: string, params: Record<string, string>, signature: string): boolean {
  if (!config.twilioToken) return false;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join("");
  const expected = createHmac("sha1", config.twilioToken).update(data).digest("base64");
  return expected === signature;
}

/** Shared by SMS and iMessage: text in → reply text out. */
export async function handleTextChannel(db: Db, channel: "sms" | "imessage", from: string, text: string): Promise<string> {
  const t = text.trim();
  const link = /^link\s+([a-z0-9]{6})$/i.exec(t);
  let user = await findUserByIdentity(db, channel, from);
  if (link) {
    const u = await redeemLinkCode(db, link[1], channel, from);
    return u ? `Linked. This is the same me${u.name ? `, ${u.name.split(" ")[0]}` : ""}: text me here like you would on Telegram, and reply 1 or 2 where I'd show buttons.` : "That code didn't work; it may have expired, they last fifteen minutes. Say \"link\" on Telegram or the web app for a fresh one.";
  }
  if (!user) return 'This number isn\'t linked to anyone yet. Say "link" to me on Telegram or the web app, then text me "link" and the code you get.';
  const buttons = lastButtons.get(from) ?? [];
  const n = /^\d$/.test(t) ? Number(t) : 0;
  let reply: Reply;
  if (n && buttons[n - 1]) reply = await handleCallback(db, user, buttons[n - 1].data);
  else if (n === 1 || n === 2) reply = await handleMessage(db, user, n === 1 ? "yes" : "no", { channel }); // no buttons cached (restart): 1 = confirm, 2 = cancel latest pending
  else reply = await handleMessage(db, user, t, { channel });
  lastButtons.set(from, reply.buttons ?? []);
  return buttonsAsText(reply);
}
