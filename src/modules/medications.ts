/**
 * Medication reminders. This module stores what the user tells it and rings
 * at the times they chose. It never suggests doses, timing changes or
 * interactions — the intent layer refuses those and points to a pharmacist.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { fmt, parseClock } from "../core/time.js";
import { cancelJob, onJob, push, schedule } from "../core/scheduler.js";
import { addExamples, addRules } from "../core/plugins.js";

onJob("med_slot", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const med = await deps.db.one<{ id: number; name: string; dose: string | null; active: boolean; days_left: number | null }>(
    `SELECT id, name, dose, active, days_left FROM medications WHERE id=$1`,
    [job.payload.medId],
  );
  if (!med || !med.active) return;
  // The dose belongs to the time it was due, even when the server was down and this runs late.
  const due = job.run_at ? new Date(job.run_at) : new Date();
  const late = (job.lateMs ?? 0) > 30 * 60_000;
  const logRow = await deps.db.one<{ id: number }>(
    `INSERT INTO medication_logs (medication_id, scheduled_for) VALUES ($1, $2) RETURNING id`,
    [med.id, due],
  );
  const kb = [{ label: "Taken", data: `med:taken:${logRow!.id}` }, { label: "Skip", data: `med:skip:${logRow!.id}` }];
  const low = med.days_left !== null && med.days_left <= 3 ? ` About ${med.days_left} day${med.days_left === 1 ? "" : "s"} of supply left, time to refill.` : "";
  const what = `${med.name}${med.dose ? `, ${med.dose}` : ""}`;
  const text = late ? `${what} was due at ${fmt(due, user.tz, false)}. I'm late with this one; tap Taken if you've had it.${low}` : `Time for ${what}.${low}`;
  const ok = await push(deps, user, "medication", text, { exempt: true, buttons: kb });
  // Not delivered: the follow-up comes in ten minutes instead of ninety, and doubles as the retry.
  await schedule(deps.db, { userId: user.id, kind: "med_nudge", payload: { logId: logRow!.id }, runAt: new Date(Date.now() + (ok ? 90 : 10) * 60_000) });
});

onJob("med_nudge", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const l = await deps.db.one<{ status: string; name: string; id: number }>(
    `SELECT l.id, l.status, m.name FROM medication_logs l JOIN medications m ON m.id=l.medication_id WHERE l.id=$1`,
    [job.payload.logId],
  );
  if (!l || l.status !== "pending") return;
  await push(deps, user, "medication", `Did you take ${l.name}? I haven't heard back.`, { exempt: true, buttons: [{ label: "Taken", data: `med:taken:${l.id}` }, { label: "Skip", data: `med:skip:${l.id}` }] });
});

const add = defineAction({
  name: "medication.add",
  tier: 1,
  description:
    "Add a medication reminder. `times` is a list of clock times like ['08:00','20:00'] or ['9am']; leave it empty if the user gave no times and the bot will ask. `dose` is the user's own words (e.g. '1 tablet'); never invent it. `days_left` optional supply count for refill nudges.",
  schema: z.object({
    name: z.string().min(1).max(100),
    times: z.array(z.string()).max(6).optional(),
    dose: z.string().max(100).optional(),
    days_left: z.number().int().positive().optional(),
  }),
  needs(args) {
    if (args.times?.length) return null;
    return { need: "times", question: `What times do you take ${args.name}? Say "8am and 8pm" or "20:00".` };
  },
  fill(need, answer) {
    if (need !== "times") return null;
    const times = answer.split(/\s*(?:,|and|&|\/)\s*/).map((t) => t.trim()).filter(Boolean);
    return times.length && times.every((t) => parseClock(t)) ? { times } : null;
  },
  async run(args, ctx) {
    const parsed = (args.times ?? []).map((t) => [t, parseClock(t)] as const);
    if (!parsed.length) throw new Error(`What times do you take ${args.name}?`);
    const bad = parsed.find(([, p]) => !p);
    if (bad) throw new Error(`I couldn't read "${bad[0]}" as a time. Try 08:00 or 8am.`);
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
      reply: `${args.name}${args.dose ? `, ${args.dose},` : ""} at ${times.join(" and ")} every day. I'll ring you at each one with Taken and Skip, and keep the log.`,
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
    if (!rows.length) return { reply: "No medication on the list. Say \"I take vitamin D at 8am and 8pm\" and I'll keep it." };
    const head = rows.length === 1 ? "One on the list." : `${rows.length} on the list.`;
    return {
      reply: [head, ...rows
        .map((r) => `${r.name}${r.dose ? `, ${r.dose},` : ""} at ${r.times.join(" and ")}. ${r.taken} of ${r.total} taken this week${r.days_left !== null ? `, about ${r.days_left} day${r.days_left === 1 ? "" : "s"} of supply left` : ""}.`)]
        .join("\n"),
    };
  },
});

const remove = defineAction({
  name: "medication.delete",
  tier: 2,
  description: "Stop a medication reminder by id, or by `match` on its name. Confirmed first because a missed medication is costly.",
  schema: z.object({ id: z.number().int().optional(), match: z.string().optional() }),
  echo: (a) => (a.id ? `This stops the medication reminder you pointed at. No more rings for it.` : `This stops the reminders for ${a.match}. No more rings for it.`),
  async run(args, ctx) {
    const r = args.id
      ? await ctx.db.query(`UPDATE medications SET active=false WHERE id=$1 AND user_id=$2 AND active RETURNING id, name`, [args.id, ctx.user.id])
      : await ctx.db.query(`UPDATE medications SET active=false WHERE id=(SELECT id FROM medications WHERE user_id=$1 AND active AND name ILIKE $2 ORDER BY id LIMIT 1) RETURNING id, name`, [ctx.user.id, `%${args.match ?? ""}%`]);
    if (!r.length) return { reply: "I couldn't find that one. Say \"my meds\" to see what's set." };
    await ctx.db.query(`UPDATE jobs SET active=false WHERE kind='med_slot' AND payload->>'medId'=$1`, [String(r[0].id)]);
    return { reply: `Stopped the reminders for ${r[0].name}. The log stays.` };
  },
});

/**
 * "Took my meds": the dose that's waiting (rung in the last twelve hours) is marked taken. With a name, that
 * medication's waiting dose, or a dose logged now if none is waiting. On Telegram this gets a reaction, not a reply.
 */
const taken = defineAction({
  name: "medication.taken",
  tier: 1,
  description: "The person says they took their medication ('took my meds', 'took my metformin', 'meds taken'). Marks the waiting dose as taken. `match` is the medication's name if they said one. Never advice, never doses.",
  schema: z.object({ match: z.string().max(60).optional() }),
  async run(args, ctx) {
    const meds = await ctx.db.query<{ id: number; name: string }>(`SELECT id, name FROM medications WHERE user_id=$1 AND active ORDER BY id`, [ctx.user.id]);
    if (!meds.length) return { reply: "Noted. I don't have any medication set to remind you about. Say \"I take vitamin D at 8am\" and I'll ring you and keep the log." };
    const m = args.match?.trim().toLowerCase().replace(/\s+(?:dose|tablets?|pills?)$/, "");
    const pick = m ? meds.filter((x) => x.name.toLowerCase().includes(m) || m.includes(x.name.toLowerCase())) : meds;
    if (m && !pick.length) return { reply: `I don't have ${args.match} on your list. Your list: ${meds.map((x) => x.name).join(", ")}. Say "I take ${args.match} at 8am" to add it.` };
    const waiting = await ctx.db.query<{ id: number; name: string }>(
      `SELECT l.id, m.name FROM medication_logs l JOIN medications m ON m.id=l.medication_id
       WHERE m.user_id=$1 AND m.id = ANY($2::int[]) AND l.status='pending' AND l.scheduled_for > $3 ORDER BY l.scheduled_for DESC`,
      [ctx.user.id, pick.map((x) => x.id), new Date(ctx.now.getTime() - 12 * 3_600_000)],
    );
    if (waiting.length) {
      for (const w of waiting) await resolveLog(ctx.db, ctx.user.id, w.id, "taken");
      const names = [...new Set(waiting.map((w) => w.name))];
      return { reply: `${names.join(" and ")}, taken. Logged.`, undo: { payload: { logs: waiting.map((w) => w.id) } } };
    }
    if (!m && pick.length > 1) return { reply: `Nothing's waiting on a dose right now. Which one did you take: ${pick.map((x) => x.name).join(", ")}?` };
    const row = await ctx.db.one<{ id: number }>(`INSERT INTO medication_logs (medication_id, scheduled_for, status, taken_at) VALUES ($1, $2, 'taken', $2) RETURNING id`, [pick[0].id, ctx.now]);
    await ctx.db.query(`UPDATE medications SET days_left = CASE WHEN days_left IS NULL THEN NULL ELSE GREATEST(days_left-1,0) END WHERE id=$1`, [pick[0].id]);
    return { reply: `${pick[0].name}, taken. Logged.`, undo: { payload: { inserted: row!.id, medId: pick[0].id } } };
  },
  async undo(p, ctx) {
    if (p.inserted) {
      await ctx.db.query(`DELETE FROM medication_logs WHERE id=$1 AND medication_id IN (SELECT id FROM medications WHERE user_id=$2)`, [p.inserted, ctx.user.id]);
      await ctx.db.query(`UPDATE medications SET days_left = CASE WHEN days_left IS NULL THEN NULL ELSE days_left+1 END WHERE id=$1 AND user_id=$2`, [p.medId, ctx.user.id]);
    }
    for (const id of p.logs ?? []) await ctx.db.query(`UPDATE medication_logs SET status='pending', taken_at=NULL WHERE id=$1 AND medication_id IN (SELECT id FROM medications WHERE user_id=$2)`, [id, ctx.user.id]);
    return "Taken back. That dose is open again.";
  },
});

/** Taken or Skip from a button. Tapping Taken on both the app notification and Telegram counts the dose once. */
export async function resolveLog(db: any, userId: number, logId: number, status: "taken" | "skipped") {
  const r = await db.query(
    `UPDATE medication_logs SET status=$3, taken_at=CASE WHEN $3='taken' THEN now() END
     WHERE id=$1 AND status <> $3 AND medication_id IN (SELECT id FROM medications WHERE user_id=$2) RETURNING medication_id`,
    [logId, userId, status],
  );
  if (r.length && status === "taken") {
    await db.query(`UPDATE medications SET days_left = CASE WHEN days_left IS NULL THEN NULL ELSE GREATEST(days_left-1,0) END WHERE id=$1`, [r[0].medication_id]);
  }
  if (r.length) return true;
  // Already marked that way: still a yes, just nothing more to count.
  return Boolean(await db.one(`SELECT 1 FROM medication_logs WHERE id=$1 AND medication_id IN (SELECT id FROM medications WHERE user_id=$2)`, [logId, userId]));
}

register(add, list, remove, taken);

/* Plain med words only: "took my time" or "took my kids to school" never land here, and "took my pill" stays with the cycle log. */
addRules(
  [/^(?:i(?:'ve| have)?\s+)?(?:just\s+)?(?:took|taken|had)\s+(?:my|the)\s+(?:(?:morning|evening|night|bedtime|afternoon)\s+)?(?:meds|medication|medicine|tablets)\b[.!]*$/i, () => ({ action: "medication.taken", args: {} })],
  [/^(?:meds|medication|medicine|tablets)\s+(?:taken|done)[.!]*$/i, () => ({ action: "medication.taken", args: {} })],
  [/^(?:i(?:'ve| have)?\s+)?(?:just\s+)?(?:took|taken)\s+(?:my\s+)?([a-z][\w -]{1,40}?)\s+(?:dose|tablets?)[.!]*$/i, (m) => ({ action: "medication.taken", args: { match: m[1] } })],
);
addExamples("medication.taken", ["took my meds", "took my metformin dose", "meds taken"]);
/* "I take vitamin D at 8am and 8pm" (also what the onboarding button sends): the name, then the times. */
addRules([/^i (?:take|need to take|have to take)\s+(?:my\s+)?([a-z][\w' .-]{1,40}?)(?:,?\s+(\d+\s*(?:mg|ml|tablets?|pills?|caps?(?:ules)?|drops?|iu|mcg)))?\s+(?:at|every day at|daily at)\s+(.{2,60})$/i,
  (m) => {
    const times = m[3].split(/\s*(?:,|and|&)\s*/).map((t) => t.trim()).filter((t) => /^\d{1,2}(?::\d{2})?\s*(?:am|pm)?$|^(?:noon|midnight)$/i.test(t));
    return times.length ? { action: "medication.add", args: { name: m[1].trim(), times, ...(m[2] ? { dose: m[2].trim() } : {}) } } : null;
  }]);
addExamples("medication.add", ["I take vitamin D at 8am and 8pm"]);
