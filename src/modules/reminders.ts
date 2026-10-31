import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { fmt, human, parseWhen, parseWhenOrMorning } from "../core/time.js";
import { cancelJob, nextCron, onJob, push, schedule } from "../core/scheduler.js";

onJob("reminder", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const r = await deps.db.one<{ id: number; text: string; deleted: boolean; done: boolean }>(
    `SELECT id, text, deleted, done FROM reminders WHERE id=$1`,
    [job.payload.reminderId],
  );
  if (!r || r.deleted || (r.done && !job.cron)) return;
  const cap = r.text.charAt(0).toUpperCase() + r.text.slice(1);
  // A repeating reminder's date moves on each time it rings, so it stays in Today, the brief and the list.
  if (job.cron) await deps.db.query(`UPDATE reminders SET due_at=$2 WHERE id=$1`, [r.id, nextCron(job.cron, job.tz ?? user.tz, new Date(Math.max(Date.now(), new Date(job.run_at).getTime() + 1000)))]).catch(() => {});
  const ok = await push(deps, user, "reminder", `Reminder: ${cap}.`, { exempt: true, buttons: [{ label: "Done", data: `rem:done:${r.id}` }, { label: "Snooze an hour", data: `rem:snooze:${r.id}` }] });
  // Nowhere reached them (Telegram down, no other way in): throwing lets the scheduler try a one-off again shortly.
  if (!ok && !job.cron) throw new Error("reminder not delivered");
});

const create = defineAction({
  name: "reminder.create",
  tier: 1,
  description:
    "Create a reminder. `when` is natural language in the user's timezone ('tomorrow 9am', 'in 2 hours', 'friday 18:00'); leave it empty if the user gave no time and the bot will ask. `repeat` is an optional cron expression for recurring reminders (e.g. '0 9 * * 1-5' for weekdays 9am).",
  schema: z.object({
    text: z.string().min(1).max(500),
    when: z.string().optional(),
    repeat: z.string().optional(),
  }),
  needs(args, ctx) {
    if (args.when && parseWhen(args.when, ctx.user.tz, ctx.now)) return null;
    if (args.when) return { need: "when", question: `I couldn't read a time in "${args.when}". When should I ring you about ${args.text}?` };
    return { need: "when", question: `When should I remind you${args.text.length < 60 ? ` to ${args.text}` : ""}?` };
  },
  async run(args, ctx) {
    const due = args.when ? parseWhenOrMorning(args.when, ctx.user.tz, ctx.now) : new Date(ctx.now.getTime() + 3_600_000);
    if (!due) throw new Error(`I couldn't read a time from "${args.when}". When should I ring you?`);
    const row = await ctx.db.one<{ id: number }>(
      `INSERT INTO reminders (user_id, text, due_at, cron) VALUES ($1,$2,$3,$4) RETURNING id`,
      [ctx.user.id, args.text.replace(/^(?:to|that i (?:need to|should|have to)|about)\s+/i, ""), due, args.repeat ?? null],
    );
    const jobId = await schedule(ctx.db, {
      userId: ctx.user.id,
      kind: "reminder",
      payload: { reminderId: row!.id },
      runAt: args.repeat ? undefined : due,
      cron: args.repeat,
      tz: ctx.user.tz,
    });
    await ctx.db.query(`UPDATE reminders SET job_id=$2 WHERE id=$1`, [row!.id, jobId]);
    const when = args.repeat ? `repeating, next ${human(due, ctx.user.tz, ctx.now)}` : args.when ? human(due, ctx.user.tz, ctx.now) : "in an hour";
    const clean = args.text.replace(/^(?:to|that i (?:need to|should|have to)|about)\s+/i, "");
    const cap = clean.charAt(0).toUpperCase() + clean.slice(1);
    return { reply: `${cap}, ${when}. I'll ping you here.`, undo: { payload: { reminderId: row!.id, jobId } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE reminders SET deleted=true WHERE id=$1 AND user_id=$2`, [p.reminderId, ctx.user.id]);
    await cancelJob(ctx.db, p.jobId);
    return "Reminder removed.";
  },
});

const list = defineAction({
  name: "reminder.list",
  tier: 1,
  description: "List upcoming reminders.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ id: number; text: string; due_at: string; cron: string | null }>(
      `SELECT id, text, due_at, cron FROM reminders WHERE user_id=$1 AND NOT deleted AND NOT done ORDER BY due_at LIMIT 20`,
      [ctx.user.id],
    );
    if (!rows.length) return { reply: "Nothing set. Say \"remind me to ... at ...\" and I'll keep it." };
    const head = rows.length === 1 ? "One reminder coming up." : `${rows.length} reminders coming up.`;
    return {
      reply: [head, ...rows.map((r) => `${fmt(r.due_at, ctx.user.tz)}${r.cron ? " (repeats)" : ""}: ${r.text}`)].join("\n"),
    };
  },
});

const remove = defineAction({
  name: "reminder.delete",
  tier: 1,
  description: "Delete a reminder by id, or by matching text if id unknown.",
  schema: z.object({ id: z.number().int().optional(), match: z.string().optional() }),
  async run(args, ctx) {
    const row = args.id
      ? await ctx.db.one<{ id: number; job_id: number; text: string }>(`SELECT id, job_id, text FROM reminders WHERE id=$1 AND user_id=$2 AND NOT deleted`, [args.id, ctx.user.id])
      : await ctx.db.one<{ id: number; job_id: number; text: string }>(
          `SELECT id, job_id, text FROM reminders WHERE user_id=$1 AND NOT deleted AND NOT done AND text ILIKE $2 ORDER BY due_at LIMIT 1`,
          [ctx.user.id, `%${args.match ?? ""}%`],
        );
    if (!row) return { reply: "I couldn't find a reminder like that. Say \"my reminders\" to see what's set." };
    await ctx.db.query(`UPDATE reminders SET deleted=true WHERE id=$1`, [row.id]);
    if (row.job_id) await cancelJob(ctx.db, row.job_id);
    return { reply: `Dropped the reminder to ${row.text}.`, undo: { payload: { reminderId: row.id, jobId: row.job_id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE reminders SET deleted=false WHERE id=$1 AND user_id=$2`, [p.reminderId, ctx.user.id]);
    if (p.jobId) await ctx.db.query(`UPDATE jobs SET active=true WHERE id=$1`, [p.jobId]);
    return "Reminder restored.";
  },
});

/** Used by the Done / Snooze buttons. */
export async function markDone(db: any, userId: number, id: number): Promise<{ repeats: boolean; next?: string }> {
  const r = await db.one(`SELECT cron, due_at FROM reminders WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (r?.cron) return { repeats: true, next: r.due_at };
  await db.query(`UPDATE reminders SET done=true WHERE id=$1 AND user_id=$2 AND cron IS NULL`, [id, userId]);
  return { repeats: false };
}
export async function snooze(db: any, userId: number, id: number, minutes = 60) {
  const r = await db.one(`SELECT id FROM reminders WHERE id=$1 AND user_id=$2`, [id, userId]);
  if (!r) return;
  await schedule(db, { userId, kind: "reminder", payload: { reminderId: id }, runAt: new Date(Date.now() + minutes * 60_000) });
}

register(create, list, remove);
