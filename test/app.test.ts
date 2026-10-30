/**
 * The installable app: push subscriptions per person and device, the "app" sender (web-push is mocked),
 * dropping subscriptions the push service says are gone, "Where should reminders reach you?" including
 * Both, and the files a browser needs to install it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import { readFileSync } from "node:fs";
import { createWeb } from "../src/web/server.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { ensureUser, getUserById, identitiesOf, type Reply } from "../src/core/handler.js";
import { dispatch, registerSender } from "../src/core/dispatch.js";
import { cleanSubscription, notificationFor, usePushClient, type PushClient } from "../src/core/webpush.js";
import * as email from "../src/core/email.js";

let db: Db;
let web: ReturnType<typeof createWeb>;
const saved = { pub: config.vapidPublicKey, priv: config.vapidPrivateKey, subj: config.vapidSubject, token: config.telegramToken };
const pushes: { endpoint: string; payload: any; options: any }[] = [];
let failWith: number | null = null;
const client: PushClient = {
  async sendNotification(sub, payload, options) {
    if (failWith) { const e: any = new Error(`push service said ${failWith}`); e.statusCode = failWith; throw e; }
    pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), options });
    return { statusCode: 201 };
  },
};
const telegramSent: { to: string; reply: Reply }[] = [];
let telegramDown = false;

const sub = (n: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/device-${n}`, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } });

/** Sign someone in the way the website does: a Telegram user given a session through the link-code route. */
async function signIn(tgId: string, name: string) {
  const u = await ensureUser(db, "telegram", tgId, name);
  const { createLinkCode } = await import("../src/core/handler.js");
  const code = await createLinkCode(db, u.id);
  const r = await web.request("/auth/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const cookie = /ll_session=[0-9a-f]{64}/.exec(r.headers.get("set-cookie") ?? "")![0];
  return { user: u, cookie };
}
async function call(path: string, body: unknown, cookie: string, method = "POST") {
  const r = await web.request(path, { method, headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
}

beforeAll(async () => {
  db = await openTestDb();
  web = createWeb(db, "lifeline_bot");
  registerSender("telegram", async (to, reply) => { if (telegramDown) throw new Error("telegram down"); telegramSent.push({ to, reply }); });
});
beforeEach(() => {
  // Keys shaped like real ones (a 65-byte public point, a 32-byte private key): pushOn() checks the shape.
  config.vapidPublicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64url");
  config.vapidPrivateKey = Buffer.alloc(32, 9).toString("base64url"); config.vapidSubject = "mailto:owner@example.com";
  usePushClient(client); pushes.length = 0; telegramSent.length = 0; failWith = null; telegramDown = false;
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  config.vapidPublicKey = saved.pub; config.vapidPrivateKey = saved.priv; config.vapidSubject = saved.subj; config.telegramToken = saved.token;
  usePushClient(null);
  await db.close();
});

describe("push subscriptions", () => {
  it("keeps one per device, gives the person an app identity, and lets them go again", async () => {
    const { user, cookie } = await signIn("9001", "Ada");
    const a = await call("/api/push/subscribe", { subscription: sub("a"), device: "Android" }, cookie);
    expect(a.json).toMatchObject({ ok: true, text: "Notifications are on for this device.", devices: 1, telegram: true, reach: "telegram" });
    await call("/api/push/subscribe", { subscription: sub("b"), device: "Mac" }, cookie);
    await call("/api/push/subscribe", { subscription: sub("b"), device: "Mac" }, cookie); // the same browser again
    expect(await db.query(`SELECT device FROM push_subscriptions WHERE user_id=$1 ORDER BY id`, [user.id])).toEqual([{ device: "Android" }, { device: "Mac" }]);
    expect((await identitiesOf(db, user.id)).map((i) => i.channel)).toContain("app");

    await call("/api/push/unsubscribe", { endpoint: sub("a").endpoint }, cookie);
    const off = await call("/api/push/unsubscribe", { endpoint: sub("b").endpoint }, cookie);
    expect(off.json).toMatchObject({ ok: true, devices: 0 });
    expect((await identitiesOf(db, user.id)).map((i) => i.channel)).not.toContain("app");
  });

  it("stops this device's notifications when the person signs out here", async () => {
    const { user, cookie } = await signIn("9003", "Chidi");
    await call("/api/push/subscribe", { subscription: sub("shared") }, cookie);
    await call("/api/push/subscribe", { subscription: sub("own") }, cookie);
    const out = await call("/auth/logout", { endpoint: sub("shared").endpoint }, cookie);
    expect(out.status).toBe(200);
    expect((await db.query<{ endpoint: string }>(`SELECT endpoint FROM push_subscriptions WHERE user_id=$1`, [user.id])).map((r) => r.endpoint)).toEqual([sub("own").endpoint]);
    // Someone else's endpoint is never touched by another person's sign-out.
    const other = await signIn("9004", "Dayo");
    await call("/api/push/subscribe", { subscription: sub("dayo") }, other.cookie);
    const mallory = await signIn("9005", "Mallory");
    await call("/auth/logout", { endpoint: sub("dayo").endpoint }, mallory.cookie);
    expect(await db.one(`SELECT 1 FROM push_subscriptions WHERE endpoint=$1 AND user_id=$2`, [sub("dayo").endpoint, other.user.id])).toBeTruthy();
  });

  it("refuses a change from another site's page on any /api route", async () => {
    const { cookie } = await signIn("9006", "Eve");
    for (const [path, body] of [["/api/chat", { text: "yes" }], ["/api/button", { data: "confirm:1" }], ["/api/do", { action: "list.add", args: {} }]] as const) {
      const r = await web.request(path, { method: "POST", headers: { "content-type": "text/plain", cookie, origin: "https://evil.example" }, body: JSON.stringify(body) });
      expect(r.status, path).toBe(403);
    }
    const patch = await web.request("/api/settings", { method: "PATCH", headers: { "content-type": "application/json", cookie, origin: "https://evil.example" }, body: JSON.stringify({ mode: "night" }) });
    expect(patch.status).toBe(403);
    // Our own page, and reads, carry on as before.
    const own = await web.request("/api/chat", { method: "POST", headers: { "content-type": "application/json", cookie, origin: "http://localhost" }, body: JSON.stringify({ text: "my lists" }) });
    expect(own.status).toBe(200);
    expect((await web.request("/api/me", { headers: { cookie, origin: "https://evil.example" } })).status).toBe(200);
  });

  it("refuses anything that isn't a real push subscription", async () => {
    const { cookie } = await signIn("9002", "Bola");
    expect(cleanSubscription({ endpoint: "http://insecure.example/push", keys: sub("x").keys })).toBeNull();
    expect(cleanSubscription({ endpoint: sub("x").endpoint, keys: { p256dh: "<script>", auth: "a" } })).toBeNull();
    expect(cleanSubscription({ endpoint: sub("x").endpoint })).toBeNull();
    const r = await call("/api/push/subscribe", { subscription: { endpoint: "javascript:alert(1)" } }, cookie);
    expect(r.status).toBe(400);
    expect(r.json.text).toMatch(/didn't give me a way to reach it/);
  });

  it("says plainly when push isn't switched on", async () => {
    config.vapidPrivateKey = "";
    const { cookie } = await signIn("9003", "Chi");
    const r = await call("/api/push/subscribe", { subscription: sub("c") }, cookie);
    expect(r.status).toBe(400);
    expect(r.json.text).toBe("Notifications aren't switched on for this lifeline yet.");
    const pub = await (await web.request("/api/public")).json();
    expect(pub.push).toEqual({ on: false, key: null });
  });

  it("is refused from another site", async () => {
    const { cookie } = await signIn("9004", "Dayo");
    const r = await web.request("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json", cookie, origin: "https://evil.example" }, body: JSON.stringify({ subscription: sub("d") }) });
    expect(r.status).toBe(403);
  });
});

describe("the app sender", () => {
  it("delivers a reminder as a notification with at most two buttons, and keeps it in the chat", async () => {
    const { user, cookie } = await signIn("9010", "Efe");
    await call("/api/push/subscribe", { subscription: sub("e") }, cookie);
    await call("/api/settings", { reach: "app" }, cookie, "PATCH");
    const u = (await getUserById(db, user.id))!;
    expect(u.preferred_channel).toBe("app");
    const reply: Reply = { text: "**Call mum**, now.", buttons: [{ label: "Done", data: "rem:done:1" }, { label: "Snooze", data: "rem:snooze:1" }, { label: "Undo", data: "undo:3" }] };
    expect(await dispatch(db, u, reply)).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(pushes[0].payload).toMatchObject({ title: "lifeline", body: "Call mum, now.", url: "/#today", actions: [{ action: "rem:done:1", title: "Done" }, { action: "rem:snooze:1", title: "Snooze" }] });
    expect(pushes[0].options).toMatchObject({ TTL: 43200, urgency: "high", vapidDetails: { subject: "mailto:owner@example.com" } });
    expect(telegramSent).toHaveLength(0);
    expect((await db.one<{ content: string }>(`SELECT content FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [user.id]))?.content).toBe(reply.text);
  });

  it("keeps health, cycle, mood, safety and remembered facts off the lock screen, and never offers a yes there", () => {
    const dose = notificationFor({ text: "Time for Sertraline, 50mg.", buttons: [{ label: "Taken", data: "med:taken:4" }, { label: "Skip", data: "med:skip:4" }], kind: "medication" });
    expect(dose.body).not.toMatch(/Sertraline/);
    expect(dose.private).toBe(true);
    expect(dose.actions).toEqual([{ action: "med:taken:4", title: "Taken" }, { action: "med:skip:4", title: "Skip" }]);
    for (const kind of ["cycle", "well_mood", "well_quit", "well_remember", "safety", "safety_legacy", "memory"]) {
      const n = notificationFor({ text: "Your period is 5 days later than I'd expect.", kind });
      expect(n.body, kind).not.toMatch(/period/);
      expect(n.private, kind).toBe(true);
    }
    // Sent straight through dispatch, a safety button still marks it private.
    expect(notificationFor({ text: "I didn't hear back. Tap I'm safe.", buttons: [{ label: "I'm safe", data: "sf:ci:safe:3" }] }).body).not.toMatch(/hear back/);
    // The morning brief: the first line only; doses and the cycle stay inside.
    const brief = notificationFor({ text: "Thursday, Ada: one thing on today.\n\nMeds: Sertraline at 08:00.\nCycle: day 3, on your period.", kind: "digest" });
    expect(brief.body).toBe("Thursday, Ada: one thing on today.");
    // An ordinary reminder reads as before.
    expect(notificationFor({ text: "Reminder: call mum.", kind: "reminder" })).toMatchObject({ body: "Reminder: call mum.", private: false });
    // A yes that moves money or reaches someone opens the app instead of being a button on the notification.
    expect(notificationFor({ text: "This sends 2,000 naira. Go ahead?", buttons: [{ label: "Yes, go ahead", data: "confirm:9" }, { label: "No", data: "cancel:9" }] }).actions).toEqual([]);
  });

  it("carries the kind from push() to the notification", async () => {
    const { user, cookie } = await signIn("9014", "Ifeoma");
    await call("/api/push/subscribe", { subscription: sub("priv") }, cookie);
    await call("/api/settings", { reach: "app" }, cookie, "PATCH");
    const { push } = await import("../src/core/scheduler.js");
    const u = (await getUserById(db, user.id))!;
    expect(await push({ db, getUser: (id) => getUserById(db, id), send: (x, r) => dispatch(db, x, r) }, u, "medication", "Time for Sertraline, 50mg.", { exempt: true, buttons: [{ label: "Taken", data: "med:taken:1" }] })).toBe(true);
    expect(pushes.at(-1)!.payload.body).not.toMatch(/Sertraline/);
  });

  it("opens the right page for each kind of message", () => {
    expect(notificationFor({ text: "Vitamin D", buttons: [{ label: "Taken", data: "med:taken:4" }] }).url).toBe("/#health");
    expect(notificationFor({ text: "This sends 2,000 naira. Go ahead?", buttons: [{ label: "Yes, go ahead", data: "confirm:9" }] }).url).toBe("/#today");
    expect(notificationFor({ text: "Good morning." }).url).toBe("/#chat");
    expect(notificationFor({ text: "x".repeat(900) }).body).toHaveLength(600);
  });

  it("drops subscriptions the push service says are gone, and falls back down the chain", async () => {
    const { user, cookie } = await signIn("9011", "Femi");
    await call("/api/push/subscribe", { subscription: sub("f") }, cookie);
    await call("/api/settings", { reach: "app" }, cookie, "PATCH");
    failWith = 410;
    const u = (await getUserById(db, user.id))!;
    expect(await dispatch(db, u, { text: "Rent, today." })).toBe(true);
    expect(await db.query(`SELECT 1 FROM push_subscriptions WHERE user_id=$1`, [user.id])).toHaveLength(0);
    expect((await identitiesOf(db, user.id)).map((i) => i.channel)).not.toContain("app");
    expect(telegramSent.map((t) => t.reply.text)).toEqual(["Rent, today."]); // Telegram was next

    // 404 is gone too; a 500 is a bad moment, so the subscription stays.
    failWith = null;
    await call("/api/push/subscribe", { subscription: sub("g") }, cookie);
    failWith = 500;
    await dispatch(db, (await getUserById(db, user.id))!, { text: "Again." });
    expect(await db.query(`SELECT 1 FROM push_subscriptions WHERE user_id=$1`, [user.id])).toHaveLength(1);
    failWith = 404;
    await dispatch(db, (await getUserById(db, user.id))!, { text: "And again." });
    expect(await db.query(`SELECT 1 FROM push_subscriptions WHERE user_id=$1`, [user.id])).toHaveLength(0);
  });

  it("sends a test notification on request", async () => {
    const { cookie } = await signIn("9012", "Gbenga");
    expect((await call("/api/push/test", {}, cookie)).status).toBe(400);
    await call("/api/push/subscribe", { subscription: sub("h") }, cookie);
    const r = await call("/api/push/test", {}, cookie);
    expect(r.json.ok).toBe(true);
    expect(pushes[0].payload.body).toMatch(/^Notifications work on this device\./);
  });

  it("can't be registered for a sign-in-only identity", () => {
    expect(() => registerSender("google", async () => {})).toThrow(/never carries messages/);
    expect(() => registerSender("apple", async () => {})).toThrow();
  });
});

describe("Where should reminders reach you?", () => {
  it("Both sends to the app and Telegram, and keeps the fallback chain and the email last resort", async () => {
    const { user, cookie } = await signIn("9020", "Hadiza");
    expect((await call("/api/settings", { reach: "both" }, cookie, "PATCH")).json.text).toBe("Turn on notifications on this device first, then choose again.");
    await call("/api/push/subscribe", { subscription: sub("i") }, cookie);
    const r = await call("/api/settings", { reach: "both" }, cookie, "PATCH");
    expect(r.json).toMatchObject({ ok: true, reach: "both", text: "Reminders will reach you here and on Telegram." });
    let u = (await getUserById(db, user.id))!;
    expect(u.preferred_channel).toBe("telegram");
    expect(u.prefs.alsoApp).toBe(true);
    const settings = await (await web.request("/api/settings", { headers: { cookie } })).json();
    expect(settings).toMatchObject({ reach: "both", push: { on: true, devices: 1 } });

    expect(await dispatch(db, u, { text: "Dentist at 3." })).toBe(true);
    expect(pushes).toHaveLength(1);
    expect(telegramSent).toHaveLength(1);
    // The app already put it in the web chat once.
    expect(await db.query(`SELECT 1 FROM messages WHERE user_id=$1 AND content='Dentist at 3.'`, [user.id])).toHaveLength(1);

    // Telegram down: the app reached them, so that's enough, and no email goes out.
    telegramDown = true;
    const mail = vi.spyOn(email, "sendEmail");
    expect(await dispatch(db, u, { text: "Pills at 8." })).toBe(true);
    expect(pushes).toHaveLength(2);
    expect(mail).not.toHaveBeenCalled();

    // Both down and no other way: the chain still falls through to the web inbox, as before.
    failWith = 503;
    expect(await dispatch(db, u, { text: "Water." })).toBe(true);
    expect(await db.query(`SELECT 1 FROM messages WHERE user_id=$1 AND content='Water.'`, [user.id])).toHaveLength(1);

    // Back to Telegram only.
    failWith = null; telegramDown = false;
    await call("/api/settings", { reach: "telegram" }, cookie, "PATCH");
    u = (await getUserById(db, user.id))!;
    pushes.length = 0; telegramSent.length = 0;
    await dispatch(db, u, { text: "Only Telegram." });
    expect(pushes).toHaveLength(0);
    expect(telegramSent).toHaveLength(1);
  });

  it("the email last resort still works when nothing else reaches someone", async () => {
    const u = await ensureUser(db, "sms", "+447700903003", "Ivie");
    await db.query(`UPDATE users SET prefs = prefs || '{"emailVerified":"ivie@example.com","alsoApp":true}'::jsonb WHERE id=$1`, [u.id]);
    const mail = vi.spyOn(email, "sendEmail").mockResolvedValue(true);
    expect(await dispatch(db, (await getUserById(db, u.id))!, { text: "Last resort." })).toBe(true);
    expect(mail).toHaveBeenCalledWith("ivie@example.com", "lifeline", "Last resort.");
  });

  it("won't choose Telegram for someone who hasn't got it, and the app becomes home when they turn notifications on", async () => {
    const created = await ensureUser(db, "google", "g-app-only", "Jide");
    const { createLinkCode } = await import("../src/core/handler.js");
    const code = await createLinkCode(db, created.id);
    const s = await web.request("/auth/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
    const cookie = /ll_session=[0-9a-f]{64}/.exec(s.headers.get("set-cookie") ?? "")![0];
    expect((await call("/api/settings", { reach: "telegram" }, cookie, "PATCH")).json.text).toMatch(/Telegram isn't one of your ways in yet/);
    const r = await call("/api/push/subscribe", { subscription: sub("j") }, cookie);
    expect(r.json).toMatchObject({ reach: "app", telegram: false });
    expect(await dispatch(db, (await getUserById(db, created.id))!, { text: "Hello from the app." })).toBe(true);
    expect(pushes.map((p) => p.payload.body)).toEqual(["Hello from the app."]);
    expect((await call("/api/settings", { reach: "sideways" }, cookie, "PATCH")).status).toBe(400);
    const off = await call("/api/push/unsubscribe", { endpoint: sub("j").endpoint }, cookie);
    expect(off.json.reach).toBeNull();
    expect((await getUserById(db, created.id))?.preferred_channel).toBe("web");
  });
});

describe("installing it", () => {
  it("serves the service worker from the root, the offline page and the icons", async () => {
    const swr = await web.request("/sw.js");
    expect(swr.status).toBe(200);
    expect(swr.headers.get("service-worker-allowed")).toBe("/");
    expect(swr.headers.get("cache-control")).toBe("no-cache");
    const sw = await swr.text();
    for (const ev of ["install", "activate", "fetch", "push", "notificationclick"]) expect(sw).toContain(`addEventListener("${ev}"`);
    expect(sw).toContain("(api|auth|webhooks|health)"); // never caches the API or sign-in
    expect((await web.request("/offline")).status).toBe(200);
    for (const f of ["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png"]) expect((await web.request(f)).status).toBe(200);
  });

  it("has a manifest a browser will install from", () => {
    const m = JSON.parse(readFileSync(new URL("../web/manifest.webmanifest", import.meta.url), "utf8"));
    expect(m).toMatchObject({ name: "lifeline", start_url: "/#today", display: "standalone", scope: "/", theme_color: "#EDE6D6", background_color: "#EDE6D6" });
    expect(m.icons.some((i: any) => i.purpose === "maskable" && i.sizes === "512x512")).toBe(true);
    expect(m.icons.some((i: any) => i.sizes === "192x192" && i.type === "image/png")).toBe(true);
    const vercel = JSON.parse(readFileSync(new URL("../web/vercel.json", import.meta.url), "utf8"));
    expect(vercel.headers.some((h: any) => h.source === "/sw.js")).toBe(true);
  });
});
