/**
 * Shared bits for the wellbeing area: per-person settings under users.prefs.wb, a gentle model helper,
 * dates people say in the past tense, the crisis words, and messages to another person in the circle.
 * Everything here is private to the person it belongs to.
 */
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import type { Db } from "../../../core/db.js";
import type { User } from "../../../policy/types.js";
import type { ButtonReply } from "../../../core/plugins.js";
import { complete, providerName } from "../../../intent/providers.js";
import { overBudget, recordUsage } from "../../../core/budget.js";
import { log } from "../../../core/log.js";
import { cancelJob, onJob, push, schedule } from "../../../core/scheduler.js";
import { countryOf } from "../../../core/money.js";

/* ---------- settings ---------- */

export type Wb = Record<string, any>;
export const wb = (u: Pick<User, "prefs">): Wb => (u.prefs?.wb && typeof u.prefs.wb === "object" ? (u.prefs.wb as Wb) : {});

/** Merge into prefs.wb. A null value removes the key. Keeps the in-memory user in step, so a later setThread doesn't undo it. */
export async function setWb(db: Db, user: User, patch: Wb): Promise<Wb> {
  const next: Wb = { ...wb(user), ...patch };
  for (const k of Object.keys(next)) if (next[k] === null || next[k] === undefined) delete next[k];
  user.prefs = { ...user.prefs, wb: next };
  await db.query(`UPDATE users SET prefs = jsonb_set(prefs, '{wb}', $2::jsonb, true) WHERE id=$1`, [user.id, JSON.stringify(next)]);
  return next;
}

export const isCalm = (u: Pick<User, "prefs">) => u.prefs?.calm === true;
export const first = (u: Pick<User, "name">) => (u.name ? u.name.split(" ")[0] : null);
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/* ---------- sentences ---------- */

const POLITE = String.raw`(?:(?:hey|hi|ok|okay|so|please|pls|pip|lifeline|can you|could you|would you|will you|i'?d like you to|i want you to)[,\s]+)*`;
/** An anchored, case-insensitive rule that tolerates a polite opening, a trailing "please" or "thanks" and a question mark. */
export const rx = (body: string) => new RegExp(`^${POLITE}(?:${body})(?:[,\\s]+(?:please|thanks|thank you))?\\s*\\?*$`, "i");

/** "Mum", "my mum" and "MUM" are the same person. Shown with a capital. */
export function personName(s: string): string {
  const t = s.trim().replace(/^@/, "").replace(/^(?:my|our)\s+/i, "").replace(/[.,!?]+$/, "").trim();
  return cap(t);
}

export const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, "a couple of": 2, few: 3, "a few": 3 };
export const toNum = (s: string | undefined): number | null => {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  return NUM[t] ?? null;
};

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
export const weekdayOf = (s: string): number | null => { const i = WEEKDAYS.findIndex((d) => d.startsWith(s.trim().toLowerCase().slice(0, 3))); return i >= 0 && s.trim().length >= 3 ? i : null; };
export const monthOf = (s: string): number | null => { const t = s.trim().toLowerCase(); if (t.length < 3) return null; const i = MONTHS.findIndex((m) => m.startsWith(t.slice(0, 3))); return i >= 0 ? i + 1 : null; };

/* ---------- days ---------- */

export const today = (user: Pick<User, "tz">, now: Date) => DateTime.fromJSDate(now).setZone(user.tz).startOf("day");
export const iso = (d: DateTime) => d.toISODate()!;
export const dayOf = (isoDay: string, tz: string) => DateTime.fromISO(isoDay, { zone: tz }).startOf("day");
export const daysBetween = (a: string, b: string) => Math.round(DateTime.fromISO(b).diff(DateTime.fromISO(a), "days").days);
export const sayDay = (isoDay: string, tz: string, now?: Date) => {
  const d = dayOf(isoDay, tz);
  const sameYear = now ? d.year === DateTime.fromJSDate(now).setZone(tz).year : true;
  return d.toFormat(sameYear ? "d LLL" : "d LLL yyyy");
};

/** A day someone names in the past: "1 Oct", "Monday", "yesterday", "last week". Never a future day. */
export function pastDay(text: string | undefined, user: Pick<User, "tz">, now: Date): string | null {
  const t0 = today(user, now);
  const t = (text ?? "").trim().toLowerCase();
  if (!t || /^(?:today|now|this morning|tonight|this evening)$/.test(t)) return iso(t0);
  if (/^(?:yesterday|last night)$/.test(t)) return iso(t0.minus({ days: 1 }));
  const ref = DateTime.fromJSDate(now).setZone(user.tz);
  const r = chrono.parse(t, { instant: now, timezone: ref.offset })[0];
  if (!r) return null;
  let d = DateTime.fromJSDate(r.start.date()).setZone(user.tz).startOf("day");
  if (d > t0) {
    if (r.start.isCertain("year")) return null;
    d = r.start.isCertain("month") || r.start.isCertain("day") ? d.minus({ years: 1 }) : d.minus({ weeks: 1 });
    if (d > t0) d = d.minus({ weeks: 1 });
  }
  return iso(d);
}

/** "4 June 2019", "12 August": the day and month (and the year when given). */
export function dayMonth(text: string, user: Pick<User, "tz">, now: Date): { month: number; day: number; year: number | null } | null {
  const ref = DateTime.fromJSDate(now).setZone(user.tz);
  const r = chrono.parse(text, { instant: now, timezone: ref.offset })[0];
  if (!r || !r.start.isCertain("day") || !r.start.isCertain("month")) return null;
  return { month: r.start.get("month")!, day: r.start.get("day")!, year: r.start.isCertain("year") ? r.start.get("year")! : null };
}

/** The next time a yearly day comes round at a local clock time (today counts if the time hasn't passed). */
export function nextYearly(month: number, day: number, user: Pick<User, "tz">, now: Date, hour = 10): Date {
  const local = DateTime.fromJSDate(now).setZone(user.tz);
  const safeDay = (y: number) => Math.min(day, DateTime.fromObject({ year: y, month }, { zone: user.tz }).daysInMonth ?? 28);
  let d = DateTime.fromObject({ year: local.year, month, day: safeDay(local.year), hour }, { zone: user.tz });
  if (d <= local) d = DateTime.fromObject({ year: local.year + 1, month, day: safeDay(local.year + 1), hour }, { zone: user.tz });
  return d.toJSDate();
}

/** A five-field cron at a local clock time, with the minute nudged off :00 so jobs never land together. */
export const dailyCron = (hour: number, minute: number | null, dow = "*") => `${minute ?? 7} ${hour} * * ${dow}`;
export const clockOf = (hour: number, minute = 0) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** "9pm", "21:00", "at 8" → hour and minute. */
export function readClock(text: string | undefined): [number, number] | null {
  if (!text) return null;
  const m = /^\s*(?:at\s+)?(\d{1,2})(?::|\.)?(\d{2})?\s*(am|pm)?\s*$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return [h, min];
}

/* ---------- jobs ---------- */

/** One recurring job of this kind per person: the old one goes, the new one starts. Returns its id. */
export async function ensureCron(db: Db, user: User, kind: string, cron: string, payload: unknown = {}): Promise<number> {
  await db.query(`UPDATE jobs SET active=false WHERE user_id=$1 AND kind=$2 AND active`, [user.id, kind]);
  return schedule(db, { userId: user.id, kind, cron, tz: user.tz, payload });
}
/** Keep a daily sweep job (one per person) if there isn't one already. */
export async function keepDaily(db: Db, user: User, kind: string, cron: string) {
  const has = await db.one(`SELECT 1 FROM jobs WHERE user_id=$1 AND kind=$2 AND active`, [user.id, kind]);
  if (!has) await schedule(db, { userId: user.id, kind, cron, tz: user.tz });
}
export async function stopJobs(db: Db, userId: number, kind: string) {
  await db.query(`UPDATE jobs SET active=false WHERE user_id=$1 AND kind=$2 AND active`, [userId, kind]);
}
export { cancelJob };

/**
 * A message to someone in the circle (a buddy's request, a caregiver's alert). It goes through push(),
 * so their quiet hours, calm mode and quiet days apply unless it's marked exempt.
 */
export async function tell(db: Db, userId: number, text: string, opts: { buttons?: { label: string; data: string }[]; exempt?: boolean; kind?: string } = {}) {
  await schedule(db, { userId, kind: "well_send", payload: { text, buttons: opts.buttons, exempt: Boolean(opts.exempt), kind: opts.kind ?? "well" }, runAt: new Date() });
}
onJob("well_send", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user || !job.payload?.text) return;
  await push(deps, user, job.payload.kind ?? "well", job.payload.text, { buttons: job.payload.buttons, exempt: job.payload.exempt === true });
});

/* ---------- the model, used lightly ---------- */

/** A short model call in a gentle voice. Null with no model, over budget, or on any failure: callers always have a plain fallback. */
export async function think(db: Db, user: User, instruction: string, o: { json?: boolean; max?: number } = {}): Promise<string | null> {
  if (!providerName() || (await overBudget(db, user.id))) return null;
  try {
    const r = await complete({
      system: "You are lifeline, a calm, kind personal assistant. Plain words, short, warm, never preachy. Never diagnose or give medical advice. No emoji. No em dashes.",
      messages: [{ role: "user", content: instruction }], json: o.json, maxTokens: o.max ?? 400,
    });
    if (!r) return null;
    await recordUsage(db, user.id, r.usage.input, r.usage.output);
    return r.text || null;
  } catch (e: any) { log.warn({ err: e?.message }, "wellbeing model call failed"); return null; }
}

/* ---------- crisis ---------- */

/** Words that suggest someone may be thinking of harming themselves. Deliberately specific: everyday phrases ("I cut myself cooking") stay out. */
export const CRISIS = /\b(?:kill(?:ing)?\s+my\s?self|end(?:ing)?\s+my\s+(?:own\s+)?life|take\s+my\s+(?:own\s+)?life|end\s+it\s+all(?!\s+(?:with|for|on|in|at)\b)|(?:want|wanna|going|plan(?:ning)?|ready)\s+to\s+die(?!\s+(?:laughing|of\s+(?:laughter|embarrassment|boredom|shame)|for\s+(?:a|some|this|that|one)\b))|wish\s+i\s+(?:was|were)\s+dead|wish\s+i\s+(?:wasn'?t|weren'?t)\s+(?:alive|here|born)|better\s+off\s+(?:dead|without\s+me)|suicid\w*(?!\s+squad)|self[- ]?harm\w*|(?:want|going|thinking\s+(?:about|of))\s+(?:to\s+)?(?:hurt|hurting|cut|cutting)\s+my\s?self|(?:been|started|keep|kept)\s+(?:cutting|hurting)\s+my\s?self|don'?t\s+want\s+to\s+(?:be\s+alive|live|be\s+here\s+any\s?more|wake\s+up)|no\s+reason\s+to\s+(?:live|go\s+on)|can'?t\s+go\s+on\s+(?:living|any\s?more)|not\s+worth\s+living|overdos(?:e|ing)\s+on\s+purpose|take\s+all\s+my\s+(?:pills|tablets))\b/i;

/** Emergency numbers we're sure of. Anywhere else we say "your local emergency number" rather than guess. */
const EMERGENCY: Record<string, string> = {
  US: "911", CA: "911", MX: "911", GB: "999", AU: "000", NZ: "111", IN: "112", NG: "112", KE: "112", GH: "112", ZA: "112",
  ...Object.fromEntries("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE NO CH IS".split(" ").map((c) => [c, "112"])),
};

/** Warm, short, and pointing to real help wherever the person is. No lecture, no single country's helpline. */
export function crisisReply(user: Pick<User, "tz" | "prefs">): string {
  const c = countryOf(user);
  const n = c ? EMERGENCY[c] : undefined;
  return [
    "I'm really glad you told me. You don't have to hold this on your own.",
    `If you might act on these thoughts, or you're in danger right now, please call ${n ? `${n}, the emergency number where you are,` : "your local emergency number"} now.`,
    "To talk to someone, free and confidential, https://findahelpline.com finds a helpline near you, by phone, text or chat.",
    "I'm here too. Tell me what's going on, if you'd like.",
  ].join("\n\n");
}

/* ---------- buttons ---------- */

type Sub = (db: Db, user: User, parts: string[], now: Date) => Promise<ButtonReply>;
const subs = new Map<string, Sub>();
/** Each file registers its own button family: "wb:m:3" goes to the "m" handler with ["3"]. */
export const onButton = (sub: string, fn: Sub) => { subs.set(sub, fn); };
export async function wbButton(db: Db, user: User, data: string, now: Date): Promise<ButtonReply> {
  const [, sub, ...rest] = data.split(":");
  const fn = subs.get(sub);
  return fn ? fn(db, user, rest, now) : { text: "That button doesn't do anything any more." };
}

/** A sticker only on real moments, and never in calm mode. */
export const cheers = (user: Pick<User, "prefs">) => (isCalm(user) ? undefined : "cheers");

/** The first time a recurring prompt arrives, it says how to stop it. Returns the hint to append (or ""), and remembers it was said. */
export async function stopHint(db: Db, user: User, key: string, words: string): Promise<string> {
  const told = (wb(user).told ?? {}) as Record<string, boolean>;
  if (told[key]) return "";
  await setWb(db, user, { told: { ...told, [key]: true } });
  return `\n\nSay "${words}" any time to stop these.`;
}
