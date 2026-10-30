/**
 * Web channel + webhooks. Hono on node:http, static files from src/web/public.
 *  auth:    POST /auth/telegram  POST /auth/webapp (Mini App)  POST /auth/link  POST /auth/logout
 *           POST /auth/google  POST /auth/apple/start  POST /auth/apple  POST /auth/code/start  POST /auth/code/verify
 *           POST /auth/telegram/link  POST /auth/ways/remove   (every POST under /auth: JSON only, Origin checked)
 *  app:     GET /api/ways  POST /api/welcome  POST /api/push/subscribe /api/push/unsubscribe /api/push/test
 *  app:     GET /api/me /api/public /api/messages /api/state /api/digest /api/hackathons /api/scout /api/money /api/trips /api/settings /api/quip
 *           GET /api/day /api/cycle /api/emergency   (read-only views, src/web/views.ts)
 *           POST /api/chat /api/button /api/scout   PATCH /api/settings
 *  hooks:   POST /webhooks/twilio  POST /webhooks/imessage   GET /health
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import type { Db } from "../core/db.js";
import { ensureUser, getUserById, handleCallback, handleMessage, handlePhoto, redeemLinkCode, identitiesOf, type Reply } from "../core/handler.js";
import { allow, mediaAbilities, speak, transcribe, wantsVoice } from "../core/media.js";
import { registerSender } from "../core/dispatch.js";
import { handleGatewayWebhook, handleTextChannel, verifyTwilio } from "../channels/sms.js";
import { parseInbound } from "../channels/imessage.js";
import { handleInboundEmail } from "../channels/email.js";
import { buildDigest } from "../modules/digest.js";
import { rankedForUser } from "../modules/hackathons.js";
import { scout } from "../modules/scout.js";
import { spentToday } from "../core/budget.js";
import { inQuietHours } from "../core/time.js";
import { propose } from "../policy/engine.js";
import { PERSONAS } from "../intent/persona.js";
import { startWebLogin, pollWebLogin } from "../core/weblogin.js";
import { admit, FULL_MESSAGE } from "../core/circle.js";
import { verifyInitData } from "../core/webapp.js";
import { mountExtras } from "./extras.js";
import { mountViews } from "./views.js";
import { pageReply } from "./replies.js";
import { providerName } from "../intent/providers.js";
import { draftReply } from "../intent/model.js";
import { DateTime } from "luxon";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import type { User } from "../policy/types.js";
import { allCapabilities, helpGroups } from "../intent/capabilities.js";
import { pipLine, PIP_BIO, type PipState } from "../core/pip.js";
import { polish, personaOf } from "../core/voice.js";
import { adoptTelegram, allowTokenTry, checkCode, issueAppleNonce, linkTryAllowed, linkTryFailed, removeWay, sayResult, signInMethods, signInOrLink, startCode, verifyApple, verifyGoogle, waysOf, wayName, type CodeVia, type WayResult, issueNonce, takeNonce } from "../core/auth.js";
import { cleanSubscription, devicesOf, pushOn, pushPublic, registerApp, sendToApp, subscribe, unsubscribe } from "../core/webpush.js";
import { findCity } from "../core/geo.js";
import { IANAZone } from "luxon";

const SESSION_DAYS = 30;
/** The web app lives in web/ at the repo root: Railway serves it here, and the same folder is the Vercel project. */
const PUBLIC_DIR = path.relative(process.cwd(), path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web")) || ".";

export function createWeb(db: Db, botUsername: string) {
  const app = new Hono<{ Variables: { user: User } }>();
  /** Size limits before any body is read: recordings and photos may be big, nothing else should be. */
  const tooBig = (c: any) => c.json({ error: "too big", text: "That's bigger than I can take. Something smaller?" }, 413);
  const bigBody = bodyLimit({ maxSize: 20 * 1024 * 1024, onError: tooBig });
  const smallBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooBig });
  app.use("*", (c, next) => (c.req.method === "GET" || c.req.method === "HEAD" ? next() : (c.req.path === "/api/voice" || c.req.path === "/api/photo" ? bigBody : smallBody)(c, next)));
  /** Anything that breaks still answers in a sentence, never a bare 500 page. */
  app.onError((err, c) => {
    log.error({ err: err?.message, path: c.req.path }, "web error");
    return c.json({ error: "server", text: "Something broke on my side while doing that, so it may not have gone through. Try once more in a moment." }, 500);
  });

  registerSender("web", async (externalId, reply) => {
    const u = await db.one<{ id: number }>(`SELECT user_id AS id FROM identities WHERE channel='web' AND external_id=$1`, [externalId]);
    if (!u) throw new Error("no web identity");
    await db.query(`INSERT INTO messages (user_id, role, content) VALUES ($1,'assistant',$2)`, [u.id, reply.text]);
  });
  /* The installed app: reminders and pings as notifications (src/core/webpush.ts). */
  registerApp(db);

  const session = async (c: any): Promise<User | null> => {
    const bearer = /^Bearer ([0-9a-f]{64})$/.exec(c.req.header("authorization") ?? "")?.[1];
    const tok = bearer ?? getCookie(c, "ll_session");
    if (!tok) return null;
    const row = await db.one<{ user_id: number }>(`SELECT user_id FROM sessions WHERE token=$1 AND expires_at > now()`, [tok]);
    return row ? (await getUserById(db, row.user_id)) ?? null : null;
  };
  /** `tabOnly`: a token for one tab (the Mini App), no cookie, a day long, so a crafted link can't take over the browser's own sign-in. */
  /**
   * The signed-in person, for adding or removing a way to sign in. Inside Telegram's app the session is tab-only (it came
   * from launch data a link could carry), so changes to sign-in wait for the website in a browser.
   */
  /** In Telegram's app a new way in signs in on its own rather than joining the tab's account. */
  const linkOrNull = async (c: any): Promise<User | null> => { const u = await forLinking(c); return u === "tab" ? null : u; };
  const TAB_REFUSAL = { error: "tab", text: "Add or remove ways to sign in from the website in your browser, not inside Telegram." };
  const forLinking = async (c: any): Promise<User | null | "tab"> => {
    const u = await session(c);
    if (!u) return null;
    const bearer = /^Bearer ([0-9a-f]{64})$/.exec(c.req.header("authorization") ?? "")?.[1];
    const tok = bearer ?? getCookie(c, "ll_session");
    const row = tok ? await db.one<{ tab_only: boolean }>(`SELECT tab_only FROM sessions WHERE token=$1`, [tok]) : null;
    return row?.tab_only ? "tab" : u;
  };
  const newSession = async (c: any, user: User, o: { tabOnly?: boolean } = {}) => {
    const token = randomBytes(32).toString("hex");
    await db.query(`INSERT INTO sessions (token, user_id, expires_at, tab_only) VALUES ($1,$2,$3,$4)`, [token, user.id, new Date(Date.now() + (o.tabOnly ? 1 : SESSION_DAYS) * 86_400_000), Boolean(o.tabOnly)]);
    const cross = config.webOrigins.length > 0;
    if (!o.tabOnly) setCookie(c, "ll_session", token, { httpOnly: true, sameSite: cross ? "None" : "Lax", secure: cross || config.publicUrl.startsWith("https"), path: "/", maxAge: SESSION_DAYS * 86_400 });
    await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,'web',$2) ON CONFLICT DO NOTHING`, [user.id, `web:${user.id}`]);
    return token;
  };
  const ctxOf = (u: User, src: string) => ({ db, user: u, now: new Date(), sourceMessage: `[web] ${src}` });
  /** Stop notifications on one device. No device left: reminders go back to Telegram, or the web inbox for someone without it. */
  const dropDevice = async (u: User, endpoint: string): Promise<number> => {
    if (endpoint) await unsubscribe(db, u.id, endpoint);
    const left = await devicesOf(db, u.id);
    if (!left) {
      const tg = await db.one(`SELECT 1 FROM identities WHERE user_id=$1 AND channel='telegram'`, [u.id]);
      await db.query(`UPDATE users SET preferred_channel = CASE WHEN preferred_channel='app' THEN $2 ELSE preferred_channel END, prefs = prefs || '{"alsoApp":false}'::jsonb WHERE id=$1`, [u.id, tg ? "telegram" : "web"]);
    }
    return left;
  };

  // A web front on another origin (the Vercel domain) talks to this brain with cookies.
  if (config.webOrigins.length) app.use("/api/*", cors({ origin: config.webOrigins, credentials: true })) && app.use("/auth/*", cors({ origin: config.webOrigins, credentials: true }));

  /**
   * Sign-in routes only take JSON, and only from lifeline's own pages: the Origin must be this server, the
   * site that proxies to it (x-forwarded-host from Vercel), WEB_URL, PUBLIC_URL or WEB_ORIGINS. A form or an
   * image tag on another site can't sign someone in, out, or into someone else's account.
   */
  const originOk = (c: any): boolean => {
    const origin = c.req.header("origin");
    if (!origin) return c.req.header("sec-fetch-site") !== "cross-site";
    let host: string;
    try { host = new URL(origin).host; } catch { return false; }
    const hosts = new Set<string>();
    for (const o of [...config.webOrigins, config.webUrl, config.publicUrl]) { try { if (o) hosts.add(new URL(o).host); } catch { /* not a URL */ } }
    try { hosts.add(new URL(c.req.url).host); } catch { /* no URL */ }
    const fwd = (c.req.header("x-forwarded-host") ?? "").split(",")[0].trim();
    if (fwd) hosts.add(fwd);
    return hosts.has(host);
  };
  app.use("/auth/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    // JSON, or nothing at all (sign out, start a bot sign-in). Forms and plain text from another site never get in.
    const type = c.req.header("content-type");
    if (type ? !/^application\/json\b/i.test(type) : Number(c.req.header("content-length") ?? 0) > 0 || c.req.header("transfer-encoding")) return c.json({ error: "json only", text: "That sign-in didn't come from lifeline's page. Open the page and try again." }, 415);
    if (!originOk(c)) return c.json({ error: "origin", text: "That came from another site, so I didn't act on it. Open lifeline's own page and try again." }, 403);
    await next();
  });
  /* Everything that changes something under /api (a message, a button, a yes, settings) must come from lifeline's own
     pages too. With WEB_ORIGINS set the session cookie is SameSite=None, so without this a form on any site could post
     "yes" to /api/chat in the signed-in person's name. Reads stay open to the page as before. */
  app.use("/api/*", async (c, next) => (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method) && !originOk(c) ? c.json({ error: "origin", text: "That came from another site, so I didn't act on it." }, 403) : next()));
  const ipOf = (c: any): string => (c.req.header("x-forwarded-for") ?? "").split(",")[0].trim() || c.req.header("x-real-ip") || "local";
  const bodyOf = async (c: any): Promise<Record<string, any>> => { const b = await c.req.json().catch(() => null); return b && typeof b === "object" && !Array.isArray(b) ? b : {}; };
  /** One answer shape for every way in: a session when someone signs in, nothing new when a way is linked. */
  const answerWay = async (c: any, r: WayResult, what: string) => {
    const said = sayResult(r, what);
    if (r.kind === "signed-in") await newSession(c, r.user);
    const firstRun = r.kind === "signed-in" && r.user.prefs?.firstRun === true;
    return c.json({ ok: said.ok, text: said.text, ...(said.error ? { error: said.error } : {}), ...(r.kind === "signed-in" ? { created: r.created, firstRun } : { linked: r.kind === "linked" || r.kind === "already" }) }, said.status as 200);
  };

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/public", async (c) => {
    const n = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
    return c.json({ botUsername, places: { taken: Number(n?.n ?? 0), max: config.maxUsers }, signin: await signInMethods(botUsername), push: pushPublic() });
  });
  /** The catalogue is public: the landing page shows everything before anyone signs in. */
  app.get("/api/capabilities", (c) => c.json({ capabilities: allCapabilities(), groups: helpGroups(), pip: PIP_BIO }));
  for (const f of ["styles.css", "app.js", "mascot.js", "path.js", "icon.svg", "manifest.webmanifest"]) app.use(`/${f}`, serveStatic({ root: PUBLIC_DIR, path: f }));
  app.use("/fonts/*", serveStatic({ root: PUBLIC_DIR }));
  /* The installable app: icons, the offline page and the service worker, which must come from the root to control every page. */
  for (const f of ["offline.html", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png"]) app.use(`/${f}`, serveStatic({ root: PUBLIC_DIR, path: f }));
  app.get("/offline", serveStatic({ root: PUBLIC_DIR, path: "offline.html" }));
  app.use("/sw.js", async (c, next) => { await next(); c.header("Cache-Control", "no-cache"); c.header("Service-Worker-Allowed", "/"); });
  app.use("/sw.js", serveStatic({ root: PUBLIC_DIR, path: "sw.js" }));
  app.get("/", serveStatic({ root: PUBLIC_DIR, path: "index.html" }));
  /* Dashboard cards and shared plans (src/web/extras.ts). */
  mountExtras(app, db);

  /* ---- auth ---- */
  app.post("/auth/telegram", async (c) => {
    // Without a bot token the expected hash is computable by anyone: refuse rather than accept it.
    if (!config.telegramToken) return c.json({ error: "off", text: "Telegram sign-in isn't set up on this server." }, 503);
    const data = (await c.req.json()) as Record<string, string>;
    const { hash, ...rest } = data;
    const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("\n");
    const expected = createHmac("sha256", createHash("sha256").update(config.telegramToken).digest()).update(check).digest();
    const given = Buffer.from(/^[0-9a-f]{64}$/i.test(String(hash ?? "")) ? String(hash) : "", "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected) || Date.now() / 1000 - Number(rest.auth_date) > 86_400) return c.json({ error: "bad signature", text: "That Telegram sign-in didn't check out, or it's more than a day old. Try signing in again." }, 401);
    const id = Number(rest.id);
    // Already signed in here: this adds Telegram to the account instead of switching to another one.
    const current = await forLinking(c);
    if (current === "tab") return c.json(TAB_REFUSAL, 403);
    if (current) return answerWay(c, await signInOrLink(db, { channel: "telegram", externalId: String(id), current }), "that Telegram account");
    if ((await admit(db, id)) === "full") return c.json({ error: "full", text: FULL_MESSAGE() }, 403);
    const user = await ensureUser(db, "telegram", String(id), [rest.first_name, rest.last_name].filter(Boolean).join(" "));
    await newSession(c, user);
    return c.json({ ok: true });
  });
  /* inside Telegram (the Mini App): the page posts the signed initData Telegram gave it */
  app.post("/auth/webapp", async (c) => {
    const { initData } = (await c.req.json().catch(() => ({}))) as { initData?: string };
    const tg = verifyInitData(String(initData ?? ""), config.telegramToken);
    if (!tg) return c.json({ error: "bad signature", text: "Telegram's sign-in didn't check out. Close the app and open it again from the bot." }, 401);
    if ((await admit(db, tg.id)) === "full") return c.json({ error: "full", text: FULL_MESSAGE() }, 403);
    const user = await ensureUser(db, "telegram", String(tg.id), [tg.first_name, tg.last_name].filter(Boolean).join(" "));
    /* A token for this tab only: inside Telegram's desktop and web apps the page sits in a frame where cookies may not stick,
       and no cookie means a link carrying someone else's launch data can't replace this browser's own sign-in. */
    return c.json({ ok: true, token: await newSession(c, user, { tabOnly: true }) });
  });
  /* sign in through the bot: the page opens t.me/<bot>?start=web_<id> and polls */
  app.post("/auth/telegram/start", (c) => { const id = startWebLogin(); return c.json({ id, url: `https://t.me/${botUsername}?start=web_${id}` }); });
  app.get("/auth/telegram/poll", async (c) => {
    const r = pollWebLogin(String(c.req.query("id") ?? ""));
    if (r.state !== "approved") return c.json({ state: r.state });
    const user = await getUserById(db, r.userId);
    if (!user) return c.json({ state: "expired" });
    await newSession(c, user);
    return c.json({ state: "approved", ok: true });
  });
  /* Adding Telegram from settings, through the bot: same request and poll as signing in, but it joins this account. */
  app.post("/auth/telegram/link/start", async (c) => {
    const current = await forLinking(c);
    if (current === "tab") return c.json(TAB_REFUSAL, 403);
    if (!current) return c.json({ error: "unauthenticated", text: "Sign in first, then add Telegram from Settings." }, 401);
    const id = startWebLogin({ forUserId: current.id, forName: current.name ? current.name.split(" ")[0] : null });
    return c.json({ id, url: `https://t.me/${botUsername}?start=link_${id}` });
  });
  app.post("/auth/telegram/link", async (c) => {
    const current = await forLinking(c);
    if (current === "tab") return c.json(TAB_REFUSAL, 403);
    if (!current) return c.json({ error: "unauthenticated", text: "Sign in first, then add Telegram from Settings." }, 401);
    const r = pollWebLogin(String((await bodyOf(c)).id ?? ""), { purpose: "link", forUserId: current.id });
    if (r.state !== "approved") return c.json({ state: r.state });
    const said = sayResult(await adoptTelegram(db, current, r.userId), "that Telegram account");
    return c.json({ state: said.ok ? "approved" : "taken", ok: said.ok, text: said.text }, said.ok ? 200 : 409);
  });

  /* ---- Google, Apple, and codes by text, iMessage or email (src/core/auth.ts, docs/SIGNIN.md) ---- */
  app.post("/auth/google", async (c) => {
    if (!config.googleClientId) return c.json({ error: "off", text: "Google sign-in isn't switched on here." }, 400);
    if (!allowTokenTry(ipOf(c))) return c.json({ error: "limit", text: "That's a lot of tries from here. Wait a few minutes, then try again." }, 429);
    const person = await verifyGoogle(String((await bodyOf(c)).credential ?? ""));
    if (!person || !takeNonce(person.nonce)) return c.json({ error: "bad token", text: "Google's sign-in didn't check out. Try once more." }, 401);
    return answerWay(c, await signInOrLink(db, { channel: "google", externalId: person.sub, name: person.name, email: person.email, label: person.email, current: await linkOrNull(c) }), "that Google account");
  });
  app.post("/auth/google/start", (c) => {
    if (!config.googleClientId) return c.json({ error: "off", text: "Google sign-in isn't switched on here." }, 400);
    if (!allowTokenTry(ipOf(c))) return c.json({ error: "limit", text: "That's a lot of tries from here. Wait a few minutes, then try again." }, 429);
    return c.json({ nonce: issueNonce() });
  });
  app.post("/auth/apple/start", (c) => {
    if (!config.appleClientId) return c.json({ error: "off", text: "Sign in with Apple isn't switched on here." }, 400);
    if (!allowTokenTry(ipOf(c))) return c.json({ error: "limit", text: "That's a lot of tries from here. Wait a few minutes, then try again." }, 429);
    return c.json({ nonce: issueAppleNonce(), state: randomBytes(12).toString("base64url") });
  });
  app.post("/auth/apple", async (c) => {
    if (!config.appleClientId) return c.json({ error: "off", text: "Sign in with Apple isn't switched on here." }, 400);
    if (!allowTokenTry(ipOf(c))) return c.json({ error: "limit", text: "That's a lot of tries from here. Wait a few minutes, then try again." }, 429);
    const b = await bodyOf(c);
    const person = await verifyApple(String(b.id_token ?? ""), String(b.nonce ?? ""));
    if (!person) return c.json({ error: "bad token", text: "Apple's sign-in didn't check out, or it took too long. Try once more." }, 401);
    // Apple gives the name only the first time someone signs in, and only to the page. Keep it if it came.
    const n = b.name && typeof b.name === "object" ? [b.name.firstName, b.name.lastName].filter((x: unknown) => typeof x === "string").join(" ") : typeof b.name === "string" ? b.name : "";
    return answerWay(c, await signInOrLink(db, { channel: "apple", externalId: person.sub, name: n || null, email: person.email, label: person.email, current: await linkOrNull(c) }), "that Apple ID");
  });
  const viaOf = (v: unknown): CodeVia | null => (v === "sms" || v === "imessage" || v === "email" ? v : null);
  app.post("/auth/code/start", async (c) => {
    const b = await bodyOf(c);
    const via = viaOf(b.via);
    if (!via) return c.json({ error: "method", text: "I don't know that way in." }, 400);
    const r = await startCode(db, via, b.to, ipOf(c));
    return c.json({ ok: r.ok, text: r.text, ...(r.error ? { error: r.error } : {}) }, r.status as 200);
  });
  app.post("/auth/code/verify", async (c) => {
    const b = await bodyOf(c);
    const via = viaOf(b.via);
    if (!via) return c.json({ error: "method", text: "I don't know that way in." }, 400);
    const r = await checkCode(db, via, b.to, b.code, ipOf(c));
    if (!r.ok || !r.target) return c.json({ ok: false, text: r.text, error: r.error }, r.status as 400);
    return answerWay(c, await signInOrLink(db, { channel: via, externalId: r.target, current: await linkOrNull(c) }), via === "email" ? "that address" : "that number");
  });
  /* Take a way in off the account. Never the last one. */
  app.post("/auth/ways/remove", async (c) => {
    const current = await forLinking(c);
    if (current === "tab") return c.json(TAB_REFUSAL, 403);
    if (!current) return c.json({ error: "unauthenticated", text: "You're signed out on this device. Sign in again to carry on." }, 401);
    const id = Number((await bodyOf(c)).id);
    const ways = await waysOf(db, current.id);
    const w = ways.find((x) => x.id === id);
    const r = Number.isInteger(id) ? await removeWay(db, current, id) : "missing";
    if (r === "last") return c.json({ error: "last", text: "That's your only way in, so it stays. Add another first, then you can take this one off." }, 400);
    if (r === "missing") return c.json({ error: "missing", text: "That one isn't on your account any more." }, 404);
    return c.json({ ok: true, text: `${wayName(w!.channel)} is no longer a way into your account.`, ways: await waysOf(db, current.id) });
  });

  app.post("/auth/link", async (c) => {
    const ip = ipOf(c);
    if (!linkTryAllowed(ip)) return c.json({ error: "limit", text: "That's a lot of codes that didn't work. Wait a while, then say link to the bot for a fresh one." }, 429);
    const { code } = await bodyOf(c);
    const user = await redeemLinkCode(db, String(code ?? ""), "web", `web:${randomBytes(8).toString("hex")}`);
    if (!user) { linkTryFailed(ip); return c.json({ error: "invalid or expired code", text: "That code didn't work. Codes last fifteen minutes; say link to the bot for a fresh one." }, 401); }
    await newSession(c, user);
    return c.json({ ok: true });
  });
  app.post("/auth/logout", async (c) => {
    // Signing out on a shared device also stops this device's notifications, so the next person never sees them.
    const endpoint = String((await bodyOf(c)).endpoint ?? "");
    const leaving = endpoint ? await session(c) : null;
    if (leaving) await dropDevice(leaving, endpoint);
    const toks = [/^Bearer ([0-9a-f]{64})$/.exec(c.req.header("authorization") ?? "")?.[1], getCookie(c, "ll_session")].filter(Boolean);
    if (toks.length) await db.query(`DELETE FROM sessions WHERE token = ANY($1::text[])`, [toks]);
    deleteCookie(c, "ll_session", { path: "/" });
    return c.json({ ok: true });
  });

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/public" || c.req.path === "/api/capabilities") return next();
    const u = await session(c);
    if (!u) return c.json({ error: "unauthenticated", text: "You're signed out on this device. Sign in again to carry on." }, 401);
    c.set("user", u);
    await next();
  });
  const user = (c: any): User => c.get("user") as User;
  /* The day timeline, the cycle calendar and the emergency card (src/web/views.ts). After the check above, so signed in only. */
  mountViews(app, db);
  /** Add a spoken version of the reply when the action asks for it or the person's setting says so. */
  const withVoice = async (u: User, r: Reply, spoken: boolean): Promise<Reply & { audio?: string }> => {
    if (!wantsVoice(u.prefs, r, spoken) || !mediaAbilities().speak || !allow("speak", u.id)) return r;
    const sp = await speak(typeof r.speak === "string" ? r.speak : r.text, { voice: u.prefs.ttsVoice as string | undefined, persona: personaOf(u.prefs), ogg: false }).catch(() => null);
    return sp ? { ...r, audio: sp.wav.toString("base64") } : r;
  };

  /** Where reminders go: Telegram, the installed app, or both. */
  const reachOf = (u: User): "telegram" | "app" | "both" | null =>
    u.preferred_channel === "app" ? "app" : u.prefs.alsoApp === true ? "both" : (u.preferred_channel ?? "telegram") === "telegram" ? "telegram" : null;

  /* ---- ways to sign in, the first-run step, and the installed app ---- */
  app.get("/api/ways", async (c) => {
    const u = user(c);
    return c.json({ ways: await waysOf(db, u.id), methods: await signInMethods(botUsername) });
  });
  /** A person who came in on the web without Telegram: what to call them and where they are. Nothing more. */
  app.post("/api/welcome", async (c) => {
    const u = user(c);
    const b = await bodyOf(c);
    const name = typeof b.name === "string" ? b.name.replace(/[\u0000-\u001f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
    const place = typeof b.place === "string" ? b.place.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80) : "";
    const args: Record<string, string> = {};
    if (name) args.name = name;
    if (place) {
      if (/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$|^UTC$/.test(place) && IANAZone.isValidZone(place)) args.tz = place;
      else {
        const found = await findCity(place);
        if (!found) return c.json({ error: "place", text: "I couldn't find that place. Try the nearest big city, or a time zone like Europe/Lisbon." }, 400);
        args.tz = found.tz;
        if (found.country && /^[A-Za-z]{2}$/.test(found.country)) args.country = found.country.toUpperCase();
      }
    }
    if (Object.keys(args).length) {
      const d = await propose(ctxOf(u, "welcome"), "settings.update", args);
      if (d.kind !== "ran") return c.json({ error: "settings", text: "reply" in d ? d.reply : "That didn't save. Try once more?" }, 400);
    }
    await db.query(`UPDATE users SET prefs = prefs - 'firstRun' WHERE id=$1`, [u.id]);
    const first = (name || u.name || "").split(" ")[0];
    return c.json({ ok: true, text: `${first ? `${first}, you're in` : "You're in"}. Tell me one thing you'd hate to forget.` });
  });
  app.post("/api/push/subscribe", async (c) => {
    const u = user(c);
    if (!pushOn()) return c.json({ error: "off", text: "Notifications aren't switched on for this lifeline yet." }, 400);
    const b = await bodyOf(c);
    const sub = cleanSubscription(b.subscription);
    if (!sub) return c.json({ error: "bad subscription", text: "Your browser didn't give me a way to reach it. Try turning notifications on again." }, 400);
    await subscribe(db, u.id, sub, typeof b.device === "string" ? b.device : undefined);
    const tg = await db.one(`SELECT 1 FROM identities WHERE user_id=$1 AND channel='telegram'`, [u.id]);
    // Someone without Telegram has nowhere better: the app becomes where reminders go.
    if (!tg && u.preferred_channel !== "app") await db.query(`UPDATE users SET preferred_channel='app', prefs = prefs || '{"alsoApp":false}'::jsonb WHERE id=$1`, [u.id]);
    const fresh = (await getUserById(db, u.id))!;
    return c.json({ ok: true, text: "Notifications are on for this device.", reach: reachOf(fresh), devices: await devicesOf(db, u.id), telegram: Boolean(tg) });
  });
  app.post("/api/push/unsubscribe", async (c) => {
    const u = user(c);
    const left = await dropDevice(u, String((await bodyOf(c)).endpoint ?? ""));
    const fresh = (await getUserById(db, u.id))!;
    return c.json({ ok: true, text: "Notifications are off for this device.", reach: reachOf(fresh), devices: left });
  });
  app.post("/api/push/test", async (c) => {
    const u = user(c);
    const ok = await sendToApp(db, u.id, { text: "Notifications work on this device. This is how reminders will look." });
    return ok ? c.json({ ok: true, text: "Sent. It should arrive in a moment." }) : c.json({ error: "not sent", text: "That didn't reach any device. Turn notifications off and on again here, then try once more." }, 400);
  });

  /* ---- app data ---- */
  app.get("/api/me", async (c) => {
    const u = user(c);
    return c.json({ firstRun: u.prefs.firstRun === true, reach: reachOf(u), id: u.id, name: u.name, tz: u.tz, theme: u.prefs.theme ?? null, persona: u.prefs.personaCustom ? "custom" : u.prefs.persona ?? "plain", spend: await spentToday(db, u.id), budget: config.dailyModelBudgetUsd, gemini: Boolean(config.geminiKey), pip: pipLine("return", u), quiet_start: u.quiet_start, quiet_end: u.quiet_end, palette: u.prefs.palette ?? null, mode: u.prefs.mode ?? null, work: typeof u.prefs.work === "boolean" ? u.prefs.work : null, tags: Array.isArray(u.prefs.tags) ? u.prefs.tags : [] });
  });
  app.get("/api/messages", async (c) => c.json((await db.query(`SELECT id, role, content, created_at FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT 60`, [user(c).id])).reverse()));
  app.post("/api/chat", async (c) => {
    const { text } = await c.req.json();
    if (!text || !String(text).trim()) return c.json({ error: "empty", text: "There was nothing in that message." }, 400);
    if (String(text).length > 4000) return c.json({ error: "too long", text: "That's longer than I can take in one message. Try it in two parts." }, 400);
    const u = user(c);
    return c.json(pageReply(await withVoice(u, await handleMessage(db, u, String(text), { channel: "web" }), false)));
  });
  /** A recording from the page's mic button: hear it, act on it, and talk back if they like that. */
  app.post("/api/voice", async (c) => {
    const u = user(c);
    if (!mediaAbilities().hear) return c.json({ error: "no hearing", text: "I can't listen on this server yet. Type it for now." }, 400);
    const buf = Buffer.from(await c.req.arrayBuffer());
    if (buf.length < 500) return c.json({ error: "empty", text: "That recording was empty. Hold the mic a moment longer?" }, 400);
    if (buf.length > 20_000_000) return c.json({ error: "too long", text: "That recording's too long for me. Keep it under a few minutes?" }, 400);
    if (!allow("hear", u.id)) return c.json({ error: "limit", text: "That's a lot of voice notes for one day. Type it for now." }, 429);
    const mime = (c.req.header("content-type") ?? "audio/webm").split(";")[0];
    const heard = await transcribe(buf, mime.includes("mp4") ? "voice.mp4" : mime.includes("ogg") ? "voice.ogg" : mime.includes("wav") ? "voice.wav" : "voice.webm", mime);
    if (!heard) return c.json({ error: "unheard", text: "I couldn't make that out. Try again, a little closer to the mic?" }, 422);
    return c.json({ heard, ...pageReply(await withVoice(u, await handleMessage(db, u, heard, { channel: "web" }), true)) });
  });
  /** A photo from the page, with an optional caption in the x-caption header. */
  app.post("/api/photo", async (c) => {
    const u = user(c);
    const buf = Buffer.from(await c.req.arrayBuffer());
    const mime = (c.req.header("content-type") ?? "").split(";")[0];
    if (!/^image\/(jpeg|png|webp|heic|heif|gif)$/.test(mime)) return c.json({ error: "type", text: "That doesn't look like a photo. JPEG, PNG or WebP work." }, 400);
    if (buf.length > 15_000_000) return c.json({ error: "too big", text: "That picture's too big for me. Something under 15 MB?" }, 400);
    const caption = decodeURIComponent(c.req.header("x-caption") ?? "");
    return c.json(pageReply(await handlePhoto(db, u, buf, mime, caption.slice(0, 1000), "web")));
  });
  /** Read something aloud on the page. */
  app.post("/api/speak", async (c) => {
    const u = user(c);
    const { text } = await c.req.json().catch(() => ({ text: "" }));
    if (!text) return c.json({ error: "empty", text: "There's nothing to read." }, 400);
    if (!mediaAbilities().speak || !allow("speak", u.id)) return c.json({ error: "no voice", text: "I can't speak on this server right now." }, 400);
    const sp = await speak(String(text).slice(0, 1400), { voice: u.prefs.ttsVoice as string | undefined, persona: personaOf(u.prefs), ogg: false });
    return sp ? c.json({ audio: sp.wav.toString("base64"), mime: "audio/wav" }) : c.json({ error: "no voice", text: "My voice didn't come through this time. Try again?" }, 502);
  });
  /** A structured action from a web control (tick, add to a list). Same gate, same audit, same voice as a sentence. */
  app.post("/api/do", async (c) => {
    const u = user(c);
    const { action, args } = await c.req.json();
    if (typeof action !== "string" || !/^[a-z]+\.[a-z_]+$/.test(action)) return c.json({ error: "bad action", text: "That button didn't work. Reload the page and try again." }, 400);
    const d = await propose(ctxOf(u, `${action} ${JSON.stringify(args ?? {}).slice(0, 200)}`), action, args ?? {});
    const r = d.kind === "pending" ? { text: `${d.echo}\n\nGo ahead? This waits ten minutes for a yes.`, buttons: [{ label: "Yes, go ahead", data: `confirm:${d.pendingId}` }, { label: "No", data: `cancel:${d.pendingId}` }] } : d.kind === "ran" && d.undoId ? { text: d.reply, buttons: [{ label: "Undo", data: `undo:${d.undoId}` }] } : { text: "reply" in d ? d.reply : "" };
    return c.json(pageReply({ ...r, ...(d.kind === "ran" && d.extra?.file ? { file: d.extra.file } : {}), text: polish(r.text, { persona: personaOf(u.prefs) }) }));
  });
  app.post("/api/button", async (c) => { const u = user(c); return c.json(pageReply(await withVoice(u, await handleCallback(db, u, String((await c.req.json()).data)), false))); });
  app.get("/api/state", async (c) => {
    const u = user(c);
    const now = new Date();
    const wd = DateTime.fromJSDate(now).setZone(u.tz).weekday % 7;
    const [pending, reminders, events, meds, ledger, lists, memory, dates, classes_today, habits] = await Promise.all([
      db.query(`SELECT id, echo, expires_at FROM pending_actions WHERE user_id=$1 AND resolved IS NULL AND expires_at > now() ORDER BY id`, [u.id]),
      db.query(`SELECT id, text, due_at, cron FROM reminders WHERE user_id=$1 AND NOT deleted AND NOT done ORDER BY due_at LIMIT 30`, [u.id]),
      db.query(`SELECT id, title, starts_at, location FROM events WHERE user_id=$1 AND NOT deleted AND starts_at >= now() - interval '12 hours' ORDER BY starts_at LIMIT 30`, [u.id]),
      db.query(`SELECT id, name, dose, times, days_left FROM medications WHERE user_id=$1 AND active ORDER BY name`, [u.id]),
      db.query(`SELECT id, title, status, deadline, prize, url, payout_received FROM hackathon_entries WHERE user_id=$1 ORDER BY (status IN ('won','lost','withdrawn')), deadline NULLS LAST`, [u.id]),
      db.query(`SELECT id, list, text FROM todos WHERE user_id=$1 AND NOT done ORDER BY list, id`, [u.id]),
      db.query(`SELECT id, fact, confirmed FROM memories WHERE user_id=$1 ORDER BY id`, [u.id]),
      db.query(`SELECT id, kind, label, to_char(on_date,'YYYY-MM-DD') AS on_date, yearly FROM dates WHERE user_id=$1 ORDER BY on_date`, [u.id]),
      db.query(`SELECT name, start_time, location FROM classes WHERE user_id=$1 AND active AND weekday=$2 ORDER BY start_time`, [u.id, wd]),
      db.query(`SELECT h.name, h.target_per_week, (SELECT count(*) FROM habit_checkins c WHERE c.habit_id=h.id AND c.day >= current_date - 6)::text AS n FROM habits h WHERE h.user_id=$1 AND h.active ORDER BY h.name`, [u.id]),
    ]);
    return c.json({ pending, reminders, events, meds, ledger, lists, memory, dates, classes_today, habits, spend: await spentToday(db, u.id), quiet: inQuietHours(now, u.tz, u.quiet_start, u.quiet_end) });
  });
  app.get("/api/digest", async (c) => c.json({ text: await buildDigest(db, user(c), new Date()) }));
  /** Cycle and measures for the Health view. Only ever the signed-in person's own data. */
  app.get("/api/health", async (c) => {
    const u = user(c);
    const { cycleRows, cyclePicture, cyclePrefs } = await import("../modules/cycle.js");
    const today = DateTime.now().setZone(u.tz).toISODate()!;
    const rows = await cycleRows(db, u.id);
    const pic = cyclePicture(rows, cyclePrefs(u), today);
    const cycle = pic.tracking
      ? {
          ...pic,
          history: rows.slice(-6).map((r, i, a) => ({ start: r.started_on, end: r.ended_on, length: a[i + 1] ? Math.round((Date.parse(a[i + 1].started_on) - Date.parse(r.started_on)) / 86_400_000) : null })),
          logs: await db.query(`SELECT to_char(day,'YYYY-MM-DD') AS day, kind, value FROM cycle_logs WHERE user_id=$1 AND day >= $2::date - 20 ORDER BY day DESC, id DESC`, [u.id, today]),
          settings: cyclePrefs(u),
        }
      : { tracking: false };
    const rowsM = await db.query<{ name: string; value: string | null; unit: string | null; note: string | null; at: string }>(
      `SELECT name, value::text, unit, note, at FROM measures WHERE user_id=$1 AND at >= now() - interval '60 days' ORDER BY name, at`, [u.id]);
    const byName = new Map<string, typeof rowsM>();
    for (const r of rowsM) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
    const weekAgo = Date.now() - 7 * 86_400_000;
    const measures = [...byName.entries()].map(([name, rs]) => {
      const last = rs[rs.length - 1];
      const recent = rs.filter((r) => r.value != null && new Date(r.at).getTime() >= weekAgo).map((r) => Number(r.value));
      return {
        name, unit: rs.find((r) => r.unit)?.unit ?? null,
        last: { value: last.value == null ? null : Number(last.value), at: last.at, note: last.note },
        points: rs.filter((r) => r.value != null).map((r) => ({ at: r.at, value: Number(r.value) })),
        avg7: recent.length ? Math.round((recent.reduce((s, v) => s + v, 0) / recent.length) * 10) / 10 : null,
      };
    });
    return c.json({ cycle, measures });
  });
  app.get("/api/hackathons", async (c) => {
    const u = user(c);
    const feed = await rankedForUser(db, u, new Date(), 12, { unseenOnly: false });
    const ledger = await db.query<any>(`SELECT * FROM hackathon_entries WHERE user_id=$1 ORDER BY (status IN ('won','lost','withdrawn')), deadline NULLS LAST`, [u.id]);
    const won = ledger.filter((r) => r.status === "won").length, decided = ledger.filter((r) => ["won", "lost"].includes(r.status)).length;
    return c.json({ feed, ledger, stats: decided ? `${won} won / ${decided} decided (${Math.round((won / decided) * 100)}%)` : "No outcomes yet." });
  });
  app.get("/api/scout", async (c) => {
    const u = user(c);
    const watches = await db.query(`SELECT niche, objective FROM scout_watches WHERE user_id=$1 AND active`, [u.id]);
    const results = await db.query(`SELECT * FROM scout_results ORDER BY first_seen DESC LIMIT 30`);
    return c.json({ results, watches });
  });
  app.post("/api/scout", async (c) => {
    const u = user(c);
    const { niche, objective } = await c.req.json();
    if (!niche) return c.json({ error: "niche required", text: "Tell me what to look for first, like \"fintech in Nairobi\"." }, 400);
    await scout(db, String(niche), objective ? String(objective) : undefined, 10).catch((e) => log.warn({ err: e?.message }, "scout"));
    await db.query(`INSERT INTO audit_log (user_id, action, tier, args, outcome, source_message) VALUES ($1,'scout.find',1,$2,'ran','[web] scout')`, [u.id, JSON.stringify({ niche, objective })]);
    const results = await db.query(`SELECT * FROM scout_results WHERE niche=$1 ORDER BY first_seen DESC LIMIT 30`, [String(niche).toLowerCase()]);
    const watches = await db.query(`SELECT niche, objective FROM scout_watches WHERE user_id=$1 AND active`, [u.id]);
    return c.json({ results, watches });
  });
  app.get("/api/money", async (c) => {
    const u = user(c);
    const [spend, alerts, wallets, follows, bills] = await Promise.all([
      db.query(`SELECT currency, category, sum(amount)::text AS total FROM spend WHERE user_id=$1 AND spent_at > now() - interval '7 days' GROUP BY currency, category ORDER BY sum(amount) DESC`, [u.id]),
      db.query(`SELECT coin, op, target, pct_window, active FROM price_alerts WHERE user_id=$1 ORDER BY id DESC LIMIT 20`, [u.id]),
      db.query(`SELECT chain, address, label FROM wallets WHERE user_id=$1`, [u.id]),
      db.query(`SELECT venue, address, label, mode FROM followed_wallets WHERE user_id=$1 AND active`, [u.id]),
      db.query(`SELECT biller_code, customer, amount, status, created_at FROM bill_payments WHERE user_id=$1 ORDER BY id DESC LIMIT 10`, [u.id]),
    ]);
    return c.json({ spend, alerts, wallets, follows, bills });
  });
  app.get("/api/trips", async (c) => {
    const u = user(c);
    const trips = await db.query<any>(`SELECT id, destination, to_char(starts_on,'YYYY-MM-DD') AS starts_on, to_char(ends_on,'YYYY-MM-DD') AS ends_on, budget, currency FROM trips WHERE user_id=$1 AND status<>'cancelled' ORDER BY starts_on NULLS LAST`, [u.id]);
    for (const t of trips) t.items = await db.query(`SELECT kind, title, at, cost, done FROM trip_items WHERE trip_id=$1 ORDER BY at NULLS LAST, id`, [t.id]);
    return c.json(trips);
  });
  app.get("/api/settings", async (c) => {
    const u = user(c);
    return c.json({
      tz: u.tz, digest_hour: u.digest_hour, quiet_start: u.quiet_start, quiet_end: u.quiet_end, name: u.name, email: u.email ?? null,
      country: u.prefs.country ?? "", tags: u.prefs.tags ?? [], persona: u.prefs.personaCustom ? "custom" : u.prefs.persona ?? "plain", personaCustom: u.prefs.personaCustom ?? "",
      personas: PERSONAS, identities: await identitiesOf(db, u.id), provider: providerName(), spend: await spentToday(db, u.id), budget: config.dailyModelBudgetUsd,
      smsNumber: config.smsNumber || null,
      reach: reachOf(u), push: { ...pushPublic(), devices: await devicesOf(db, u.id) },
    });
  });
  app.patch("/api/settings", async (c) => {
    const u = user(c);
    const body = await c.req.json();
    const look: Record<string, string | boolean> = {};
    if (typeof body.palette === "string" && /^(manor|claret|riviera|tobacco|ivory)$/.test(body.palette)) look.palette = body.palette;
    if (body.mode === "day" || body.mode === "night") look.mode = body.mode;
    if (typeof body.work === "boolean") look.work = body.work; // show the work tools (hackathons, scout) in the web app's bar
    /* "Where should reminders reach you?" Telegram, this app, or both. */
    if ("reach" in body) {
      const reach = body.reach;
      if (reach !== "telegram" && reach !== "app" && reach !== "both") return c.json({ ok: false, text: "Choose Telegram, this app, or both." }, 400);
      const tg = await db.one(`SELECT 1 FROM identities WHERE user_id=$1 AND channel='telegram'`, [u.id]);
      if (reach !== "app" && !tg) return c.json({ ok: false, error: "no telegram", text: "Telegram isn't one of your ways in yet. Add it under Ways to sign in, then choose again." }, 400);
      if (reach !== "telegram" && !(await devicesOf(db, u.id))) return c.json({ ok: false, error: "no device", text: "Turn on notifications on this device first, then choose again." }, 400);
      await db.query(`UPDATE users SET preferred_channel=$2, prefs = prefs || $3::jsonb WHERE id=$1`, [u.id, reach === "app" ? "app" : "telegram", JSON.stringify({ alsoApp: reach === "both" })]);
      return c.json({ ok: true, reach, text: reach === "both" ? "Reminders will reach you here and on Telegram." : reach === "app" ? "Reminders will reach you in this app." : "Reminders will reach you on Telegram." });
    }
    if (Object.keys(look).length) {
      await db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [u.id, JSON.stringify(look)]);
      return c.json({ ok: true, text: "Saved." });
    }
    if ("palette" in body || "mode" in body) return c.json({ ok: false, text: "I don't have that look." }, 400);
    const d = await propose(ctxOf(u, "settings"), "settings.update", body);
    return c.json({ ok: d.kind === "ran", text: d.kind === "pending" ? d.echo : d.reply });
  });
  /** A line from Pip for the moment. With a model, in the user's voice; otherwise from his own book of lines. */
  const pipRoute = async (c: any) => {
    const u = user(c);
    const state = (c.req.query("state") ?? "idle") as PipState;
    const fallback = pipLine(state, u);
    const line = await draftReply(db, u, `State of the day: ${state}. Time: ${DateTime.now().setZone(u.tz).toFormat("HH:mm cccc")}. Fallback line you may improve on: "${fallback}"`, "You are Pip, a small tortoise with spectacles who keeps the user's day. Slow on purpose, never drops what he carries, dry and warm. Say one line (max 16 words) in the user's chosen voice that fits the state. No emoji, no em dashes. Output the line only.").catch(() => null);
    return c.json({ text: polish(line ?? fallback, { persona: personaOf(u.prefs) }) });
  };
  app.get("/api/pip", pipRoute);
  app.get("/api/quip", pipRoute);

  /* ---- inbound webhooks ---- */
  /** Android SMS gateways (httpSMS, TextBee): signed JSON in, reply sent back through the gateway's API. See docs/SMS.md. */
  app.post("/webhooks/sms/:provider", async (c) => {
    const raw = await c.req.text();
    const r = await handleGatewayWebhook(db, c.req.param("provider"), raw, {
      authorization: c.req.header("authorization"), "x-signature": c.req.header("x-signature"), "x-event-type": c.req.header("x-event-type"),
    });
    return c.json(r.body, r.status as 200);
  });
  app.post("/webhooks/twilio", async (c) => {
    const form = Object.fromEntries((await c.req.formData()).entries()) as Record<string, string>;
    if (!verifyTwilio(`${config.publicUrl}/webhooks/twilio`, form, c.req.header("x-twilio-signature") ?? "")) return c.text("forbidden", 403);
    const reply = await handleTextChannel(db, "sms", form.From, form.Body ?? "");
    return c.body(`<?xml version="1.0" encoding="UTF-8"?><Response>${reply ? `<Message>${escapeXml(reply)}</Message>` : ""}</Response>`, 200, { "content-type": "text/xml" });
  });
  /** Email in: Resend's email.received webhook (see docs/EMAIL.md). */
  app.post("/webhooks/email", async (c) => {
    const raw = await c.req.text();
    const h = (k: string) => c.req.header(k);
    // Answer Resend within a few seconds; slow work (a model call, a search) carries on after.
    const work = handleInboundEmail(db, raw, { "svix-id": h("svix-id"), "svix-timestamp": h("svix-timestamp"), "svix-signature": h("svix-signature") })
      .catch((e) => { log.error({ err: e?.message }, "inbound email failed"); return { status: 200, body: { error: "failed" } }; });
    const r = await Promise.race([work, new Promise<{ status: number; body: Record<string, unknown> }>((res) => setTimeout(() => res({ status: 200, body: { accepted: true } }), 8000))]);
    return c.json(r.body, r.status as any);
  });
  app.post("/webhooks/imessage", async (c) => {
    const secret = c.req.query("secret") ?? c.req.header("x-webhook-secret") ?? "";
    if (!config.webhookSecret || secret !== config.webhookSecret) return c.text("forbidden", 403);
    const inbound = parseInbound(await c.req.json().catch(() => null));
    if (!inbound) return c.json({ ignored: true });
    const reply = await handleTextChannel(db, "imessage", inbound.from, inbound.text);
    if (!reply) return c.json({ ignored: "not linked" });
    const { sendIMessage } = await import("../channels/imessage.js");
    await sendIMessage(inbound.from, reply).catch((e) => log.warn({ err: e?.message }, "imessage reply failed"));
    return c.json({ ok: true });
  });

  return app;
}

export function startWeb(db: Db, botUsername: string) {
  const app = createWeb(db, botUsername);
  serve({ fetch: app.fetch, port: config.port }, (info) => log.info({ port: info.port }, "web listening"));
  return app;
}

function escapeXml(s: string) {
  return s.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]!));
}
