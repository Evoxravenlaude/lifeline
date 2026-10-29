/**
 * Utilities and refills: gas cylinders, prepaid electricity, generator fuel and hours, water deliveries,
 * and power, water or internet cuts. It learns how long a refill lasts for this person, warns gently
 * a couple of days before the likely end (brief line, one ping), keeps the monthly cost in their own
 * currency, and turns cuts into hours of supply a week: plain evidence for a complaint, anywhere.
 */
import { z } from "zod";
import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import type { Db } from "../../../core/db.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema, addSystemJob } from "../../../core/plugins.js";
import { onJob } from "../../../core/scheduler.js";
import { money, userCurrency } from "../../../core/money.js";
import { andList, cap, dayWord, homePrefs, local, parseCost, pingOnce, plural, setHome, usersIn } from "./util.js";

addSchema(`CREATE TABLE IF NOT EXISTS home_refills (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, qty NUMERIC, unit TEXT, cost NUMERIC, currency TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now(), pinged BOOLEAN NOT NULL DEFAULT false);
CREATE INDEX IF NOT EXISTS home_refills_user ON home_refills(user_id, kind, at);
CREATE TABLE IF NOT EXISTS home_outages (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, ended_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS home_outages_user ON home_outages(user_id, kind, started_at)`);

export type RefillKind = "gas" | "power" | "power_reading" | "fuel" | "water" | "gen_run" | "gen_off";
const WATCHED = ["gas", "power", "water"] as const;
type Watched = (typeof WATCHED)[number];
const WORD: Record<string, string> = { gas: "gas", power: "power units", water: "water", fuel: "generator fuel" };
const OUT_WORD: Record<string, string> = { power: "power", water: "water", internet: "internet" };
const DAY = 86_400_000;

interface Row { id: number; kind: string; qty: number | null; unit: string | null; cost: number | null; currency: string | null; at: Date; pinged: boolean }

export async function refillRows(db: Db, userId: number, since?: Date): Promise<Row[]> {
  const rows = await db.query<any>(`SELECT id, kind, qty::text, unit, cost::text, currency, at, pinged FROM home_refills WHERE user_id=$1 AND ($2::timestamptz IS NULL OR at >= $2) ORDER BY at, id`, [userId, since ?? null]);
  return rows.map((r) => ({ ...r, qty: r.qty === null ? null : Number(r.qty), cost: r.cost === null ? null : Number(r.cost), at: new Date(r.at) }));
}

/* ---------------- reading what people say ---------------- */

/** A time in the past ("6pm", "yesterday at 4", "this morning"), never pushed into tomorrow. */
export function pastTime(text: string | undefined, tz: string, now: Date): Date | null {
  if (!text) return null;
  const ref = DateTime.fromJSDate(now).setZone(tz);
  const r = chrono.parse(text, { instant: now, timezone: ref.offset })[0];
  if (!r) return null;
  let d = r.start.date();
  if (d.getTime() > now.getTime() + 10 * 60_000 && !r.start.isCertain("day")) d = new Date(d.getTime() - DAY);
  return d;
}

const QTY: Record<string, RegExp> = {
  gas: /(\d+(?:\.\d+)?)\s*(kg|kgs|kilos?)\b/i,
  power: /(\d+(?:\.\d+)?)\s*(kwh|units?)\b/i,
  power_reading: /(\d+(?:\.\d+)?)\s*(kwh|units?)?/i,
  fuel: /(\d+(?:\.\d+)?)\s*(l|litres?|liters?)\b/i,
  water: /(\d+(?:\.\d+)?)\s*(l|litres?|liters?|jerrycans?|drums?|tankers?)\b/i,
  gen_run: /(\d+(?:\.\d+)?)\s*(h|hrs?|hours?)\b/i,
};
const WHEN = /\b(today|yesterday|this morning|this evening|last night|tonight|on (?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|\d+ days? ago)\b/i;

/* ---------------- forecasts ---------------- */

export interface Forecast { kind: Watched; last: Row; endAt: Date; avgDays: number | null; perDay: number | null }

/** How long a refill usually lasts here, and when this one likely ends. Null until there's enough to say. */
export function forecast(rows: Row[], kind: Watched): Forecast | null {
  const ev = rows.filter((r) => r.kind === kind);
  const last = ev[ev.length - 1];
  const gaps: number[] = [];
  for (let i = 1; i < ev.length; i++) {
    const d = (ev[i].at.getTime() - ev[i - 1].at.getTime()) / DAY;
    if (d >= 1 && d <= 400) gaps.push(d);
  }
  const avgDays = gaps.length ? gaps.slice(-4).reduce((a, b) => a + b, 0) / gaps.slice(-4).length : null;
  if (kind === "power") {
    // Meter readings give a burn rate: units before, plus top-ups between, minus units after, over the days.
    const readings = rows.filter((r) => r.kind === "power_reading" && r.qty !== null);
    const rates: number[] = [];
    for (let i = 1; i < readings.length; i++) {
      const a = readings[i - 1], b = readings[i];
      const days = (b.at.getTime() - a.at.getTime()) / DAY;
      const added = rows.filter((r) => r.kind === "power" && r.at > a.at && r.at <= b.at).reduce((s, r) => s + (r.qty ?? 0), 0);
      const used = a.qty! + added - b.qty!;
      if (days >= 0.25 && used > 0) rates.push(used / days);
    }
    if (rates.length) {
      const perDay = rates.slice(-3).reduce((a, b) => a + b, 0) / rates.slice(-3).length;
      const r = readings[readings.length - 1];
      let bal = r.qty!, t = r.at;
      for (const top of rows.filter((x) => x.kind === "power" && x.at > r.at)) {
        bal = Math.max(0, bal - perDay * ((top.at.getTime() - t.getTime()) / DAY)) + (top.qty ?? 0);
        t = top.at;
      }
      const latest = rows.filter((x) => x.kind === "power" || x.kind === "power_reading").pop()!;
      return { kind, last: latest, endAt: new Date(t.getTime() + (bal / perDay) * DAY), avgDays, perDay };
    }
  }
  if (!last || avgDays === null) return null;
  return { kind, last, endAt: new Date(last.at.getTime() + avgDays * DAY), avgDays, perDay: null };
}

const lasts = (f: Forecast) => f.perDay ? `you use about ${round(f.perDay)} units a day` : `${f.kind === "gas" ? "a cylinder" : f.kind === "water" ? "a delivery" : "a top-up"} lasts you about ${plural(Math.round(f.avgDays!), "day")}`;
const round = (n: number) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);

/* ---------------- outages ---------------- */

interface Outage { id: number; kind: string; started_at: Date; ended_at: Date | null }
async function outages(db: Db, userId: number, kind: string, from: Date): Promise<Outage[]> {
  const rows = await db.query<any>(`SELECT id, kind, started_at, ended_at FROM home_outages WHERE user_id=$1 AND kind=$2 AND (ended_at IS NULL OR ended_at > $3) ORDER BY started_at`, [userId, kind, from]);
  return rows.map((r) => ({ ...r, started_at: new Date(r.started_at), ended_at: r.ended_at ? new Date(r.ended_at) : null }));
}

/** Hours without supply in [from, to], the cuts that touched it and the longest one. */
export function supply(rows: Outage[], from: Date, to: Date) {
  let off = 0, longest: { at: Date; hours: number } | null = null;
  const cuts = rows.filter((o) => o.started_at < to && (o.ended_at ?? to) > from);
  for (const o of cuts) {
    const s = Math.max(o.started_at.getTime(), from.getTime()), e = Math.min((o.ended_at ?? to).getTime(), to.getTime());
    const h = Math.max(0, (e - s) / 3_600_000);
    off += h;
    if (!longest || h > longest.hours) longest = { at: o.started_at, hours: h };
  }
  const total = (to.getTime() - from.getTime()) / 3_600_000;
  return { off, total, on: total - off, pct: total ? Math.round(((total - off) / total) * 100) : 100, cuts, longest };
}
const hrs = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} minutes` : plural(Math.round(h * 10) / 10, "hour"));

/** The copyable log for a complaint: generic wording, any provider, any country. */
export async function outageLog(db: Db, user: User, kind: string, days: number, now: Date): Promise<string> {
  const from = new Date(now.getTime() - days * DAY);
  const rows = await outages(db, user.id, kind, from);
  const s = supply(rows, from, now);
  const f = local(from, user.tz), t = local(now, user.tz);
  if (!s.cuts.length) return `No ${OUT_WORD[kind]} cuts logged in the last ${days} days.`;
  const lines = s.cuts.slice(-14).map((o) => {
    const a = local(o.started_at, user.tz), b = o.ended_at ? local(o.ended_at, user.tz) : null;
    const h = ((o.ended_at ?? now).getTime() - o.started_at.getTime()) / 3_600_000;
    return `${a.toFormat("ccc d LLL")}: off ${a.toFormat("HH:mm")} to ${b ? (b.hasSame(a, "day") ? b.toFormat("HH:mm") : b.toFormat("ccc HH:mm")) : "still off"} (${hrs(h)})`;
  });
  return [`${cap(OUT_WORD[kind])} supply log, ${f.toFormat("d LLL")} to ${t.toFormat("d LLL yyyy")}`, ...lines,
    `Total: ${hrs(s.off)} without ${OUT_WORD[kind]} across ${plural(s.cuts.length, "interruption")}, ${Math.round(s.on)} of ${Math.round(s.total)} hours supplied (${s.pct}%).`].join("\n");
}

/* ---------------- generator hours (also used by home jobs) ---------------- */

export async function genHoursSince(db: Db, userId: number, since: Date, now = new Date()): Promise<number> {
  const rows = await db.query<{ qty: string | null; at: string }>(`SELECT qty::text, at FROM home_refills WHERE user_id=$1 AND kind='gen_run' AND at >= $2`, [userId, since]);
  return rows.reduce((s, r) => s + (r.qty !== null ? Number(r.qty) : Math.min(24, (now.getTime() - new Date(r.at).getTime()) / 3_600_000)), 0);
}

/* ---------------- actions ---------------- */

const log = defineAction({
  name: "utility.log",
  tier: 1,
  description: "Log a home utility refill or reading: kind 'gas' (cylinder, qty in kg), 'power' (prepaid electricity top-up, qty in kWh or units), 'power_reading' (units left on the meter), 'fuel' (generator fuel, litres), 'water' (a water delivery), 'gen_run' (generator ran for qty hours, or qty empty when it was just switched on), 'gen_off' (generator switched off). Optional cost and currency; 'text' is the person's own words, used to find quantity, cost and day.",
  schema: z.object({
    kind: z.enum(["gas", "power", "power_reading", "fuel", "water", "gen_run", "gen_off"]),
    qty: z.number().nonnegative().optional(), unit: z.string().max(12).optional(),
    cost: z.number().positive().optional(), currency: z.string().length(3).optional(),
    when: z.string().max(40).optional(), text: z.string().max(200).optional(),
  }),
  async run(a, ctx) {
    const t = a.text ?? "";
    let qty = a.qty, unit = a.unit;
    const rest = t.replace(/^(?:.*?\b(?:gas|cylinder|bottle|generator|gen|genset|electricity|power|light|meter|prepaid|delivery|tanker))\b/i, "");
    const q = QTY[a.kind] ? (QTY[a.kind].exec(a.kind === "power_reading" ? t.replace(/^\D+/, "") : t) ?? null) : null;
    if (qty === undefined && q) { qty = Number(q[1]); unit = unit ?? q[2]?.toLowerCase().replace(/^kgs?$|^kilos?$/, "kg").replace(/^liters?$|^litres?$/, "litres").replace(/^l$/, "litres").replace(/^units?$/, "units").replace(/^kwh$/, "kWh"); }
    const c = a.cost ? { amount: a.cost, currency: (a.currency ?? "").toUpperCase() || userCurrency(ctx.user) } : (a.kind === "power_reading" || a.kind === "gen_off" ? null : parseCost(rest || t, ctx.user));
    const whenWord = a.when ?? WHEN.exec(t)?.[0];
    const said = /^(?:today|tonight|this (?:morning|evening))$/i.test(whenWord ?? "") ? null : pastTime(whenWord, ctx.user.tz, ctx.now);
    const at = said && said < ctx.now ? said : ctx.now;

    if (a.kind === "gen_off") {
      const open = await ctx.db.one<{ id: number; at: string }>(`SELECT id, at FROM home_refills WHERE user_id=$1 AND kind='gen_run' AND qty IS NULL ORDER BY at DESC LIMIT 1`, [ctx.user.id]);
      if (!open) return { reply: `I didn't have the generator down as on. Say "ran the generator 4 hours" to log a run.` };
      const h = Math.max(0, Math.min(24, (at.getTime() - new Date(open.at).getTime()) / 3_600_000));
      await ctx.db.query(`UPDATE home_refills SET qty=$2, unit='hours' WHERE id=$1`, [open.id, Math.round(h * 100) / 100]);
      return { reply: `Generator off after ${hrs(h)}.`, undo: { payload: { reopen: open.id } } };
    }
    if (a.kind === "gen_run" && qty === undefined) {
      const open = await ctx.db.one(`SELECT id FROM home_refills WHERE user_id=$1 AND kind='gen_run' AND qty IS NULL AND at > $2`, [ctx.user.id, new Date(ctx.now.getTime() - DAY)]);
      if (open) return { reply: `The generator's already on in my notes. Say "generator off" when it stops.` };
    }
    if (a.kind === "power_reading" && qty === undefined) throw new Error("I didn't catch the number on the meter. How many units are left?");
    const row = await ctx.db.one<{ id: number }>(`INSERT INTO home_refills (user_id, kind, qty, unit, cost, currency, at) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.user.id, a.kind, qty ?? null, unit ?? (a.kind === "gen_run" ? "hours" : null), c?.amount ?? null, c?.currency ?? null, at]);
    const undo = { payload: { id: row!.id } };
    const costBit = c ? ` for ${money(c.amount, c.currency)}` : "";
    const when = Math.abs(at.getTime() - ctx.now.getTime()) > 6 * 3_600_000 ? ` ${dayWord(local(at, ctx.user.tz), local(ctx.now, ctx.user.tz))}` : "";
    if (a.kind === "gen_run") return { reply: qty !== undefined ? `Generator, ${hrs(qty)}${when}. I count these toward its service.` : `Generator on. Say "generator off" when it stops and I'll log the hours.`, undo };

    const rows = await refillRows(ctx.db, ctx.user.id, new Date(ctx.now.getTime() - 400 * DAY));
    if (a.kind === "power_reading") {
      const f = forecast(rows, "power");
      const left = f?.perDay ? ` At your pace that's about ${plural(Math.max(0, Math.round((f.endAt.getTime() - ctx.now.getTime()) / DAY)), "day")} left.` : " Tell me the units again in a day or two and I'll learn how fast you use them.";
      return { reply: `${round(qty!)} units on the meter.${left}`, undo };
    }
    const what = a.kind === "gas" ? `Gas${qty ? `, ${qty}${unit === "kg" ? "kg" : ` ${unit}`}` : ""}` : a.kind === "power" ? `Power${qty ? `, ${round(qty)} ${unit ?? "units"}` : ""}` : a.kind === "fuel" ? `Generator fuel${qty ? `, ${round(qty)} ${unit ?? "litres"}` : ""}` : `Water delivery${qty ? `, ${round(qty)} ${unit ?? "litres"}` : ""}`;
    let next = "";
    if ((WATCHED as readonly string[]).includes(a.kind)) {
      const f = forecast(rows, a.kind as Watched);
      const count = rows.filter((r) => r.kind === a.kind).length;
      if (f && f.avgDays) next = ` ${cap(lasts(f))}, so I'd expect the next one around ${local(f.endAt, ctx.user.tz).toFormat("ccc d LLL")}. I'll mention it a couple of days before; say "stop the ${a.kind} reminders" if you'd rather I didn't.`;
      else if (count === 1) next = ` After the next ${a.kind === "gas" ? "refill" : a.kind === "power" ? "top-up" : "delivery"} I'll know how long one lasts you and can warn you before it runs out.`;
    }
    return { reply: `${what}${costBit}${when}, logged.${next}`, undo };
  },
  async undo(p, ctx) {
    if (p.reopen) { await ctx.db.query(`UPDATE home_refills SET qty=NULL WHERE id=$1 AND user_id=$2`, [p.reopen, ctx.user.id]); return "Taken back. The generator's on again in my notes."; }
    await ctx.db.query(`DELETE FROM home_refills WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Taken off the log.";
  },
});

const outage = defineAction({
  name: "utility.outage",
  tier: 1,
  description: "Log a cut in the person's own power, water or internet supply: state 'off' (it just went, optional 'since'), 'on' (it's back, optional 'since'), or 'range' with 'from' and 'to' (a cut that already ended, like 'from 6pm to 11pm'). For their own record of hours of supply; never shared.",
  schema: z.object({ kind: z.enum(["power", "water", "internet"]), state: z.enum(["off", "on", "range"]), from: z.string().max(40).optional(), to: z.string().max(40).optional(), since: z.string().max(40).optional() }),
  async run(a, ctx) {
    const tz = ctx.user.tz, now = ctx.now, w = OUT_WORD[a.kind];
    const open = await ctx.db.one<{ id: number; started_at: string }>(`SELECT id, started_at FROM home_outages WHERE user_id=$1 AND kind=$2 AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`, [ctx.user.id, a.kind]);
    if (a.state === "range") {
      const day = WHEN.exec(`${a.to ?? ""} ${a.from ?? ""}`)?.[0] ?? "";
      const bare = (s?: string) => (s ?? "").replace(WHEN, "").trim();
      let s = pastTime(`${bare(a.from)} ${day}`.trim(), tz, now), e = pastTime(`${bare(a.to)} ${day}`.trim(), tz, now);
      if (!s || !e) throw new Error(`I couldn't read the times in that. Say it like "power cut from 6pm to 11pm".`);
      if (e <= s) { if (s > now) s = new Date(s.getTime() - DAY); else e = new Date(e.getTime() + DAY); }
      if (e > now && s < now && !day) e = now;
      const row = await ctx.db.one<{ id: number }>(`INSERT INTO home_outages (user_id, kind, started_at, ended_at) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.user.id, a.kind, s, e]);
      const S = local(s, tz), E = local(e, tz);
      return { reply: `${cap(w)} cut ${dayWord(S, local(now, tz))}, ${S.toFormat("HH:mm")} to ${E.toFormat("HH:mm")} (${hrs((e.getTime() - s.getTime()) / 3_600_000)}), logged. Say "${a.kind} this week" for your hours of supply.`, undo: { payload: { del: row!.id } } };
    }
    if (a.state === "off") {
      if (open) return { reply: `I already have ${w} off since ${local(open.started_at, tz).toFormat("HH:mm")}. Say "${a.kind === "power" ? "power" : a.kind} is back" when it returns.` };
      const s = pastTime(a.since, tz, now) ?? now;
      const row = await ctx.db.one<{ id: number }>(`INSERT INTO home_outages (user_id, kind, started_at) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, a.kind, s]);
      return { reply: `${cap(w)} off since ${local(s, tz).toFormat("HH:mm")}, noted. Say "${a.kind} is back" when it returns and I'll count the hours.`, undo: { payload: { del: row!.id } } };
    }
    if (!open) return { reply: `Good. I didn't have ${w} down as off; say "${a.kind} cut from 6pm to 11pm" to log one after the fact.` };
    const e = pastTime(a.since, tz, now) ?? now;
    await ctx.db.query(`UPDATE home_outages SET ended_at=$2 WHERE id=$1`, [open.id, e]);
    const h = (e.getTime() - new Date(open.started_at).getTime()) / 3_600_000;
    const from = new Date(now.getTime() - 7 * DAY);
    const st = supply(await outages(ctx.db, ctx.user.id, a.kind, from), from, now);
    return { reply: `${cap(w)} back after ${hrs(h)}. This week so far: ${st.pct}% supply, ${hrs(st.off)} without.`, undo: { payload: { reopen: open.id } } };
  },
  async undo(p, ctx) {
    if (p.reopen) { await ctx.db.query(`UPDATE home_outages SET ended_at=NULL WHERE id=$1 AND user_id=$2`, [p.reopen, ctx.user.id]); return "Taken back. It's down as off again."; }
    await ctx.db.query(`DELETE FROM home_outages WHERE id=$1 AND user_id=$2`, [p.del, ctx.user.id]);
    return "Taken off the log.";
  },
});

async function overview(db: Db, user: User, now: Date): Promise<string> {
  const rows = await refillRows(db, user.id, new Date(now.getTime() - 400 * DAY));
  const tz = user.tz, L = local(now, tz);
  const lines: string[] = [];
  for (const k of ["gas", "power", "fuel", "water"] as const) {
    const ev = rows.filter((r) => r.kind === k);
    const last = ev[ev.length - 1];
    if (!last) continue;
    const f = k === "fuel" ? null : forecast(rows, k);
    const qty = last.qty ? ` (${round(last.qty)}${last.unit === "kg" ? "kg" : ` ${last.unit ?? ""}`.trimEnd()})` : "";
    const lastBit = `last ${k === "gas" ? "refilled" : k === "power" ? "topped up" : k === "fuel" ? "filled" : "delivered"} ${dayWord(local(last.at, tz), L)}${qty}`;
    const ahead = f ? (f.endAt < now ? `; it may have run out by now` : `; ${lasts(f)}, so around ${local(f.endAt, tz).toFormat("ccc d LLL")}`) : "";
    lines.push(`${cap(WORD[k] === "power units" ? "power" : WORD[k])}: ${lastBit}${ahead}.`);
  }
  const gen = await genHoursSince(db, user.id, L.startOf("month").toJSDate(), now);
  if (gen > 0) lines.push(`Generator: ${hrs(gen)} run this month.`);
  // Money: this month, and the monthly average over the months before it, per currency.
  const month = L.startOf("month").toJSDate();
  const spend = await db.query<{ currency: string; this: string; before: string; months: string }>(
    `SELECT currency, SUM(CASE WHEN at >= $2 THEN cost ELSE 0 END)::text AS this, SUM(CASE WHEN at < $2 THEN cost ELSE 0 END)::text AS before,
            COUNT(DISTINCT CASE WHEN at < $2 THEN to_char(at AT TIME ZONE $3, 'YYYY-MM') END)::text AS months
       FROM home_refills WHERE user_id=$1 AND cost IS NOT NULL AND at >= $4 GROUP BY currency ORDER BY SUM(cost) DESC`,
    [user.id, month, tz, L.startOf("month").minus({ months: 6 }).toJSDate()]);
  if (spend.length) {
    const bits = spend.slice(0, 2).map((s) => `${money(Number(s.this), s.currency)}${Number(s.months) ? ` (about ${money(Math.round(Number(s.before) / Number(s.months)), s.currency)} a month before)` : ""}`);
    lines.push(`This month on utilities: ${bits.join(", and ")}.`);
  }
  const from = new Date(now.getTime() - 7 * DAY);
  for (const k of ["power", "water", "internet"]) {
    const st = supply(await outages(db, user.id, k, from), from, now);
    if (st.cuts.length) lines.push(`${cap(OUT_WORD[k])} this week: ${st.pct}% supply, ${hrs(st.off)} without. Say "${k} this week" for the log.`);
  }
  if (!lines.length) return `Nothing logged yet. Tell me when you refill, like "refilled the gas 12.5kg for 15000", "topped up 50 kWh of electricity" or "power cut from 6pm to 11pm", and I'll learn how long things last and what they cost.`;
  return lines.slice(0, 7).join("\n");
}

const show = defineAction({
  name: "utility.show",
  tier: 1,
  description: "Show the person's utilities: refills, when gas or prepaid power will likely run out, monthly cost, and hours of supply. 'focus' power, water or internet shows that supply over 'days' (default 7) with a copyable log for a complaint to the provider.",
  schema: z.object({ focus: z.enum(["power", "water", "internet", "gas"]).optional(), days: z.number().int().min(1).max(92).optional() }),
  async run(a, ctx) {
    if (!a.focus || a.focus === "gas") return { reply: await overview(ctx.db, ctx.user, ctx.now) };
    const days = a.days ?? 7;
    const from = new Date(ctx.now.getTime() - days * DAY);
    const st = supply(await outages(ctx.db, ctx.user.id, a.focus, from), from, ctx.now);
    const w = OUT_WORD[a.focus], span = days === 7 ? "this week" : days >= 28 && days <= 31 ? "this month" : `over the last ${days} days`;
    if (!st.cuts.length) return { reply: `No ${w} cuts logged ${span}. When it goes, say "${a.focus} is out", and "${a.focus} is back" when it returns.` };
    const L = st.longest ? local(st.longest.at, ctx.user.tz) : null;
    return {
      reply: `${cap(w)} ${span}: off for ${hrs(st.off)} across ${plural(st.cuts.length, "cut")}, so about ${Math.round(st.on)} of ${Math.round(st.total)} hours of supply (${st.pct}%).${L && st.cuts.length > 1 ? ` Longest: ${L.toFormat("ccc d LLL")}, ${hrs(st.longest!.hours)}.` : ""}`,
      buttons: [{ label: "Copy the log", data: `hm:log:${a.focus}:${days}` }],
    };
  },
});

const stop = defineAction({
  name: "utility.stop",
  tier: 1,
  description: "Turn the gentle 'running out soon' warnings for gas, power or water on or off ('all' for every kind). The log itself stays.",
  schema: z.object({ kind: z.enum(["gas", "power", "water", "all"]), on: z.boolean().optional() }),
  async run(a, ctx) {
    const quiet = { ...(homePrefs(ctx.user).quiet ?? {}) } as Record<string, boolean>;
    const prev = { ...quiet };
    for (const k of a.kind === "all" ? WATCHED : [a.kind]) quiet[k] = !a.on;
    await setHome(ctx.db, ctx.user, { quiet });
    const what = a.kind === "all" ? "running-out warnings" : `${WORD[a.kind]} reminders`;
    return { reply: a.on ? `${cap(what)} are back on. I'll mention it a couple of days before.` : `No more ${what}. I'll keep the log; say "start the ${a.kind === "all" ? "utility" : a.kind} reminders" to have them back.`, undo: { payload: { prev } } };
  },
  async undo(p, ctx) { await setHome(ctx.db, ctx.user, { quiet: p.prev }); return "Put back as it was."; },
});

register(log, outage, show, stop);

/* ---------------- words ---------------- */

const KIND_OUT = "(power|light|electricity|nepa|current|water|internet|wi-?fi|network|broadband)";
const outKind = (w: string) => (/^(?:water)$/i.test(w) ? "water" : /^(?:internet|wi-?fi|network|broadband)$/i.test(w) ? "internet" : "power");
const DAYS_RE = "(?:\\s+(today|yesterday|last night))?";

addRules(
  // gas
  [/^(?:i\s+)?(?:just\s+)?(?:refilled|refill|changed|swapped|replaced|bought|got)\s+(?:the\s+|my\s+|a\s+|an\s+)?(?:new\s+)?(?:\d+(?:\.\d+)?\s*kg\s+)?(?:cooking\s+)?gas(?:\s+(?:cylinder|bottle|tank))?\b.*$/i, (m) => ({ action: "utility.log", args: { kind: "gas", text: m[0] } })],
  [/^(?:new\s+)?(?:\d+(?:\.\d+)?\s*kg\s+)?(?:cooking\s+)?gas\s+(?:cylinder\s+|bottle\s+)?(?:refill(?:ed)?|changed|bought|delivered)\b.*$|^new\s+(?:\d+(?:\.\d+)?\s*kg\s+)?gas\s+(?:cylinder|bottle)\b.*$/i, (m) => ({ action: "utility.log", args: { kind: "gas", text: m[0] } })],
  // prepaid power
  [/^(?:i\s+)?(?:just\s+)?(?:topped up|top up|recharged|loaded|bought|got|paid for)\s+(?:the\s+|my\s+)?(?:\d+(?:\.\d+)?\s*(?:kwh|units?)\s+(?:of\s+)?)?(?:electricity|power|light|prepaid|meter|nepa)(?:\s+(?:units?|meter|token))?\b.*$|^(?:i\s+)?(?:just\s+)?(?:topped up|recharged|loaded|bought|got)\s+\d+(?:\.\d+)?\s*(?:kwh|units)\b.*$/i, (m) => ({ action: "utility.log", args: { kind: "power", text: m[0] } })],
  [/^(?:my\s+)?(?:power|electricity|light|meter|prepaid)\s+(?:units?\s+|balance\s+|meter\s+)?(?:is\s+|are\s+|at\s+|left:?\s+|reads\s+|now\s+|on\s+)+(\d+(?:\.\d+)?)\s*(?:kwh|units?)?(?:\s+left)?$|^(\d+(?:\.\d+)?)\s*(?:kwh|units?)\s+left(?:\s+on\s+(?:the\s+|my\s+)?meter)?$/i, (m) => ({ action: "utility.log", args: { kind: "power_reading", qty: Number(m[1] ?? m[2]), unit: "units" } })],
  // generator
  [/^(?:i\s+)?(?:filled|fuelled|fueled|topped up|refuelled|refueled)\s+(?:up\s+)?(?:the\s+|my\s+)?(?:generator|gen|genset)\b.*$|^(?:i\s+)?(?:put|bought|got)\s+\d+(?:\.\d+)?\s*(?:l|litres?|liters?)\s+(?:of\s+)?(?:diesel|petrol|fuel|gas)?\s*(?:in|into|for)\s+(?:the\s+|my\s+)?(?:generator|gen|genset)\b.*$/i, (m) => ({ action: "utility.log", args: { kind: "fuel", text: m[0] } })],
  [new RegExp(`^(?:i\\s+)?(?:ran|used|run)\\s+(?:the\\s+|my\\s+)?(?:generator|gen|genset)\\s+(?:for\\s+)?(\\d+(?:\\.\\d+)?)\\s*(?:h|hrs?|hours?)${DAYS_RE}$`, "i"), (m) => ({ action: "utility.log", args: { kind: "gen_run", qty: Number(m[1]), unit: "hours", ...(m[2] ? { when: m[2] } : {}) } })],
  [/^(?:the\s+)?(?:generator|gen|genset)\s+(?:is\s+)?(on|off)$|^(?:i\s+)?(?:turned|switched|put)\s+(on|off)\s+the\s+(?:generator|gen|genset)$|^(?:i\s+)?(?:turned|switched)\s+the\s+(?:generator|gen|genset)\s+(on|off)$/i, (m) => ({ action: "utility.log", args: { kind: (m[1] ?? m[2] ?? m[3]).toLowerCase() === "on" ? "gen_run" : "gen_off" } })],
  // water deliveries
  [/^(?:(?:we|i)\s+(?:got|had)\s+(?:a\s+)?)?water\s+(?:delivery|tanker|truck|delivered|came|refill(?:ed)?)\b.*$|^(?:the\s+)?water\s+tanker\s+came\b.*$/i, (m) => ({ action: "utility.log", args: { kind: "water", text: m[0] } })],
  // cuts in my own supply (a neighbourhood name, "in Rumuola", is the circle alert instead)
  [new RegExp(`^(?:the\\s+)?${KIND_OUT}\\s+(?:was\\s+|went\\s+)?(?:cut|out|off|gone|down)\\s+(?:from\\s+|between\\s+)(.+?)\\s+(?:to|till|until|and)\\s+(.+?)$|^no\\s+${KIND_OUT}\\s+from\\s+(.+?)\\s+(?:to|till|until)\\s+(.+?)$`, "i"), (m) => ({ action: "utility.outage", args: { kind: outKind(m[1] ?? m[4]), state: "range", from: m[2] ?? m[5], to: m[3] ?? m[6] } })],
  [new RegExp(`^(?:the\\s+)?${KIND_OUT}\\s+(?:is\\s+|has\\s+|just\\s+)*(?:out|off|gone|down|cut|gone off|went off|been cut)(?:\\s+(?:since|from)\\s+(?!.*\\bin\\s)(.+))?$|^no\\s+${KIND_OUT}(?:\\s+since\\s+(.+))?$|^${KIND_OUT}\\s+(?:cut|outage)$`, "i"), (m) => ({ action: "utility.outage", args: { kind: outKind(m[1] ?? m[3] ?? m[5]), state: "off", ...(m[2] ?? m[4] ? { since: m[2] ?? m[4] } : {}) } })],
  [new RegExp(`^(?:the\\s+)?${KIND_OUT}\\s+(?:is\\s+|has\\s+|just\\s+)*(?:back|restored|came back|come back|returned)(?:\\s+on)?(?:\\s+(?:at|since)\\s+(.+))?$|^(?:they(?:'ve| have)?\\s+)?brought\\s+(?:the\\s+)?light(?:\\s+back)?$`, "i"), (m) => ({ action: "utility.outage", args: { kind: m[1] ? outKind(m[1]) : "power", state: "on", ...(m[2] ? { since: m[2] } : {}) } })],
  // views
  [/^(?:show\s+)?(?:my\s+)?(?:utilities|utility (?:costs|bills|log)|refills)$|^when will (?:my|the) (?:gas|power|electricity|light|units) run out$|^(?:my|how'?s my) gas$/i, () => ({ action: "utility.show", args: {} })],
  // "water this week" is drinking water (measures); the supply needs the word "supply".
  [new RegExp(`^(?:my\\s+|show\\s+my\\s+)?(?:${KIND_OUT.replace("water|", "")}\\s+(?:supply\\s+)?|(water)\\s+supply\\s+)(this week|this month|report|log|hours)$|^(?:how many\\s+)?hours of ${KIND_OUT}(?:\\s+supply)?(\\s+this week|\\s+this month)?$`, "i"), (m) => ({ action: "utility.show", args: { focus: outKind(m[1] ?? m[2] ?? m[4]), days: /month/i.test(m[3] ?? m[5] ?? "") ? 30 : 7 } })],
  [/^(stop|turn off|no more|mute|start|turn on|resume)\s+(?:the\s+|my\s+)?(gas|power|electricity|light|water|utility|utilities|refill)\s+(?:reminders|warnings|nudges)$/i, (m) => ({ action: "utility.stop", args: { kind: /utilit|refill/i.test(m[2]) ? "all" : /water/i.test(m[2]) ? "water" : /gas/i.test(m[2]) ? "gas" : "power", on: /^(?:start|turn on|resume)$/i.test(m[1]) } })],
);
addExamples("utility.log", ["refilled the gas 12.5kg for 15000", "new gas cylinder 12.5kg", "gas refill 6kg for ₦9,000", "topped up 50 kWh of electricity", "recharged the meter 30 units for 10000", "power units at 20", "45 units left on the meter", "filled the generator with 10 litres", "ran the generator 4 hours", "generator on", "generator off", "water delivery today", "water tanker came, 2000 litres for 8000"]);
addExamples("utility.outage", ["power cut from 6pm to 11pm", "no light from 2pm to 6pm yesterday", "power is out", "no light since 4pm", "water is off", "internet is down", "power is back", "light is back", "they brought light"]);
addExamples("utility.show", ["my utilities", "utilities", "when will my gas run out", "power this week", "hours of power this week", "water supply this month"]);
addExamples("utility.stop", ["stop the gas reminders", "stop utility reminders", "start the gas reminders"]);
addCues("utility", ["gas", "cylinder", "kwh", "units", "prepaid", "meter", "electricity", "power cut", "light", "nepa", "generator", "diesel", "petrol", "water delivery", "tanker", "outage", "blackout", "load shedding", "utilities", "supply", "refill", "topped up"]);
addCapability({
  key: "utilities", name: "Utilities and refills",
  cues: ["gas", "cylinder", "electricity", "prepaid", "meter", "units", "generator", "power cut", "outage", "utilities", "water delivery", "load shedding", "blackout"],
  what: "Tell me when you refill gas, top up prepaid electricity, fuel the generator or get water delivered, and I learn how long each lasts for you, warn you a couple of days before it runs out, and keep the monthly cost. Log power, water or internet cuts and I'll show your hours of supply a week, with a log you can send your provider.",
  say: ["refilled the gas 12.5kg for 15000", "topped up 50 kWh of electricity", "power cut from 6pm to 11pm", "my utilities"],
  then: "Running-out warnings come in your morning note, with one ping two days before; say \"stop the gas reminders\" to turn them off. \"power this week\" gives the supply log to copy.",
}, "Home and paperwork");

/* ---------------- the brief and the one ping ---------------- */

async function watchList(db: Db, user: User, now: Date): Promise<Forecast[]> {
  const quiet = (homePrefs(user).quiet ?? {}) as Record<string, boolean>;
  const rows = await refillRows(db, user.id, new Date(now.getTime() - 400 * DAY));
  return WATCHED.filter((k) => !quiet[k]).map((k) => forecast(rows, k)).filter((f): f is Forecast => !!f);
}
const endLine = (fs: Forecast[], tz: string, now: Date) => {
  const L = local(now, tz);
  const bits = fs.map((f) => `${f === fs[0] ? cap(WORD[f.kind]) : WORD[f.kind]} ${f.endAt < now ? "may have run out" : `may run out ${dayWord(local(f.endAt, tz), L) === "today" ? "today" : `around ${dayWord(local(f.endAt, tz), L)}`}`}`);
  return `${andList(bits)}${fs.length === 1 ? `; ${lasts(fs[0])}` : ""}.`;
};

addBriefSection({
  key: "home_utilities", order: 30,
  async lines(db, user, now) {
    const soon = (await watchList(db, user, now)).filter((f) => { const d = (f.endAt.getTime() - now.getTime()) / DAY; return d <= 3 && d >= -1; });
    return soon.length ? [endLine(soon, user.tz, now)] : [];
  },
});

addSystemJob("home_utilities", "17 * * * *");
onJob("home_utilities", async (_job, deps) => {
  const now = new Date();
  for (const user of await usersIn(deps.db, `SELECT DISTINCT user_id FROM home_refills WHERE at > $1`, [new Date(now.getTime() - 400 * DAY)])) {
    const h = local(now, user.tz).hour;
    if (h < 9 || h > 20) continue;
    const due = (await watchList(deps.db, user, now)).filter((f) => { const d = (f.endAt.getTime() - now.getTime()) / DAY; return d > 0.5 && d <= 2.5 && !f.last.pinged; });
    if (!due.length) continue;
    const kinds = due.map((f) => f.kind);
    const text = `${endLine(due, user.tz, now)} Say "stop the ${kinds.length === 1 ? kinds[0] : "utility"} reminders" to turn these off.`;
    const buttons = kinds.length === 1 ? [{ label: kinds[0] === "gas" ? "Refilled" : kinds[0] === "power" ? "Topped up" : "Delivered", data: `hm:ref:${kinds[0]}` }, { label: "Stop these", data: `hm:quiet:${kinds[0]}` }] : undefined;
    if (await pingOnce(deps, user, "utilities", text, { buttons, now })) {
      await deps.db.query(`UPDATE home_refills SET pinged=true WHERE id = ANY($1)`, [due.map((f) => f.last.id)]);
    }
  }
});

/** Buttons from the ping: "hm:ref:gas" logs a refill like the last one, "hm:quiet:gas" stops the warnings, "hm:log:power:7" sends the log. */
export async function utilityButton(db: Db, user: User, parts: string[], now: Date): Promise<string | null> {
  const [kind, a, b] = parts;
  if (kind === "ref" && (WATCHED as readonly string[]).includes(a)) {
    const last = await db.one<{ qty: string | null; unit: string | null }>(`SELECT qty::text, unit FROM home_refills WHERE user_id=$1 AND kind=$2 ORDER BY at DESC LIMIT 1`, [user.id, a]);
    await db.query(`INSERT INTO home_refills (user_id, kind, qty, unit, at) VALUES ($1,$2,$3,$4,$5)`, [user.id, a, last?.qty ?? null, last?.unit ?? null, now]);
    return `${cap(a === "power" ? "power top-up" : a === "gas" ? "gas refill" : "water delivery")} logged for today. Tell me the cost any time, like "${a === "gas" ? "gas refill" : a === "power" ? "topped up electricity" : "water delivery"} for 15000".`;
  }
  if (kind === "quiet" && (WATCHED as readonly string[]).includes(a)) {
    await setHome(db, user, { quiet: { ...(homePrefs(user).quiet ?? {}), [a]: true } });
    return `No more ${WORD[a]} reminders. The log stays; say "start the ${a} reminders" to have them back.`;
  }
  if (kind === "log" && ["power", "water", "internet"].includes(a)) return "```\n" + (await outageLog(db, user, a, Math.min(92, Math.max(1, Number(b) || 7)), now)) + "\n```";
  return null;
}
