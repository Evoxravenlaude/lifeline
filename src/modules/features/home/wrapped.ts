/**
 * Year Wrapped: a calm year in numbers, from what people already keep here. In December (once, through
 * push, so quiet hours and calm mode apply) and on request. Five to seven short cards. Never health,
 * cycle, mood or anything sensitive; sleep and steps only as a gentle average and total.
 * "compare my year with the circle" is opt in, uses only people who opted in too, needs at least three
 * of them, and compares counts only (trips, places, longest habit streak, reminders done), never names or money.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import type { Db } from "../../../core/db.js";
import { addCapability, addCues, addExamples, addRules, addSystemJob } from "../../../core/plugins.js";
import { onJob } from "../../../core/scheduler.js";
import { money } from "../../../core/money.js";
import { andList, homePrefs, local, pingOnce, plural, setHome } from "./util.js";

export interface YearStats {
  year: number; messages: number; busiestMonth: string | null; remindersDone: number; listDone: number;
  spend: { currency: string; total: number; top: string | null }[]; sleepAvg: number | null; steps: number | null;
  checkins: number; streak: { days: number; habit: string } | null; trips: number; places: string[]; refills: number; jobsDone: number;
}

/** Days in a row, the longest run in a sorted list of ISO days. */
function longestRun(days: string[]): number {
  let best = 0, cur = 0, prev: DateTime | null = null;
  for (const d of [...new Set(days)].sort()) {
    const x = DateTime.fromISO(d);
    cur = prev && Math.round(x.diff(prev, "days").days) === 1 ? cur + 1 : 1;
    best = Math.max(best, cur); prev = x;
  }
  return best;
}

export async function yearStats(db: Db, user: User, year: number): Promise<YearStats> {
  const from = DateTime.fromObject({ year, month: 1, day: 1 }, { zone: user.tz }).toJSDate();
  const to = DateTime.fromObject({ year: year + 1, month: 1, day: 1 }, { zone: user.tz }).toJSDate();
  const n = async (sql: string) => Number((await db.one<{ n: string }>(sql, [user.id, from, to]))?.n ?? 0);
  const busiest = await db.one<{ m: string }>(`SELECT to_char(created_at AT TIME ZONE $4, 'FMMonth') AS m FROM messages WHERE user_id=$1 AND role='user' AND created_at >= $2 AND created_at < $3 GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`, [user.id, from, to, user.tz]);
  const spend = await db.query<{ currency: string; total: string; top: string | null }>(
    `SELECT currency, SUM(amount)::text AS total, (SELECT category FROM spend s2 WHERE s2.user_id=$1 AND s2.spent_at >= $2 AND s2.spent_at < $3 AND s2.currency=s.currency GROUP BY category ORDER BY SUM(amount) DESC LIMIT 1) AS top
       FROM spend s WHERE user_id=$1 AND spent_at >= $2 AND spent_at < $3 GROUP BY currency ORDER BY SUM(amount) DESC`, [user.id, from, to]);
  const sleep = await db.one<{ a: string | null }>(`SELECT AVG(value)::text AS a FROM measures WHERE user_id=$1 AND name='sleep' AND at >= $2 AND at < $3`, [user.id, from, to]);
  const steps = await db.one<{ s: string | null }>(`SELECT SUM(value)::text AS s FROM measures WHERE user_id=$1 AND name='steps' AND at >= $2 AND at < $3`, [user.id, from, to]);
  const checks = await db.query<{ name: string; day: string }>(`SELECT h.name, to_char(c.day, 'YYYY-MM-DD') AS day FROM habit_checkins c JOIN habits h ON h.id=c.habit_id WHERE h.user_id=$1 AND c.day >= $2::date AND c.day < $3::date`, [user.id, from, to]);
  let streak: YearStats["streak"] = null;
  for (const name of new Set(checks.map((c) => c.name))) {
    const run = longestRun(checks.filter((c) => c.name === name).map((c) => c.day));
    if (!streak || run > streak.days) streak = { days: run, habit: name };
  }
  const trips = await db.query<{ destination: string }>(`SELECT destination FROM trips WHERE user_id=$1 AND status<>'cancelled' AND starts_on >= $2::date AND starts_on < $3::date AND starts_on <= current_date`, [user.id, from, to]);
  const places = [...new Map(trips.map((t) => [t.destination.trim().toLowerCase(), t.destination.trim().replace(/\b\p{Ll}/gu, (c) => c.toUpperCase())])).values()];
  return {
    year,
    messages: await n(`SELECT count(*)::text AS n FROM messages WHERE user_id=$1 AND role='user' AND created_at >= $2 AND created_at < $3`),
    busiestMonth: busiest?.m ?? null,
    remindersDone: await n(`SELECT count(*)::text AS n FROM reminders WHERE user_id=$1 AND done AND due_at >= $2 AND due_at < $3`),
    listDone: await n(`SELECT count(*)::text AS n FROM todos WHERE user_id=$1 AND done AND created_at >= $2 AND created_at < $3`),
    spend: spend.map((r) => ({ currency: r.currency, total: Number(r.total), top: r.top })),
    sleepAvg: sleep?.a ? Math.round(Number(sleep.a) * 10) / 10 : null,
    steps: steps?.s ? Math.round(Number(steps.s)) : null,
    checkins: checks.length, streak, trips: trips.length, places,
    refills: await n(`SELECT count(*)::text AS n FROM home_refills WHERE user_id=$1 AND kind IN ('gas','power','fuel','water') AND at >= $2 AND at < $3`),
    jobsDone: await n(`SELECT count(*)::text AS n FROM home_job_log WHERE user_id=$1 AND done_at >= $2 AND done_at < $3`),
  };
}

const bigNum = (n: number) => (n >= 1_000_000 ? `${Math.round(n / 100_000) / 10} million` : n.toLocaleString("en-GB"));

/** Habit names that say something private (drinking, quitting, health): the count shows, the name doesn't. */
const PRIVATE_HABIT = /\b(?:no|not|quit|stop|sober|drink|drinking|alcohol|smok|vap|bet|gambl|porn|weed|drug|meds?|pill|therapy|insulin|fast|diet|purg|binge|cut|self)/i;

/** The cards, each a short label and one line. Only the ones with something in them. */
export function cards(s: YearStats): [string, string][] {
  const out: [string, string][] = [];
  if (s.messages) out.push(["You and me", `${plural(s.messages, "message")}${s.busiestMonth ? `, most of them in ${s.busiestMonth}` : ""}.`]);
  if (s.remindersDone || s.listDone) out.push(["Things done", andList([s.remindersDone ? plural(s.remindersDone, "reminder") + " done" : "", s.listDone ? `${plural(s.listDone, "list item")} ticked off` : ""].filter(Boolean)) + "."]);
  if (s.spend.length) out.push(["Money", `${andList(s.spend.slice(0, 2).map((x) => `${money(Math.round(x.total), x.currency)} spent${x.top && x.top !== "other" ? `, mostly on ${x.top}` : ""}`))}.`]);
  if (s.sleepAvg || s.steps) out.push(["Rest and steps", andList([s.sleepAvg ? `${s.sleepAvg} hours of sleep a night on average` : "", s.steps ? `${bigNum(s.steps)} steps` : ""].filter(Boolean)) + "."]);
  if (s.checkins) out.push(["Habits", `${plural(s.checkins, "check-in")}${s.streak && s.streak.days > 1 ? `; your longest run was ${s.streak.days} days${PRIVATE_HABIT.test(s.streak.habit) ? "" : ` of ${s.streak.habit}`}` : ""}.`]);
  if (s.trips) out.push(["Out in the world", `${plural(s.trips, "trip")}${s.places.length ? ` to ${andList(s.places.slice(0, 4))}${s.places.length > 4 ? ` and ${s.places.length - 4} more` : ""}` : ""}.`]);
  if (s.refills || s.jobsDone) out.push(["Home", andList([s.refills ? `${plural(s.refills, "refill")} logged` : "", s.jobsDone ? `${plural(s.jobsDone, "home job")} done` : ""].filter(Boolean)) + "."]);
  return out.slice(0, 7);
}

export function story(s: YearStats): string | null {
  const cs = cards(s);
  if (cs.length < 2) return null;
  return [`**${s.year}, wrapped**`, ...cs.map(([k, v]) => `**${k}**\n${v}`)].join("\n\n");
}

const yearOf = (ctx: { now: Date; user: User }, y?: number) => y ?? (() => { const L = local(ctx.now, ctx.user.tz); return L.month === 1 && L.day <= 15 ? L.year - 1 : L.year; })();

const show = defineAction({
  name: "yearwrap.show",
  tier: 1,
  description: "The person's year, wrapped: a calm year in numbers from what they keep here (messages, reminders and list items done, spending by currency, sleep and steps averages, habits and longest streak, trips and places, home refills and jobs). Never health, mood or cycle details.",
  schema: z.object({ year: z.number().int().min(2000).max(2100).optional() }),
  async run(a, ctx) {
    const y = yearOf(ctx, a.year);
    const text = story(await yearStats(ctx.db, ctx.user, y));
    if (!text) return { reply: `${y} is still a quiet page here. Keep telling me what you do, spend and plan, and December will have a story in it.` };
    const opted = homePrefs(ctx.user).yearCompare === true;
    return { reply: `${text}\n\n${opted ? `Say "compare my year with the circle" to see it beside the others who opted in.` : `If you'd like, "compare my year with the circle" sets it beside others who opt in, counts only.`}`, ...(ctx.user.prefs.calm === true ? {} : { sticker: "cheers" }) };
  },
});

/** Only counts that say nothing sensitive. */
const METRICS: [string, (s: YearStats) => number, string][] = [
  ["Trips", (s) => s.trips, "trip"], ["Places", (s) => s.places.length, "place"], ["Longest habit run", (s) => s.streak?.days ?? 0, "day"], ["Reminders done", (s) => s.remindersDone, "reminder"],
];
const median = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : Math.round(((a[m - 1] + a[m]) / 2) * 10) / 10; };

const compare = defineAction({
  name: "yearwrap.compare",
  tier: 1,
  description: "Compare the person's year with the circle: asking opts them in. Uses only members who also opted in (at least five in all), and only counts: trips, places, longest habit streak, reminders done. Never names, money, health, mood or cycle.",
  schema: z.object({}),
  async run(_a, ctx) {
    const was = homePrefs(ctx.user).yearCompare === true;
    if (!was) await setHome(ctx.db, ctx.user, { yearCompare: true });
    const y = yearOf(ctx);
    const others = await ctx.db.query<User>(`SELECT * FROM users WHERE id<>$1 AND prefs->'home'->>'yearCompare' = 'true'`, [ctx.user.id]);
    const intro = was ? "" : `You're in. Only counts are compared (trips, places, longest habit run, reminders done), never names, money or health, and only with people who opted in too. Say "stop comparing my year" to leave.\n\n`;
    if (others.length < 4) return { reply: `${intro}${others.length === 0 ? "Nobody else has opted in yet" : `Only ${others.length === 1 ? "one other person has" : `${others.length} others have`} opted in so far`}, and I wait for at least five of you so nobody can be picked out. I'll have it when there are.`, undo: was ? undefined : { payload: {} } };
    const mine = await yearStats(ctx.db, ctx.user, y);
    const theirs = await Promise.all(others.map((o) => yearStats(ctx.db, o, y)));
    const lines = METRICS.map(([label, f, unit]) => `- ${label}: you ${plural(f(mine), unit)}, the middle of the circle ${plural(median(theirs.map(f)), unit)}`);
    return { reply: `${intro}${y} beside ${others.length} others who opted in:\n${lines.join("\n")}`, undo: was ? undefined : { payload: {} } };
  },
  async undo(_p, ctx) { await setHome(ctx.db, ctx.user, { yearCompare: false }); return "You're out of the comparison."; },
});

const settings = defineAction({
  name: "yearwrap.settings",
  tier: 1,
  description: "Year Wrapped settings: 'december' false stops the December message (true brings it back); 'compare' false leaves the circle comparison.",
  schema: z.object({ december: z.boolean().optional(), compare: z.boolean().optional() }),
  async run(a, ctx) {
    const prev = { yearWrapOff: homePrefs(ctx.user).yearWrapOff ?? false, yearCompare: homePrefs(ctx.user).yearCompare ?? false };
    const patch: Record<string, boolean> = {};
    if (a.december !== undefined) patch.yearWrapOff = !a.december;
    if (a.compare !== undefined) patch.yearCompare = a.compare;
    await setHome(ctx.db, ctx.user, patch);
    const bits = [a.december === false ? "No year wrapped in December; you can still ask for it" : a.december ? "Your year, wrapped, comes in late December" : "", a.compare === false ? "you're out of the circle comparison" : a.compare ? "you're in the circle comparison" : ""].filter(Boolean);
    return { reply: `${bits.join(", and ")}.`.replace(/^./, (c) => c.toUpperCase()), undo: { payload: prev } };
  },
  async undo(p, ctx) { await setHome(ctx.db, ctx.user, p); return "Put back as it was."; },
});

register(show, compare, settings);

addRules(
  [/^(?:my\s+)?(?:year\s+(?:wrapped|in numbers|in review)|(\d{4})\s+wrapped|wrapped\s+(\d{4}))$|^my year$|^how was my year$|^(?:show\s+)?my\s+(\d{4})(?:\s+wrapped)?$/i, (m) => ({ action: "yearwrap.show", args: m[1] ?? m[2] ?? m[3] ? { year: Number(m[1] ?? m[2] ?? m[3]) } : {} })],
  [/^compare my year(?:\s+(?:with|to|against)\s+(?:the\s+)?(?:circle|others|everyone))?$|^how does my year compare(?:\s+(?:with|to)\s+(?:the\s+)?circle)?\??$/i, () => ({ action: "yearwrap.compare", args: {} })],
  [/^(?:no|stop|skip|turn off)\s+(?:the\s+)?(?:year wrapped|yearly wrapped|year in review)(?:\s+in december)?$/i, () => ({ action: "yearwrap.settings", args: { december: false } })],
  [/^(?:send|turn on|start)\s+(?:the\s+|my\s+)?(?:year wrapped|year in review)(?:\s+in december)?$/i, () => ({ action: "yearwrap.settings", args: { december: true } })],
  [/^(?:stop comparing my year|leave the (?:year )?comparison|don'?t compare my year)$/i, () => ({ action: "yearwrap.settings", args: { compare: false } })],
);
addExamples("yearwrap.show", ["my year wrapped", "year wrapped", "2026 wrapped", "my year in numbers"]);
addExamples("yearwrap.compare", ["compare my year with the circle", "how does my year compare"]);
addExamples("yearwrap.settings", ["no year wrapped", "stop comparing my year", "turn on year wrapped"]);
addCues("yearwrap", ["year wrapped", "my year", "year in numbers", "year in review", "compare my year", "circle"]);
addCapability({
  key: "year_wrapped", name: "Your year, wrapped",
  cues: ["year wrapped", "my year", "year in review", "year in numbers", "wrapped"],
  what: "At the end of the year, a calm story of it in numbers: what you got done, where you went, your habits and what you spent. Never health, mood or anything private.",
  say: ["my year wrapped", "compare my year with the circle"],
  then: "It comes once in late December, or whenever you ask. Comparing with the circle is opt in, counts only, and needs at least three people. Say \"no year wrapped\" to skip the December one.",
}, "Fun");

/** Late December, once a year: through push, so quiet hours, the daily cap and calm mode all apply; it retries until the 31st. */
addSystemJob("home_yearwrap", "41 * 25-31 12 *");
onJob("home_yearwrap", async (_job, deps) => {
  const now = new Date();
  for (const user of await deps.db.query<User>(`SELECT * FROM users`)) {
    const L = local(now, user.tz);
    if (L.month !== 12 || L.day < 28 || L.hour < 10 || L.hour > 19) continue;
    const hp = homePrefs(user);
    if (hp.yearWrapOff === true || user.prefs.wrapped === false || hp.yearWrapSent === L.year) continue;
    const text = story(await yearStats(deps.db, user, L.year));
    if (!text) continue;
    if (await pingOnce(deps, user, "wrapped", `${text}\n\nSay "no year wrapped" to skip this next December.`, { now, buttons: [{ label: "Compare with the circle", data: "hm:wr:cmp" }] })) {
      await setHome(deps.db, user, { yearWrapSent: L.year });
    }
  }
});
