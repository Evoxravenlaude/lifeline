/**
 * Outbound dispatcher. Each channel registers a sender; a push goes to the
 * user's preferred channel and falls back down the chain, ending in email.
 *
 * "Both" (prefs.alsoApp): the installed app gets every push as a notification as well,
 * and the usual chain still runs for Telegram. If the app was reached, the chain skips the
 * web inbox (the app already wrote there), and the email last resort is only for when
 * nothing reached the person at all.
 */
import type { Db } from "./db.js";
import { log } from "./log.js";
import { sendEmail } from "./email.js";
import type { Reply, Channel } from "./handler.js";
import { identitiesOf, SIGN_IN_ONLY } from "./handler.js";
import type { User } from "../policy/types.js";

export type Sender = (externalId: string, reply: Reply) => Promise<void>;
const senders = new Map<Channel, Sender>();
export function registerSender(channel: Channel, s: Sender) {
  if (SIGN_IN_ONLY.includes(channel)) throw new Error(`${channel} is a sign-in identity and never carries messages`);
  senders.set(channel, s);
}

const ORDER: Channel[] = ["telegram", "app", "imessage", "sms", "web", "email"];

export async function dispatch(db: Db, user: User, reply: Reply): Promise<boolean> {
  const ids = await identitiesOf(db, user.id);
  const preferred = (user.preferred_channel ?? "telegram") as Channel;
  const chain = [preferred, ...ORDER].filter((c, i, a) => a.indexOf(c) === i && !SIGN_IN_ONLY.includes(c));
  const trySend = async (ch: Channel): Promise<boolean> => {
    const id = ids.find((i) => i.channel === ch)?.external_id;
    const s = senders.get(ch);
    if (!id || !s) return false;
    try { await s(id, reply); return true; }
    catch (e: any) { log.warn({ channel: ch, user: user.id, err: e?.message }, "send failed, falling back"); return false; }
  };
  const alsoApp = user.prefs?.alsoApp === true && preferred !== "app";
  const appReached = alsoApp ? await trySend("app") : false;
  if (appReached) {
    // "Both": the app already has it. Try only the preferred place too; never walk on to a paid text or another inbox.
    if (preferred !== "web") await trySend(preferred);
    return true;
  }
  for (const ch of chain) {
    if (alsoApp && ch === "app") continue;
    if (await trySend(ch)) return true;
  }
  const verified = typeof user.prefs?.emailVerified === "string" ? (user.prefs.emailVerified as string) : null;
  if (verified && (await sendEmail(verified, "lifeline", reply.text))) return true;
  return false;
}
