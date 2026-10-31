/**
 * "What I did for you this week", once, in Sunday's morning brief. An assistant that works quietly is easy to forget;
 * one line a week shows the value without a ping of its own. Counts only, never health details: doses are a number,
 * never a name. Silent when there's nothing worth saying.
 */
import { DateTime } from "luxon";
import type { Db } from "../core/db.js";
import type { User } from "../policy/types.js";
import { z } from "zod";
import { addBriefSection, addExamples, addRules } from "../core/plugins.js";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";

const n = async (db: Db, sql: string, args: unknown[]) => Number((await db.one<{ n: string }>(sql, args).catch(() => undefined))?.n ?? 0);

/** The week's counts, for the person. Exported for tests. */
export async function weekCounts(db: Db, user: User, now: Date) {
  const since = new Date(now.getTime() - 7 * 86_400_000);
  const [reminders, doses, logs, pings] = await Promise.all([
    n(db, `SELECT count(*)::text AS n FROM reminders WHERE user_id=$1 AND NOT deleted AND due_at BETWEEN $2 AND $3`, [user.id, since, now]),
    n(db, `SELECT count(*)::text AS n FROM medication_logs l JOIN medications m ON m.id=l.medication_id WHERE m.user_id=$1 AND l.status='taken' AND l.scheduled_for BETWEEN $2 AND $3`, [user.id, since, now]),
    n(db, `SELECT ((SELECT count(*) FROM measures WHERE user_id=$1 AND at BETWEEN $2 AND $3) + (SELECT count(*) FROM spend WHERE user_id=$1 AND spent_at BETWEEN $2 AND $3) + (SELECT count(*) FROM habit_checkins c JOIN habits h ON h.id=c.habit_id WHERE h.user_id=$1 AND c.day BETWEEN $2::date AND $3::date))::text AS n`, [user.id, since, now]),
    n(db, `SELECT count(*)::text AS n FROM pushes WHERE user_id=$1 AND sent_at BETWEEN $2 AND $3 AND kind <> 'digest'`, [user.id, since, now]),
  ]);
  return { reminders, doses, logs, pings };
}

export function recapLine(c: { reminders: number; doses: number; logs: number; pings: number }): string | null {
  const parts = [
    c.reminders ? `rang ${c.reminders} reminder${c.reminders === 1 ? "" : "s"}` : "",
    c.doses ? `logged ${c.doses} dose${c.doses === 1 ? "" : "s"}` : "",
    c.logs ? `kept ${c.logs} thing${c.logs === 1 ? "" : "s"} you tracked` : "",
  ].filter(Boolean);
  if (!parts.length) return null;
  const said = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Your week with me: I ${said}${c.pings ? `, and only tapped you on the shoulder ${c.pings} time${c.pings === 1 ? "" : "s"}` : ""}.`;
}

addBriefSection({
  key: "week_recap", order: 6,
  async lines(db, user, now) {
    if (DateTime.fromJSDate(now).setZone(user.tz).weekday !== 7) return [];
    const line = recapLine(await weekCounts(db, user, now));
    return line ? [line] : [];
  },
});

/** Asked for, any day: the same counts, with a nudge toward a first thing when the week was empty. */
const week = defineAction({
  name: "recap.week",
  tier: 1,
  description: "The person asks what lifeline did for them this week, or how their week went with it. Counts of reminders rung, doses logged and things tracked.",
  schema: z.object({}),
  async run(_args, ctx) {
    const line = recapLine(await weekCounts(ctx.db, ctx.user, ctx.now));
    return line
      ? { reply: line }
      : { reply: "A quiet week: nothing rang and nothing got logged. Give me one thing to hold, like \"remind me to call mum Sunday at 5\", and next week's count starts there." };
  },
});
register(week);
addRules([/^(?:what (?:did|have) you (?:do|done) for me|my week with you|weekly recap|week recap)(?: this week)?\??[.!]*$/i, () => ({ action: "recap.week", args: {} })]);
addExamples("recap.week", ["what did you do for me this week?", "weekly recap"]);
