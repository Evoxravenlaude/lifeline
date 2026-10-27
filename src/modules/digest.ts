/**
 * One morning message per user: today's events and classes, meds, open
 * reminders, nearest hackathon deadlines, trip countdowns, top new hackathons.
 * Also the weekly memory review (Sunday) so unconfirmed facts get confirmed
 * or dropped.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { fmt, humanDelta } from "../core/time.js";
import { onJob, push } from "../core/scheduler.js";
import { rangeBounds } from "./calendar.js";
import { hackLine, rankedForUser } from "./hackathons.js";
import type { Db } from "../core/db.js";
import type { User } from "../policy/types.js";
import { DateTime } from "luxon";

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
  const first = user.name ? user.name.split(" ")[0] : null;
  const today = [
    ...events.map((e: any) => ({ t: fmt(e.starts_at, user.tz, false), l: `${e.title}${e.location ? `, ${e.location}` : ""}` })),
    ...classes.map((c: any) => ({ t: c.start_time, l: `${c.name}${c.location ? `, ${c.location}` : ""}` })),
    ...reminders.map((r: any) => ({ t: fmt(r.due_at, user.tz, false), l: r.text })),
  ].sort((a, b) => a.t.localeCompare(b.t));
  const dayName = DateTime.fromJSDate(now).setZone(user.tz).toFormat("cccc");
  const tripDays = trips.length ? Math.ceil((new Date(trips[0].starts_on).getTime() - now.getTime()) / 86_400_000) : null;

  // The one thing that matters most goes in the greeting.
  let lead: string;
  if (today.length) lead = `${today.length === 1 ? "one thing" : `${today.length} things`} on today, first up ${today[0].l} at ${today[0].t}.`;
  else if (assignments.length) lead = `nothing booked, but ${assignments[0].title} is due in ${humanDelta(now, assignments[0].due_at)}.`;
  else if (hacks.length) lead = `a clear day. ${hacks[0].title} closes in ${humanDelta(now, hacks[0].deadline)}.`;
  else if (tripDays !== null) lead = `a clear day, and ${trips[0].destination} is ${tripDays === 0 ? "today" : tripDays === 1 ? "tomorrow" : `${tripDays} days out`}.`;
  else lead = "nothing booked. A good day to plan something.";
  const lines: string[] = [`${dayName}${first ? `, ${first}` : ""}: ${lead}`];

  if (today.length > 1) lines.push("", ...today.map((x) => `${x.t} ${x.l}`));
  const side: string[] = [];
  if (meds.length) side.push(`Meds: ${meds.map((m: any) => `${m.name} at ${m.times.join(" and ")}`).join(", ")}.`);
  if (assignments.length) side.push(`Due soon: ${assignments.map((a: any) => `${a.title} in ${humanDelta(now, a.due_at)}`).join(", ")}.`);
  if (hacks.length) side.push(`Hackathon deadlines: ${hacks.map((h: any) => `${h.title} in ${humanDelta(now, h.deadline)}`).join(", ")}.`);
  // Cycle: one line, only for the person who tracks it, and only if they haven't turned it off.
  if ((user.prefs?.cycle as any)?.inBrief !== false) {
    const { cycleRows, cyclePicture, cyclePrefs } = await import("./cycle.js");
    const pic = cyclePicture(await cycleRows(db, user.id), cyclePrefs(user), DateTime.fromJSDate(now).setZone(user.tz).toISODate()!);
    if (pic.tracking && pic.nextStart && pic.day != null) {
      const next = DateTime.fromISO(pic.nextStart).toFormat("ccc d LLL");
      side.push(pic.inPeriod ? `Cycle: day ${pic.day}, on your period.` : pic.lateBy > 0 ? `Cycle: day ${pic.day}, period about ${pic.lateBy} day${pic.lateBy === 1 ? "" : "s"} later than expected.` : `Cycle: day ${pic.day}, next period around ${next}.`);
    }
  }
  if (tripDays !== null && !lead.includes(trips[0].destination)) side.push(`${trips[0].destination.replace(/\b[a-z]/g, (c: string) => c.toUpperCase())} in ${tripDays} day${tripDays === 1 ? "" : "s"}.`);
  if (side.length) lines.push("", ...side);

  const { matchesFor } = await import("./jobs.js");
  const jobs = await matchesFor(db, user.id, 3);
  if (jobs.length) {
    lines.push("", `${jobs.length === 1 ? "A job that fits you" : `${jobs.length} jobs that fit you`}:`, ...jobs.map((j: any) => `${j.title}, ${j.url}`));
    for (const j of jobs) await db.query(`INSERT INTO job_seen (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, j.id]);
  }
  const fresh = await rankedForUser(db, user, now, 3);
  if (fresh.length) {
    lines.push("", `New since yesterday, ${fresh.length === 1 ? "one hackathon" : `${fresh.length} hackathons`} worth a look:`, ...fresh.map((h) => hackLine(h, user.tz, now)));
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
    await push(deps, user, "memory", `Sunday check. I picked this up and haven't used it yet: "${r.fact}". Keep it?`, { exempt: true, buttons: [{ label: "Keep", data: `mem:keep:${r.id}` }, { label: "Drop", data: `mem:drop:${r.id}` }] });
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
      try { new Intl.DateTimeFormat("en", { timeZone: args.tz }); } catch { throw new Error(`I don't know a timezone called "${args.tz}". Try the city, like Africa/Lagos or Europe/London.`); }
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
    const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
    const bits: string[] = [];
    if (args.tz) bits.push(`your clock is set to ${args.tz.split("/").pop()!.replace(/_/g, " ")} time`);
    if (args.digest_hour !== undefined) bits.push(`your morning brief comes at ${hh(args.digest_hour)}`);
    if (args.quiet_start !== undefined || args.quiet_end !== undefined) bits.push(`quiet hours run ${hh(args.quiet_start ?? ctx.user.quiet_start)} to ${hh(args.quiet_end ?? ctx.user.quiet_end)}`);
    if (args.name) bits.push(`I'll call you ${args.name}`);
    if (args.country) bits.push(`your country is ${args.country.toUpperCase()}`);
    if (args.email) bits.push(`your email is ${args.email}`);
    const said = bits.join(", ");
    return { reply: bits.length ? `Saved. ${said.charAt(0).toUpperCase()}${said.slice(1)}.` : "Nothing to change there." };
  },
});

register(now, settings);

/** Export a small summary for the "what do you know" command. */
export function weekdayName(i: number) { return DAYS[i]; }
