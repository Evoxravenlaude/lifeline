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

/**
 * A kinder streak: a run of days, where one missed day a week is a rest day and doesn't break it.
 * `days` are ISO dates, newest first; `today` is the day just logged. Also the best run in that history.
 */
export function streakOf(days: string[], today: string): { run: number; best: number; restYesterday: boolean } {
  const have = new Set(days);
  const step = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const walk = (from: string) => {
    let cur = from, run = 0, lastRest: string | null = null, firstRest: string | null = null;
    for (let guard = 0; guard < 1000; guard++) {
      if (have.has(cur)) { run++; cur = step(cur, -1); continue; }
      const before = step(cur, -1);
      const restOk = have.has(before) && run > 0 && (!lastRest || Date.parse(lastRest) - Date.parse(cur) >= 7 * 86_400_000);
      if (!restOk) break;
      lastRest = cur; firstRest ??= cur; cur = before;
    }
    return { run, firstRest };
  };
  const now = walk(today);
  let best = now.run;
  for (const d of days) if (!have.has(step(d, 1)) && !have.has(step(d, 2))) best = Math.max(best, walk(d).run);
  return { run: now.run, best, restYesterday: now.firstRest === step(today, -1) };
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
    const s = streakOf(days, day);
    const n = s.run;
    const said = first ? "I'll count it from here; say \"did " + h.name + "\" each time and I keep the streak."
      : n === 1 ? (s.best > 2 ? `Day one again. Your best run is ${s.best} days, and every one of them still counts.` : "Day one.")
      : `That's ${n} days running.${s.restYesterday ? " Yesterday was a rest day; one a week keeps the run going." : ""}`;
    const milestone = !first && [7, 30, 100, 365].includes(n);
    return { reply: `${h.name}, logged. ${said}`, ...(milestone ? { sticker: "cheers", celebrate: true } : {}), undo: { payload: { id: h.id, day, created: first } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM habit_checkins WHERE habit_id=$1 AND day=$2`, [p.id, p.day]);
    if (p.created) await ctx.db.query(`UPDATE habits SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return p.created ? "Taken back, and I've stopped counting it." : "Check-in taken back.";
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

register(habitAdd, habitCheck, habitList, spendLog, spendSummary, noteAdd, noteSearch, remember, forget, memList);
