import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { fmt, parseClock, parseWhen } from "../core/time.js";
import { cancelJob, onJob, push, schedule } from "../core/scheduler.js";

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function weekday(s: string): number {
  const i = DAYS.findIndex((d) => s.toLowerCase().startsWith(d));
  if (i < 0) throw new Error(`"${s}" isn't a weekday`);
  return i;
}

onJob("class_alert", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const c = await deps.db.one<{ name: string; start_time: string; location: string | null; active: boolean; term_end: string | null }>(
    `SELECT name, start_time, location, active, term_end FROM classes WHERE id=$1`,
    [job.payload.classId],
  );
  if (!c || !c.active) return;
  if (c.term_end && new Date(c.term_end) < new Date()) return;
  await push(deps, user, "reminder", `🎓 ${c.name} at ${c.start_time}${c.location ? ` — ${c.location}` : ""}`, { exempt: true });
});

onJob("assignment_alert", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const a = await deps.db.one<{ title: string; due_at: string; done: boolean }>(`SELECT title, due_at, done FROM assignments WHERE id=$1`, [job.payload.assignmentId]);
  if (!a || a.done) return;
  await push(deps, user, "reminder", `📝 Due ${fmt(a.due_at, user.tz)}: ${a.title}`, { exempt: true });
});

const add = defineAction({
  name: "class.add",
  tier: 1,
  description: "Add a recurring weekly class. `day` like 'monday', `start` like '10:00' or '2pm', optional `end`, `location`, `term_end` (natural date). Alerts 15 minutes before.",
  schema: z.object({
    name: z.string().min(1).max(120),
    day: z.string(),
    start: z.string(),
    end: z.string().optional(),
    location: z.string().optional(),
    term_end: z.string().optional(),
  }),
  async run(args, ctx) {
    const wd = weekday(args.day);
    const s = parseClock(args.start);
    if (!s) throw new Error(`"${args.start}" isn't a time I understand`);
    const termEnd = args.term_end ? parseWhen(args.term_end, ctx.user.tz, ctx.now) : null;
    const start = `${String(s[0]).padStart(2, "0")}:${String(s[1]).padStart(2, "0")}`;
    const row = await ctx.db.one<{ id: number }>(
      `INSERT INTO classes (user_id, name, weekday, start_time, end_time, location, term_end) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.user.id, args.name, wd, start, args.end ?? null, args.location ?? null, termEnd],
    );
    // alert 15 min before
    let m = s[1] - 15, h = s[0], d = wd;
    if (m < 0) { m += 60; h -= 1; }
    if (h < 0) { h += 24; d = (d + 6) % 7; }
    const jobId = await schedule(ctx.db, { userId: ctx.user.id, kind: "class_alert", payload: { classId: row!.id }, cron: `${m} ${h} * * ${d}`, tz: ctx.user.tz });
    return { reply: `Added ${args.name}: ${DAYS[wd]} ${start}${args.end ? `–${args.end}` : ""}${args.location ? ` at ${args.location}` : ""}.`, undo: { payload: { classId: row!.id, jobId } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE classes SET active=false WHERE id=$1 AND user_id=$2`, [p.classId, ctx.user.id]);
    await cancelJob(ctx.db, p.jobId);
    return "Class removed.";
  },
});

const list = defineAction({
  name: "class.list",
  tier: 1,
  description: "Show the weekly class timetable and open assignments.",
  schema: z.object({}),
  async run(_a, ctx) {
    const cls = await ctx.db.query<{ id: number; name: string; weekday: number; start_time: string; end_time: string | null; location: string | null }>(
      `SELECT id, name, weekday, start_time, end_time, location FROM classes WHERE user_id=$1 AND active ORDER BY weekday, start_time`,
      [ctx.user.id],
    );
    const asg = await ctx.db.query<{ id: number; title: string; due_at: string }>(
      `SELECT id, title, due_at FROM assignments WHERE user_id=$1 AND NOT done ORDER BY due_at LIMIT 10`,
      [ctx.user.id],
    );
    const lines = cls.map((c) => `${DAYS[c.weekday]} ${c.start_time}${c.end_time ? `–${c.end_time}` : ""} ${c.name}${c.location ? ` (${c.location})` : ""}`);
    if (asg.length) lines.push("", "Assignments:", ...asg.map((a) => `#${a.id} ${fmt(a.due_at, ctx.user.tz)} — ${a.title}`));
    return { reply: lines.length ? lines.join("\n") : "No classes yet." };
  },
});

const assignment = defineAction({
  name: "assignment.add",
  tier: 1,
  description: "Add an assignment or exam with a due date (natural language). Alerts two days before and on the morning of the due date.",
  schema: z.object({ title: z.string().min(1), due: z.string(), class_name: z.string().optional() }),
  async run(args, ctx) {
    const due = parseWhen(args.due, ctx.user.tz, ctx.now);
    if (!due) throw new Error(`I couldn't read a date from "${args.due}"`);
    const cls = args.class_name
      ? await ctx.db.one<{ id: number }>(`SELECT id FROM classes WHERE user_id=$1 AND active AND name ILIKE $2 LIMIT 1`, [ctx.user.id, `%${args.class_name}%`])
      : null;
    const row = await ctx.db.one<{ id: number }>(
      `INSERT INTO assignments (user_id, class_id, title, due_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [ctx.user.id, cls?.id ?? null, args.title, due],
    );
    const jobs: number[] = [];
    for (const offsetMs of [2 * 86_400_000, 0]) {
      const at = new Date(due.getTime() - offsetMs - (offsetMs === 0 ? 10 * 3_600_000 : 0));
      if (at > ctx.now) jobs.push(await schedule(ctx.db, { userId: ctx.user.id, kind: "assignment_alert", payload: { assignmentId: row!.id }, runAt: at }));
    }
    return { reply: `Noted: "${args.title}" due ${fmt(due, ctx.user.tz)}.`, undo: { payload: { id: row!.id, jobs } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM assignments WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    for (const j of p.jobs) await cancelJob(ctx.db, j);
    return "Assignment removed.";
  },
});

const done = defineAction({
  name: "assignment.done",
  tier: 1,
  description: "Mark an assignment done by id or title match.",
  schema: z.object({ id: z.number().int().optional(), match: z.string().optional() }),
  async run(args, ctx) {
    const r = args.id
      ? await ctx.db.query(`UPDATE assignments SET done=true WHERE id=$1 AND user_id=$2 RETURNING id, title`, [args.id, ctx.user.id])
      : await ctx.db.query(`UPDATE assignments SET done=true WHERE id=(SELECT id FROM assignments WHERE user_id=$1 AND NOT done AND title ILIKE $2 ORDER BY due_at LIMIT 1) RETURNING id, title`, [ctx.user.id, `%${args.match ?? ""}%`]);
    if (!r.length) return { reply: "Couldn't find that assignment." };
    return { reply: `Done: ${r[0].title} ✅`, undo: { payload: { id: r[0].id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE assignments SET done=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Reopened.";
  },
});

register(add, list, assignment, done);
