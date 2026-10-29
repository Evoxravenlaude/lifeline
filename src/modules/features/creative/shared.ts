/**
 * Creative and NFTs: the shared parts. Dates in the person's own zone, a small HTTP helper,
 * one calm daily sweep that merges every time-sensitive creative thing (a commission due,
 * an open call closing, a release step due) into a single ping, the brief lines that carry
 * everything else, the "cr:" buttons, and the one off switch, "stop creative pings".
 */
import { DateTime } from "luxon";
import * as chrono from "chrono-node";
import { z } from "zod";
import type { Db } from "../../../core/db.js";
import type { Ctx, User } from "../../../policy/types.js";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addBriefSection, addButtons, addCues, addExamples, addRules, addSchema, type ButtonReply } from "../../../core/plugins.js";
import { localDay } from "../../../core/time.js";
import { onJob, push, schedule, type SchedulerDeps } from "../../../core/scheduler.js";
import { propose, type Decision } from "../../../policy/engine.js";
import { setThread } from "../../../intent/thread.js";
import { complete, providerName } from "../../../intent/providers.js";
import { overBudget, recordUsage } from "../../../core/budget.js";
import { log } from "../../../core/log.js";
import { looksSecret as secretKind } from "../safety/shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS crt_pings (user_id INT NOT NULL REFERENCES users(id), key TEXT NOT NULL, at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (user_id, key));
CREATE TABLE IF NOT EXISTS crt_cache (key TEXT PRIMARY KEY, body JSONB, at TIMESTAMPTZ NOT NULL DEFAULT now())`);

/* ---------------- HTTP ---------------- */

export const UA = "lifeline-bot/0.1 (personal assistant; read-only)";
export class HttpError extends Error {
  constructor(public status: number, public url: string) { super(`${new URL(url).hostname} answered ${status}`); }
}
export async function getJson<T = any>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, signal: AbortSignal.timeout(12_000) });
  if (!r.ok) throw new HttpError(r.status, url);
  return (await r.json()) as T;
}
/** A cached JSON body, or null when it's older than `maxAgeMs`. */
export async function cacheGet(db: Db, key: string, maxAgeMs: number, now = new Date()): Promise<any | null> {
  const c = await db.one<{ body: any; at: string }>(`SELECT body, at FROM crt_cache WHERE key=$1`, [key]);
  if (!c || now.getTime() - new Date(c.at).getTime() > maxAgeMs) return null;
  return typeof c.body === "string" ? JSON.parse(c.body) : c.body;
}
export async function cachePut(db: Db, key: string, body: unknown, now = new Date()): Promise<void> {
  await db.query(`INSERT INTO crt_cache (key, body, at) VALUES ($1,$2,$3) ON CONFLICT (key) DO UPDATE SET body=EXCLUDED.body, at=EXCLUDED.at`, [key, JSON.stringify(body), now]);
}
/** Run `fn` over `items`, `n` at a time; one failing item never stops the rest. */
export async function inBatches<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map((x) => fn(x).catch((e) => log.warn({ err: (e as Error)?.message }, "creative batch item failed"))));
}

/* ---------------- secrets ---------------- */

/** A seed phrase or private key in what someone typed, said in plain words. Null when there's none. */
export function refuseSecret(...texts: (string | undefined | null)[]): string | null {
  for (const t of texts) {
    if (!t) continue;
    const what = secretKind(t);
    if (what) return `That looks like ${what}, so I haven't kept it and I never will. I only need names and public addresses for your mints. If it's real, move everything to a fresh wallet now; anyone who has seen it can empty the old one.`;
  }
  return null;
}

/* ---------------- dates, always in the person's own zone ---------------- */

export const todayOf = (user: User, now: Date) => localDay(now, user.tz);
const isoDay = (iso: string) => DateTime.fromISO(iso.slice(0, 10));
export const isoOf = (d: string | Date) => (typeof d === "string" ? d.slice(0, 10) : DateTime.fromJSDate(d).toISODate()!);
export const addDays = (iso: string, n: number) => isoDay(iso).plus({ days: n }).toISODate()!;
export function daysTo(iso: string, user: User, now: Date): number {
  return Math.round(isoDay(iso).diff(isoDay(todayOf(user, now)), "days").days);
}
/** "today", "tomorrow", "Thursday", "20 November", "3 March 2027". */
export function sayDay(iso: string, user: User, now: Date): string {
  const d = daysTo(iso, user, now);
  const day = isoDay(iso);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  if (d > 1 && d < 7) return day.toFormat("cccc");
  return day.toFormat(day.year === isoDay(todayOf(user, now)).year ? "d LLLL" : "d LLLL yyyy");
}
/** "Thu 20 Nov": short, for lists. */
export const shortDay = (iso: string) => isoDay(iso).toFormat("ccc d LLL");
export function sayIn(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return days === -1 ? "yesterday" : `${-days} days ago`;
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30.4)} months`;
}

/** A day someone typed ("Friday", "20 Nov", "3 March"), as a local ISO day. */
export function parseDay(text: string, user: User, now: Date): string | null {
  const t = text.trim().replace(/^(?:on|by|the|before|until)\s+/i, "").replace(/\bthe\s+(?=\d)/i, "");
  const ref = DateTime.fromJSDate(now).setZone(user.tz);
  const r = chrono.parse(t, { instant: now, timezone: ref.offset }, { forwardDate: true })[0];
  if (!r) return null;
  return DateTime.fromJSDate(r.start.date()).setZone(user.tz).toISODate();
}

export interface Moment { at: Date; timed: boolean; utc: boolean }
/**
 * A moment someone typed: "3 Nov 18:00 UTC", "5pm my time", "Friday". `timed` is false when only a day was given
 * (then it sits at 09:00 their time); `utc` is true when they gave the time in UTC or GMT, so we can say both.
 */
export function parseMoment(text: string, user: User, now: Date): Moment | null {
  const utc = /\b(?:utc|gmt)\b|\d\s*z\b/i.test(text);
  const t = text.replace(/\b(?:my|your|our|local)\s+time\b|\blocal\b/gi, " ").replace(/(\d)\s*z\b/gi, "$1 UTC").replace(/\s+/g, " ").trim();
  const ref = DateTime.fromJSDate(now).setZone(user.tz);
  const r = chrono.parse(t, { instant: now, timezone: ref.offset }, { forwardDate: true })[0];
  if (!r) return null;
  const timed = r.start.isCertain("hour");
  // chrono was given today's offset; across a clock change (summer time) that's an hour out. Unless they named a zone,
  // read the day and time they typed as wall-clock time in their own zone, on that date.
  const wall = (h: number, min: number) => DateTime.fromObject({ year: r.start.get("year")!, month: r.start.get("month")!, day: r.start.get("day")!, hour: h, minute: min }, { zone: user.tz }).toJSDate();
  let at = r.start.isCertain("timezoneOffset") ? r.start.date() : wall(r.start.get("hour") ?? 9, r.start.get("minute") ?? 0);
  if (!timed) at = wall(9, 0);
  return { at, timed, utc: utc && timed };
}
/** "Tue 3 Nov at 19:00 your time (18:00 UTC)", "Friday", "today at 17:00". */
export function sayMoment(at: Date | string, timed: boolean, utc: boolean, user: User, now: Date): string {
  const d = typeof at === "string" ? new Date(at) : at;
  const local = DateTime.fromJSDate(d).setZone(user.tz);
  const day = sayDay(local.toISODate()!, user, now);
  const dayWords = /^(?:today|tomorrow|yesterday|[A-Z][a-z]+day)$/.test(day) ? day : local.toFormat("ccc d LLL");
  if (!timed) return dayWords;
  const clock = local.toFormat("HH:mm");
  if (!utc) return `${dayWords} at ${clock}`;
  const u = DateTime.fromJSDate(d).setZone("UTC");
  if (local.offset === 0) return `${dayWords} at ${clock} UTC`;
  const uDay = u.toISODate() !== local.toISODate() ? `${u.toFormat("ccc d LLL")} ` : "";
  return `${dayWords} at ${clock} your time (${uDay}${u.toFormat("HH:mm")} UTC)`;
}

/* ---------------- words ---------------- */

const NUM_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };
export const COUNT = "(\\d{1,5}|an?|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)";
export const countOf = (w?: string | null): number | undefined => (!w ? undefined : /^\d+$/.test(w) ? Number(w) : NUM_WORDS[w.toLowerCase()]);
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
export const clean = (s: string) => s.trim().replace(/^(?:the|my|our|a|an)\s+/i, "").replace(/[.?!,;:]+$/, "").trim();
/** A plain amount: 1.5, 0.08, 12,345.6. */
export function num(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  if (a === 0) return "0";
  if (a >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a >= 1) return String(Number(n.toFixed(4)));
  return n.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 12 });
}
/** The row whose name best matches what someone typed: exact, then starts-with, then contains. */
export function byName<T extends Record<string, any>>(rows: T[], fields: (keyof T)[], typed: string): T[] {
  const q = clean(typed).toLowerCase().replace(/'s\b/g, "");
  if (!q) return [];
  const vals = (r: T) => fields.map((f) => String(r[f] ?? "").toLowerCase()).filter(Boolean);
  const words = q.split(/\s+/).filter((w) => w.length > 1 && !/^(?:the|for|my|of)$/.test(w));
  const tiers: ((r: T) => boolean)[] = [
    (r) => vals(r).some((v) => v === q) || vals(r).join(" ") === q,
    (r) => vals(r).some((v) => v.startsWith(q) || q.startsWith(v)),
    (r) => vals(r).some((v) => v.includes(q) || q.includes(v)),
    (r) => words.length > 0 && words.every((w) => vals(r).some((v) => v.includes(w))),
  ];
  for (const t of tiers) { const hit = rows.filter(t); if (hit.length) return hit; }
  return [];
}

/* ---------------- prefs ---------------- */

export async function setPrefs(db: Db, user: User, patch: Record<string, unknown>): Promise<void> {
  await db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [user.id, JSON.stringify(patch)]);
  Object.assign(user.prefs, patch);
}

/* ---------------- pings, at most one a day, merged ---------------- */

export async function wasPinged(db: Db, userId: number, key: string): Promise<boolean> {
  return Boolean(await db.one(`SELECT 1 FROM crt_pings WHERE user_id=$1 AND key=$2`, [userId, key]));
}
export async function markPinged(db: Db, userId: number, keys: string[]): Promise<void> {
  for (const k of keys) await db.query(`INSERT INTO crt_pings (user_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, k]);
}

export interface Button { label: string; data: string }
export interface SweepItem { key: string; text: string; button?: Button }
type Pinger = (db: Db, user: User, today: string, now: Date) => Promise<SweepItem[]>;
const pingers: [string, Pinger][] = [];
/** A feature's time-sensitive things for today (a commission due in 3 days, a call closing tomorrow). */
export const addPinger = (feature: string, fn: Pinger) => { pingers.push([feature, fn]); };

export const STOP_LINE = `Say "stop creative pings" to keep these to your morning brief.`;

/** The person's own daily creative check, created the first time they keep something with a date. */
export async function ensureDaily(db: Db, user: User): Promise<void> {
  const j = await db.one<{ id: number; tz: string | null }>(`SELECT id, tz FROM jobs WHERE user_id=$1 AND kind='crt_daily' AND active LIMIT 1`, [user.id]);
  if (!j) { await schedule(db, { userId: user.id, kind: "crt_daily", cron: "17 9 * * *", tz: user.tz }); return; }
  if (j.tz !== user.tz) await db.query(`UPDATE jobs SET tz=$2 WHERE id=$1`, [j.id, user.tz]);
}

/** Everything time-sensitive today, one line per feature, in one message, at most once a day. Returns what was sent, or null. */
export async function creativeSweep(deps: SchedulerDeps, user: User, now = new Date()): Promise<string | null> {
  if (user.prefs?.crtQuiet === true) return null;
  const today = todayOf(user, now);
  if (await wasPinged(deps.db, user.id, `sweep:${today}`)) return null;
  const parts: { text: string; keys: string[]; button?: Button }[] = [];
  for (const [f, fn] of pingers) {
    let items: SweepItem[] = [];
    try { items = await fn(deps.db, user, today, now); } catch (e: any) { log.warn({ err: e?.message, f }, "creative pinger failed"); }
    const fresh: SweepItem[] = [];
    for (const it of items) if (!(await wasPinged(deps.db, user.id, it.key))) fresh.push(it);
    if (fresh.length) parts.push({ text: fresh.map((x) => x.text).join(" "), keys: fresh.map((x) => x.key), button: fresh.find((x) => x.button)?.button });
  }
  if (!parts.length) return null;
  const body = parts.length === 1 ? parts[0].text : `A few creative things today:\n${parts.map((p) => `- ${p.text}`).join("\n")}`;
  const text = `${body}\n\n${STOP_LINE}`;
  const buttons = parts.map((p) => p.button).filter((b): b is Button => Boolean(b)).slice(0, 3);
  const ok = await push(deps, user, "creative", text, { buttons: buttons.length ? buttons : undefined, now });
  if (!ok) return null;
  await markPinged(deps.db, user.id, [...parts.flatMap((p) => p.keys), `sweep:${today}`]);
  return text;
}

onJob("crt_daily", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  if (job.tz !== user.tz) await deps.db.query(`UPDATE jobs SET tz=$2 WHERE id=$1`, [job.id, user.tz]);
  await creativeSweep(deps, user, new Date());
});

/* ---------------- the brief ---------------- */

export interface BriefItem { p: number; text: string; group?: string }
type Collector = (db: Db, user: User, now: Date, peek: boolean) => Promise<BriefItem[]>;
const collectors: Collector[] = [];
export const addBriefItems = (fn: Collector) => { collectors.push(fn); };

const sentence = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);
/** At most two lines: the most pressing thing on its own, then the rest joined. */
addBriefSection({
  key: "creative", order: 22,
  async lines(db, user, now, opts) {
    const all: BriefItem[] = [];
    for (const fn of collectors) {
      try { all.push(...(await fn(db, user, now, Boolean(opts?.peek)))); } catch (e: any) { log.warn({ err: e?.message }, "creative brief failed"); }
    }
    if (!all.length) return [];
    all.sort((a, b) => a.p - b.p);
    if (all.length <= 2) return all.map((x) => sentence(x.text));
    const rest = all.slice(1).map((x) => x.text.replace(/\.$/, ""));
    const joined = rest.length <= 3 ? rest.join("; ") : `${rest.slice(0, 3).join("; ")}; and ${rest.length - 3} more`;
    return [sentence(all[0].text), sentence(`Also: ${joined}`)];
  },
});

/* ---------------- buttons ---------------- */

type ButtonFn = (ctx: Ctx, parts: string[]) => Promise<ButtonReply>;
const buttonFns = new Map<string, ButtonFn>();
/** A button "cr:<name>:..." comes to `fn` with the parts after the name. */
export const addCrButton = (name: string, fn: ButtonFn) => { buttonFns.set(name, fn); };
addButtons("cr", async (db, user, data, now) => {
  const [, name, ...parts] = data.split(":");
  const fn = buttonFns.get(name);
  if (!fn) return { text: "That button doesn't do anything any more." };
  return fn({ db, user, now, sourceMessage: `[button ${data}]` }, parts);
});

/** How another action's decision reads as a reply (used when a sentence belongs to another feature after all). */
export async function render(ctx: Ctx, d: Decision): Promise<ButtonReply> {
  switch (d.kind) {
    case "ran": return { text: d.reply, buttons: [...(d.extra?.buttons ?? []), ...(d.undoId ? [{ label: "Undo", data: `undo:${d.undoId}` }] : [])] };
    case "pending": return { text: `${d.echo}\n\nGo ahead? This waits ten minutes for a yes.`, buttons: [{ label: "Yes, go ahead", data: `confirm:${d.pendingId}` }, { label: "No", data: `cancel:${d.pendingId}` }] };
    case "ask": await setThread(ctx.db, ctx.user, d.thread); return { text: d.reply };
    default: return { text: d.reply };
  }
}
export async function runOther(ctx: Ctx, action: string, args: unknown): Promise<ButtonReply> {
  return render(ctx, await propose(ctx, action, args));
}

/* ---------------- a short model call, only where it earns its cost ---------------- */

export async function think(db: Db, user: User, instruction: string, max = 160): Promise<string | null> {
  if (!providerName() || (await overBudget(db, user.id))) return null;
  try {
    const r = await complete({ system: "You are lifeline, a calm personal assistant for creative people. Plain sentences, no emoji, no em dashes, no preamble.", messages: [{ role: "user", content: instruction }], maxTokens: max });
    if (!r?.text) return null;
    await recordUsage(db, user.id, r.usage.input, r.usage.output);
    return r.text.trim().replace(/—/g, ", ");
  } catch (e: any) { log.warn({ err: e?.message }, "creative model call failed"); return null; }
}

/* ---------------- the off switch, in words ---------------- */

const quiet = defineAction({
  name: "creative.quiet",
  tier: 1,
  description: "Turn the daily creative ping off or back on (commission deadlines, open calls closing, release steps due). Off means they wait for the morning brief instead. Mint reminders the person set are not affected.",
  schema: z.object({ on: z.boolean() }),
  async run(args, ctx) {
    const prev = ctx.user.prefs.crtQuiet === true;
    await setPrefs(ctx.db, ctx.user, { crtQuiet: !args.on });
    return args.on
      ? { reply: "Creative pings are back on. At most one a day, and only when a date is close.", undo: { payload: { prev } } }
      : { reply: "No more creative pings. Deadlines and steps will wait for your morning brief. Say \"creative pings on\" to bring them back.", undo: { payload: { prev } } };
  },
  async undo(p, ctx) { await setPrefs(ctx.db, ctx.user, { crtQuiet: p.prev }); return "Back how it was."; },
});
register(quiet);
addRules(
  [/^(?:stop|no more|mute|pause|turn off)(?: the| my)? (?:creative|art|commission|open call|release) (?:pings|reminders|nudges|alerts|notifications)$/i, () => ({ action: "creative.quiet", args: { on: false } })],
  [/^(?:turn on|resume|unmute|start)(?: the| my)? (?:creative|art) (?:pings|reminders|nudges)$|^(?:creative|art) (?:pings|reminders|nudges) (?:back )?on$/i, () => ({ action: "creative.quiet", args: { on: true } })],
);
addExamples("creative.quiet", ["stop creative pings", "stop the commission reminders", "creative pings on"]);
addCues("creative", ["creative pings", "stop creative", "commission reminders", "release reminders"]);
