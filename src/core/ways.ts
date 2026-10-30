/**
 * How to reach lifeline from each place, stated from what's actually switched on.
 * Used by "link", by "can you do iMessage", and given to the model so it never invents an app or a login.
 */
import { config } from "./config.js";

export function webAddress(): string {
  return config.webUrl || config.webOrigins[0] || config.publicUrl || "";
}
const smsOn = () => Boolean((config.twilioSid && config.twilioToken && config.twilioFrom) || config.smsGatewayKey);
const imessageOn = () => Boolean(config.imessageProvider);
const emailOn = () => Boolean(config.resendKey && config.resendWebhookSecret && config.inboundEmail);
export const emailInOn = emailOn;

/**
 * One tap to link an email address: an email already addressed to lifeline, with the code as its subject and body,
 * so the person only presses Send. Telegram buttons can't open mailto: directly, so the button opens a small page on
 * the website that hands over to the mail app (web/mail-link.html). Null when email in isn't switched on.
 */
export function mailLink(code: string): { mailto: string; page: string | null; address: string } | null {
  if (!emailOn()) return null;
  const to = config.inboundEmail;
  const q = `subject=${encodeURIComponent(`link ${code}`)}&body=${encodeURIComponent(`link ${code}\n\n(Just press send. This links this email address to your lifeline.)`)}`;
  const web = webAddress().replace(/\/$/, "");
  return { mailto: `mailto:${to}?${q}`, page: /^https:\/\//.test(web) ? `${web}/mail-link?to=${encodeURIComponent(to)}&c=${encodeURIComponent(code)}` : null, address: to };
}

/** Where people can reach lifeline right now, as a phrase: "Telegram, the website and text messages". */
export function activePlaces(): string {
  const p = ["Telegram", "the website", ...(smsOn() ? ["text messages"] : []), ...(imessageOn() ? ["iMessage"] : []), ...(emailOn() ? ["email"] : [])];
  return p.length > 1 ? `${p.slice(0, -1).join(", ")} and ${p[p.length - 1]}` : p[0];
}

/** One line per place, for a person. `code` is filled in when we've just made one. */
export function waysIn(code?: string): string {
  const c = code ? `\`link ${code}\`` : "link and the code";
  const web = webAddress();
  const lines = [
    web ? `On the website or the app: open ${web} and sign in (Telegram, or the other ways shown there). You can install it from there as an app. Or type the code there.` : "On the website: sign in with Telegram, or type the code there.",
    smsOn()
      ? config.smsNumber ? `By text message: send ${c} to ${config.smsNumber}.` : `By text message: send ${c} to the lifeline number.`
      : "By text message: not switched on for this circle yet.",
    imessageOn()
      ? config.imessageAddress ? `On iMessage: send ${c} to ${config.imessageAddress} from your iPhone.` : `On iMessage: send ${c} to the lifeline iMessage address from your iPhone.`
      : "On iMessage: not switched on yet. Apple has no public way in, so it needs a Mac relay set up by whoever runs lifeline.",
    ...(emailOn() ? [`By email: send ${c} to ${config.inboundEmail}, from the address you'll use. After that, email or forward me anything.`] : []),
  ];
  return lines.join("\n");
}

/** The same facts, for the model's instructions. */
export function waysInForModel(): string {
  return [
    "How someone uses lifeline in another place (answer from this, never invent an app, account, password or download):",
    `lifeline has a website and an app: ${webAddress() || "the lifeline website"}. It opens inside Telegram too ("Open the app" in /menu, or say "open the app"), and it can be installed on a phone or computer from the site so reminders arrive as notifications even with Telegram closed. People sign in there with the options the page shows (Telegram first). Never claim there is no website or app.`,
    "Every place is the same assistant with the same memory. To join another place by message, the person says \"link\" here, gets a six-character code, and sends \"link CODE\" from the other place within fifteen minutes.",
    waysIn(),
  ].join("\n");
}
