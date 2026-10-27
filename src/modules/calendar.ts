import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { fmt, parseWhen } from "../core/time.js";
import { cancelJob, onJob, push, schedule } from "../core/scheduler.js";
import { DateTime } from "luxon";

onJob("event_alert", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const e = await deps.db.one<{ title: string; starts_at: string; location: string | null; deleted: boolean }>(
    `SELECT title, starts_at, location, deleted FROM events WHERE id=$1`,
    [job.payload.eventId],
  );
  if (!e || e.deleted) return;
  await push(deps, user, "reminder", `${e.title} at ${fmt(e.starts_at, user.tz, false)}${e.location ? `, ${e.location}` : ""}.`, { exempt: true });
});

async function scheduleAlert(ctx: any, eventId: number, startsAt: Date, remindMinutes: number) {
  const at = new Date(startsAt.getTime() - remindMinutes * 60_000);
  if (at <= ctx.now) return null;
  return schedule(ctx.db, { userId: ctx.user.id, kind: "event_alert", payload: { eventId }, runAt: at });
}

const add = defineAction({
  name: "calendar.add",
  tier: 1,
  description:
    "Add a calendar event. `when` is natural language ('thursday 3pm', 'nov 2 10:00'); leave it empty if the user gave no time and the bot will ask. Optional duration in minutes, location, notes, and remind_minutes before start (default 30).",
  schema: z.object({
    title: z.string().min(1).max(200),
    when: z.string().optional(),
    duration_minutes: z.number().int().positive().optional(),
    location: z.string().optional(),
    notes: z.string().optional(),
    remind_minutes: z.number().int().nonnegative().optional(),
  }),
  needs(args, ctx) {
    if (args.when && parseWhen(args.when, ctx.user.tz, ctx.now)) return null;
    if (args.when) return { need: "when", question: `I couldn't read a time in "${args.when}". When is ${args.title}?` };
    return { need: "when", question: `When is ${args.title}?` };
  },
  async run(args, ctx) {
    const start = args.when ? parseWhen(args.when, ctx.user.tz, ctx.now) : null;
    if (!start) throw new Error(`I couldn't read a time in that. When is ${args.title}?`);
    const end = args.duration_minutes ? new Date(start.getTime() + args.duration_minutes * 60_000) : null;
    const remind = args.remind_minutes ?? 30;
    const row = await ctx.db.one<{ id: number }>(
      `INSERT INTO events (user_id, title, starts_at, ends_at, location, notes, remind_minutes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.user.id, args.title, start, end, args.location ?? null, args.notes ?? null, remind],
    );
    const jobId = await scheduleAlert(ctx, row!.id, start, remind);
    const clash = await ctx.db.one<{ title: string }>(
      `SELECT title FROM events WHERE user_id=$1 AND NOT deleted AND id<>$2 AND starts_at < $4 AND COALESCE(ends_at, starts_at + interval '1 hour') > $3 LIMIT 1`,
      [ctx.user.id, row!.id, start, end ?? new Date(start.getTime() + 3_600_000)],
    );
    return {
      reply: `${args.title}, ${fmt(start, ctx.user.tz)}${args.location ? ` at ${args.location}` : ""}. I'll ping you ${remind === 0 ? "when it starts" : `${remind} minutes before`}.${clash ? ` Heads up, that overlaps with ${clash.title}.` : ""}`,
      undo: { payload: { eventId: row!.id, jobId } },
    };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE events SET deleted=true WHERE id=$1 AND user_id=$2`, [p.eventId, ctx.user.id]);
    if (p.jobId) await cancelJob(ctx.db, p.jobId);
    return "Taken off the calendar.";
  },
});

const list = defineAction({
  name: "calendar.list",
  tier: 1,
  description: "List events. `range` is 'today', 'tomorrow', 'week' (default) or 'month'.",
  schema: z.object({ range: z.enum(["today", "tomorrow", "week", "month"]).optional() }),
  async run(args, ctx) {
    const { from, to } = rangeBounds(args.range ?? "week", ctx.user.tz, ctx.now);
    const rows = await ctx.db.query<{ id: number; title: string; starts_at: string; location: string | null }>(
      `SELECT id, title, starts_at, location FROM events WHERE user_id=$1 AND NOT deleted AND starts_at >= $2 AND starts_at < $3 ORDER BY starts_at LIMIT 40`,
      [ctx.user.id, from, to],
    );
    const label = { today: "today", tomorrow: "tomorrow", week: "this week", month: "this month" }[args.range ?? "week"];
    if (!rows.length) return { reply: `Nothing on the calendar ${label}. Say "dentist friday 3pm" and I'll keep it.` };
    const head = rows.length === 1 ? `One thing ${label}.` : `${rows.length} things ${label}.`;
    return { reply: [head, ...rows.map((r) => `${fmt(r.starts_at, ctx.user.tz)}: ${r.title}${r.location ? `, ${r.location}` : ""}`)].join("\n") };
  },
});

const remove = defineAction({
  name: "calendar.delete",
  tier: 2,
  description: "Delete a calendar event by id, or by `match` on its title. Deleting is irreversible so it is confirmed first.",
  schema: z.object({ id: z.number().int().optional(), match: z.string().optional() }),
  echo: (a) => (a.id ? `This deletes the event you pointed at (${a.id}).` : `This deletes the event called "${a.match}".`),
  async run(args, ctx) {
    const r = args.id
      ? await ctx.db.query(`UPDATE events SET deleted=true WHERE id=$1 AND user_id=$2 AND NOT deleted RETURNING title, starts_at`, [args.id, ctx.user.id])
      : await ctx.db.query(`UPDATE events SET deleted=true WHERE id=(SELECT id FROM events WHERE user_id=$1 AND NOT deleted AND title ILIKE $2 ORDER BY starts_at LIMIT 1) RETURNING title, starts_at`, [ctx.user.id, `%${args.match ?? ""}%`]);
    if (!r.length) return { reply: "I couldn't find that event. Say \"what's on this week\" to see what's there." };
    return { reply: `Deleted ${r[0].title}, ${fmt(r[0].starts_at, ctx.user.tz)}.` };
  },
});

const importIcs = defineAction({
  name: "calendar.import_ics",
  tier: 1,
  description: "Import events from ICS text (an exported Google/Apple/Outlook calendar). The user sends the .ics file; pass its text content.",
  schema: z.object({ ics: z.string().min(10) }),
  async run(args, ctx) {
    const events = parseIcs(args.ics);
    let n = 0;
    for (const e of events) {
      if (e.start < ctx.now) continue;
      const r = await ctx.db.query(
        `INSERT INTO events (user_id, title, starts_at, ends_at, location, source, external_uid) VALUES ($1,$2,$3,$4,$5,'ics',$6)
         ON CONFLICT (user_id, external_uid) DO UPDATE SET title=EXCLUDED.title, starts_at=EXCLUDED.starts_at, ends_at=EXCLUDED.ends_at RETURNING id`,
        [ctx.user.id, e.title, e.start, e.end, e.location, e.uid],
      );
      if (r.length) {
        await scheduleAlert(ctx, r[0].id, e.start, 30);
        n++;
      }
    }
    return { reply: n === 0 ? "That file had nothing upcoming in it, so nothing changed." : `${n} upcoming event${n === 1 ? "" : "s"} in from that file. Ask "what's on this week" to see them.` };
  },
});

export function rangeBounds(range: string, tz: string, now: Date) {
  const d = DateTime.fromJSDate(now).setZone(tz).startOf("day");
  switch (range) {
    case "today": return { from: d.toJSDate(), to: d.plus({ days: 1 }).toJSDate() };
    case "tomorrow": return { from: d.plus({ days: 1 }).toJSDate(), to: d.plus({ days: 2 }).toJSDate() };
    case "month": return { from: d.toJSDate(), to: d.plus({ months: 1 }).toJSDate() };
    default: return { from: d.toJSDate(), to: d.plus({ days: 7 }).toJSDate() };
  }
}

/** Minimal ICS parser: VEVENT with DTSTART/DTEND/SUMMARY/LOCATION/UID. Handles UTC (Z), TZID, and all-day DATE values. */
export function parseIcs(ics: string): { uid: string; title: string; start: Date; end: Date | null; location: string | null }[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const out: any[] = [];
  for (const block of unfolded.split("BEGIN:VEVENT").slice(1)) {
    const body = block.split("END:VEVENT")[0];
    const get = (k: string) => {
      const m = new RegExp(`^${k}(?:;([^:]*))?:(.*)$`, "m").exec(body);
      return m ? { params: m[1] ?? "", value: m[2].trim() } : null;
    };
    const s = get("DTSTART");
    if (!s) continue;
    const start = icsDate(s.value, s.params);
    const e = get("DTEND");
    out.push({
      uid: get("UID")?.value ?? `${start.toISOString()}-${get("SUMMARY")?.value}`,
      title: (get("SUMMARY")?.value ?? "Untitled").replace(/\\,/g, ","),
      start,
      end: e ? icsDate(e.value, e.params) : null,
      location: get("LOCATION")?.value?.replace(/\\,/g, ",") ?? null,
    });
  }
  return out;
}

function icsDate(v: string, params: string): Date {
  const tzid = /TZID=([^;]+)/.exec(params)?.[1];
  if (/^\d{8}$/.test(v)) return DateTime.fromFormat(v, "yyyyMMdd", { zone: tzid ?? "utc" }).toJSDate();
  const z = v.endsWith("Z");
  const dt = DateTime.fromFormat(v.replace("Z", ""), "yyyyMMdd'T'HHmmss", { zone: z ? "utc" : tzid ?? "utc" });
  return dt.toJSDate();
}

register(add, list, remove, importIcs);
