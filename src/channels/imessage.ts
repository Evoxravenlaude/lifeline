/**
 * iMessage. Apple has no public API, so this goes through one of two relays:
 *  - BlueBubbles: self-hosted on any Mac you own (free). Server posts
 *    webhooks to /webhooks/imessage; we send via its REST API.
 *  - Sendblue: hosted, paid per message, same webhook shape mapped here.
 * Identity = the sender's handle (phone or Apple ID email). Linking works
 * exactly like SMS: "link <code>".
 */
import { config } from "../core/config.js";
import { registerSender } from "../core/dispatch.js";
import { buttonsAsText } from "../core/handler.js";

export async function sendIMessage(to: string, text: string): Promise<void> {
  if (config.imessageProvider === "bluebubbles") {
    const r = await fetch(`${config.bluebubblesUrl}/api/v1/message/text?password=${encodeURIComponent(config.bluebubblesPassword)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatGuid: `iMessage;-;${to}`, message: text, method: "private-api", tempGuid: `lifeline-${Date.now()}` }),
    });
    if (!r.ok) throw new Error(`bluebubbles ${r.status}`);
    return;
  }
  if (config.imessageProvider === "sendblue") {
    const r = await fetch("https://api.sendblue.co/api/send-message", {
      method: "POST", headers: { "content-type": "application/json", "sb-api-key-id": config.sendblueKey, "sb-api-secret-key": config.sendblueSecret },
      body: JSON.stringify({ number: to, content: text }),
    });
    if (!r.ok) throw new Error(`sendblue ${r.status}`);
    return;
  }
  throw new Error("imessage not configured");
}

export function registerIMessage() {
  if (!config.imessageProvider) return;
  registerSender("imessage", async (to, reply) => sendIMessage(to, buttonsAsText(reply)));
}

/** Normalise the two providers' inbound webhook payloads to {from, text}. */
export function parseInbound(body: any): { from: string; text: string } | null {
  // BlueBubbles: { type: "new-message", data: { text, handle: { address }, isFromMe } }
  if (body?.type === "new-message" && body.data && !body.data.isFromMe) {
    const from = body.data.handle?.address ?? body.data.chats?.[0]?.chatIdentifier;
    return from && body.data.text ? { from, text: body.data.text } : null;
  }
  // Sendblue: { number, content, is_outbound, ... }
  if (body?.number && body?.content !== undefined && !body.is_outbound) return { from: body.number, text: body.content };
  return null;
}
