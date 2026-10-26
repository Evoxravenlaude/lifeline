/**
 * Send-only email fallback. Used when a Telegram send fails (block day, token
 * rotation) and the user has set an email. Never reads a mailbox.
 */
import { config } from "./config.js";
import { log } from "./log.js";

let transport: any;

export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  if (!config.smtpUrl || !config.emailFrom) return false;
  try {
    if (!transport) {
      const nodemailer = await import("nodemailer");
      transport = nodemailer.createTransport(config.smtpUrl);
    }
    await transport.sendMail({ from: config.emailFrom, to, subject, text });
    return true;
  } catch (e: any) {
    log.warn({ err: e?.message }, "email send failed");
    return false;
  }
}
