/**
 * Period and cycle tracking. Starts, ends, symptoms, moods, pills and tests;
 * predictions from the person's own history (calendar method), a nudge two
 * days before the next period, and one gentle note if it is late.
 *
 * This is health data. It is only ever shown to the person it belongs to,
 * never included in anything sent to someone else, and "forget my cycle data"
 * deletes all of it. Predictions are estimates, never birth control.
 */
import { z } from "zod";
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { defineAction, type Ctx, type User } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { localDay } from "../core/time.js";
import { onJob, push, schedule } from "../core/scheduler.js";
import type { Db } from "../core/db.js";

export interface CyclePrefs { avgLength?: number; periodLength?: number; reminders?: boolean; inBrief?: boolean }
export interface CycleRow { started_on: string; ended_on: string | null }
export interface CyclePicture {
  tracking: boolean;
  day: number | null;
  length: number;
  periodLength: number;
  lastStart: string | null;
  nextStart: string | null;
  fertileStart: string | null;
  fertileEnd: string | null;
  ovulation: string | null;
  inPeriod: boolean;
  lateBy: number;
  irregular: boolean;
}

const D = (iso: string) => DateTime.fromISO(iso, { zone: "utc" }).startOf("day");
const iso = (d: DateTime) => d.toISODate()!;
const daysBetween = (a: string, b: string) => Math.round(D(b).diff(D(a), "days").days);

/** Everything the bot says about a cycle comes from this one pure function. */
export function cyclePicture(rows: CycleRow[], prefs: CyclePrefs = {}, todayISO: string): CyclePicture {
  const starts = [...rows].sort((a, b) => a.started_on.localeCompare(b.started_on));
  const raw: number[] = [];
  for (let i = 1; i < starts.length; i++) raw.push(daysBetween(starts[i - 1].started_on, starts[i].started_on));
  const usable = raw.filter((n) => n >= 15 && n <= 60).slice(-6);
  const avg = (a: number[]) => a.reduce((s, n) => s + n, 0) / a.length;
  const length = usable.length ? Math.round(avg(usable)) : prefs.avgLength ?? 28;
  const periods = starts.filter((r) => r.ended_on).map((r) => daysBetween(r.started_on, r.ended_on!) + 1).filter((n) => n >= 1 && n <= 15).slice(-6);
  const periodLength = periods.length ? Math.round(avg(periods)) : prefs.periodLength ?? 5;
  const considered = raw.filter((n) => n >= 10 && n <= 90).slice(-6);
  const sd = considered.length >= 2 ? Math.sqrt(avg(considered.map((n) => (n - avg(considered)) ** 2))) : 0;
  const irregular = considered.length >= 2 && (sd > 7 || considered.some((n) => n < 21 || n > 45));

  if (!starts.length) return { tracking: false, day: null, length, periodLength, lastStart: null, nextStart: null, fertileStart: null, fertileEnd: null, ovulation: null, inPeriod: false, lateBy: 0, irregular: false };

  const last = starts[starts.length - 1];
  const day = daysBetween(last.started_on, todayISO) + 1;
  const next = D(last.started_on).plus({ days: length });
  const ovulation = next.minus({ days: 14 });
  const lateBy = Math.max(0, daysBetween(iso(next), todayISO));
  const inPeriod = day >= 1 && (last.ended_on ? todayISO <= last.ended_on : day <= periodLength);
  return {
    tracking: true, day, length, periodLength, lastStart: last.started_on, nextStart: iso(next),
    fertileStart: iso(ovulation.minus({ days: 5 })), fertileEnd: iso(ovulation.plus({ days: 1 })), ovulation: iso(ovulation),
    inPeriod, lateBy, irregular,
  };
}

/* ---------- storage helpers ---------- */

export async function cycleRows(db: Db, userId: number): Promise<CycleRow[]> {
  return db.query<CycleRow>(`SELECT to_char(started_on,'YYYY-MM-DD') AS started_on, to_char(ended_on,'YYYY-MM-DD') AS ended_on FROM cycles WHERE user_id=$1 ORDER BY started_on`, [userId]);
}
export const cyclePrefs = (u: Pick<User, "prefs">): CyclePrefs => ((u.prefs?.cycle as CyclePrefs) ?? {});

async function savePrefs(ctx: Ctx, patch: Partial<CyclePrefs> | null) {
  const prefs = { ...ctx.user.prefs };
  if (patch === null) delete prefs.cycle; else prefs.cycle = { ...cyclePrefs(ctx.user), ...patch };
  ctx.user.prefs = prefs;
  await ctx.db.query(`UPDATE users SET prefs=$2 WHERE id=$1`, [ctx.user.id, JSON.stringify(prefs)]);
}

/** A past day from words: "today", "yesterday", "on monday" means the last Monday, never a future one. */
export function pastDay(text: string | undefined, tz: string, now: Date): string {
  const today = localDay(now, tz);
  if (!text || /^\s*(?:today|now|this morning|tonight)\s*$/i.test(text)) return today;
  const ref = DateTime.fromJSDate(now).setZone(tz);
  // "on the 1st", "the 23rd": that day this month, or last month if it hasn't come yet.
  const ord = /^\s*(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s*$/i.exec(text);
  if (ord) {
    const n = Number(ord[1]);
    let d = ref.startOf("month");
    if (n > ref.day) d = d.minus({ months: 1 });
    d = d.set({ day: Math.min(n, d.daysInMonth ?? 28) });
    return d.toISODate()!;
  }
  const r = chrono.parse(text, { instant: now, timezone: ref.offset }, { forwardDate: false })[0];
  if (!r) return today;
  let d = DateTime.fromJSDate(r.start.date()).setZone(tz).toISODate()!;
  if (d > today) d = DateTime.fromISO(d).minus({ days: 7 }).toISODate()!; // a weekday name that landed ahead
  return d > today ? today : d;
}

const pretty = (isoDate: string) => DateTime.fromISO(isoDate).toFormat("ccc d LLL");
const span = (a: string, b: string) => {
  const x = DateTime.fromISO(a), y = DateTime.fromISO(b);
  return x.month === y.month ? `${x.toFormat("ccc d")} to ${y.toFormat("ccc d LLL")}` : `${x.toFormat("ccc d LLL")} to ${y.toFormat("ccc d LLL")}`;
};
const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);

async function ensureCheck(db: Db, user: User) {
  const has = await db.one(`SELECT 1 FROM jobs WHERE user_id=$1 AND kind='cycle_check' AND active`, [user.id]);
  if (!has) await schedule(db, { userId: user.id, kind: "cycle_check", cron: "0 9 * * *", tz: user.tz });
}

/* ---------- actions ---------- */

const start = defineAction({
  name: "cycle.start",
  tier: 1,
  description: "Log that the user's period started. `when` is a past day in words ('today', 'yesterday', 'on monday'); defaults to today.",
  schema: z.object({ when: z.string().optional() }),
  async run(args, ctx) {
    const day = pastDay(args.when, ctx.user.tz, ctx.now);
    const rows = await cycleRows(ctx.db, ctx.user.id);
    const first = rows.length === 0;
    const near = await ctx.db.one<{ id: number; started_on: string }>(
      `SELECT id, to_char(started_on,'YYYY-MM-DD') AS started_on FROM cycles WHERE user_id=$1 AND abs(started_on - $2::date) <= 10 ORDER BY started_on DESC LIMIT 1`,
      [ctx.user.id, day],
    );
    let undo: unknown;
    if (near) {
      await ctx.db.query(`UPDATE cycles SET started_on=$2 WHERE id=$1`, [near.id, day]);
      undo = { updated: near.id, was: near.started_on };
    } else {
      const r = await ctx.db.one<{ id: number }>(`INSERT INTO cycles (user_id, started_on) VALUES ($1,$2) RETURNING id`, [ctx.user.id, day]);
      undo = { inserted: r!.id };
    }
    await ensureCheck(ctx.db, ctx.user);
    const pic = cyclePicture(await cycleRows(ctx.db, ctx.user.id), cyclePrefs(ctx.user), localDay(ctx.now, ctx.user.tz));
    const when = day === localDay(ctx.now, ctx.user.tz) ? "today" : pretty(day);
    const next = pic.nextStart ? ` Next one likely around ${pretty(pic.nextStart)}.` : "";
    const note = first ? ` This stays in your account only. Say "forget my cycle data" any time.` : "";
    return { reply: `${near ? "Updated: your period started" : "Period started"} ${when}.${next} Tell me when it ends, and anything you notice along the way, like cramps or mood.${note}`, undo: { payload: undo } };
  },
  async undo(p, ctx) {
    if (p.inserted) await ctx.db.query(`DELETE FROM cycles WHERE id=$1 AND user_id=$2`, [p.inserted, ctx.user.id]);
    if (p.updated) await ctx.db.query(`UPDATE cycles SET started_on=$3 WHERE id=$1 AND user_id=$2`, [p.updated, ctx.user.id, p.was]);
    return "Taken back.";
  },
});

const end = defineAction({
  name: "cycle.end",
  tier: 1,
  description: "Log that the user's period ended. `when` is a past day in words; defaults to today.",
  schema: z.object({ when: z.string().optional() }),
  async run(args, ctx) {
    const day = pastDay(args.when, ctx.user.tz, ctx.now);
    const open = await ctx.db.one<{ id: number; started_on: string; ended_on: string | null }>(
      `SELECT id, to_char(started_on,'YYYY-MM-DD') AS started_on, to_char(ended_on,'YYYY-MM-DD') AS ended_on FROM cycles WHERE user_id=$1 AND started_on <= $2::date AND $2::date - started_on <= 15 ORDER BY started_on DESC LIMIT 1`,
      [ctx.user.id, day],
    );
    if (!open) return { reply: `I don't have a period starting in the two weeks before that. Tell me when it started, like "my period started on monday", and I'll set both.` };
    await ctx.db.query(`UPDATE cycles SET ended_on=$2 WHERE id=$1`, [open.id, day]);
    const days = daysBetween(open.started_on, day) + 1;
    return { reply: `Period ended ${day === localDay(ctx.now, ctx.user.tz) ? "today" : pretty(day)}, ${days} day${days === 1 ? "" : "s"} this time. I'll use that to get the next estimate closer.`, undo: { payload: { id: open.id, was: open.ended_on } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE cycles SET ended_on=$3 WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id, p.was]);
    return "Taken back.";
  },
});

/** Which kind of note a symptom sentence is. */
export function cycleKind(what: string): "flow" | "symptom" | "mood" | "note" | "pill" | "test" {
  const t = what.toLowerCase();
  if (/\btest\b/.test(t)) return "test";
  if (/\bpill\b|contracept/.test(t)) return "pill";
  if (/\bflow\b|spotting|bleed|clots?\b/.test(t)) return "flow";
  if (/\bmood|sad|anxious|irritable|happy|low\b|emotional|teary|angry|calm|stressed|swings?\b/.test(t)) return "mood";
  if (/cramp|headache|migraine|bloat|acne|tender|back ?ache|nausea|fatigue|tired|craving|pain|sore|dizzy|insomnia/.test(t)) return "symptom";
  return "note";
}

const log = defineAction({
  name: "cycle.log",
  tier: 1,
  description: "Log a period symptom, flow, mood, pill or test result for a day, e.g. 'cramps', 'heavy flow', 'spotting', 'mood low', 'took my pill', 'pregnancy test negative'.",
  schema: z.object({ what: z.string().min(1).max(200), when: z.string().optional() }),
  async run(args, ctx) {
    const day = pastDay(args.when, ctx.user.tz, ctx.now);
    const kind = cycleKind(args.what);
    const value = args.what.trim().replace(/[.!]+$/, "");
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO cycle_logs (user_id, day, kind, value) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.user.id, day, kind, value]);
    const when = day === localDay(ctx.now, ctx.user.tz) ? "today" : pretty(day);
    const shown = kind === "pill" ? "Pill taken" : value;
    const cap = shown.charAt(0).toUpperCase() + shown.slice(1);
    const tail = kind === "pill" ? " I'll keep the log." : kind === "test" ? " Kept with the date." : " I'll keep it with your cycle so patterns show over time.";
    return { reply: `${cap}, noted for ${when}.${tail}`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM cycle_logs WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Taken off.";
  },
});

/** The plain-words status line set, shared by the action and the morning brief. */
export function describeCycle(pic: CyclePicture, todayISO: string): string[] {
  if (!pic.tracking || !pic.nextStart || pic.day == null) return [];
  const lines: string[] = [];
  const until = daysBetween(todayISO, pic.nextStart);
  if (pic.inPeriod) lines.push(`Day ${pic.day} of your cycle, so you're on your period.`);
  else if (pic.lateBy > 0) lines.push(`Day ${pic.day} of your cycle. Your period is ${pic.lateBy} day${pic.lateBy === 1 ? "" : "s"} later than I'd expect from your history.`);
  else lines.push(`Day ${pic.day} of your cycle. Next period likely around ${pretty(pic.nextStart)} (${inDays(until)}).`);
  if (pic.fertileStart && pic.fertileEnd && pic.lateBy === 0) {
    const past = pic.fertileEnd < todayISO, now = pic.fertileStart <= todayISO && todayISO <= pic.fertileEnd;
    lines.push(now ? `You're probably in your fertile window, ${span(pic.fertileStart, pic.fertileEnd)}.` : `Your fertile window ${past ? "was" : "is"} probably ${span(pic.fertileStart, pic.fertileEnd)}.`);
  }
  return lines;
}

const status = defineAction({
  name: "cycle.status",
  tier: 1,
  description: "Where the user is in their menstrual cycle: day, next period, fertile window, whether late.",
  schema: z.object({}),
  async run(_a, ctx) {
    const today = localDay(ctx.now, ctx.user.tz);
    const rows = await cycleRows(ctx.db, ctx.user.id);
    const pic = cyclePicture(rows, cyclePrefs(ctx.user), today);
    if (!pic.tracking) return { reply: `I'm not tracking your cycle yet. Tell me when your last period started, like "my period started on the 3rd", and I'll work out the rest from there.` };
    const lines = describeCycle(pic, today);
    const recent = await ctx.db.query<{ value: string }>(`SELECT value FROM cycle_logs WHERE user_id=$1 AND day >= $2::date ORDER BY day DESC, id DESC LIMIT 4`, [ctx.user.id, pic.lastStart]);
    if (recent.length) lines.push(`Noted this cycle: ${recent.map((r) => r.value.toLowerCase()).join(", ")}.`);
    if (rows.length < 3) lines.push(rows.length === 1 ? `I'm working from one period so far${cyclePrefs(ctx.user).avgLength ? ` and your usual ${pic.length} days` : " and a 28-day guess"}; it gets better with each one you log.` : `I'm working from two periods so far; it gets better with each one you log.`);
    if (pic.irregular) lines.push("Your cycles have varied quite a bit. That's common, and a doctor or nurse can look at it if it bothers you.");
    else if (pic.lateBy >= 5) lines.push("Cycles shift for lots of reasons. If you're worried, a test or a nurse can tell you more.");
    lines.push("These are estimates from your past cycles, not birth control.");
    return { reply: lines.join("\n") };
  },
});

const settings = defineAction({
  name: "cycle.settings",
  tier: 1,
  description: "Cycle preferences: usual cycle length in days, usual period length, whether to send period reminders, whether the cycle appears in the morning brief.",
  schema: z.object({ avg_length: z.number().int().min(15).max(60).optional(), period_length: z.number().int().min(1).max(15).optional(), reminders: z.boolean().optional(), in_brief: z.boolean().optional() }),
  async run(args, ctx) {
    const before = cyclePrefs(ctx.user);
    const patch: Partial<CyclePrefs> = {};
    if (args.avg_length) patch.avgLength = args.avg_length;
    if (args.period_length) patch.periodLength = args.period_length;
    if (args.reminders !== undefined) patch.reminders = args.reminders;
    if (args.in_brief !== undefined) patch.inBrief = args.in_brief;
    if (!Object.keys(patch).length) return { reply: `Tell me what to change: "my cycle is usually 30 days", "periods last 6 days", "stop period reminders", or "don't put my cycle in the brief".` };
    await savePrefs(ctx, patch);
    const said: string[] = [];
    if (patch.avgLength) said.push(`a ${patch.avgLength}-day cycle until I've seen a few of yours`);
    if (patch.periodLength) said.push(`periods of about ${patch.periodLength} days`);
    if (patch.reminders !== undefined) said.push(patch.reminders ? "reminders before your period are on" : "no more reminders before your period");
    if (patch.inBrief !== undefined) said.push(patch.inBrief ? "your cycle shows in the morning brief" : "your cycle stays out of the morning brief");
    const s = said.join(", ");
    return { reply: `${s.charAt(0).toUpperCase() + s.slice(1)}.`, undo: { payload: { before } } };
  },
  async undo(p, ctx) {
    await savePrefs(ctx, null);
    if (p.before && Object.keys(p.before).length) await savePrefs(ctx, p.before);
    return "Back as it was.";
  },
});

const forget = defineAction({
  name: "cycle.forget",
  tier: 2,
  description: "Delete all of the user's period and cycle data and settings.",
  schema: z.object({}),
  echo: () => "This deletes every period and symptom you've logged, and your cycle settings. It can't be undone.",
  async run(_a, ctx) {
    await ctx.db.query(`DELETE FROM cycle_logs WHERE user_id=$1`, [ctx.user.id]);
    await ctx.db.query(`DELETE FROM cycles WHERE user_id=$1`, [ctx.user.id]);
    await ctx.db.query(`UPDATE jobs SET active=false WHERE user_id=$1 AND kind='cycle_check'`, [ctx.user.id]);
    await savePrefs(ctx, null);
    return { reply: "Gone. I've deleted every period, symptom and setting, and I won't remind you about your cycle again." };
  },
});

/* ---------- daily check: a nudge two days before, one note if late ---------- */
onJob("cycle_check", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const prefs = cyclePrefs(user);
  if (prefs.reminders === false) return;
  const today = localDay(new Date(), user.tz);
  const pic = cyclePicture(await cycleRows(deps.db, user.id), prefs, today);
  if (!pic.tracking || !pic.nextStart) return;
  const until = daysBetween(today, pic.nextStart);
  if (until === 2) await push(deps, user, "cycle", `Your period is likely around ${DateTime.fromISO(pic.nextStart).toFormat("cccc")}. Worth having what you need with you.`);
  else if (pic.lateBy === 5) await push(deps, user, "cycle", `Your period is 5 days later than I'd expect. Cycles shift for lots of reasons; if you're worried, a test or a nurse can tell you more.`);
});

register(start, end, log, status, settings, forget);
