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
    web ? `On the website: open ${web} and tap Sign in with Telegram. Or type the code there.` : "On the website: tap Sign in with Telegram, or type the code there.",
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
    "There is no app to install and nothing to log into. Every place is the same assistant with the same memory, joined by a six-character code: the person says \"link\" here, gets a code, and sends \"link CODE\" from the other place within fifteen minutes.",
    waysIn(),
  ].join("\n");
}
