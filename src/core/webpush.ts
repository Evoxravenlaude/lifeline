/**
 * The installed app (a PWA): reminders and pings as phone and desktop notifications, for people who
 * mute or block Telegram while they focus. Standard Web Push with VAPID keys (the `web-push` package),
 * so it works in Chrome, Edge, Firefox, Safari on the Mac, and on iPhone from iOS 16.4 once the site is
 * added to the Home Screen. See docs/APP.md.
 *
 * Each browser that says yes is one row in push_subscriptions. The person gets one "app" identity
 * (app:<user id>) while they have at least one, which is how dispatch knows to try it. Subscriptions
 * the push service says are gone (404 or 410) are dropped on the spot.
 */
import { recordPush } from "./health.js";
import { addSchema } from "./plugins.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { registerSender } from "./dispatch.js";
import { toPlain } from "./format.js";
import type { Db } from "./db.js";
import type { Reply } from "./handler.js";

addSchema(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  device TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_ok_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id)
`);

export interface PushSubscriptionJson { endpoint: string; keys: { p256dh: string; auth: string } }
/** The part of `web-push` we use. Tests pass their own. */
export interface PushClient {
  sendNotification(sub: PushSubscriptionJson, payload: string, options: Record<string, unknown>): Promise<{ statusCode?: number }>;
}

let client: PushClient | null = null;
/** Tests: replace the web-push client. Pass null to go back to the real one. */
export function usePushClient(c: PushClient | null) { client = c; }

async function realClient(): Promise<PushClient> {
  const mod: any = await import("web-push");
  const wp = mod.default ?? mod;
  return { sendNotification: (sub, payload, options) => wp.sendNotification(sub, payload, options) };
}

/** Push is on when all three VAPID values are set. */
export function pushOn(): boolean {
  return Boolean(config.vapidPublicKey && config.vapidPrivateKey && /^(mailto:|https:)/.test(config.vapidSubject)) && !vapidProblem();
}

/** What's wrong with the VAPID settings, in words for /doctor, or null when they look right. */
export function vapidProblem(): string | null {
  const bytes = (k: string) => { try { return /^[A-Za-z0-9_-]+$/.test(k) ? Buffer.from(k, "base64url") : null; } catch { return null; } };
  if (!config.vapidPublicKey || !config.vapidPrivateKey || !config.vapidSubject) return "set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT";
  const pub = bytes(config.vapidPublicKey), priv = bytes(config.vapidPrivateKey);
  if (!pub || pub.length !== 65 || pub[0] !== 4) return "VAPID_PUBLIC_KEY doesn't look like the public key from `npx web-push generate-vapid-keys` (it should be about 87 characters, starting with B)";
  if (!priv || priv.length !== 32) return "VAPID_PRIVATE_KEY doesn't look like the private key from the same command (about 43 characters)";
  if (!/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(config.vapidSubject)) return "VAPID_SUBJECT should be mailto: and your email, like mailto:you@example.com";
  return null;
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;
/** The real push services (Chrome and Android, Firefox, Safari and iOS, Edge and Windows). Nothing else is ever posted to. */
export const PUSH_HOSTS = /(?:^|\.)(?:fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|push\.apple\.com|notify\.windows\.com)$/i;
/** A subscription from the browser, checked: an https endpoint and the two keys, nothing else kept. */
export function cleanSubscription(raw: any): PushSubscriptionJson | null {
  const endpoint = typeof raw?.endpoint === "string" ? raw.endpoint.trim() : "";
  const p256dh = typeof raw?.keys?.p256dh === "string" ? raw.keys.p256dh.trim() : "";
  const auth = typeof raw?.keys?.auth === "string" ? raw.keys.auth.trim() : "";
  if (!endpoint || endpoint.length > 1000 || !p256dh || p256dh.length > 200 || !auth || auth.length > 100) return null;
  if (!B64URL.test(p256dh) || !B64URL.test(auth)) return null;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:" || !PUSH_HOSTS.test(u.hostname)) return null;
  } catch { return null; }
  return { endpoint, keys: { p256dh, auth } };
}

export async function subscribe(db: Db, userId: number, sub: PushSubscriptionJson, device?: string): Promise<void> {
  // One endpoint belongs to one browser; if someone else signed in there before, it moves to whoever is here now.
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id=EXCLUDED.user_id, p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth, device=EXCLUDED.device`,
    [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, device ? device.slice(0, 80) : null],
  );
  await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,'app',$2) ON CONFLICT (channel, external_id) DO UPDATE SET user_id=EXCLUDED.user_id, verified=true`, [userId, `app:${userId}`]);
  await tidyIdentity(db);
}

export async function unsubscribe(db: Db, userId: number, endpoint: string): Promise<void> {
  await db.query(`DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2`, [userId, endpoint]);
  await tidyIdentity(db, userId);
}

/** No subscriptions left means no "app" identity, so dispatch moves straight on. */
async function tidyIdentity(db: Db, userId?: number) {
  await db.query(
    `DELETE FROM identities i WHERE i.channel='app' ${userId ? "AND i.user_id=$1" : ""} AND NOT EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.user_id=i.user_id)`,
    userId ? [userId] : [],
  );
}

export async function devicesOf(db: Db, userId: number): Promise<number> {
  return Number((await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM push_subscriptions WHERE user_id=$1`, [userId]))?.n ?? 0);
}

/** Which page a notification opens: doses on Health, reminders and anything waiting on Today, the rest in Chat. */
export function viewFor(reply: Reply): string {
  const data = (reply.buttons ?? []).map((b) => b.data).join(" ");
  if (/\bmed:/.test(data)) return "health";
  if (/\b(?:rem|confirm|cancel):/.test(data)) return "today";
  return "chat";
}

/**
 * Notifications show on lock screens, where anyone nearby can read them. Health, cycle, mood, quitting, grief,
 * safety and remembered facts never appear there in full: the notification says what sort of thing it is and
 * the details wait inside the app. The morning brief shows its first line only (its other lines carry doses and the cycle).
 */
const PRIVATE_KINDS = /^(?:medication|cycle|measure|memory|safety|well(?:_|$))/;
const PRIVATE_BUTTONS = /^(?:med|sf|wb):/;
export function privateBody(reply: Reply): string | null {
  const kind = reply.kind ?? "";
  const data = (reply.buttons ?? []).map((b) => b.data);
  if (kind === "medication" || data.some((d) => d.startsWith("med:"))) return "A medication reminder. Open lifeline for the details.";
  if (/^safety/.test(kind) || data.some((d) => d.startsWith("sf:"))) return "A safety message from lifeline. Open it to read.";
  if (PRIVATE_KINDS.test(kind) || data.some((d) => PRIVATE_BUTTONS.test(d))) return "Something private from lifeline. Open it to read.";
  return null;
}

/** What the service worker shows. At most two buttons, since that's what most platforms allow. */
export function notificationFor(reply: Reply): Record<string, unknown> {
  const hidden = privateBody(reply);
  const plain = toPlain(reply.text).replace(/\n{3,}/g, "\n\n").trim();
  const body = hidden ?? (reply.kind === "digest" ? plain.split("\n")[0] : plain);
  // A yes that moves money or reaches someone is never pressed from a lock screen: that one opens the app.
  const actions = (reply.buttons ?? []).filter((b) => b.data.length <= 64 && !/^(?:confirm|cancel):/.test(b.data)).slice(0, 2).map((b) => ({ action: b.data, title: b.label.slice(0, 40) }));
  const view = viewFor(reply);
  return {
    title: "lifeline",
    body: body.length > 600 ? `${body.slice(0, 597)}...` : body,
    private: Boolean(hidden),
    tag: `ll-${Date.now().toString(36)}`,
    url: `/#${view}`,
    actions,
    // Without actions on this platform, the notification opens the app where the buttons are.
    buttons: (reply.buttons ?? []).slice(0, 4),
  };
}

/** Send one reply to every browser the person turned notifications on in. True when at least one took it. */
export async function sendToApp(db: Db, userId: number, reply: Reply): Promise<boolean> {
  if (!pushOn()) return false;
  const subs = await db.query<{ id: number; endpoint: string; p256dh: string; auth: string }>(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=$1`, [userId]);
  if (!subs.length) return false;
  const c = client ?? (await realClient());
  const payload = JSON.stringify(notificationFor(reply));
  const urgent = /\b(?:rem|med):/.test((reply.buttons ?? []).map((b) => b.data).join(" "));
  const options = {
    TTL: 12 * 3600,
    urgency: urgent ? "high" : "normal",
    vapidDetails: { subject: config.vapidSubject, publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey },
  };
  let reached = 0;
  for (const s of subs) {
    try {
      await c.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options);
      reached++;
      await db.query(`UPDATE push_subscriptions SET last_ok_at=now() WHERE id=$1`, [s.id]);
      await recordPush(db, userId, true, 201);
    } catch (e: any) {
      const status = Number(e?.statusCode ?? 0);
      await recordPush(db, userId, false, status || null);
      // 404 and 410: the browser dropped it. 403 with a VAPID complaint: it was made with an older server key and can
      // never be reached again. Either way it goes, and the page makes a fresh one on its next visit (resumePush).
      if (status === 404 || status === 410 || (status === 403 && /vapid|credential/i.test(String(e?.body ?? e?.message ?? "")))) {
        await db.query(`DELETE FROM push_subscriptions WHERE id=$1`, [s.id]);
        log.info({ user: userId, status }, "push subscription gone, dropped");
      } else log.warn({ user: userId, status, err: String(e?.message ?? "").slice(0, 120) }, "push send failed");
    }
  }
  await tidyIdentity(db, userId);
  return reached > 0;
}

/** The "app" sender for dispatch. The message also lands in the web chat, like the web inbox does. */
export function registerApp(db: Db) {
  registerSender("app", async (externalId, reply) => {
    const userId = Number(/^app:(\d+)$/.exec(externalId)?.[1]);
    if (!userId) throw new Error("bad app identity");
    if (!(await sendToApp(db, userId, reply))) throw new Error("no device took the notification");
    await db.query(`INSERT INTO messages (user_id, role, content) VALUES ($1,'assistant',$2)`, [userId, reply.text]);
  });
}

/** What the website needs to know, for /api/public. The public key is meant to be public. */
export function pushPublic(): { on: boolean; key: string | null } {
  return pushOn() ? { on: true, key: config.vapidPublicKey } : { on: false, key: null };
}
