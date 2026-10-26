/**
 * Medication reminders. This module stores what the user tells it and rings
 * at the times they chose. It never suggests doses, timing changes or
 * interactions — the intent layer refuses those and points to a pharmacist.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { parseClock } from "../core/time.js";
import { cancelJob, onJob, push, schedule } from "../core/scheduler.js";

onJob("med_slot", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const med = await deps.db.one<{ id: number; name: string; dose: string | null; active: boolean; days_left: number | null }>(
    `SELECT id, name, dose, active, days_left FROM medications WHERE id=$1`,
    [job.payload.medId],
  );
  if (!med || !med.active) return;
  const logRow = await deps.db.one<{ id: number }>(
    `INSERT INTO medication_logs (medication_id, scheduled_for) VALUES ($1, now()) RETURNING id`,
    [med.id],
  );
  const kb = [{ label: "Taken", data: `med:taken:${logRow!.id}` }, { label: "Skip", data: `med:skip:${logRow!.id}` }];
  const low = med.days_left !== null && med.days_left <= 3 ? ` (about ${med.days_left} day${med.days_left === 1 ? "" : "s"} of supply left)` : "";
  await push(deps, user, "medication", `💊 ${med.name}${med.dose ? ` — ${med.dose}` : ""}${low}`, { exempt: true, buttons: kb });
  await schedule(deps.db, { userId: user.id, kind: "med_nudge", payload: { logId: logRow!.id }, runAt: new Date(Date.now() + 90 * 60_000) });
});

onJob("med_nudge", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const l = await deps.db.one<{ status: string; name: string; id: number }>(
    `SELECT l.id, l.status, m.name FROM medication_logs l JOIN medications m ON m.id=l.medication_id WHERE l.id=$1`,
    [job.payload.logId],
  );
  if (!l || l.status !== "pending") return;
  await push(deps, user, "medication", `Still pending: ${l.name}. Taken?`, { exempt: true, buttons: [{ label: "Taken", data: `med:taken:${l.id}` }, { label: "Skip", data: `med:skip:${l.id}` }] });
});

const add = defineAction({
  name: "medication.add",
  tier: 1,
  description:
    "Add a medication reminder. `times` is a list of clock times like ['08:00','20:00'] or ['9am']. `dose` is the user's own words (e.g. '1 tablet'); never invent it. `days_left` optional supply count for refill nudges.",
  schema: z.object({
    name: z.string().min(1).max(100),
    times: z.array(z.string()).min(1).max(6),
    dose: z.string().max(100).optional(),
    days_left: z.number().int().positive().optional(),
  }),
  async run(args, ctx) {
    const parsed = args.times.map((t) => [t, parseClock(t)] as const);
    const bad = parsed.find(([, p]) => !p);
    if (bad) throw new Error(`"${bad[0]}" isn't a time I understand (try 08:00 or 8am)`);
    const times = parsed.map(([, p]) => `${String(p![0]).padStart(2, "0")}:${String(p![1]).padStart(2, "0")}`);
    const row = await ctx.db.one<{ id: number }>(
      `INSERT INTO medications (user_id, name, dose, times, days_left) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.user.id, args.name, args.dose ?? null, times, args.days_left ?? null],
    );
    const jobIds: number[] = [];
    for (const [h, m] of parsed.map(([, p]) => p!)) {
      jobIds.push(await schedule(ctx.db, { userId: ctx.user.id, kind: "med_slot", payload: { medId: row!.id }, cron: `${m} ${h} * * *`, tz: ctx.user.tz }));
    }
    return {
      reply: `Added ${args.name}${args.dose ? ` (${args.dose})` : ""} at ${times.join(", ")} daily. I'll ask you to mark each one taken.`,
      undo: { payload: { medId: row!.id, jobIds } },
    };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE medications SET active=false WHERE id=$1 AND user_id=$2`, [p.medId, ctx.user.id]);
    for (const j of p.jobIds) await cancelJob(ctx.db, j);
    return "Medication reminder removed.";
  },
});

const list = defineAction({
  name: "medication.list",
  tier: 1,
  description: "List active medication reminders and this week's adherence.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ id: number; name: string; dose: string | null; times: string[]; days_left: number | null; taken: string; total: string }>(
      `SELECT m.id, m.name, m.dose, m.times, m.days_left,
         (SELECT count(*) FROM medication_logs l WHERE l.medication_id=m.id AND l.scheduled_for > now() - interval '7 days' AND l.status='taken')::text AS taken,
         (SELECT count(*) FROM medication_logs l WHERE l.medication_id=m.id AND l.scheduled_for > now() - interval '7 days')::text AS total
       FROM medications m WHERE m.user_id=$1 AND m.active ORDER BY m.name`,
      [ctx.user.id],
    );
    if (!rows.length) return { reply: "No medication reminders set." };
    return {
      reply: rows
        .map((r) => `#${r.id} ${r.name}${r.dose ? ` (${r.dose})` : ""} at ${r.times.join(", ")} — ${r.taken}/${r.total} taken this week${r.days_left !== null ? `, ~${r.days_left}d supply` : ""}`)
        .join("\n"),
    };
  },
});

const remove = defineAction({
  name: "medication.delete",
  tier: 2,
  description: "Stop a medication reminder by id. Confirmed first because a missed medication is costly.",
  schema: z.object({ id: z.number().int() }),
  echo: (a) => `Stop medication reminder #${a.id}`,
  async run(args, ctx) {
    const r = await ctx.db.query(`UPDATE medications SET active=false WHERE id=$1 AND user_id=$2 RETURNING name`, [args.id, ctx.user.id]);
    if (!r.length) return { reply: "No such medication." };
    await ctx.db.query(`UPDATE jobs SET active=false WHERE kind='med_slot' AND payload->>'medId'=$1`, [String(args.id)]);
    return { reply: `Stopped reminders for ${r[0].name}.` };
  },
});

export async function resolveLog(db: any, userId: number, logId: number, status: "taken" | "skipped") {
  const r = await db.query(
    `UPDATE medication_logs SET status=$3, taken_at=CASE WHEN $3='taken' THEN now() END
     WHERE id=$1 AND medication_id IN (SELECT id FROM medications WHERE user_id=$2) RETURNING medication_id`,
    [logId, userId, status],
  );
  if (r.length && status === "taken") {
    await db.query(`UPDATE medications SET days_left = CASE WHEN days_left IS NULL THEN NULL ELSE GREATEST(days_left-1,0) END WHERE id=$1`, [r[0].medication_id]);
  }
  return r.length > 0;
}

register(add, list, remove);
