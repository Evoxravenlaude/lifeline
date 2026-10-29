/**
 * Pages and images the bot links to: the picture card shown above the Telegram menu, and shared plans.
 * Mounted by src/web/server.ts; owned separately so the sign-in work there and this can move independently.
 *
 * Card links are signed (person, card and minute), expire in half an hour (Telegram fetches the picture once, when the
 * message is sent or edited), and the picture holds only what the menu text under it says anyway.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import type { Db } from "../core/db.js";
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import { homeSvg, pageSvg, renderPng, type Plate } from "../core/cards.js";
import { money } from "../core/money.js";
import { getUserById } from "../core/handler.js";
import { homeFacts } from "../telegram/panels.js";
import { inQuietHours } from "../core/time.js";
import { DateTime } from "luxon";
import { mountPlans } from "./plans.js";

const key = () => createHash("sha256").update(`lifeline-cards:${config.telegramToken}`).digest();
const sign = (s: string) => createHmac("sha256", key()).update(s).digest("hex").slice(0, 32);

const PAGES: Record<string, { title: string; plate: Plate; pose: string; subtitle?: string }> = {
  today: { title: "Today", plate: "event", pose: "ontoit" },
  lists: { title: "Your lists", plate: "list", pose: "noted" },
  health: { title: "Body and mind", plate: "dose", pose: "noted", subtitle: "Kept between us" },
  money: { title: "Money", plate: "money", pose: "noted", subtitle: "This week, so far" },
  trips: { title: "Trips", plate: "trip", pose: "carrying" },
  play: { title: "Play", plate: "hack", pose: "cheers", subtitle: "A quick game" },
  settings: { title: "Settings", plate: "scout", pose: "thinking", subtitle: "Tap to change" },
  everything: { title: "Everything", plate: "class", pose: "hello", subtitle: "In drawers, not a wall" },
};
export const CARD_KINDS = ["home", ...Object.keys(PAGES)];

/**
 * A signed, expiring address for one person's card, or null when the server has no public https address
 * (Telegram must be able to fetch it). The minute in it makes Telegram fetch a fresh picture each time.
 */
export function cardUrl(userId: number, kind: string, now = new Date()): string | null {
  const base = (config.publicUrl || "").replace(/\/$/, "");
  if (!/^https:\/\//.test(base) || !config.telegramToken || !CARD_KINDS.includes(kind)) return null;
  const exp = Math.floor(now.getTime() / 1000) + 30 * 60;
  const v = Math.floor(now.getTime() / 60_000).toString(36);
  return `${base}/card/${kind}.png?u=${userId}&e=${exp}&v=${v}&s=${sign(`${userId}.${kind}.${exp}.${v}`)}`;
}

/** Whether a card address checks out. Exported for tests. */
export function cardOk(userId: number, kind: string, exp: number, sig: string, now = new Date(), v = ""): boolean {
  if (!config.telegramToken) return false; // the signing key comes from the bot token; without one, nothing is signed
  if (!Number.isFinite(exp) || exp * 1000 < now.getTime() || exp * 1000 > now.getTime() + 31 * 60_000 || !/^[0-9a-f]{32}$/.test(sig)) return false;
  const want = Buffer.from(sign(`${userId}.${kind}.${exp}.${v}`)), got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

const poseFor = (hour: number, quiet: boolean, pending: number) => (quiet ? "asleep" : pending ? "waiting" : hour < 12 ? "hello" : hour < 18 ? "ontoit" : "later");

/** The picture for a card: built from live data each time (cached for a minute). */
export async function cardPng(db: Db, userId: number, kind: string, now = new Date()): Promise<Buffer | null> {
  const user = await getUserById(db, userId);
  if (!user) return null;
  if (kind === "home") {
    const f = await homeFacts(db, user, now);
    const quiet = inQuietHours(now, user.tz, user.quiet_start, user.quiet_end);
    return renderPng(homeSvg({
      greeting: f.greeting, date: f.date, pose: poseFor(f.hour, quiet, f.pending),
      stats: [
        { label: "Next", value: f.next ? `${f.next.title}, ${f.next.at}` : "A clear day", plate: "event" },
        { label: f.pending ? "Waiting on you" : "On your lists", value: f.pending ? `${f.pending} to answer` : f.open ? `${f.open} open` : "All clear", plate: f.pending ? "rem" : "list" },
        { label: "This week", value: f.spent ? `${money(f.spent.amount, f.spent.currency)} spent` : "Nothing spent", plate: "money" },
      ],
    }));
  }
  const p = PAGES[kind];
  if (!p) return null;
  const subtitle = kind === "today" ? DateTime.fromJSDate(now).setZone(user.tz).toFormat("cccc d LLLL") : p.subtitle;
  return renderPng(pageSvg({ title: p.title, subtitle, plate: p.plate, pose: p.pose }));
}

const cache = new Map<string, { at: number; png: Buffer }>();

export function mountExtras(app: Hono<any>, db: Db): void {
  app.get("/card/:file", async (c) => {
    const m = /^([a-z]+)\.png$/.exec(c.req.param("file") ?? "");
    const kind = m?.[1] ?? "", userId = Number(c.req.query("u")), exp = Number(c.req.query("e")), sig = String(c.req.query("s") ?? "");
    if (!m || !CARD_KINDS.includes(kind) || !Number.isInteger(userId) || !cardOk(userId, kind, exp, sig, new Date(), String(c.req.query("v") ?? ""))) return c.body(null, 404);
    const id = `${userId}.${kind}.${c.req.query("v") ?? ""}`;
    let hit = cache.get(id);
    if (!hit || Date.now() - hit.at > 60_000) {
      try {
        const png = await cardPng(db, userId, kind);
        if (!png) return c.body(null, 404);
        hit = { at: Date.now(), png };
        cache.set(id, hit);
        if (cache.size > 300) cache.delete(cache.keys().next().value!);
      } catch (e: any) { log.warn({ err: e?.message, kind }, "card render failed"); return c.body(null, 500); }
    }
    return c.body(new Uint8Array(hit.png), 200, { "content-type": "image/png", "cache-control": "private, max-age=60", "x-robots-tag": "noindex" });
  });
  mountPlans(app, db);
}
