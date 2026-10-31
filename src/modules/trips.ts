/**
 * Trip planning as a ledger, not a booking engine. The bot keeps the plan,
 * the checklist and the budget; booking anything with money is out of scope
 * (the research found agents fail at payment and CAPTCHAs and the travel APIs
 * are paid-per-order). Flight/hotel items are tracked by the user pasting
 * confirmations; the bot extracts and echoes dates.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { fmt, fmtDate, parseWhen, parseRange, parseMoney, settle } from "../core/time.js";
import { onJob, push, schedule } from "../core/scheduler.js";
import { DateTime } from "luxon";
import * as chrono from "chrono-node";

const PACK_DEFAULTS = ["passport or ID", "charger and power bank", "SIM, eSIM or roaming", "cash in local currency", "medication", "travel insurance details"];

interface TripRow { id: number; destination: string; starts_on: string | null; ends_on: string | null; budget: string | null; currency: string }

function dates(t: { starts_on: string | Date | null; ends_on: string | Date | null }, tz: string): string {
  if (!t.starts_on) return "";
  const s = DateTime.fromJSDate(new Date(t.starts_on)).setZone(tz);
  if (!t.ends_on) return `from ${s.toFormat("d LLL")}`;
  const e = DateTime.fromJSDate(new Date(t.ends_on)).setZone(tz);
  return s.month === e.month ? `${s.toFormat("d")} to ${e.toFormat("d LLLL")}` : `${s.toFormat("d LLL")} to ${e.toFormat("d LLL")}`;
}

/** Destinations get every word capitalised ("port harcourt"); other text just its first letter. */
function cap(s: string, every = false): string {
  return every ? s.replace(/\b[a-z]/g, (c) => c.toUpperCase()) : s.charAt(0).toUpperCase() + s.slice(1);
}

onJob("trip_alert", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const t = await deps.db.one<{ id: number; destination: string; starts_on: string; status: string }>(`SELECT id, destination, starts_on, status FROM trips WHERE id=$1`, [job.payload.tripId]);
  if (!t || t.status === "cancelled") return;
  const open = await deps.db.query<{ title: string }>(`SELECT title FROM trip_items WHERE trip_id=$1 AND NOT done ORDER BY id`, [t.id]);
  const days = job.payload.daysBefore;
  const head = days === 1 ? `${cap(t.destination, true)} is tomorrow.` : `${cap(t.destination, true)} in ${days} days, ${fmtDate(t.starts_on, user.tz)}.`;
  const list = open.length ? ` Still open: ${open.map((o) => o.title).join(", ")}.` : " Everything on the list is ticked.";
  await push(deps, user, "trip", head + list);
});

const create = defineAction({
  name: "trip.create",
  tier: 1,
  description: "Start planning a trip. Dates in natural language (or ISO). Creates a default packing checklist and schedules nudges 7 and 1 days before departure. If the user gave no dates, leave start/end empty and the bot will ask.",
  schema: z.object({
    destination: z.string().min(1),
    start: z.string().optional(),
    end: z.string().optional(),
    budget: z.number().positive().optional(),
    currency: z.string().length(3).optional(),
    notes: z.string().optional(),
  }),
  needs(args) {
    if (!args.start) return { need: "dates", question: `${cap(args.destination, true)}, nice. When are you going? Dates, or roughly, or say skip and I'll hold the trip without them.` };
    return null;
  },
  fill(need, answer, _args, ctx) {
    if (need !== "dates") return null;
    const r = parseRange(answer, ctx.user.tz, ctx.now);
    if (!r) return null;
    const out: Record<string, unknown> = { start: r.start.toISOString(), end: r.end?.toISOString() };
    const m = parseMoney(answer.replace(/\b\d{1,2}(?:st|nd|rd|th)?\b/g, ""));
    if (m && m.amount >= 50) { out.budget = m.amount; out.currency = m.currency; }
    return out;
  },
  async run(args, ctx) {
    const s = args.start ? parseWhen(args.start, ctx.user.tz, ctx.now) : null;
    const e = args.end ? parseWhen(args.end, ctx.user.tz, ctx.now) : null;
    const dest = args.destination.trim();
    // Same place, no dates yet: this is the same trip, now with dates.
    const twin = await ctx.db.one<TripRow>(`SELECT id, destination, starts_on, ends_on, budget, currency FROM trips WHERE user_id=$1 AND status<>'cancelled' AND lower(destination)=lower($2) AND starts_on IS NULL ORDER BY id DESC LIMIT 1`, [ctx.user.id, dest]);
    if (twin && s) {
      await ctx.db.query(`UPDATE trips SET starts_on=$2, ends_on=$3, budget=COALESCE($4, budget), currency=COALESCE($5, currency) WHERE id=$1`, [twin.id, s, e, args.budget ?? null, args.currency ?? null]);
      await scheduleNudges(ctx, twin.id, s);
      return { reply: `${cap(dest, true)}, ${dates({ starts_on: s, ends_on: e }, ctx.user.tz)}. Updated the trip you'd already started.${args.budget ? ` Budget ${money(args.budget, args.currency ?? twin.currency)}.` : ""}` };
    }
    const existing = await ctx.db.one<TripRow>(`SELECT id, destination, starts_on, ends_on, budget, currency FROM trips WHERE user_id=$1 AND status<>'cancelled' AND lower(destination)=lower($2) AND (ends_on IS NULL OR ends_on >= current_date) ORDER BY id DESC LIMIT 1`, [ctx.user.id, dest]);
    const row = await ctx.db.one<{ id: number }>(
      `INSERT INTO trips (user_id, destination, starts_on, ends_on, budget, currency, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.user.id, dest, s, e, args.budget ?? null, args.currency ?? "USD", args.notes ?? null],
    );
    for (const item of PACK_DEFAULTS) await ctx.db.query(`INSERT INTO trip_items (trip_id, kind, title) VALUES ($1,'pack',$2)`, [row!.id, item]);
    if (s) await scheduleNudges(ctx, row!.id, s);
    const head = s ? `${cap(dest, true)}, ${dates({ starts_on: s, ends_on: e }, ctx.user.tz)}.` : `${cap(dest, true)}, dates open.`;
    const budget = args.budget ? ` Budget ${money(args.budget, args.currency ?? "USD")}.` : "";
    const next = s
      ? ` I've started a packing list and I'll nudge you a week before and the day before. Tell me flights and stays as you book them${args.budget ? "" : ", and a budget if you want me to watch it"}.`
      : ` I've started a packing list. Give me dates whenever you have them and I'll set the nudges.`;
    const twinNote = existing ? ` That's a second ${cap(dest, true)} trip; the first is ${dates(existing, ctx.user.tz) || "undated"}.` : "";
    return { reply: head + budget + next + twinNote, undo: { payload: { tripId: row!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE trips SET status='cancelled' WHERE id=$1 AND user_id=$2`, [p.tripId, ctx.user.id]);
    await ctx.db.query(`UPDATE jobs SET active=false WHERE kind='trip_alert' AND payload->>'tripId'=$1`, [String(p.tripId)]);
    return "Trip scrapped.";
  },
});

async function scheduleNudges(ctx: any, tripId: number, start: Date) {
  await ctx.db.query(`UPDATE jobs SET active=false WHERE kind='trip_alert' AND payload->>'tripId'=$1`, [String(tripId)]);
  for (const days of [7, 1]) {
    const at = new Date(start.getTime() - days * 86_400_000 + 9 * 3_600_000);
    if (at > ctx.now) await schedule(ctx.db, { userId: ctx.user.id, kind: "trip_alert", payload: { tripId, daysBefore: days }, runAt: at });
  }
}

function money(n: number | string, cur: string): string {
  const v = Number(n);
  return `${v.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${cur}`;
}

const KIND_WORD: Record<string, string> = { flight: "flight", stay: "stay", transport: "ride", activity: "plan", pack: "packing item", todo: "to-do" };

const addItem = defineAction({
  name: "trip.add_item",
  tier: 1,
  description: "Add an item to a trip: kind is 'flight', 'stay', 'transport', 'activity', 'pack' or 'todo'. Optional `at` (natural datetime) and `cost`. If trip_id is omitted, uses the next upcoming trip. Use `destination` to name the trip instead of an id.",
  schema: z.object({
    trip_id: z.number().int().optional(),
    destination: z.string().optional(),
    kind: z.enum(["flight", "stay", "transport", "activity", "pack", "todo"]),
    title: z.string().min(1),
    at: z.string().optional(),
    cost: z.number().nonnegative().optional(),
  }),
  async run(args, ctx) {
    const trip = await pickTrip(ctx, args.trip_id, args.destination);
    if (!trip) return { reply: "There's no trip to add that to yet. Say where you're going and I'll start one." };
    let title = args.title.trim();
    let at = args.at ? parseWhen(args.at, ctx.user.tz, ctx.now) : null;
    if (!at) {
      // "flight LOS to ACC on dec 20 at 7am": the time is in the title
      const ref = DateTime.fromJSDate(ctx.now).setZone(ctx.user.tz);
      const found = chrono.parse(title, { instant: ctx.now, timezone: ref.offset }, { forwardDate: true })[0];
      if (found && /\d/.test(found.text)) { at = settle(found.start, ctx.user.tz, found.text); title = title.replace(found.text, "").replace(/\s+(?:on|at|for)\s*$/i, "").replace(/\s{2,}/g, " ").trim() || args.title; }
    }
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO trip_items (trip_id, kind, title, at, cost) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [trip.id, args.kind, title, at, args.cost ?? null]);
    const spent = await plannedSpend(ctx, trip.id);
    const vs = trip.budget && args.cost ? ` That's ${money(spent, trip.currency)} of your ${money(trip.budget, trip.currency)}.` : "";
    return { reply: `${cap(title)} on the ${cap(trip.destination, true)} ${KIND_WORD[args.kind]} list${at ? `, ${fmt(at, ctx.user.tz)}` : ""}${args.cost ? ` (${money(args.cost, trip.currency)})` : ""}.${vs}`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM trip_items WHERE id=$1 AND trip_id IN (SELECT id FROM trips WHERE user_id=$2)`, [p.id, ctx.user.id]);
    return "Taken off the trip.";
  },
});

const tick = defineAction({
  name: "trip.tick",
  tier: 1,
  description: "Mark a trip checklist item done by title match (e.g. 'packed charger').",
  schema: z.object({ match: z.string().min(1), trip_id: z.number().int().optional(), destination: z.string().optional() }),
  async run(args, ctx) {
    const trip = await pickTrip(ctx, args.trip_id, args.destination);
    if (!trip) return { reply: "No trip on the books right now." };
    const r = await ctx.db.query(`UPDATE trip_items SET done=true WHERE id=(SELECT id FROM trip_items WHERE trip_id=$1 AND NOT done AND title ILIKE $2 LIMIT 1) RETURNING id, title`, [trip.id, `%${args.match}%`]);
    if (!r.length) return { reply: `Nothing like "${args.match}" is open on the ${cap(trip.destination, true)} list.` };
    const left = await ctx.db.one<{ n: string }>(`SELECT count(*)::text AS n FROM trip_items WHERE trip_id=$1 AND NOT done`, [trip.id]);
    const n = Number(left?.n ?? 0);
    return { reply: `${cap(r[0].title)}, ticked. ${n === 0 ? "That's everything." : `${n} left.`}`, undo: { payload: { id: r[0].id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE trip_items SET done=false WHERE id=$1`, [p.id]);
    return "Unticked.";
  },
});

const show = defineAction({
  name: "trip.show",
  tier: 1,
  description: "Show a trip's plan, checklist and spend vs budget. Name the destination to pick one; otherwise the next upcoming trip.",
  schema: z.object({ trip_id: z.number().int().optional(), destination: z.string().optional() }),
  async run(args, ctx) {
    const trip = await pickTrip(ctx, args.trip_id, args.destination);
    if (!trip) return { reply: "No trips planned. Say where you're going and I'll start one." };
    const items = await ctx.db.query<{ kind: string; title: string; at: string | null; cost: string | null; done: boolean }>(`SELECT kind, title, at, cost, done FROM trip_items WHERE trip_id=$1 ORDER BY at NULLS LAST, id`, [trip.id]);
    const spent = items.reduce((s, i) => s + Number(i.cost ?? 0), 0);
    const lines = [`${cap(trip.destination, true)}${trip.starts_on ? `, ${dates(trip, ctx.user.tz)}` : ", dates open"}.`];
    if (trip.budget) lines.push(`Budget ${money(trip.budget, trip.currency)}, ${money(spent, trip.currency)} planned so far.`);
    const words: Record<string, string> = { flight: "Flights", stay: "Stays", transport: "Getting around", activity: "Plans", todo: "To do", pack: "Packing" };
    for (const k of ["flight", "stay", "transport", "activity", "todo", "pack"]) {
      const g = items.filter((i) => i.kind === k);
      if (!g.length) continue;
      const open = g.filter((i) => !i.done);
      lines.push("", k === "pack" ? `${words[k]}: ${open.length ? open.map((i) => i.title).join(", ") : "all packed"}${g.length - open.length ? ` (${g.length - open.length} ticked)` : ""}` : words[k]);
      if (k !== "pack") for (const i of g) lines.push(`${i.done ? "done: " : ""}${i.title}${i.at ? `, ${fmt(i.at, ctx.user.tz)}` : ""}${i.cost ? ` (${money(i.cost, trip.currency)})` : ""}`);
    }
    return { reply: lines.join("\n") };
  },
});

async function plannedSpend(ctx: any, tripId: number): Promise<number> {
  const r = await ctx.db.one(`SELECT coalesce(sum(cost),0)::text AS s FROM trip_items WHERE trip_id=$1`, [tripId]);
  return Number(r?.s ?? 0);
}

async function pickTrip(ctx: any, id?: number, destination?: string): Promise<TripRow | undefined> {
  if (id) return ctx.db.one(`SELECT id, destination, starts_on, ends_on, budget, currency FROM trips WHERE id=$1 AND user_id=$2 AND status<>'cancelled'`, [id, ctx.user.id]);
  if (destination) {
    const t = await ctx.db.one(`SELECT id, destination, starts_on, ends_on, budget, currency FROM trips WHERE user_id=$1 AND status<>'cancelled' AND destination ILIKE $2 ORDER BY starts_on NULLS LAST, id DESC LIMIT 1`, [ctx.user.id, `%${destination}%`]);
    if (t) return t;
  }
  return ctx.db.one(`SELECT id, destination, starts_on, ends_on, budget, currency FROM trips WHERE user_id=$1 AND status<>'cancelled' AND (ends_on IS NULL OR ends_on >= current_date) ORDER BY starts_on NULLS LAST, id DESC LIMIT 1`, [ctx.user.id]);
}

register(create, addItem, tick, show);
