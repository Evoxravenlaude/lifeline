/**
 * Outbound dispatcher. Each channel registers a sender; a push goes to the
 * user's preferred channel and falls back down the chain, ending in email.
 */
import type { Db } from "./db.js";
import { log } from "./log.js";
import { sendEmail } from "./email.js";
import type { Reply, Channel } from "./handler.js";
import { identitiesOf } from "./handler.js";
import type { User } from "../policy/types.js";

export type Sender = (externalId: string, reply: Reply) => Promise<void>;
const senders = new Map<Channel, Sender>();
export function registerSender(channel: Channel, s: Sender) { senders.set(channel, s); }

const ORDER: Channel[] = ["telegram", "imessage", "sms", "web", "email"];

export async function dispatch(db: Db, user: User, reply: Reply): Promise<boolean> {
  const ids = await identitiesOf(db, user.id);
  const chain = [(user.preferred_channel ?? "telegram") as Channel, ...ORDER].filter((c, i, a) => a.indexOf(c) === i);
  for (const ch of chain) {
    const id = ids.find((i) => i.channel === ch)?.external_id;
    const s = senders.get(ch);
    if (!id || !s) continue;
    try { await s(id, reply); return true; }
    catch (e: any) { log.warn({ channel: ch, user: user.id, err: e?.message }, "send failed, falling back"); }
  }
  const verified = typeof user.prefs?.emailVerified === "string" ? (user.prefs.emailVerified as string) : null;
  if (verified && (await sendEmail(verified, "lifeline", reply.text))) return true;
  return false;
}
