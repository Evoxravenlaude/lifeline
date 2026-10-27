/**
 * Sending email. Two routes, whichever is set:
 *  - SMTP_URL (Gmail with an app password works: smtps://you%40gmail.com:app-password@smtp.gmail.com:465)
 *  - RESEND_API_KEY. Without a verified domain Resend only delivers to the account owner's own address,
 *    so SMTP is the better choice for emailing other people.
 * EMAIL_FROM is the sender, e.g. "lifeline <you@gmail.com>".
 */
import { config } from "./config.js";
import { log } from "./log.js";

let transport: any;

export function canEmail(): boolean {
  return Boolean(config.emailFrom && (config.smtpUrl || config.resendKey));
}

export async function sendEmail(to: string, subject: string, text: string, opts: { replyTo?: string; html?: string } = {}): Promise<boolean> {
  if (!canEmail()) return false;
  try {
    if (config.smtpUrl) {
      if (!transport) {
        const nodemailer = await import("nodemailer");
        transport = nodemailer.createTransport(config.smtpUrl);
      }
      await transport.sendMail({ from: config.emailFrom, to, subject, text, html: opts.html, replyTo: opts.replyTo });
      return true;
    }
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.resendKey}` }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text, ...(opts.html ? { html: opts.html } : {}), ...(opts.replyTo ? { reply_to: opts.replyTo } : {}) }),
    });
    if (!r.ok) { log.warn({ status: r.status, body: (await r.text()).slice(0, 200) }, "resend send failed"); return false; }
    return true;
  } catch (e: any) {
    log.warn({ err: e?.message }, "email send failed");
    return false;
  }
}
