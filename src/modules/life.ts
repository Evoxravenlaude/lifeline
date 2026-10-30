/** Habits, spend log, quick notes, memory with provenance. */
import { money, userCurrency } from "../core/money.js";
import { z } from "zod";

/** "I'm vegetarian" said back is "you're vegetarian". */
export function yours(fact: string): string {
  const swaps: [RegExp, string][] = [[/\bI am\b/g, "you are"], [/\bI'm\b/gi, "you're"], [/\bI've\b/gi, "you've"], [/\bI'll\b/gi, "you'll"], [/\bI'd\b/gi, "you'd"], [/\bmyself\b/gi, "yourself"], [/\bmy\b/gi, "your"], [/\bmine\b/gi, "yours"], [/\bme\b/gi, "you"], [/\bI\b/g, "you"]];
  return swaps.reduce((s, [re, to]) => s.replace(re, to), fact);
}
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { localDay } from "../core/time.js";
import { addCues, addExamples, addRules, addSchema } from "../core/plugins.js";
import type { Db } from "../core/db.js";

/** Days filled in by "repair my streak", kept with the habit. They count as logged for the streak only. */
addSchema(`ALTER TABLE habits ADD COLUMN IF NOT EXISTS repaired_days TEXT[] NOT NULL DEFAULT '{}'`);

/** A kinder streak, as it stands on `today`. */
export interface Streak {
  /** Days logged in the current run (rest and freeze days keep it going but aren't counted). */
  run: number;
  /** The best run in this history. */
  best: number;
  /** Yesterday was the week's rest day. */
  restYesterday: boolean;
  /** Streak freezes banked, 0 to 2. */
  freezes: number;
  /** Yesterday was missed and a freeze covered it. */
  frozeYesterday: boolean;
  /** Today's log earned a freeze (every 7th day logged in a run, while fewer than 2 are banked). */
  earnedToday: boolean;
  /** The last missed day that ended a run, or null. Used to offer a repair. */
  brokeOn: string | null;
}

export const FREEZE_CAP = 2;
const DAY = 86_400_000;
const step = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const gap = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

/**
 * A kinder streak. One missed day a week is a rest day and doesn't break the run. A missed day the rest day
 * doesn't cover spends a streak freeze, if one is banked: one is earned for every 7 days logged in a run, at
 * most 2 banked. Repaired days (see habit.repair) count as logged. `days` are ISO dates in any order; `today`
 * is the day being looked at. Today isn't over, so a day not logged yet is never counted against the run.
 */
export function streakOf(days: string[], today: string, repaired: string[] = []): Streak {
  const have = new Set([...days, ...repaired].filter((d) => d <= today));
  const out: Streak = { run: 0, best: 0, restYesterday: false, freezes: 0, frozeYesterday: false, earnedToday: false, brokeOn: null };
  if (!have.size) return out;
  let d = [...have].sort()[0];
  if (gap(d, today) > 4000) d = step(today, -4000);
  let run = 0, freezes = 0, lastRest: string | null = null, sinceRest = 0, freezeSinceRest = false, earnedOn: string | null = null;
  const rests = new Set<string>(), frozen = new Set<string>();
  const breakAt = (day: string) => { out.brokeOn = day; run = 0; freezes = 0; lastRest = null; sinceRest = 0; freezeSinceRest = false; rests.clear(); frozen.clear(); };
  for (; d <= today; d = step(d, 1)) {
    if (have.has(d)) {
      run++; sinceRest++;
      if (run % 7 === 0 && freezes < FREEZE_CAP) { freezes++; earnedOn = d; freezeSinceRest = true; }
      out.best = Math.max(out.best, run);
      continue;
    }
    if (d === today || run === 0) continue;
    if (!lastRest || gap(lastRest, d) >= 7) { lastRest = d; rests.add(d); sinceRest = 0; freezeSinceRest = false; continue; }
    if (freezes > 0) { freezes--; frozen.add(d); freezeSinceRest = true; continue; }
    if (sinceRest > 0 && !freezeSinceRest) {
      // Kinder to end the run at the earlier rest day and rest today instead: the run since then is kept.
      const kept = sinceRest, rest = d;
      breakAt(lastRest);
      run = kept; lastRest = rest; rests.add(rest);
      continue;
    }
    breakAt(d);
  }
  const y = step(today, -1);
  return { ...out, run, freezes, restYesterday: run > 0 && rests.has(y), frozeYesterday: run > 0 && frozen.has(y), earnedToday: earnedOn === today && have.has(today) };
}

const habitAdd = defineAction({
  name: "habit.add",
  tier: 1,
  description: "Track a habit (gym, reading, water). `target_per_week` defaults to 7.",
  schema: z.object({ name: z.string().min(1).max(80), target_per_week: z.number().int().min(1).max(7).optional() }),
  async run(args, ctx) {
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO habits (user_id, name, target_per_week) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, args.name, args.target_per_week ?? 7]);
    const n = args.target_per_week ?? 7;
    return { reply: `${args.name}, ${n === 7 ? "every day" : `${n} times a week`}. Say "did ${args.name}" whenever you do it and I'll keep the streak.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE habits SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Habit dropped.";
  },
});

const habitCheck = defineAction({
  name: "habit.checkin",
  tier: 1,
  description: "Check in a habit for today (or 'yesterday'). Matches by name.",
  schema: z.object({ name: z.string().min(1), day: z.enum(["today", "yesterday"]).optional() }),
  async run(args, ctx) {
    let h = await ctx.db.one<{ id: number; name: string }>(`SELECT id, name FROM habits WHERE user_id=$1 AND active AND name ILIKE $2 LIMIT 1`, [ctx.user.id, `%${args.name}%`]);
    let first = false;
    if (!h) {
      // First time they mention it: start counting from here rather than sending them off to set it up.
      if (args.name.length > 40 || /\s(?:to|the|a|an|my)\s/.test(` ${args.name} `)) return { reply: `I'm not counting anything like "${args.name}". If it's a habit, say "track ${args.name}" and I'll keep the streak; if it's a task, say "done with ${args.name}".` };
      h = (await ctx.db.one<{ id: number; name: string }>(`INSERT INTO habits (user_id, name, target_per_week) VALUES ($1,$2,7) RETURNING id, name`, [ctx.user.id, args.name.toLowerCase()]))!;
      first = true;
    }
    const day = localDay(args.day === "yesterday" ? new Date(ctx.now.getTime() - 86_400_000) : ctx.now, ctx.user.tz);
    await ctx.db.query(`INSERT INTO habit_checkins (habit_id, day) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [h.id, day]);
    const days = (await ctx.db.query<{ day: string }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM habit_checkins WHERE habit_id=$1 AND day <= $2::date ORDER BY day DESC LIMIT 800`, [h.id, day])).map((r) => r.day);
    const repaired = await repairedDays(ctx.db, h.id);
    const s = streakOf(days, day, repaired);
    const n = s.run;
    const canRepair = n === 1 && !!repairable(days, repaired, day) && !repairUsed(repaired, day);
    const said = first ? "I'll count it from here; say \"did " + h.name + "\" each time and I keep the streak."
      : n === 1 ? (s.best > 2 ? `Day one again. Your best run is ${s.best} days, and every one of them still counts.${canRepair ? " If a day slipped by, say \"repair my streak\" and I'll fill it in." : ""}` : "Day one.")
      : `That's ${n} days running.${streakNote(s)}`;
    const milestone = !first && [7, 30, 100, 365].includes(n);
    return { reply: `${h.name}, logged. ${said}`, ...(milestone ? { sticker: "cheers", celebrate: true } : {}), undo: { payload: { id: h.id, day, created: first } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM habit_checkins WHERE habit_id=$1 AND day=$2`, [p.id, p.day]);
    if (p.created) await ctx.db.query(`UPDATE habits SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return p.created ? "Taken back, and I've stopped counting it." : "Check-in taken back.";
  },
});

/** One short plain clause about the rest day or a freeze, or nothing. */
export function streakNote(s: Streak): string {
  if (s.frozeYesterday) return ` Yesterday used a streak freeze, so the run holds${s.freezes ? `, and you have ${s.freezes} left` : ""}.`;
  if (s.restYesterday) return " Yesterday was a rest day; one a week keeps the run going.";
  if (s.earnedToday) return ` You've earned a streak freeze${s.freezes > 1 ? ` (${s.freezes} banked)` : ""}, so a missed day won't break the run.`;
  return "";
}

async function repairedDays(db: Db, habitId: number): Promise<string[]> {
  const r = await db.one<{ repaired_days: string[] | null }>(`SELECT repaired_days FROM habits WHERE id=$1`, [habitId]);
  return r?.repaired_days ?? [];
}
const checkinDays = async (db: Db, habitId: number, upTo: string) =>
  (await db.query<{ day: string }>(`SELECT to_char(day, 'YYYY-MM-DD') AS day FROM habit_checkins WHERE habit_id=$1 AND day <= $2::date ORDER BY day DESC LIMIT 800`, [habitId, upTo])).map((r) => r.day);

/** A repair already used in the last 30 days (one a month per habit). Returns that day, or null. */
export function repairUsed(repaired: string[], today: string): string | null {
  return repaired.filter((d) => gap(d, today) < 30 && d <= today).sort().pop() ?? null;
}

/**
 * The missed day a repair would fill: the day that broke the run, when it was yesterday or the day before
 * (within 48 hours), and only if filling it really brings the run back.
 */
export function repairable(days: string[], repaired: string[], today: string): string | null {
  const s = streakOf(days, today, repaired);
  if (!s.brokeOn || gap(s.brokeOn, today) > 2) return null;
  const before = streakOf(days, step(s.brokeOn, -1), repaired).run; // the run that was going until the break
  const after = streakOf(days, today, [...repaired, s.brokeOn]);
  return after.run > before ? s.brokeOn : null;
}

const dayName = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });

const habitRepair = defineAction({
  name: "habit.repair",
  tier: 1,
  description: "Repair a habit streak: fill in the one missed day that broke it, within 48 hours of that day, at most once per 30 days per habit. 'name' is the habit (optional when only one fits). With did_yesterday true (\"I did it yesterday\"), log yesterday as a real check-in instead.",
  schema: z.object({ name: z.string().max(80).optional(), did_yesterday: z.boolean().optional() }),
  async run(args, ctx) {
    const today = localDay(ctx.now, ctx.user.tz), yesterday = step(today, -1);
    const habits = await ctx.db.query<{ id: number; name: string }>(
      `SELECT id, name FROM habits WHERE user_id=$1 AND active ${args.name ? "AND name ILIKE $2" : ""} ORDER BY name`, args.name ? [ctx.user.id, `%${args.name.trim()}%`] : [ctx.user.id]);
    if (!habits.length) return { reply: args.name ? `I'm not keeping a streak for "${args.name}". Say "my habits" to see the ones I am.` : "There's no streak to repair yet. Say \"track reading\" and then \"did reading\" whenever you do it." };
    const info = await Promise.all(habits.map(async (h) => { const days = await checkinDays(ctx.db, h.id, today); const repaired = await repairedDays(ctx.db, h.id); return { ...h, days, repaired, s: streakOf(days, today, repaired) }; }));
    const which = (list: { name: string }[]) => `Which one: ${list.map((h) => h.name).join(", ")}? Say "repair my ${list[0].name} streak".`;

    if (args.did_yesterday) {
      // They did it: a real check-in for yesterday, not a repair, so the monthly repair stays free.
      const open = info.filter((h) => !h.days.includes(yesterday) && h.days.some((d) => gap(d, today) <= 8));
      if (!open.length) return { reply: info.some((h) => h.days.includes(yesterday)) ? "Yesterday's already logged." : "Which habit was it? Say it like \"did reading yesterday\"." };
      if (open.length > 1) return { reply: `Which habit was it? Say it like "did ${open[0].name} yesterday".` };
      const h = open[0];
      await ctx.db.query(`INSERT INTO habit_checkins (habit_id, day) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [h.id, yesterday]);
      const s = streakOf([...h.days, yesterday], today, h.repaired);
      return { reply: `${h.name}, logged for yesterday. ${s.run > 1 ? `That's ${s.run} days running.` : "It counts."}`, undo: { payload: { id: h.id, checkin: yesterday } } };
    }

    const fixable = info.filter((h) => repairable(h.days, h.repaired, today));
    if (!fixable.length) {
      const h = info.length === 1 ? info[0] : null;
      if (h?.s.brokeOn && h.s.run === 0 && gap(h.s.brokeOn, today) > 2) return { reply: `A repair works within two days of a missed day, and this one was ${dayName(h.s.brokeOn)}. Your best run of ${h.s.best} days still counts, and a new one starts whenever you log.` };
      if (h?.s.brokeOn && gap(h.s.brokeOn, today) <= 2) return { reply: `That gap is more than one day, so a repair won't bridge it. Your best run of ${h.s.best} days still counts.` };
      return { reply: h ? `Nothing to repair. ${h.s.run ? `Your ${h.name} run is going: ${h.s.run} days.` : `Say "did ${h.name}" whenever you do it.`}` : "Nothing to repair. Your streaks are fine." };
    }
    if (fixable.length > 1) return { reply: which(fixable) };
    const h = fixable[0];
    const used = repairUsed(h.repaired, today);
    if (used) return { reply: `You've used this month's repair for ${h.name} (${dayName(used)}). Your best run of ${h.s.best} days still counts, and a new one starts with your next log.` };
    const day = repairable(h.days, h.repaired, today)!;
    await ctx.db.query(`UPDATE habits SET repaired_days = array_append(repaired_days, $2) WHERE id=$1`, [h.id, day]);
    const s = streakOf(h.days, today, [...h.repaired, day]);
    return { reply: `Done. ${dayName(day)} counts for ${h.name} now, so the run holds at ${s.run} ${s.run === 1 ? "day" : "days"}. One repair a month per habit.`, undo: { payload: { id: h.id, repaired: day } } };
  },
  async undo(p, ctx) {
    const own = await ctx.db.one(`SELECT 1 FROM habits WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    if (!own) return "Nothing to take back.";
    if (p.checkin) await ctx.db.query(`DELETE FROM habit_checkins WHERE habit_id=$1 AND day=$2`, [p.id, p.checkin]);
    if (p.repaired) await ctx.db.query(`UPDATE habits SET repaired_days = array_remove(repaired_days, $2) WHERE id=$1`, [p.id, p.repaired]);
    return "Taken back.";
  },
});

const habitList = defineAction({
  name: "habit.list",
  tier: 1,
  description: "Show habits with this week's progress.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ name: string; target_per_week: number; n: string }>(
      `SELECT h.name, h.target_per_week, (SELECT count(*) FROM habit_checkins c WHERE c.habit_id=h.id AND c.day >= $2::date - 6)::text AS n
       FROM habits h WHERE h.user_id=$1 AND h.active ORDER BY h.name`,
      [ctx.user.id, localDay(ctx.now, ctx.user.tz)],
    );
    if (!rows.length) return { reply: "Nothing tracked yet. Say \"track gym\" and then \"did gym\" whenever you go." };
    const head = rows.length === 1 ? "One habit this week." : `${rows.length} habits this week.`;
    return { reply: [head, ...rows.map((r) => `${r.name}: ${r.n} of ${r.target_per_week}`)].join("\n") };
  },
});

const spendLog = defineAction({
  name: "spend.log",
  tier: 1,
  description: "Log a spend from chat ('spent 20 dollars on lunch'). Currency as an ISO code (USD, EUR, GBP, NGN, KES, INR...); leave it out when the person didn't say one and their own currency is used. Category free text: food, transport, data, rent, fun, other.",
  schema: z.object({ amount: z.number().positive(), currency: z.string().min(3).max(3).optional(), category: z.string().optional(), note: z.string().optional() }),
  async run(args, ctx) {
    const cur = (args.currency ?? userCurrency(ctx.user)).toUpperCase();
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO spend (user_id, amount, currency, category, note) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.user.id, args.amount, cur, args.category ?? "other", args.note ?? null]);
    return { reply: `${money(args.amount, cur)} on ${args.category ?? "other"}, logged. Ask "how much did I spend this week" any time.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM spend WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Spend taken off the log.";
  },
});

const spendSummary = defineAction({
  name: "spend.summary",
  tier: 1,
  description: "Spend summary by category for 'week' or 'month'.",
  schema: z.object({ range: z.enum(["week", "month"]).optional() }),
  async run(args, ctx) {
    const days = args.range === "month" ? 30 : 7;
    const rows = await ctx.db.query<{ currency: string; category: string; total: string }>(
      `SELECT currency, category, sum(amount)::text AS total FROM spend WHERE user_id=$1 AND spent_at > now() - ($2 || ' days')::interval GROUP BY currency, category ORDER BY currency, sum(amount) DESC`,
      [ctx.user.id, String(days)],
    );
    const label = args.range === "month" ? "this month" : "this week";
    if (!rows.length) return { reply: `Nothing logged ${label}. Say "I spent 20 on lunch" and I'll keep count.` };
    const byCur = new Map<string, number>();
    for (const r of rows) byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + Number(r.total));
    const head = `${[...byCur].map(([c, t]) => `${t.toLocaleString()} ${c}`).join(" and ")} ${label}.`;
    return { reply: [head, ...rows.map((r) => `${r.category}: ${Number(r.total).toLocaleString()} ${r.currency}`)].join("\n") };
  },
});

const noteAdd = defineAction({
  name: "note.add",
  tier: 1,
  description: "Save a quick note. Tags optional.",
  schema: z.object({ text: z.string().min(1), tags: z.array(z.string()).optional() }),
  async run(args, ctx) {
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO notes (user_id, text, tags) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, args.text, args.tags ?? []]);
    return { reply: `Kept. Ask "notes about ${args.tags?.[0] ?? args.text.split(/\s+/).slice(0, 2).join(" ")}" to find it again.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM notes WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Note dropped.";
  },
});

const noteSearch = defineAction({
  name: "note.search",
  tier: 1,
  description: "Search saved notes by text or tag.",
  schema: z.object({ query: z.string().min(1) }),
  async run(args, ctx) {
    const rows = await ctx.db.query<{ id: number; text: string; created_at: string }>(`SELECT id, text, created_at FROM notes WHERE user_id=$1 AND (text ILIKE $2 OR $3 = ANY(tags)) ORDER BY id DESC LIMIT 10`, [ctx.user.id, `%${args.query}%`, args.query]);
    if (!rows.length) return { reply: `No notes mention "${args.query}".` };
    return { reply: [rows.length === 1 ? "One note." : `${rows.length} notes.`, ...rows.map((r) => r.text)].join("\n") };
  },
});

/**
 * Memory with provenance. Facts the user states are stored unconfirmed and
 * shown back in the weekly review; the intent layer only ever reads confirmed
 * facts, which is what keeps a poisoned memory from steering a later action.
 */
const remember = defineAction({
  name: "memory.remember",
  tier: 1,
  description: "Remember a durable fact about the user ('I'm vegetarian', 'my sister is Ada', 'I work at X'). Not for tasks or dates — those are reminders/events.",
  schema: z.object({ fact: z.string().min(1).max(300) }),
  async run(args, ctx) {
    const risk = /\b(from now on|always|never|send|pay|transfer|wallet|password|key)\b/i.test(args.fact) ? 2 : 0;
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO memories (user_id, fact, source, confirmed, risk) VALUES ($1,$2,'user',$3,$4) RETURNING id`, [ctx.user.id, args.fact, risk === 0, risk]);
    return { reply: risk ? `Kept, but held back. That one touches money or standing instructions, so I'll ask you to confirm it on Sunday before it changes anything.` : `Got it: ${yours(args.fact)}. I'll keep that in mind.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM memories WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Forgotten.";
  },
});

const forget = defineAction({
  name: "memory.forget",
  tier: 1,
  description: "Forget a remembered fact by text match.",
  schema: z.object({ match: z.string().min(1) }),
  async run(args, ctx) {
    const r = await ctx.db.query(`DELETE FROM memories WHERE user_id=$1 AND fact ILIKE $2 RETURNING fact`, [ctx.user.id, `%${args.match}%`]);
    return { reply: r.length ? (r.length === 1 ? `Forgotten: ${r[0].fact}` : `Forgotten, all ${r.length} of them.`) : `Nothing I remember mentions "${args.match}".` };
  },
});

const memList = defineAction({
  name: "memory.list",
  tier: 1,
  description: "Show everything remembered about the user, marking unconfirmed facts.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ fact: string; confirmed: boolean }>(`SELECT fact, confirmed FROM memories WHERE user_id=$1 ORDER BY id`, [ctx.user.id]);
    if (!rows.length) return { reply: "Nothing yet. Say \"remember that I'm vegetarian\" and I'll keep it." };
    const sure = rows.filter((r) => r.confirmed), held = rows.filter((r) => !r.confirmed);
    const lines = [`${rows.length === 1 ? "One thing" : `${rows.length} things`} I know about you.`, ...sure.map((r) => r.fact)];
    if (held.length) lines.push("", "Waiting on your yes before I use them:", ...held.map((r) => r.fact));
    lines.push("", "Say \"forget X\" to drop one.");
    return { reply: lines.join("\n") };
  },
});

export async function confirmedMemories(db: any, userId: number): Promise<string[]> {
  const rows = await db.query(`SELECT fact FROM memories WHERE user_id=$1 AND confirmed ORDER BY id DESC LIMIT 30`, [userId]);
  return rows.map((r: any) => r.fact);
}

register(habitAdd, habitCheck, habitList, habitRepair, spendLog, spendSummary, noteAdd, noteSearch, remember, forget, memList);
addRules(
  [/^(?:please\s+)?(?:repair|fix|save|restore|mend)\s+(?:my\s+|the\s+)?(?:(.{1,40}?)\s+)?streak$/i, (m) => ({ action: "habit.repair", args: m[1] && !/^(?:my|the|a)$/i.test(m[1]) ? { name: m[1] } : {} })],
  [/^i\s+(?:did|done)\s+(?:it|that)\s+yesterday(?:\s+(?:too|after all))?$/i, () => ({ action: "habit.repair", args: { did_yesterday: true } })],
);
addExamples("habit.repair", ["repair my streak", "repair my reading streak", "I did it yesterday"]);
addCues("habit", ["streak", "repair", "freeze", "streak freeze"]);
