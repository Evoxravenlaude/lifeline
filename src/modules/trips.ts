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
import { fmt, fmtDate, parseWhen } from "../core/time.js";
import { onJob, push, schedule } from "../core/scheduler.js";

const PACK_DEFAULTS = ["passport / ID", "charger + power bank", "SIM / eSIM or roaming", "cash in local currency", "meds", "travel insurance details"];

onJob("trip_alert", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const t = await deps.db.one<{ id: number; destination: string; starts_on: string; status: string }>(`SELECT id, destination, starts_on, status FROM trips WHERE id=$1`, [job.payload.tripId]);
  if (!t || t.status === "cancelled") return;
  const open = await deps.db.query<{ title: string }>(`SELECT title FROM trip_items WHERE trip_id=$1 AND NOT done ORDER BY id`, [t.id]);
  const list = open.length ? `\nStill open: ${open.map((o) => o.title).join(", ")}` : "\nChecklist complete.";
  await push(deps, user, "trip", `✈️ ${t.destination} in ${job.payload.daysBefore} day${job.payload.daysBefore === 1 ? "" : "s"} (${fmtDate(t.starts_on, user.tz)}).${list}`);
});

const create = defineAction({
  name: "trip.create",
  tier: 1,
  description: "Start planning a trip. Dates in natural language. Creates a default packing checklist and schedules nudges 7 and 1 days before departure.",
  schema: z.object({
    destination: z.string().min(1),
    start: z.string().optional(),
    end: z.string().optional(),
    budget: z.number().positive().optional(),
    currency: z.string().length(3).optional(),
    notes: z.string().optional(),
  }),
  async run(args, ctx) {
    const s = args.start ? parseWhen(args.start, ctx.user.tz, ctx.now) : null;
    const e = args.end ? parseWhen(args.end, ctx.user.tz, ctx.now) : null;
    const row = await ctx.db.one<{ id: number }>(
      `INSERT INTO trips (user_id, destination, starts_on, ends_on, budget, currency, notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [ctx.user.id, args.destination, s, e, args.budget ?? null, args.currency ?? "USD", args.notes ?? null],
    );
    for (const item of PACK_DEFAULTS) await ctx.db.query(`INSERT INTO trip_items (trip_id, kind, title) VALUES ($1,'pack',$2)`, [row!.id, item]);
    if (s) {
      for (const days of [7, 1]) {
        const at = new Date(s.getTime() - days * 86_400_000 + 9 * 3_600_000);
        if (at > ctx.now) await schedule(ctx.db, { userId: ctx.user.id, kind: "trip_alert", payload: { tripId: row!.id, daysBefore: days }, runAt: at });
      }
    }
    return {
      reply: `Trip #${row!.id} to ${args.destination}${s ? ` from ${fmtDate(s, ctx.user.tz)}` : ""}${e ? ` to ${fmtDate(e, ctx.user.tz)}` : ""}${args.budget ? `, budget ${args.budget} ${args.currency ?? "USD"}` : ""}. Packing checklist started; add flights, stays and to-dos with "add X to trip".`,
      undo: { payload: { tripId: row!.id } },
    };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE trips SET status='cancelled' WHERE id=$1 AND user_id=$2`, [p.tripId, ctx.user.id]);
    await ctx.db.query(`UPDATE jobs SET active=false WHERE kind='trip_alert' AND payload->>'tripId'=$1`, [String(p.tripId)]);
    return "Trip removed.";
  },
});

const addItem = defineAction({
  name: "trip.add_item",
  tier: 1,
  description: "Add an item to a trip: kind is 'flight', 'stay', 'transport', 'activity', 'pack' or 'todo'. Optional `at` (natural datetime) and `cost`. If trip_id is omitted, uses the next upcoming trip.",
  schema: z.object({
    trip_id: z.number().int().optional(),
    kind: z.enum(["flight", "stay", "transport", "activity", "pack", "todo"]),
    title: z.string().min(1),
    at: z.string().optional(),
    cost: z.number().nonnegative().optional(),
  }),
  async run(args, ctx) {
    const trip = await pickTrip(ctx, args.trip_id);
    if (!trip) return { reply: "No active trip. Say 'plan a trip to X' first." };
    const at = args.at ? parseWhen(args.at, ctx.user.tz, ctx.now) : null;
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO trip_items (trip_id, kind, title, at, cost) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [trip.id, args.kind, args.title, at, args.cost ?? null]);
    return { reply: `Added to ${trip.destination}: [${args.kind}] ${args.title}${at ? ` ${fmt(at, ctx.user.tz)}` : ""}${args.cost ? ` (${args.cost})` : ""}.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM trip_items WHERE id=$1 AND trip_id IN (SELECT id FROM trips WHERE user_id=$2)`, [p.id, ctx.user.id]);
    return "Item removed.";
  },
});

const tick = defineAction({
  name: "trip.tick",
  tier: 1,
  description: "Mark a trip checklist item done by title match (e.g. 'packed charger').",
  schema: z.object({ match: z.string().min(1), trip_id: z.number().int().optional() }),
  async run(args, ctx) {
    const trip = await pickTrip(ctx, args.trip_id);
    if (!trip) return { reply: "No active trip." };
    const r = await ctx.db.query(`UPDATE trip_items SET done=true WHERE id=(SELECT id FROM trip_items WHERE trip_id=$1 AND NOT done AND title ILIKE $2 LIMIT 1) RETURNING id, title`, [trip.id, `%${args.match}%`]);
    if (!r.length) return { reply: `Nothing matching "${args.match}" on the ${trip.destination} list.` };
    return { reply: `✅ ${r[0].title}`, undo: { payload: { id: r[0].id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE trip_items SET done=false WHERE id=$1`, [p.id]);
    return "Unticked.";
  },
});

const show = defineAction({
  name: "trip.show",
  tier: 1,
  description: "Show a trip's plan, checklist and spend vs budget.",
  schema: z.object({ trip_id: z.number().int().optional() }),
  async run(args, ctx) {
    const trip = await pickTrip(ctx, args.trip_id);
    if (!trip) return { reply: "No trips planned." };
    const items = await ctx.db.query<{ kind: string; title: string; at: string | null; cost: string | null; done: boolean }>(`SELECT kind, title, at, cost, done FROM trip_items WHERE trip_id=$1 ORDER BY at NULLS LAST, id`, [trip.id]);
    const spent = items.reduce((s, i) => s + Number(i.cost ?? 0), 0);
    const lines = [`${trip.destination}${trip.starts_on ? ` · ${fmtDate(trip.starts_on, ctx.user.tz)}${trip.ends_on ? ` → ${fmtDate(trip.ends_on, ctx.user.tz)}` : ""}` : ""}`];
    if (trip.budget) lines.push(`Budget ${trip.budget} ${trip.currency}, planned ${spent.toFixed(0)}`);
    for (const k of ["flight", "stay", "transport", "activity", "todo", "pack"]) {
      const g = items.filter((i) => i.kind === k);
      if (!g.length) continue;
      lines.push(`\n${k.toUpperCase()}`);
      for (const i of g) lines.push(`${i.done ? "✅" : "▫️"} ${i.title}${i.at ? ` — ${fmt(i.at, ctx.user.tz)}` : ""}${i.cost ? ` (${i.cost})` : ""}`);
    }
    return { reply: lines.join("\n") };
  },
});

async function pickTrip(ctx: any, id?: number) {
  return id
    ? ctx.db.one(`SELECT id, destination, starts_on, ends_on, budget, currency FROM trips WHERE id=$1 AND user_id=$2 AND status<>'cancelled'`, [id, ctx.user.id])
    : ctx.db.one(`SELECT id, destination, starts_on, ends_on, budget, currency FROM trips WHERE user_id=$1 AND status<>'cancelled' AND (ends_on IS NULL OR ends_on >= current_date) ORDER BY starts_on NULLS LAST, id DESC LIMIT 1`, [ctx.user.id]);
}

register(create, addItem, tick, show);
