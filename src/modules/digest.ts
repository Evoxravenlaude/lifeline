/**
 * One morning message per user: today's events and classes, meds, open
 * reminders, nearest hackathon deadlines, trip countdowns, top new hackathons.
 * Also the weekly memory review (Sunday) so unconfirmed facts get confirmed
 * or dropped.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { fmt, fmtDate, humanDelta } from "../core/time.js";
import { onJob, push } from "../core/scheduler.js";
import { rangeBounds } from "./calendar.js";
import { hackLine, rankedForUser } from "./hackathons.js";
import type { Db } from "../core/db.js";
import type { User } from "../policy/types.js";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export async function buildDigest(db: Db, user: User, now: Date): Promise<string> {
  const { from, to } = rangeBounds("today", user.tz, now);
  const wd = new Date(from.getTime() + 12 * 3_600_000).getUTCDay(); // approx local weekday
  const [events, classes, meds, reminders, hacks, trips, assignments] = await Promise.all([
    db.query<any>(`SELECT title, starts_at, location FROM events WHERE user_id=$1 AND NOT deleted AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at`, [user.id, from, to]),
    db.query<any>(`SELECT name, start_time, location FROM classes WHERE user_id=$1 AND active AND weekday=$2 AND (term_end IS NULL OR term_end >= current_date) ORDER BY start_time`, [user.id, wd]),
    db.query<any>(`SELECT name, times FROM medications WHERE user_id=$1 AND active ORDER BY name`, [user.id]),
    db.query<any>(`SELECT text, due_at FROM reminders WHERE user_id=$1 AND NOT deleted AND NOT done AND due_at >= $2 AND due_at < $3 ORDER BY due_at`, [user.id, from, to]),
    db.query<any>(`SELECT title, deadline, status FROM hackathon_entries WHERE user_id=$1 AND status NOT IN ('submitted','won','lost','withdrawn') AND deadline > $2 ORDER BY deadline LIMIT 3`, [user.id, now]),
    db.query<any>(`SELECT destination, starts_on FROM trips WHERE user_id=$1 AND status<>'cancelled' AND starts_on >= current_date ORDER BY starts_on LIMIT 1`, [user.id]),
    db.query<any>(`SELECT title, due_at FROM assignments WHERE user_id=$1 AND NOT done AND due_at < $2::timestamptz + interval '3 days' ORDER BY due_at LIMIT 3`, [user.id, now]),
  ]);
  const lines: string[] = [`🐢 ${fmtDate(now, user.tz)}`];
  const today = [
    ...events.map((e: any) => `${fmt(e.starts_at, user.tz, false)} ${e.title}${e.location ? ` (${e.location})` : ""}`),
    ...classes.map((c: any) => `${c.start_time} ${c.name}${c.location ? ` (${c.location})` : ""}`),
    ...reminders.map((r: any) => `${fmt(r.due_at, user.tz, false)} ⏰ ${r.text}`),
  ].sort();
  lines.push(today.length ? today.join("\n") : "Nothing scheduled today.");
  if (meds.length) lines.push(`💊 ${meds.map((m: any) => `${m.name} ${m.times.join("/")}`).join(", ")}`);
  if (assignments.length) lines.push(`📝 ${assignments.map((a: any) => `${a.title} (${humanDelta(now, a.due_at)})`).join("; ")}`);
  if (hacks.length) lines.push(`🏁 ${hacks.map((h: any) => `${h.title} ${humanDelta(now, h.deadline)}`).join("; ")}`);
  if (trips.length) lines.push(`✈️ ${trips[0].destination} in ${Math.ceil((new Date(trips[0].starts_on).getTime() - now.getTime()) / 86_400_000)}d`);
  const { matchesFor } = await import("./jobs.js");
  const jobs = await matchesFor(db, user.id, 3);
  if (jobs.length) {
    lines.push("", "Job matches:", ...jobs.map((j: any) => `• ${j.title}\n  ${j.url}`));
    for (const j of jobs) await db.query(`INSERT INTO job_seen (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, j.id]);
  }
  const fresh = await rankedForUser(db, user, now, 3);
  if (fresh.length) {
    lines.push("", "New hackathons worth a look:", ...fresh.map((h) => hackLine(h, user.tz, now)));
    for (const h of fresh) await db.query(`INSERT INTO hackathon_seen (user_id, hackathon_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, h.id]);
  }
  return lines.join("\n");
}

onJob("digest", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const text = await buildDigest(deps.db, user, new Date());
  await push(deps, user, "digest", text, { exempt: true });
});

onJob("memory_review", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const rows = await deps.db.query<{ id: number; fact: string }>(`SELECT id, fact FROM memories WHERE user_id=$1 AND NOT confirmed ORDER BY id LIMIT 5`, [user.id]);
  for (const r of rows) {
    await push(deps, user, "memory", `Should I keep remembering this?\n"${r.fact}"`, { exempt: true, buttons: [{ label: "Keep", data: `mem:keep:${r.id}` }, { label: "Drop", data: `mem:drop:${r.id}` }] });
  }
});

const now = defineAction({
  name: "digest.now",
  tier: 1,
  description: "Show today's digest right now (schedule, meds, deadlines, trips, new hackathons).",
  schema: z.object({}),
  async run(_a, ctx) {
    return { reply: await buildDigest(ctx.db, ctx.user, ctx.now) };
  },
});

const settings = defineAction({
  name: "settings.update",
  tier: 1,
  description: "Update user settings: timezone (IANA like 'Africa/Lagos' or 'Europe/London'), digest_hour (0-23), quiet hours start/end, name, country (ISO-2, used only for venue geoblock checks).",
  schema: z.object({
    tz: z.string().optional(),
    digest_hour: z.number().int().min(0).max(23).optional(),
    quiet_start: z.number().int().min(0).max(23).optional(),
    quiet_end: z.number().int().min(0).max(23).optional(),
    name: z.string().max(60).optional(),
    country: z.string().length(2).optional(),
    email: z.string().email().optional(),
  }),
  async run(args, ctx) {
    if (args.tz) {
      try { new Intl.DateTimeFormat("en", { timeZone: args.tz }); } catch { throw new Error(`"${args.tz}" isn't a timezone I know`); }
    }
    const prefs = { ...ctx.user.prefs, ...(args.country ? { country: args.country.toUpperCase() } : {}) };
    await ctx.db.query(
      `UPDATE users SET tz=COALESCE($2,tz), digest_hour=COALESCE($3,digest_hour), quiet_start=COALESCE($4,quiet_start), quiet_end=COALESCE($5,quiet_end), name=COALESCE($6,name), prefs=$7, email=COALESCE($8,email) WHERE id=$1`,
      [ctx.user.id, args.tz ?? null, args.digest_hour ?? null, args.quiet_start ?? null, args.quiet_end ?? null, args.name ?? null, JSON.stringify(prefs), args.email ?? null],
    );
    if (args.tz || args.digest_hour !== undefined) {
      const tz = args.tz ?? ctx.user.tz;
      const hour = args.digest_hour ?? ctx.user.digest_hour;
      await ctx.db.query(`UPDATE jobs SET cron=$2, tz=$3 WHERE user_id=$1 AND kind='digest'`, [ctx.user.id, `0 ${hour} * * *`, tz]);
    }
    return { reply: "Settings updated." };
  },
});

register(now, settings);

/** Export a small summary for the "what do you know" command. */
export function weekdayName(i: number) { return DAYS[i]; }
