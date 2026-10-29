/**
 * Shared bits for the home area: per-person settings under prefs.home, a small cache table,
 * one-ping-per-feature-per-day, a fetch that never throws, and plain-word helpers.
 */
import { DateTime } from "luxon";
import type { Db } from "../../../core/db.js";
import type { User } from "../../../policy/types.js";
import { push, type SchedulerDeps } from "../../../core/scheduler.js";
import { localDay } from "../../../core/time.js";
import { findCity, type Place } from "../../../core/geo.js";
import { userCurrency } from "../../../core/money.js";
import { addSchema } from "../../../core/plugins.js";

addSchema(`CREATE TABLE IF NOT EXISTS home_cache (key TEXT PRIMARY KEY, value JSONB, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS home_pings (user_id INT NOT NULL REFERENCES users(id), feature TEXT NOT NULL, day TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS home_pings_day ON home_pings(user_id, feature, day)`);

export type HomePrefs = Record<string, any>;
export const homePrefs = (u: Pick<User, "prefs">): HomePrefs => ((u.prefs?.home && typeof u.prefs.home === "object") ? (u.prefs.home as HomePrefs) : {});

/** Merge `patch` into prefs.home, in the database and on the user object in hand. */
export async function setHome(db: Db, user: User, patch: HomePrefs): Promise<void> {
  const next = { ...homePrefs(user), ...patch };
  await db.query(`UPDATE users SET prefs = jsonb_set(prefs, '{home}', COALESCE(prefs->'home', '{}'::jsonb) || $2::jsonb) WHERE id=$1`, [user.id, JSON.stringify(patch)]);
  user.prefs = { ...user.prefs, home: next };
}

/** Top-level prefs (country, for one): merged, never overwritten wholesale. */
export async function setPrefs(db: Db, user: User, patch: Record<string, unknown>): Promise<void> {
  await db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [user.id, JSON.stringify(patch)]);
  user.prefs = { ...user.prefs, ...patch };
}

export const local = (d: Date | string, tz: string) => DateTime.fromJSDate(typeof d === "string" ? new Date(d) : d).setZone(tz);

/** A fetch that never throws: null when the service can't be reached or says no. */
export async function getJson(url: string, init: RequestInit = {}, ms = 10_000): Promise<{ status: number; data: any } | null> {
  try {
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    const text = await r.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: r.status, data };
  } catch { return null; }
}

/** Read a cached value younger than `maxAgeMs`, or null. */
export async function cacheGet<T = any>(db: Db, key: string, maxAgeMs: number, now = new Date()): Promise<T | null> {
  const row = await db.one<{ value: any; fetched_at: string }>(`SELECT value, fetched_at FROM home_cache WHERE key=$1`, [key]);
  if (!row) return null;
  if (now.getTime() - new Date(row.fetched_at).getTime() > maxAgeMs) return null;
  return (typeof row.value === "string" ? JSON.parse(row.value) : row.value) as T;
}
export async function cachePut(db: Db, key: string, value: unknown, now = new Date()): Promise<void> {
  await db.query(`INSERT INTO home_cache (key, value, fetched_at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, fetched_at=EXCLUDED.fetched_at`, [key, JSON.stringify(value), now]);
}
/** Cached, or fetched and kept. A failed fetch returns the stale value if there is one. */
export async function cached<T>(db: Db, key: string, maxAgeMs: number, fetcher: () => Promise<T | null>, now = new Date()): Promise<T | null> {
  const hit = await cacheGet<T>(db, key, maxAgeMs, now);
  if (hit !== null) return hit;
  const fresh = await fetcher();
  if (fresh !== null) { await cachePut(db, key, fresh, now); return fresh; }
  return cacheGet<T>(db, key, Number.MAX_SAFE_INTEGER, now);
}

/**
 * The calm rule in one place: at most `max` pings a day for this feature, through push()
 * (quiet hours, the daily cap, calm mode and quiet days all apply).
 */
export async function pingOnce(deps: SchedulerDeps, user: User, feature: string, text: string, opts: { buttons?: { label: string; data: string }[]; max?: number; now?: Date } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const day = localDay(now, user.tz);
  const n = await deps.db.one<{ n: string }>(`SELECT count(*)::text AS n FROM home_pings WHERE user_id=$1 AND feature=$2 AND day=$3`, [user.id, feature, day]);
  if (Number(n?.n ?? 0) >= (opts.max ?? 1)) return false;
  const ok = await push(deps, user, `home_${feature}`, text, { buttons: opts.buttons, now });
  if (ok) await deps.db.query(`INSERT INTO home_pings (user_id, feature, day, at) VALUES ($1,$2,$3,$4)`, [user.id, feature, day, now]);
  return ok;
}

/** Where the person is, for prayer times and sunsets: their saved city, looked up once. */
export async function homePlace(db: Db, user: User, city?: string): Promise<Place | null> {
  const saved = homePrefs(user).place as (Place & { from?: string }) | undefined;
  const own = typeof user.prefs.city === "string" ? (user.prefs.city as string).trim() : "";
  const want = (city ?? "").trim() || (own && (!saved || saved.from !== own.toLowerCase()) ? own : "");
  if (!want) return saved ?? null;
  if (saved && saved.from === want.toLowerCase()) return saved;
  const p = await findCity(want);
  if (!p) return city ? null : saved ?? null;
  const place = { ...p, from: want.toLowerCase() };
  await setHome(db, user, { place });
  return place;
}

const ISO = new Set<string>((() => { try { return (Intl as any).supportedValuesOf("currency") as string[]; } catch { return ["USD", "EUR", "GBP", "NGN", "XAF", "XOF", "GHS", "KES", "ZAR"]; } })());

/** "for 15000", "₦15,000", "15k", "for 20 euros": a cost in the person's own currency unless they named one. */
export function parseCost(text: string, user: Pick<User, "tz" | "prefs">): { amount: number; currency: string } | null {
  const UNIT = /^(?:kg|kgs|kwh|units?|litres?|liters?|l|hrs?|hours?|days?|jerrycans?|drums?)$/i;
  const cands = [
    ...text.matchAll(/(?:\bfor|\bcost|\bpaid|,)\s*([₦$£€]|ksh|kes|ngn|usd|gbp|eur|xaf|xof|ghs|zar|cfa)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?\s*(naira|dollars?|pounds?|euros?|cedis?|shillings?|rand|cfa|francs?|[a-z]{1,8}\b)?/gi),
    ...text.matchAll(/([₦$£€])\s*(\d[\d,]*(?:\.\d+)?)\s*(k\b)?()/g),
    ...text.matchAll(/()(\d[\d,]*(?:\.\d+)?)\s*(k\b)?\s*(naira|dollars?|pounds?|euros?|cedis?|shillings?|rand|cfa|francs?|ngn|usd|gbp|eur|xaf|xof|ghs|kes|zar)\b/gi),
  ];
  const m = cands.find((x) => !UNIT.test(x[4] ?? ""));
  if (!m) return null;
  let amount = Number(m[2].replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (m[3]) amount *= 1000;
  const sym = (m[1] ?? "").toLowerCase();
  const word = (m[4] ?? "").toLowerCase();
  const BY: Record<string, string> = { "₦": "NGN", $: "USD", "£": "GBP", "€": "EUR", ksh: "KES", cfa: "XAF", r: "ZAR", naira: "NGN", dollar: "USD", dollars: "USD", pound: "GBP", pounds: "GBP", euro: "EUR", euros: "EUR", cedi: "GHS", cedis: "GHS", shilling: "KES", shillings: "KES", rand: "ZAR", franc: "XAF", francs: "XAF" };
  let currency = BY[sym] ?? (sym ? sym.toUpperCase() : "");
  if (!currency && word) currency = BY[word] ?? (/^[a-z]{3}$/.test(word) && ISO.has(word.toUpperCase()) ? word.toUpperCase() : "");
  if (currency === "CFA") currency = "XAF";
  return { amount, currency: currency || userCurrency(user) };
}

export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
/** "Arsenal, Chelsea and Spurs". */
export const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** "today", "tomorrow", "Friday", "Fri 6 Nov": a day the way people say it. */
export function dayWord(d: DateTime, now: DateTime): string {
  const days = Math.round(d.startOf("day").diff(now.startOf("day"), "days").days);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  if (days > 1 && days < 7) return d.toFormat("cccc");
  return d.toFormat("ccc d LLL");
}
/** Every user who has rows in a table, with their full record. */
export async function usersIn(db: Db, sql: string, params: unknown[] = []): Promise<User[]> {
  return db.query<User>(`SELECT * FROM users WHERE id IN (${sql})`, params);
}
