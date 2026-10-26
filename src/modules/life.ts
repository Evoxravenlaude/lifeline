/** Habits, spend log, quick notes, memory with provenance. */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { localDay } from "../core/time.js";

const habitAdd = defineAction({
  name: "habit.add",
  tier: 1,
  description: "Track a habit (gym, reading, water). `target_per_week` defaults to 7.",
  schema: z.object({ name: z.string().min(1).max(80), target_per_week: z.number().int().min(1).max(7).optional() }),
  async run(args, ctx) {
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO habits (user_id, name, target_per_week) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, args.name, args.target_per_week ?? 7]);
    return { reply: `Tracking "${args.name}" (${args.target_per_week ?? 7}×/week). Say "did ${args.name}" to check in.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE habits SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Habit removed.";
  },
});

const habitCheck = defineAction({
  name: "habit.checkin",
  tier: 1,
  description: "Check in a habit for today (or 'yesterday'). Matches by name.",
  schema: z.object({ name: z.string().min(1), day: z.enum(["today", "yesterday"]).optional() }),
  async run(args, ctx) {
    const h = await ctx.db.one<{ id: number; name: string }>(`SELECT id, name FROM habits WHERE user_id=$1 AND active AND name ILIKE $2 LIMIT 1`, [ctx.user.id, `%${args.name}%`]);
    if (!h) return { reply: `No habit matching "${args.name}". Add it with "track habit ${args.name}".` };
    const day = localDay(args.day === "yesterday" ? new Date(ctx.now.getTime() - 86_400_000) : ctx.now, ctx.user.tz);
    await ctx.db.query(`INSERT INTO habit_checkins (habit_id, day) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [h.id, day]);
    const streak = await ctx.db.one<{ n: string }>(
      `WITH d AS (SELECT day FROM habit_checkins WHERE habit_id=$1 ORDER BY day DESC)
       SELECT count(*)::text AS n FROM (SELECT day, row_number() OVER (ORDER BY day DESC) AS rn FROM d) x WHERE day = $2::date - (rn-1)::int`,
      [h.id, day],
    );
    return { reply: `${h.name} ✅ (${streak?.n ?? 1}-day streak)`, undo: { payload: { id: h.id, day } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM habit_checkins WHERE habit_id=$1 AND day=$2`, [p.id, p.day]);
    return "Check-in removed.";
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
    if (!rows.length) return { reply: "No habits tracked." };
    return { reply: rows.map((r) => `${r.name}: ${r.n}/${r.target_per_week} this week`).join("\n") };
  },
});

const spendLog = defineAction({
  name: "spend.log",
  tier: 1,
  description: "Log a spend from chat ('spent 4500 naira on data'). Currency as ISO code (NGN, USD, XAF, GBP). Category free text: food, transport, data, rent, fun, other.",
  schema: z.object({ amount: z.number().positive(), currency: z.string().min(3).max(3), category: z.string().optional(), note: z.string().optional() }),
  async run(args, ctx) {
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO spend (user_id, amount, currency, category, note) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.user.id, args.amount, args.currency.toUpperCase(), args.category ?? "other", args.note ?? null]);
    return { reply: `Logged ${args.amount} ${args.currency.toUpperCase()} (${args.category ?? "other"}).`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM spend WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Spend entry removed.";
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
    if (!rows.length) return { reply: `Nothing logged in the last ${days} days.` };
    return { reply: rows.map((r) => `${r.category}: ${Number(r.total).toLocaleString()} ${r.currency}`).join("\n") };
  },
});

const noteAdd = defineAction({
  name: "note.add",
  tier: 1,
  description: "Save a quick note. Tags optional.",
  schema: z.object({ text: z.string().min(1), tags: z.array(z.string()).optional() }),
  async run(args, ctx) {
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO notes (user_id, text, tags) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, args.text, args.tags ?? []]);
    return { reply: `Noted (#${r!.id}).`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM notes WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Note deleted.";
  },
});

const noteSearch = defineAction({
  name: "note.search",
  tier: 1,
  description: "Search saved notes by text or tag.",
  schema: z.object({ query: z.string().min(1) }),
  async run(args, ctx) {
    const rows = await ctx.db.query<{ id: number; text: string; created_at: string }>(`SELECT id, text, created_at FROM notes WHERE user_id=$1 AND (text ILIKE $2 OR $3 = ANY(tags)) ORDER BY id DESC LIMIT 10`, [ctx.user.id, `%${args.query}%`, args.query]);
    return { reply: rows.length ? rows.map((r) => `#${r.id} ${r.text}`).join("\n") : "No matching notes." };
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
    return { reply: risk ? `Noted, but I'll ask you to confirm that one in the weekly memory review before it affects anything.` : `Got it: ${args.fact}`, undo: { payload: { id: r!.id } } };
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
    return { reply: r.length ? `Forgot ${r.length} fact${r.length === 1 ? "" : "s"}.` : "Nothing matched." };
  },
});

const memList = defineAction({
  name: "memory.list",
  tier: 1,
  description: "Show everything remembered about the user, marking unconfirmed facts.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ fact: string; confirmed: boolean }>(`SELECT fact, confirmed FROM memories WHERE user_id=$1 ORDER BY id`, [ctx.user.id]);
    return { reply: rows.length ? rows.map((r) => `${r.confirmed ? "•" : "○"} ${r.fact}`).join("\n") + "\n\n○ = not yet confirmed. Say \"forget X\" to drop one." : "I don't remember anything about you yet." };
  },
});

export async function confirmedMemories(db: any, userId: number): Promise<string[]> {
  const rows = await db.query(`SELECT fact FROM memories WHERE user_id=$1 AND confirmed ORDER BY id DESC LIMIT 30`, [userId]);
  return rows.map((r: any) => r.fact);
}

register(habitAdd, habitCheck, habitList, spendLog, spendSummary, noteAdd, noteSearch, remember, forget, memList);
