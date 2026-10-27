/**
 * Web channel + webhooks. Hono on node:http, static files from src/web/public.
 *  auth:    POST /auth/telegram  POST /auth/link  POST /auth/logout
 *  app:     GET /api/me /api/public /api/messages /api/state /api/digest /api/hackathons /api/scout /api/money /api/trips /api/settings /api/quip
 *           POST /api/chat /api/button /api/scout   PATCH /api/settings
 *  hooks:   POST /webhooks/twilio  POST /webhooks/imessage   GET /health
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import type { Db } from "../core/db.js";
import { ensureUser, getUserById, handleCallback, handleMessage, redeemLinkCode, identitiesOf } from "../core/handler.js";
import { registerSender } from "../core/dispatch.js";
import { handleGatewayWebhook, handleTextChannel, verifyTwilio } from "../channels/sms.js";
import { parseInbound } from "../channels/imessage.js";
import { buildDigest } from "../modules/digest.js";
import { rankedForUser } from "../modules/hackathons.js";
import { scout } from "../modules/scout.js";
import { spentToday } from "../core/budget.js";
import { inQuietHours } from "../core/time.js";
import { propose } from "../policy/engine.js";
import { PERSONAS } from "../intent/persona.js";
import { startWebLogin, pollWebLogin } from "../core/weblogin.js";
import { admit, FULL_MESSAGE } from "../core/circle.js";
import { providerName } from "../intent/providers.js";
import { draftReply } from "../intent/model.js";
import { DateTime } from "luxon";
import { cors } from "hono/cors";
import type { User } from "../policy/types.js";
import { CAPABILITIES, HELP_GROUPS } from "../intent/capabilities.js";
import { pipLine, PIP_BIO, type PipState } from "../core/pip.js";
import { polish, personaOf } from "../core/voice.js";

const SESSION_DAYS = 30;
/** The web app lives in web/ at the repo root: Railway serves it here, and the same folder is the Vercel project. */
const PUBLIC_DIR = path.relative(process.cwd(), path.join(path.dirname(fileURLToPath(import.meta.url)), "../../web")) || ".";

export function createWeb(db: Db, botUsername: string) {
  const app = new Hono<{ Variables: { user: User } }>();
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

  const session = async (c: any): Promise<User | null> => {
    const tok = getCookie(c, "ll_session");
    if (!tok) return null;
    const row = await db.one<{ user_id: number }>(`SELECT user_id FROM sessions WHERE token=$1 AND expires_at > now()`, [tok]);
    return row ? (await getUserById(db, row.user_id)) ?? null : null;
  };
  const newSession = async (c: any, user: User) => {
    const token = randomBytes(32).toString("hex");
    await db.query(`INSERT INTO sessions (token, user_id, expires_at) VALUES ($1,$2,$3)`, [token, user.id, new Date(Date.now() + SESSION_DAYS * 86_400_000)]);
    const cross = config.webOrigins.length > 0;
    setCookie(c, "ll_session", token, { httpOnly: true, sameSite: cross ? "None" : "Lax", secure: cross || config.publicUrl.startsWith("https"), path: "/", maxAge: SESSION_DAYS * 86_400 });
    await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,'web',$2) ON CONFLICT DO NOTHING`, [user.id, `web:${user.id}`]);
  };
  const ctxOf = (u: User, src: string) => ({ db, user: u, now: new Date(), sourceMessage: `[web] ${src}` });

  // A web front on another origin (the Vercel domain) talks to this brain with cookies.
  if (config.webOrigins.length) app.use("/api/*", cors({ origin: config.webOrigins, credentials: true })) && app.use("/auth/*", cors({ origin: config.webOrigins, credentials: true }));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/api/public", async (c) => {
    const n = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
    return c.json({ botUsername, places: { taken: Number(n?.n ?? 0), max: config.maxUsers } });
  });
  /** The catalogue is public: the landing page shows everything before anyone signs in. */
  app.get("/api/capabilities", (c) => c.json({ capabilities: CAPABILITIES, groups: HELP_GROUPS, pip: PIP_BIO }));
  for (const f of ["styles.css", "app.js", "mascot.js", "path.js", "icon.svg", "manifest.webmanifest"]) app.use(`/${f}`, serveStatic({ root: PUBLIC_DIR, path: f }));
  app.use("/fonts/*", serveStatic({ root: PUBLIC_DIR }));
  app.get("/", serveStatic({ root: PUBLIC_DIR, path: "index.html" }));

  /* ---- auth ---- */
  app.post("/auth/telegram", async (c) => {
    const data = (await c.req.json()) as Record<string, string>;
    const { hash, ...rest } = data;
    const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("\n");
    const expected = createHmac("sha256", createHash("sha256").update(config.telegramToken).digest()).update(check).digest("hex");
    if (expected !== hash || Date.now() / 1000 - Number(rest.auth_date) > 86_400) return c.json({ error: "bad signature", text: "That Telegram sign-in didn't check out, or it's more than a day old. Try signing in again." }, 401);
    const id = Number(rest.id);
    if ((await admit(db, id)) === "full") return c.json({ error: "full", text: FULL_MESSAGE() }, 403);
    const user = await ensureUser(db, "telegram", String(id), [rest.first_name, rest.last_name].filter(Boolean).join(" "));
    await newSession(c, user);
    return c.json({ ok: true });
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
  app.post("/auth/link", async (c) => {
    const { code } = await c.req.json();
    const user = await redeemLinkCode(db, String(code ?? ""), "web", `web:${randomBytes(8).toString("hex")}`);
    if (!user) return c.json({ error: "invalid or expired code", text: "That code didn't work. Codes last fifteen minutes; say link to the bot for a fresh one." }, 401);
    await newSession(c, user);
    return c.json({ ok: true });
  });
  app.post("/auth/logout", async (c) => {
    const tok = getCookie(c, "ll_session");
    if (tok) await db.query(`DELETE FROM sessions WHERE token=$1`, [tok]);
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

  /* ---- app data ---- */
  app.get("/api/me", async (c) => {
    const u = user(c);
    return c.json({ id: u.id, name: u.name, tz: u.tz, theme: u.prefs.theme ?? null, persona: u.prefs.personaCustom ? "custom" : u.prefs.persona ?? "plain", spend: await spentToday(db, u.id), budget: config.dailyModelBudgetUsd, gemini: Boolean(config.geminiKey), pip: pipLine("return", u), quiet_start: u.quiet_start, quiet_end: u.quiet_end, palette: u.prefs.palette ?? null, mode: u.prefs.mode ?? null, work: typeof u.prefs.work === "boolean" ? u.prefs.work : null, tags: Array.isArray(u.prefs.tags) ? u.prefs.tags : [] });
  });
  app.get("/api/messages", async (c) => c.json((await db.query(`SELECT id, role, content, created_at FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT 60`, [user(c).id])).reverse()));
  app.post("/api/chat", async (c) => {
    const { text } = await c.req.json();
    if (!text || !String(text).trim()) return c.json({ error: "empty", text: "There was nothing in that message." }, 400);
    if (String(text).length > 4000) return c.json({ error: "too long", text: "That's longer than I can take in one message. Try it in two parts." }, 400);
    return c.json(await handleMessage(db, user(c), String(text), { channel: "web" }));
  });
  /** A structured action from a web control (tick, add to a list). Same gate, same audit, same voice as a sentence. */
  app.post("/api/do", async (c) => {
    const u = user(c);
    const { action, args } = await c.req.json();
    if (typeof action !== "string" || !/^[a-z]+\.[a-z_]+$/.test(action)) return c.json({ error: "bad action", text: "That button didn't work. Reload the page and try again." }, 400);
    const d = await propose(ctxOf(u, `${action} ${JSON.stringify(args ?? {}).slice(0, 200)}`), action, args ?? {});
    const r = d.kind === "pending" ? { text: `${d.echo}\n\nGo ahead? This waits ten minutes for a yes.`, buttons: [{ label: "Yes, go ahead", data: `confirm:${d.pendingId}` }, { label: "No", data: `cancel:${d.pendingId}` }] } : d.kind === "ran" && d.undoId ? { text: d.reply, buttons: [{ label: "Undo", data: `undo:${d.undoId}` }] } : { text: "reply" in d ? d.reply : "" };
    return c.json({ ...r, text: polish(r.text, { persona: personaOf(u.prefs) }) });
  });
  app.post("/api/button", async (c) => c.json(await handleCallback(db, user(c), String((await c.req.json()).data))));
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
    if (!niche) return c.json({ error: "niche required", text: "Tell me what to look for first, like \"fintech in Lagos\"." }, 400);
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
    });
  });
  app.patch("/api/settings", async (c) => {
    const u = user(c);
    const body = await c.req.json();
    const look: Record<string, string | boolean> = {};
    if (typeof body.palette === "string" && /^(manor|claret|riviera|tobacco|ivory)$/.test(body.palette)) look.palette = body.palette;
    if (body.mode === "day" || body.mode === "night") look.mode = body.mode;
    if (typeof body.work === "boolean") look.work = body.work; // show the work tools (hackathons, scout) in the web app's bar
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
    return c.body(`<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(reply)}</Message></Response>`, 200, { "content-type": "text/xml" });
  });
  app.post("/webhooks/imessage", async (c) => {
    const secret = c.req.query("secret") ?? c.req.header("x-webhook-secret") ?? "";
    if (!config.webhookSecret || secret !== config.webhookSecret) return c.text("forbidden", 403);
    const inbound = parseInbound(await c.req.json().catch(() => null));
    if (!inbound) return c.json({ ignored: true });
    const reply = await handleTextChannel(db, "imessage", inbound.from, inbound.text);
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
