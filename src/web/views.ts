/**
 * Read-only data for three of the website's views, each only ever for the signed-in person:
 *  GET /api/day?date=YYYY-MM-DD    one day as a timeline: events, reminders, classes, doses and trip items, done and left
 *  GET /api/cycle?month=YYYY-MM    the cycle calendar: logged period days, and the module's own predictions
 *  GET /api/emergency              the emergency card's text, for "Keep a copy on this phone" inside Telegram
 *
 * Mounted by src/web/server.ts after the /api sign-in check, so every route here has a user. Nothing here writes,
 * and every answer says no-store: health and safety details never sit in a cache.
 */
import type { Hono } from "hono";
import { DateTime } from "luxon";
import type { Db } from "../core/db.js";
import type { User } from "../policy/types.js";
import { localDay } from "../core/time.js";
import { getAction } from "../policy/registry.js";
import { cyclePicture, cyclePrefs, cycleRows } from "../modules/cycle.js";

export type DayKind = "event" | "rem" | "class" | "dose" | "trip";
/** done: ticked, taken, skipped or attended. passed: its time went by without a mark. next: still to come. */
export type DayState = "done" | "passed" | "next";
export interface DayItem {
  kind: DayKind;
  at: string;
  time: string;
  end?: string;
  title: string;
  sub?: string;
  state: DayState;
  note?: string;
  actions?: { label: string; data: string }[];
}
export interface DayPlan {
  date: string;
  label: string;
  long: string;
  offset: number;
  now: string;
  nowTime: string;
  items: DayItem[];
  allDay: { title: string; sub?: string }[];
  counts: { done: number; left: number };
}

/** How far from today the day view reaches, either way. */
export const DAY_REACH = 366;
const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const clock = (t: string): [number, number] | null => { const m = /^(\d{1,2}):(\d{2})/.exec(t ?? ""); return m && Number(m[1]) < 24 && Number(m[2]) < 60 ? [Number(m[1]), Number(m[2])] : null; };

/** One day for the person, in their own time zone. `date` is an ISO day; the caller checks it. */
export async function dayPlan(db: Db, u: User, date: string, now: Date): Promise<DayPlan> {
  const zone = u.tz;
  const day = DateTime.fromISO(date, { zone }).startOf("day");
  const start = day.toJSDate(), end = day.plus({ days: 1 }).toJSDate();
  const local = DateTime.fromJSDate(now).setZone(zone);
  const offset = Math.round(day.diff(local.startOf("day"), "days").days);
  const at = (h: number, m: number) => day.set({ hour: h, minute: m });
  const hhmm = (d: Date | string | DateTime) => (d instanceof DateTime ? d : DateTime.fromJSDate(new Date(d)).setZone(zone)).toFormat("HH:mm");

  const [events, rems, classes, meds, logs, tripItems, trips] = await Promise.all([
    db.query<{ title: string; starts_at: string; ends_at: string | null; location: string | null }>(
      `SELECT title, starts_at, ends_at, location FROM events WHERE user_id=$1 AND NOT deleted AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at`, [u.id, start, end]),
    db.query<{ id: number; text: string; due_at: string; cron: string | null; done: boolean }>(
      `SELECT id, text, due_at, cron, done FROM reminders WHERE user_id=$1 AND NOT deleted AND due_at >= $2 AND due_at < $3 ORDER BY due_at`, [u.id, start, end]),
    db.query<{ name: string; start_time: string; end_time: string | null; location: string | null }>(
      `SELECT name, start_time, end_time, location FROM classes WHERE user_id=$1 AND active AND weekday=$2 AND (term_end IS NULL OR term_end >= $3::date) ORDER BY start_time`, [u.id, day.weekday % 7, date]),
    db.query<{ id: number; name: string; dose: string | null; times: string[]; created_at: string }>(
      `SELECT id, name, dose, times, created_at FROM medications WHERE user_id=$1 AND active AND created_at < $2 ORDER BY name`, [u.id, end]),
    db.query<{ id: number; medication_id: number; scheduled_for: string; status: string }>(
      `SELECT l.id, l.medication_id, l.scheduled_for, l.status FROM medication_logs l JOIN medications m ON m.id=l.medication_id WHERE m.user_id=$1 AND l.scheduled_for >= $2 AND l.scheduled_for < $3 ORDER BY l.scheduled_for`, [u.id, start, end]),
    db.query<{ kind: string; title: string; at: string; done: boolean; destination: string }>(
      `SELECT i.kind, i.title, i.at, i.done, t.destination FROM trip_items i JOIN trips t ON t.id=i.trip_id WHERE t.user_id=$1 AND t.status <> 'cancelled' AND i.at >= $2 AND i.at < $3 ORDER BY i.at`, [u.id, start, end]),
    db.query<{ destination: string; starts_on: string; ends_on: string | null }>(
      `SELECT destination, to_char(starts_on,'YYYY-MM-DD') AS starts_on, to_char(ends_on,'YYYY-MM-DD') AS ends_on FROM trips WHERE user_id=$1 AND status <> 'cancelled' AND starts_on <= $2::date AND COALESCE(ends_on, starts_on) >= $2::date ORDER BY starts_on`, [u.id, date]),
  ]);

  const items: (DayItem & { ms: number })[] = [];
  const nowMs = now.getTime();
  const push = (ms: number, it: Omit<DayItem, "at" | "time">) => items.push({ ms, at: new Date(ms).toISOString(), time: hhmm(DateTime.fromMillis(ms).setZone(zone)), ...it });

  for (const e of events) {
    const s = new Date(e.starts_at).getTime(), f = e.ends_at ? new Date(e.ends_at).getTime() : s;
    push(s, { kind: "event", title: cap(e.title), sub: e.location ?? undefined, end: e.ends_at ? hhmm(e.ends_at) : undefined, state: f < nowMs ? "done" : "next" });
  }
  for (const r of rems) {
    const s = new Date(r.due_at).getTime();
    const state: DayState = r.done ? "done" : s < nowMs ? "passed" : "next";
    const actions = r.done || offset < 0 ? undefined : [{ label: "Done", data: `rem:done:${r.id}` }, ...(offset === 0 ? [{ label: "Snooze", data: `rem:snooze:${r.id}` }] : [])];
    push(s, { kind: "rem", title: cap(r.text), sub: r.cron ? "repeats" : undefined, state, note: r.done ? "Ticked off" : state === "passed" ? "Not ticked off" : undefined, actions });
  }
  for (const c of classes) {
    const a = clock(c.start_time); if (!a) continue;
    const s = at(...a), z = c.end_time && clock(c.end_time) ? at(...clock(c.end_time)!) : s;
    push(s.toMillis(), { kind: "class", title: cap(c.name), sub: c.location ?? undefined, end: c.end_time ? z.toFormat("HH:mm") : undefined, state: z.toMillis() < nowMs ? "done" : "next" });
  }
  // Doses: each time on the list is a slot; the log the reminder made (or a "took it") is matched to its nearest slot.
  for (const m of meds) {
    const slots = m.times.map(clock).filter((x): x is [number, number] => Boolean(x)).map((x) => at(...x)).filter((s) => s.toMillis() >= new Date(m.created_at).getTime() - 60_000).sort((p, q) => p.toMillis() - q.toMillis());
    const taken = new Map<number, (typeof logs)[number]>();
    for (const l of logs.filter((x) => x.medication_id === m.id)) {
      const t = new Date(l.scheduled_for).getTime();
      let best = -1, gap = 6 * 3_600_000;
      slots.forEach((s, i) => { const g = Math.abs(s.toMillis() - t); if (!taken.has(i) && g <= gap) { best = i; gap = g; } });
      if (best >= 0) taken.set(best, l);
    }
    slots.forEach((s, i) => {
      const l = taken.get(i);
      const ms = s.toMillis();
      if (l?.status === "taken") return push(ms, { kind: "dose", title: cap(m.name), sub: m.dose ?? undefined, state: "done", note: "Taken" });
      if (l?.status === "skipped") return push(ms, { kind: "dose", title: cap(m.name), sub: m.dose ?? undefined, state: "done", note: "Skipped" });
      if (l) return push(ms, { kind: "dose", title: cap(m.name), sub: m.dose ?? undefined, state: "passed", note: "Waiting on you", actions: [{ label: "Taken", data: `med:taken:${l.id}` }, { label: "Skip", data: `med:skip:${l.id}` }] });
      push(ms, { kind: "dose", title: cap(m.name), sub: m.dose ?? undefined, state: ms < nowMs ? "passed" : "next", note: ms < nowMs ? "Not marked" : undefined });
    });
  }
  for (const t of tripItems) {
    const s = new Date(t.at).getTime();
    push(s, { kind: "trip", title: cap(t.title), sub: cap(t.destination), state: t.done || s < nowMs ? "done" : "next" });
  }
  items.sort((p, q) => p.ms - q.ms);

  const allDay = trips.map((t) => {
    const first = DateTime.fromISO(t.starts_on, { zone }), last = t.ends_on ? DateTime.fromISO(t.ends_on, { zone }) : null;
    const n = Math.round(day.diff(first, "days").days) + 1, total = last ? Math.round(last.diff(first, "days").days) + 1 : null;
    return { title: `${cap(t.destination)} trip`, sub: n === 1 ? "You set off" : total && n === total ? "The last day" : total ? `Day ${n} of ${total}` : `Day ${n}` };
  });
  const done = items.filter((i) => i.state !== "next").length;
  return {
    date, offset, items: items.map(({ ms: _ms, ...i }) => i), allDay,
    label: offset === 0 ? "Today" : offset === -1 ? "Yesterday" : offset === 1 ? "Tomorrow" : day.toFormat("cccc d LLLL"),
    long: day.toFormat("cccc d LLLL"),
    now: now.toISOString(), nowTime: local.toFormat("HH:mm"),
    counts: { done, left: items.length - done },
  };
}

/* ---------- the cycle calendar ---------- */

export interface CycleDay { date: string; day: number; period: boolean; predicted: boolean; fertile: boolean; today: boolean; notes: number }
export type CycleMonth =
  | { shown: false }
  | {
      shown: true; tracking: boolean; month: string; label: string; prev: string; next: string; today: string;
      /** Blank cells before the 1st, for a week that starts on Monday. */
      lead: number;
      days: CycleDay[];
      logs: { day: string; kind: string; value: string }[];
      picture: { day: number | null; length: number; periodLength: number; nextStart: string | null; fertileStart: string | null; fertileEnd: string | null; inPeriod: boolean; lateBy: number; irregular: boolean } | null;
    };

/** How far the calendar reaches from this month, either way. */
export const MONTH_REACH = 24;

/**
 * One month of the cycle, only for someone who tracks it (a period logged, or cycle settings chosen).
 * Logged days come from what they told lifeline. Predictions are only the module's own: the next period (from its
 * start, for the usual period length) and the fertile window it works out, both left off when the period is late,
 * the same as everywhere else the cycle is described.
 */
export async function cycleMonth(db: Db, u: User, month: string | null, now: Date): Promise<CycleMonth> {
  const rows = await cycleRows(db, u.id);
  const prefs = cyclePrefs(u);
  if (!rows.length && !Object.keys(prefs).length) return { shown: false };
  const today = localDay(now, u.tz);
  const first = (month ? DateTime.fromISO(`${month}-01`, { zone: "utc" }) : DateTime.fromISO(today, { zone: "utc" })).startOf("month");
  const last = first.endOf("month").startOf("day");
  const pic = cyclePicture(rows, prefs, today);
  const D = (s: string) => DateTime.fromISO(s, { zone: "utc" });
  const iso = (d: DateTime) => d.toISODate()!;

  const period = new Set<string>();
  rows.forEach((r, i) => {
    const s = D(r.started_on);
    // An open period runs for the usual length, and never past today.
    let e = r.ended_on ? D(r.ended_on) : s.plus({ days: pic.periodLength - 1 });
    if (!r.ended_on && i === rows.length - 1 && e > D(today)) e = D(today);
    if (e < first || s > last) return;
    for (let d = s; d <= e; d = d.plus({ days: 1 })) period.add(iso(d));
  });
  const predicted = new Set<string>(), fertile = new Set<string>();
  if (pic.tracking && pic.lateBy === 0 && pic.nextStart) {
    for (let d = D(pic.nextStart), i = 0; i < pic.periodLength; i++, d = d.plus({ days: 1 })) if (!period.has(iso(d))) predicted.add(iso(d));
    if (pic.fertileStart && pic.fertileEnd) for (let d = D(pic.fertileStart); d <= D(pic.fertileEnd); d = d.plus({ days: 1 })) fertile.add(iso(d));
  }
  const logs = await db.query<{ day: string; kind: string; value: string }>(
    `SELECT to_char(day,'YYYY-MM-DD') AS day, kind, value FROM cycle_logs WHERE user_id=$1 AND day >= $2::date AND day <= $3::date ORDER BY day, id`, [u.id, iso(first), iso(last)]);
  const notes = new Map<string, number>();
  for (const l of logs) notes.set(l.day, (notes.get(l.day) ?? 0) + 1);

  const days: CycleDay[] = [];
  for (let d = first; d <= last; d = d.plus({ days: 1 })) {
    const k = iso(d);
    days.push({ date: k, day: d.day, period: period.has(k), predicted: predicted.has(k), fertile: fertile.has(k) && !period.has(k), today: k === today, notes: notes.get(k) ?? 0 });
  }
  return {
    shown: true, tracking: pic.tracking, month: first.toFormat("yyyy-LL"), label: first.toFormat("LLLL yyyy"),
    prev: first.minus({ months: 1 }).toFormat("yyyy-LL"), next: first.plus({ months: 1 }).toFormat("yyyy-LL"), today,
    lead: first.weekday - 1, days, logs,
    picture: pic.tracking ? { day: pic.day, length: pic.length, periodLength: pic.periodLength, nextStart: pic.nextStart, fertileStart: pic.fertileStart, fertileEnd: pic.fertileEnd, inPeriod: pic.inPeriod, lateBy: pic.lateBy, irregular: pic.irregular } : null,
  };
}

/* ---------- the emergency card ---------- */

/**
 * The card's text, exactly as "show my emergency card" draws it (src/modules/features/safety/card.ts), or null
 * when there isn't one. Read through the action itself so the page and the chat never disagree.
 */
export async function emergencyCard(db: Db, u: User, now: Date): Promise<{ card: string | null }> {
  const show = getAction("emergency.card_show");
  if (!show) return { card: null };
  const r = await show.run({}, { db, user: u, now, sourceMessage: "[web] emergency card" });
  const m = /```\n([\s\S]*?)\n```/.exec(r.reply);
  return { card: m ? m[1] : null };
}

/* ---------- routes ---------- */

export function mountViews(app: Hono<any>, db: Db): void {
  const user = (c: any): User => c.get("user") as User;
  const fresh = (c: any) => c.header("Cache-Control", "no-store, private");

  app.get("/api/day", async (c) => {
    const u = user(c), now = new Date();
    const q = c.req.query("date");
    const today = localDay(now, u.tz);
    const date = q ?? today;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date) ? DateTime.fromISO(date, { zone: u.tz }) : null;
    if (!d || !d.isValid) return c.json({ error: "date", text: "I couldn't read that day. Try going back to today." }, 400);
    if (Math.abs(d.diff(DateTime.fromISO(today, { zone: u.tz }), "days").days) > DAY_REACH) return c.json({ error: "range", text: "That's further than a year away. Try a day closer to today." }, 400);
    fresh(c);
    return c.json(await dayPlan(db, u, date, now));
  });

  app.get("/api/cycle", async (c) => {
    const u = user(c), now = new Date();
    const q = c.req.query("month");
    if (q !== undefined) {
      const m = /^\d{4}-\d{2}$/.test(q) ? DateTime.fromISO(`${q}-01`, { zone: "utc" }) : null;
      if (!m || !m.isValid) return c.json({ error: "month", text: "I couldn't read that month. Try going back to this one." }, 400);
      const here = DateTime.fromISO(localDay(now, u.tz), { zone: "utc" }).startOf("month");
      if (Math.abs(m.diff(here, "months").months) > MONTH_REACH) return c.json({ error: "range", text: "That month is too far away. Try one within two years." }, 400);
    }
    fresh(c);
    return c.json(await cycleMonth(db, u, q ?? null, now));
  });

  app.get("/api/emergency", async (c) => {
    fresh(c);
    return c.json(await emergencyCard(db, user(c), new Date()));
  });

  /** The Safety page: what's set up, and a check-in if one is running. Counts and states only. */
  app.get("/api/safety", async (c) => {
    const u = user(c);
    const n = async (sql: string) => Number((await db.one<{ n: string }>(sql, [u.id]).catch(() => undefined))?.n ?? 0);
    const checkin = await db.one<{ due_at: string; about: string | null }>(`SELECT due_at, about FROM safety_checkins WHERE user_id=$1 AND status='active' ORDER BY due_at LIMIT 1`, [u.id]).catch(() => undefined);
    const legacy = await db.one<{ status: string }>(`SELECT status FROM safety_legacy WHERE user_id=$1`, [u.id]).catch(() => undefined);
    fresh(c);
    return c.json({
      checkin: checkin ? { due_at: checkin.due_at, about: checkin.about } : null,
      contacts: await n(`SELECT count(*)::text AS n FROM safety_contacts WHERE user_id=$1 AND status='confirmed'`),
      waiting: await n(`SELECT count(*)::text AS n FROM safety_contacts WHERE user_id=$1 AND status IN ('pending','asked')`),
      card: (await n(`SELECT count(*)::text AS n FROM safety_ice WHERE user_id=$1`)) > 0,
      incidents: await n(`SELECT count(*)::text AS n FROM safety_incidents WHERE user_id=$1`),
      legacy: legacy?.status ?? "off",
    });
  });

  /** You: what Pip carries, days kept, and what's remembered. */
  app.get("/api/you", async (c) => {
    const u = user(c);
    const { carried, keptDays, THINGS } = await import("../core/pipthings.js");
    const days = await keptDays(db, u.id);
    const has = carried(u.prefs);
    const next = THINGS.find((t) => !has.some((x) => x.key === t.key));
    const mem = Number((await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM memories WHERE user_id=$1`, [u.id]).catch(() => undefined))?.n ?? 0);
    fresh(c);
    return c.json({ days, things: has.map((t) => ({ key: t.key, name: t.name })), next: next ? { name: next.name, at: next.at } : null, memories: mem, keepDays: 180 });
  });
}
