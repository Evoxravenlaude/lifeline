/**
 * Spending with a pause button, and a way out of debt. The cool-off parks an impulse buy for a while
 * and asks again gently, with this week's spending for context. The debt planner is arithmetic:
 * snowball and avalanche orders and how long each takes at what the person can afford.
 */
import { z } from "zod";
import { defineAction, type Ctx, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import { onJob, push, schedule } from "../../../core/scheduler.js";
import { human } from "../../../core/time.js";
import { propose } from "../../../policy/engine.js";
import type { Db } from "../../../core/db.js";
import {
  AMT, STOP_LINE, addBrief, addMoneyButton, amt, byName, cap, clean, fmt, markPinged, muted, normCur, plural, re, runFromButton, setPrefs, todayOf, totals, wasPinged,
} from "./common.js";

addSchema(`CREATE TABLE IF NOT EXISTS money_wants (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), item TEXT NOT NULL, amount NUMERIC NOT NULL, currency TEXT NOT NULL, park_until TIMESTAMPTZ NOT NULL, status TEXT NOT NULL DEFAULT 'parked', job_id INT, decided_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS money_debts (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT NOT NULL, balance NUMERIC NOT NULL, currency TEXT NOT NULL, rate NUMERIC NOT NULL DEFAULT 0, rate_period TEXT NOT NULL DEFAULT 'year', minimum NUMERIC, closed_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`);

/* ================= impulse cool-off ================= */

interface Want { id: number; item: string; amount: string; currency: string; park_until: string; status: string; job_id: number | null }
const them = (item: string) => (/s$/i.test(item) && !/ss$/i.test(item) ? "them" : "it");
const openWants = (db: Db, user: User) => db.query<Want>(`SELECT id, item, amount::text, currency, park_until, status, job_id FROM money_wants WHERE user_id=$1 AND status IN ('parked','asked') ORDER BY park_until`, [user.id]);
async function savedByWaiting(db: Db, user: User): Promise<string | null> {
  const rows = await db.query<{ amount: string; currency: string }>(`SELECT sum(amount)::text AS amount, currency FROM money_wants WHERE user_id=$1 AND status='skipped' GROUP BY currency`, [user.id]);
  return rows.length ? totals(rows) : null;
}
async function weekSpend(db: Db, user: User, now: Date): Promise<string | null> {
  const rows = await db.query<{ amount: string; currency: string }>(`SELECT sum(amount)::text AS amount, currency FROM spend WHERE user_id=$1 AND spent_at > $2::timestamptz - interval '7 days' GROUP BY currency ORDER BY sum(amount) DESC`, [user.id, now]);
  return rows.length ? totals(rows) : null;
}
/** "a week", "3 days", "48 hours" → hours, between an hour and a month. */
function hoursIn(text?: string): number | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  const n = Number(/(\d+)/.exec(t)?.[1] ?? (/\btwo\b/.test(t) ? 2 : /\bthree\b/.test(t) ? 3 : 1));
  const h = /week/.test(t) ? n * 168 : /month/.test(t) ? n * 720 : /day/.test(t) ? n * 24 : /hour/.test(t) ? n : undefined;
  return h ? Math.min(720, Math.max(1, h)) : undefined;
}

const park = defineAction({
  name: "cooloff.park",
  tier: 1,
  description: "Park an impulse buy for a cool-off ('I want to buy AirPods for 249'): 'item', 'amount', and 'hours' (default 48; a week is 168). I ask again gently afterwards, with this week's spending for context.",
  schema: z.object({ item: z.string().min(1).max(80), amount: z.number().positive(), currency: z.string().max(8).optional(), hours: z.number().int().min(1).max(720).optional() }),
  async run(args, ctx) {
    const cur = normCur(args.currency, ctx.user);
    const item = clean(args.item);
    const hours = args.hours ?? 48;
    const until = new Date(ctx.now.getTime() + hours * 3_600_000);
    const r = (await ctx.db.one<{ id: number }>(`INSERT INTO money_wants (user_id, item, amount, currency, park_until) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.user.id, item, args.amount, cur, until]))!;
    const job = await schedule(ctx.db, { userId: ctx.user.id, kind: "money_cooloff", runAt: until, payload: { id: r.id } });
    await ctx.db.query(`UPDATE money_wants SET job_id=$2 WHERE id=$1`, [r.id, job]);
    const it = them(item);
    return { reply: `${cap(item)}, ${fmt(args.amount, cur)}, parked until ${human(until, ctx.user.tz, ctx.now)}. I'll ask you again then; if you still want ${it}, ${it === "them" ? "they'll" : "it'll"} still be there.`, undo: { payload: { id: r.id, job } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM money_wants WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    await ctx.db.query(`UPDATE jobs SET active=false WHERE id=$1 AND user_id=$2`, [p.job, ctx.user.id]);
    return "Unparked.";
  },
});

const decide = defineAction({
  name: "cooloff.decide",
  tier: 1,
  description: "After (or during) a cool-off, the person decides on a parked buy: 'decision' buy (still want it) or skip. Skipped amounts add up in a quiet 'saved by waiting' total. 'item' picks which one; otherwise the most recent.",
  schema: z.object({ decision: z.enum(["buy", "skip"]), item: z.string().optional() }),
  async run(args, ctx) {
    const rows = await openWants(ctx.db, ctx.user);
    const ready = rows.filter((w) => new Date(w.park_until) <= ctx.now);
    const w = (args.item ? byName(rows, "item", args.item) : undefined) ?? ready[ready.length - 1] ?? rows[rows.length - 1];
    if (!w) return { reply: `Nothing's parked right now. Say "I want to buy AirPods for 249" and I'll hold it for 48 hours first.` };
    await ctx.db.query(`UPDATE money_wants SET status=$2, decided_at=$3 WHERE id=$1`, [w.id, args.decision === "buy" ? "bought" : "skipped", ctx.now]);
    if (w.job_id) await ctx.db.query(`UPDATE jobs SET active=false WHERE id=$1`, [w.job_id]);
    const undo = { payload: { id: w.id, status: w.status, job: w.job_id, until: w.park_until } };
    if (args.decision === "buy") return { reply: `Then it's a considered buy. Enjoy the ${w.item}.`, buttons: [{ label: "Log the spend", data: `mn:cool:log:${w.id}` }], undo };
    const saved = await savedByWaiting(ctx.db, ctx.user);
    return { reply: `Skipped. That's ${fmt(w.amount, w.currency)} not spent${saved ? `; ${saved} saved by waiting so far` : ""}.`, undo };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE money_wants SET status=$2, decided_at=NULL WHERE id=$1 AND user_id=$3`, [p.id, p.status, ctx.user.id]);
    if (p.job && new Date(p.until) > ctx.now) await ctx.db.query(`UPDATE jobs SET active=true WHERE id=$1 AND user_id=$2`, [p.job, ctx.user.id]);
    return "Back in the cool-off.";
  },
});

const wishlist = defineAction({
  name: "cooloff.list",
  tier: 1,
  description: "Show what the person has parked in the cool-off, when each is up, and the 'saved by waiting' total.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await openWants(ctx.db, ctx.user);
    const saved = await savedByWaiting(ctx.db, ctx.user);
    if (!rows.length) return { reply: `Nothing parked.${saved ? ` ${saved} saved by waiting so far.` : ""} Say "I want to buy AirPods for 249" to cool off on something first.` };
    const lines = rows.map((w) => `- ${cap(w.item)}, ${fmt(w.amount, w.currency)}: ${new Date(w.park_until) <= ctx.now ? "ready to decide" : `until ${human(w.park_until, ctx.user.tz, ctx.now)}`}`);
    return { reply: [`${plural(rows.length, "thing")} cooling off:`, ...lines, ...(saved ? ["", `${saved} saved by waiting so far.`] : [])].join("\n") };
  },
});

addMoneyButton("cool", async (ctx, [what, id]) => {
  const w = await ctx.db.one<Want>(`SELECT id, item, amount::text, currency, park_until, status, job_id FROM money_wants WHERE id=$1 AND user_id=$2`, [Number(id), ctx.user.id]);
  if (!w) return { text: "That one's gone from the cool-off." };
  if (what === "log") return runFromButton(ctx, "spend.log", { amount: Number(w.amount), currency: w.currency, category: "shopping", note: w.item });
  if (!["parked", "asked"].includes(w.status)) return { text: `You've already decided on the ${w.item}.` };
  return runFromButton(ctx, "cooloff.decide", { decision: what === "buy" ? "buy" : "skip", item: w.item });
});

onJob("money_cooloff", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const w = await deps.db.one<Want & { created_at: string }>(`SELECT id, item, amount::text, currency, park_until, status, job_id, created_at FROM money_wants WHERE id=$1 AND user_id=$2`, [job.payload?.id, user.id]);
  if (!w || w.status !== "parked") return;
  const now = new Date();
  const today = todayOf(user, now);
  // One cool-off question a day; the rest wait for the brief.
  if (muted(user).includes("cooloff") || muted(user).includes("all") || (await wasPinged(deps.db, user, `cooloff:day:${today}`))) return;
  const days = Math.round((now.getTime() - new Date(w.created_at).getTime()) / 86_400_000);
  const ago = days <= 1 ? "Yesterday" : days === 2 ? "Two days ago" : days < 7 ? `${days} days ago` : days < 14 ? "A week ago" : `${Math.round(days / 7)} weeks ago`;
  const spent = await weekSpend(deps.db, user, now);
  const it = them(w.item);
  const text = `${ago} you wanted the ${w.item} for ${fmt(w.amount, w.currency)}.${spent ? ` This week you've spent ${spent} so far.` : ""} Still want ${it}?\n\n${STOP_LINE.replace("money pings", "cool-off pings")}`;
  const ok = await push(deps, user, "money", text, { buttons: [{ label: `Still want ${it}`, data: `mn:cool:buy:${w.id}` }, { label: "Skip it", data: `mn:cool:skip:${w.id}` }], now });
  if (ok) {
    await deps.db.query(`UPDATE money_wants SET status='asked' WHERE id=$1`, [w.id]);
    await markPinged(deps.db, user, [`cooloff:day:${today}`]);
  }
});

addBrief("money", async (db, user, _today, now) => {
  const ready = (await openWants(db, user)).filter((w) => new Date(w.park_until) <= now && now.getTime() - new Date(w.park_until).getTime() < 4 * 86_400_000);
  if (!ready.length) return [];
  const w = ready[0];
  return [{ p: 28, text: `Your cool-off on the ${w.item} (${fmt(w.amount, w.currency)}) is over. Still want ${them(w.item)}? Say "still want it" or "skip it".` }];
});

/* ================= debt payoff planner ================= */

interface Debt { id: number; name: string; balance: string; currency: string; rate: string; rate_period: string; minimum: string | null }
const openDebts = (db: Db, user: User) => db.query<Debt>(`SELECT id, name, balance::text, currency, rate::text, rate_period, minimum::text FROM money_debts WHERE user_id=$1 AND closed_at IS NULL ORDER BY id`, [user.id]);
const monthlyRate = (d: Debt) => (d.rate_period === "month" ? Number(d.rate) / 100 : Number(d.rate) / 1200);
const yearlyRate = (d: Debt) => Math.round((d.rate_period === "month" ? Number(d.rate) * 12 : Number(d.rate)) * 10) / 10;
/** When no minimum is known: the interest plus 1% of the balance, or 3%, whichever is more. */
const minOf = (d: Debt) => (d.minimum ? Number(d.minimum) : Math.ceil(Number(d.balance) * Math.max(0.03, monthlyRate(d) + 0.01)));

/** Months to clear every debt at `budget` a month, paying minimums and putting the rest on the first in `order`. */
export function simulate(debts: Debt[], order: number[], budget: number): { months: number; interest: number } {
  const bal = new Map(debts.map((d) => [d.id, Number(d.balance)]));
  let interest = 0;
  for (let m = 1; m <= 600; m++) {
    let left = budget;
    for (const d of debts) {
      const b = bal.get(d.id)!;
      if (b <= 0) continue;
      const i = b * monthlyRate(d);
      interest += i;
      bal.set(d.id, b + i);
    }
    for (const d of debts) {
      const b = bal.get(d.id)!;
      if (b <= 0) continue;
      const pay = Math.min(b, minOf(d), left);
      bal.set(d.id, b - pay);
      left -= pay;
    }
    for (const id of order) {
      if (left <= 0) break;
      const b = bal.get(id)!;
      if (b <= 0) continue;
      const pay = Math.min(b, left);
      bal.set(id, b - pay);
      left -= pay;
    }
    if ([...bal.values()].every((b) => b <= 0.005)) return { months: m, interest };
  }
  return { months: Infinity, interest };
}
const yrs = (m: number) => (m <= 18 ? plural(m, "month") : `${Math.floor(m / 12)} years${m % 12 ? ` and ${plural(m % 12, "month")}` : ""}`);

const debtAdd = defineAction({
  name: "debt.add",
  tier: 1,
  description: "Add a debt to the payoff planner (or update one by name): 'name', 'balance', interest 'rate' in percent with 'rate_period' year (APR, the default) or month (common for loan apps), and the monthly 'minimum' payment.",
  schema: z.object({ name: z.string().min(1).max(60), balance: z.number().positive(), currency: z.string().max(8).optional(), rate: z.number().min(0).max(1000), rate_period: z.enum(["year", "month"]).optional(), minimum: z.number().positive().optional() }),
  async run(args, ctx) {
    const name = clean(args.name).toLowerCase();
    const cur = normCur(args.currency, ctx.user);
    const period = args.rate_period ?? "year";
    const prev = byName(await openDebts(ctx.db, ctx.user), "name", name);
    let id: number;
    if (prev && prev.name === name) {
      id = prev.id;
      await ctx.db.query(`UPDATE money_debts SET balance=$2, currency=$3, rate=$4, rate_period=$5, minimum=COALESCE($6,minimum) WHERE id=$1`, [id, args.balance, cur, args.rate, period, args.minimum ?? null]);
    } else id = (await ctx.db.one<{ id: number }>(`INSERT INTO money_debts (user_id, name, balance, currency, rate, rate_period, minimum) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.user.id, name, args.balance, cur, args.rate, period, args.minimum ?? null]))!.id;
    const yearly = period === "month" ? ` That's about ${Math.round(args.rate * 12)}% a year, the dearest kind of borrowing.` : "";
    const min = args.minimum ? `, minimum ${fmt(args.minimum, cur)} a month` : "";
    const guess = minOf({ id, name, balance: String(args.balance), currency: cur, rate: String(args.rate), rate_period: period, minimum: null });
    const ask = args.minimum ? "" : ` Tell me the minimum payment for a sharper plan, like "debt: ${name} ${args.balance} at ${args.rate}%${period === "month" ? " monthly" : ""}, minimum ${guess}".`;
    return { reply: `${cap(name)}, ${fmt(args.balance, cur)} at ${args.rate}% a ${period}${min}.${yearly} Say "my debt plan" to see the ways out.${ask}`, undo: { payload: { id, prev: prev && prev.name === name ? prev : null } } };
  },
  async undo(p, ctx) {
    if (p.prev) await ctx.db.query(`UPDATE money_debts SET balance=$2, currency=$3, rate=$4, rate_period=$5, minimum=$6 WHERE id=$1 AND user_id=$7`, [p.id, p.prev.balance, p.prev.currency, p.prev.rate, p.prev.rate_period, p.prev.minimum, ctx.user.id]);
    else await ctx.db.query(`DELETE FROM money_debts WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Taken back.";
  },
});

const debtBudget = defineAction({
  name: "debt.budget",
  tier: 1,
  description: "Set how much the person can put toward all their debts each month; the debt plan works out how long each order takes at that amount.",
  schema: z.object({ amount: z.number().positive(), currency: z.string().max(8).optional() }),
  async run(args, ctx) {
    const prev = ctx.user.prefs.moneyDebtBudget ?? null;
    const cur = normCur(args.currency, ctx.user);
    await setPrefs(ctx, { moneyDebtBudget: { amount: args.amount, currency: cur } });
    return { reply: `${fmt(args.amount, cur)} a month toward your debts. Say "my debt plan" to see how long each way takes.`, undo: { payload: { prev } } };
  },
  async undo(p, ctx) { await setPrefs(ctx, { moneyDebtBudget: p.prev }); return "Taken back."; },
});

const debtPlan = defineAction({
  name: "debt.plan",
  tier: 1,
  description: "The person's debt payoff plan: snowball (smallest balance first) and avalanche (highest interest first) orders, with months to clear and interest paid at their monthly debt budget. Arithmetic, not financial advice.",
  schema: z.object({ amount: z.number().positive().optional() }),
  async run(args, ctx) {
    const all = await openDebts(ctx.db, ctx.user);
    if (!all.length) return { reply: `No debts in the planner. Add one like "debt: credit card 2400 at 24%, minimum 60" or "loan app 300 at 10% monthly".` };
    const b = ctx.user.prefs.moneyDebtBudget as { amount: number; currency: string } | undefined;
    const cur = b?.currency && all.some((d) => d.currency === b.currency) ? b.currency : all[0].currency;
    const debts = all.filter((d) => d.currency === cur);
    const others = all.filter((d) => d.currency !== cur);
    const budget = args.amount ?? (b?.currency === cur ? b.amount : undefined);
    const mins = debts.reduce((s, d) => s + minOf(d), 0);
    const snow = [...debts].sort((x, y) => Number(x.balance) - Number(y.balance));
    const aval = [...debts].sort((x, y) => monthlyRate(y) - monthlyRate(x) || Number(x.balance) - Number(y.balance));
    const names = (ds: Debt[]) => ds.map((d) => d.name).join(", then ");
    const lines = [`${totals(debts.map((d) => ({ amount: d.balance, currency: d.currency })))} across ${plural(debts.length, "debt")}; minimums come to about ${fmt(mins, cur)} a month.`];
    if (debts.length === 1) {
      const d = debts[0];
      lines.push(`It's ${yearlyRate(d)}% a year.`);
    } else {
      lines.push("", `**Avalanche**, highest interest first: ${names(aval)}.`, `**Snowball**, smallest balance first: ${names(snow)}.`);
    }
    const example = Math.ceil((mins * 1.5) / 10 ** Math.max(0, String(Math.round(mins)).length - 2)) * 10 ** Math.max(0, String(Math.round(mins)).length - 2);
    if (budget === undefined) lines.push("", `Tell me what you can put toward ${debts.length === 1 ? "it" : "them"} each month, like "debt budget ${example}", and I'll work out how long ${debts.length === 1 ? "it takes" : "each way takes"}.`);
    else if (budget < mins) lines.push("", `${fmt(budget, cur)} a month is less than the minimums, so the balances would grow. Covering the minimums first keeps them steady; anything above that goes to the top of either list.`);
    else {
      const a = simulate(debts, aval.map((d) => d.id), budget), s = simulate(debts, snow.map((d) => d.id), budget);
      const say = (r: { months: number; interest: number }) => (Number.isFinite(r.months) ? `clear in ${yrs(r.months)}, about ${fmt(Math.round(r.interest), cur)} in interest` : "this wouldn't clear them; the interest outpaces it");
      lines.push("", debts.length === 1 ? `At ${fmt(budget, cur)} a month: ${say(a)}.` : `At ${fmt(budget, cur)} a month, avalanche: ${say(a)}. Snowball: ${say(s)}.`);
      if (debts.length > 1 && Number.isFinite(a.months) && Number.isFinite(s.months)) lines.push(Math.round(s.interest) - Math.round(a.interest) > 0 ? `Avalanche costs less; snowball gives you a win sooner. Either works if you stick with it.` : `Both cost about the same here, so pick whichever keeps you going.`);
    }
    if (others.length) lines.push("", `Also in other currencies: ${others.map((d) => `${d.name} ${fmt(d.balance, d.currency)}`).join(", ")}.`);
    lines.push("", "This is arithmetic, not financial advice.");
    return { reply: lines.join("\n") };
  },
});

const debtPay = defineAction({
  name: "debt.pay",
  tier: 1,
  description: "Record a payment off one of the person's debts ('paid 200 off the credit card'); celebrates gently when one is cleared. A name that's a person they owe settles that IOU instead.",
  schema: z.object({ name: z.string().min(1), amount: z.number().positive(), currency: z.string().max(8).optional() }),
  async run(args, ctx) {
    const all = await openDebts(ctx.db, ctx.user);
    const d = byName(all, "name", args.name);
    if (!d) {
      const iou = await ctx.db.one<{ who: string }>(`SELECT who FROM money_ious WHERE user_id=$1 AND direction='i_owe' AND settled_at IS NULL AND lower(who)=lower($2) LIMIT 1`, [ctx.user.id, clean(args.name)]);
      if (iou) {
        const r = await propose(ctx, "iou.settle", { who: iou.who, amount: args.amount, currency: args.currency, direction: "i_owe" });
        return { reply: r.kind === "ran" ? r.reply : "reply" in r ? r.reply : "Done.", buttons: r.kind === "ran" && r.undoId ? [{ label: "Undo", data: `undo:${r.undoId}` }] : undefined };
      }
      return { reply: `I don't have a debt called ${clean(args.name)}. Say "my debts" to see them, or add it like "debt: ${clean(args.name)} 2400 at 24%".` };
    }
    const bal = Math.max(0, Number(d.balance) - args.amount);
    await ctx.db.query(`UPDATE money_debts SET balance=$2, closed_at=$3 WHERE id=$1`, [d.id, bal, bal <= 0.005 ? ctx.now : null]);
    const undo = { payload: { id: d.id, balance: d.balance } };
    const rest = all.filter((x) => x.id !== d.id);
    if (bal <= 0.005) {
      const tail = rest.length ? ` ${plural(rest.length, "debt")} left, ${totals(rest.map((x) => ({ amount: x.balance, currency: x.currency })))} to go.` : " That was the last one. You're debt-free.";
      return { reply: `That's the ${d.name} cleared. One less thing to carry.${tail}`, undo };
    }
    return { reply: `${fmt(args.amount, d.currency)} off the ${d.name}; ${fmt(bal, d.currency)} left.`, undo };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE money_debts SET balance=$2, closed_at=NULL WHERE id=$1 AND user_id=$3`, [p.id, p.balance, ctx.user.id]); return "Payment taken back."; },
});

register(park, decide, wishlist, debtAdd, debtBudget, debtPlan, debtPay);

/* ---------------- words → actions ---------------- */

const DUR = "(a week|a month|a day|one week|\\d+\\s+(?:days?|hours?|weeks?)|two days|three days|two weeks)";
const RATE = "(\\d+(?:\\.\\d+)?)\\s*%";
const RP = "(?:\\s*(?:a\\s+|per\\s+)?(month|monthly|year|yearly|annual|annually|apr|p\\.?a\\.?))";
const MIN = `(?:,?\\s+(?:with\\s+(?:a\\s+)?)?(?:min(?:imum)?(?:\\s+payment)?|minimum)\\s+(?:of\\s+)?${AMT})`;
const debtArgs = (name: string, bal: string, rate: string, rp?: string, min?: string) => {
  const b = amt(bal);
  return { name, balance: b.amount, ...(b.currency ? { currency: b.currency } : {}), rate: Number(rate), ...(rp && /month/i.test(rp) ? { rate_period: "month" } : {}), ...(min ? { minimum: amt(min).amount } : {}) };
};
const parkArgs = (item: string, a: string, dur?: string) => ({ item, ...amt(a), ...(hoursIn(dur) ? { hours: hoursIn(dur) } : {}) });

addRules(
  [re(`i\\s+(?:really\\s+)?(?:want|wanna|'d like|would like|'m dying)\\s+(?:to\\s+)?buy\\s+(?:a\\s+|an\\s+|the\\s+|some\\s+)?(.+?)\\s+(?:for|at|which is|that'?s|it'?s|costing|that costs)\\s+${AMT}(?:,?\\s+(?:(?:park|hold) it|wait|cool off|let me sleep on it)?\\s*(?:for\\s+)?${DUR})?`), (m) => ({ action: "cooloff.park", args: parkArgs(m[1], m[2], m[3]) })],
  [re(`(?:should i buy|thinking (?:of|about) buying|tempted to buy|i'?m tempted to buy|i'?m eyeing)\\s+(?:a\\s+|an\\s+|the\\s+|some\\s+)?(.+?)\\s+(?:for|at)\\s+${AMT}\\??`), (m) => ({ action: "cooloff.park", args: parkArgs(m[1], m[2]) })],
  [re(`(?:park|cool off on|let me sleep on)\\s+(?:the\\s+|a\\s+|an\\s+)?(.+?)\\s+(?:for|at)\\s+${AMT}(?:\\s+for\\s+${DUR})?`), (m) => ({ action: "cooloff.park", args: parkArgs(m[1], m[2], m[3]) })],
  [re(`(?:yes,?\\s+)?(?:i\\s+)?still want (?:it|them|the\\s+(.+))|(?:i'?ll\\s+)?buy (?:it|them) (?:after all|then)`), (m) => ({ action: "cooloff.decide", args: { decision: "buy", ...(m[1] ? { item: m[1] } : {}) } })],
  [re(`skip (?:it|them|that one)|(?:i\\s+)?don'?t (?:want|need) (?:it|them) any ?more`), () => ({ action: "cooloff.decide", args: { decision: "skip" } })],
  [re(`(?:my\\s+)?(?:wishlist|wish list|cool[- ]?offs?|cooling off list|parked (?:buys|purchases|things))|what(?:'s| is) parked\\??|(?:how much have i\\s+)?saved by waiting\\??`), () => ({ action: "cooloff.list", args: {} })],

  [re(`(?:add\\s+(?:a\\s+)?|new\\s+)?debt[:,]?\\s+(.+?)\\s+${AMT}\\s+at\\s+${RATE}${RP}?${MIN}?`), (m) => ({ action: "debt.add", args: debtArgs(m[1], m[2], m[3], m[4], m[5]) })],
  [re(`(?!(?:i|we|rent|my rent)\\b)(?:my\\s+)?(.{1,40}?)\\s+${AMT}\\s+at\\s+${RATE}${RP}${MIN}?`), (m) => ({ action: "debt.add", args: debtArgs(m[1], m[2], m[3], m[4], m[5]) })],
  [re(`(?!(?:i|we|rent|my rent)\\b)(?:my\\s+)?(.{1,40}?)\\s+${AMT}\\s+at\\s+${RATE}${MIN}`), (m) => ({ action: "debt.add", args: debtArgs(m[1], m[2], m[3], undefined, m[4]) })],
  [re(`(?:my\\s+)?debt budget(?:\\s+is)?\\s+${AMT}(?:\\s+(?:a|per)\\s+month)?|i\\s+can\\s+(?:put|pay|afford|spare)\\s+${AMT}\\s+(?:a\\s+|per\\s+)month\\s+(?:to(?:wards?)?|on|into|for)\\s+(?:my\\s+)?debts?`), (m) => ({ action: "debt.budget", args: amt((m[1] ?? m[2])!) })],
  [re(`(?:my\\s+)?debt\\s+(?:plan|payoff(?:\\s+plan)?|snowball|avalanche)|(?:my\\s+)?debts|how (?:long|soon) (?:until|till|before) i'?m debt[- ]free\\??|(?:my\\s+)?(?:snowball|avalanche)(?:\\s+plan)?`), () => ({ action: "debt.plan", args: {} })],
  [re(`(?:i\\s+)?paid\\s+${AMT}\\s+(?:off|towards?|into|on|against)\\s+(?:the\\s+|my\\s+)?(.+?)(?:\\s+(?:debt|loan|balance))?`), (m) => ({ action: "debt.pay", args: { name: m[2], ...amt(m[1]) } })],
);

addExamples("cooloff.park", ["I want to buy AirPods for 249", "I want to buy a PS5 for 450000 naira, park it for a week", "should I buy new trainers for €120?"]);
addExamples("cooloff.decide", ["still want it", "skip it"]);
addExamples("cooloff.list", ["my wishlist", "saved by waiting"]);
addExamples("debt.add", ["debt: credit card 2400 at 24%, minimum 60", "loan app 300 at 10% monthly", "new debt car loan 5000 at 9% minimum 150"]);
addExamples("debt.budget", ["debt budget 400", "I can put 300 a month towards my debts"]);
addExamples("debt.plan", ["my debt plan", "how long until I'm debt-free?"]);
addExamples("debt.pay", ["paid 200 off the credit card", "paid ₦50,000 towards the loan app"]);

addCues("cooloff", ["want to buy", "should i buy", "tempted", "impulse", "cool off", "wishlist", "still want", "skip it", "saved by waiting"]);
addCues("debt", ["debt", "debts", "loan", "credit card", "interest", "apr", "minimum payment", "snowball", "avalanche", "debt-free", "paid off"]);

addCapability({
  key: "cooloff", name: "Impulse-buy cool-off",
  cues: ["want to buy", "should i buy", "impulse", "tempted", "cool off", "wishlist"],
  what: "Tell me something you want to buy and I park it for 48 hours (or a week), then ask again gently with this week's spending beside it.",
  say: ["I want to buy AirPods for 249", "park it for a week", "still want it", "skip it", "saved by waiting"],
  then: "Whatever you skip adds up quietly in a \"saved by waiting\" total. No judgement either way.",
}, "Money");
addCapability({
  key: "debt_plan", name: "Debt payoff planner",
  cues: ["debt", "loan", "credit card", "interest", "snowball", "avalanche", "debt-free"],
  what: "Add your debts and what you can pay each month, and I show the snowball and avalanche orders and how long each takes to clear.",
  say: ["debt: credit card 2400 at 24%, minimum 60", "loan app 300 at 10% monthly", "debt budget 400", "my debt plan", "paid 200 off the credit card"],
  then: "Log payments as you make them and I keep the balances; when one hits zero, I'll mark it cleared.",
  limits: "Arithmetic, not financial advice.",
}, "Money");
