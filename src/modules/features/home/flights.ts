/**
 * Flight status for trips, through AviationStack when AVIATIONSTACK_KEY is set (free plan: 100 requests
 * a month, live data only). "status of BA75 tomorrow" on request, and one automatic check a few hours
 * before each flight saved in a trip (trip_items of kind 'flight', read only). Frugal: every request is
 * counted, automatic checks stop at 80 a month so asking still works, and nothing is fetched twice a day.
 */
import { z } from "zod";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import type { Db } from "../../../core/db.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema, addSystemJob } from "../../../core/plugins.js";
import { onJob } from "../../../core/scheduler.js";
import { localDay } from "../../../core/time.js";
import { cacheGet, cachePut, dayWord, getJson, homePrefs, local, pingOnce, setHome, usersIn } from "./util.js";

addSchema(`CREATE TABLE IF NOT EXISTS home_flight_checks (item_id INT NOT NULL, day TEXT NOT NULL, user_id INT NOT NULL REFERENCES users(id), line TEXT, checked_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (item_id, day))`);

const key = () => process.env.AVIATIONSTACK_KEY ?? "";
let base = (process.env.AVIATIONSTACK_BASE ?? "https://api.aviationstack.com/v1").replace(/\/$/, "");
const MONTHLY = 100, AUTO_MAX = 80;
const CODE = /\b([A-Z]{2}|[A-Z][0-9]|[0-9][A-Z])\s?([0-9]{1,4})\b/;
export const flightCode = (s: string) => { const m = CODE.exec(s); return m ? `${m[1]}${m[2]}` : null; };

async function used(db: Db, now: Date): Promise<number> {
  return Number((await cacheGet<{ n: number }>(db, `aviationstack:${now.toISOString().slice(0, 7)}`, 40 * 86_400_000, now))?.n ?? 0);
}

/** Live flights for one flight number. Null when the service can't be reached; { error } when it said no. */
export async function lookup(db: Db, code: string, now: Date): Promise<{ flights: any[] } | { error: string } | null> {
  const month = `aviationstack:${now.toISOString().slice(0, 7)}`;
  const call = async () => {
    const n = await used(db, now);
    await cachePut(db, month, { n: n + 1 }, now);
    return getJson(`${base}/flights?access_key=${encodeURIComponent(key())}&flight_iata=${encodeURIComponent(code)}`, {}, 12_000);
  };
  let r = await call();
  // Some free plans only answer over plain http. The key would travel in the clear, so we don't fall back; say so instead.
  if (r?.data?.error?.code === "https_access_restricted" && process.env.AVIATIONSTACK_ALLOW_HTTP !== "true") return { error: "https_access_restricted" };
  if (r?.data?.error?.code === "https_access_restricted" && base.startsWith("https://")) { base = base.replace(/^https:/, "http:"); r = await call(); }
  if (!r) return null;
  if (r.data?.error) return { error: String(r.data.error.code ?? r.data.error.type ?? "error") };
  if (r.status >= 400) return { error: String(r.status) };
  return { flights: Array.isArray(r.data?.data) ? r.data.data : [] };
}

/** AviationStack writes airport-local clock times with a +00:00 offset; read the clock part as local time at that airport. */
const clock = (s?: string | null) => (typeof s === "string" && s.length >= 16 ? s.slice(11, 16) : null);
export function describe(f: any): string {
  const code = f.flight?.iata ?? "This flight";
  const airline = f.airline?.name ? ` (${f.airline.name})` : "";
  const route = f.departure?.airport && f.arrival?.airport ? `, ${f.departure.airport} to ${f.arrival.airport}` : "";
  const dep = f.departure ?? {}, arr = f.arrival ?? {};
  const delay = Number(dep.delay ?? 0);
  const s = String(f.flight_status ?? "scheduled");
  let state: string;
  if (s === "cancelled") state = "cancelled. Check with the airline about rebooking";
  else if (s === "landed") state = `landed${clock(arr.actual ?? arr.estimated) ? ` at ${clock(arr.actual ?? arr.estimated)} local time` : ""}`;
  else if (s === "active") state = `in the air${clock(arr.estimated ?? arr.scheduled) ? `, due in at ${clock(arr.estimated ?? arr.scheduled)} local time` : ""}`;
  else if (s === "diverted") state = "diverted. The airline will have the details";
  else if (s === "incident") state = "showing an incident. Check with the airline";
  else state = `scheduled to leave at ${clock(dep.scheduled) ?? "?"} local time${delay >= 15 ? `, about ${delay} minutes late, now ${clock(dep.estimated) ?? "later"}` : ", on time so far"}`;
  const gate = s === "scheduled" || s === "active" ? [dep.terminal ? `Terminal ${dep.terminal}` : "", dep.gate ? `gate ${dep.gate}` : ""].filter(Boolean).join(", ") : "";
  return `${code}${airline}${route}: ${state}.${gate ? ` ${gate.charAt(0).toUpperCase()}${gate.slice(1)}.` : ""}`;
}

const NO_KEY = "Flight status needs an AviationStack key on the server (AVIATIONSTACK_KEY; the free plan covers 100 checks a month). Until then, the airline's app or website has it.";

async function tripFlights(db: Db, user: User, from: Date, to: Date): Promise<{ id: number; title: string; at: string; code: string | null }[]> {
  const rows = await db.query<{ id: number; title: string; at: string }>(`SELECT ti.id, ti.title, ti.at FROM trip_items ti JOIN trips t ON t.id=ti.trip_id WHERE t.user_id=$1 AND t.status<>'cancelled' AND ti.kind='flight' AND ti.at >= $2 AND ti.at < $3 ORDER BY ti.at`, [user.id, from, to]);
  return rows.map((r) => ({ ...r, code: flightCode(r.title) }));
}

const status = defineAction({
  name: "flight.status",
  tier: 1,
  description: "Live status of a flight by its number (like BA75 or KQ532) for today, tomorrow or yesterday: departure time, delay, gate, landed or cancelled. With no number, the person's next flight saved in a trip. Needs an AviationStack key on the server.",
  schema: z.object({ flight: z.string().max(10).optional(), day: z.enum(["today", "tomorrow", "yesterday"]).optional() }),
  async run(a, ctx) {
    let code = a.flight ? a.flight.toUpperCase().replace(/\s+/g, "") : null;
    let day = a.day;
    if (!code) {
      const L = local(ctx.now, ctx.user.tz);
      const mine = (await tripFlights(ctx.db, ctx.user, L.startOf("day").toJSDate(), L.plus({ days: 2 }).endOf("day").toJSDate())).find((f) => f.code);
      if (!mine) return { reply: `Which flight? Say the number, like "status of BA75 tomorrow". Flights saved in a trip with their number get checked on the day.` };
      code = mine.code!;
      day = (["today", "tomorrow"] as const)[Math.max(0, Math.min(1, Math.round(local(mine.at, ctx.user.tz).startOf("day").diff(L.startOf("day"), "days").days)))];
    }
    if (!/^(?:[A-Z]{2}|[A-Z][0-9]|[0-9][A-Z])[0-9]{1,4}$/.test(code)) throw new Error(`"${a.flight}" doesn't look like a flight number. It's the airline's two characters and a number, like BA75 or KQ532.`);
    if (!key()) return { reply: NO_KEY };
    if ((await used(ctx.db, ctx.now)) >= MONTHLY) return { reply: `I've used this month's ${MONTHLY} free flight checks, so I can't look ${code} up until next month. The airline's app will have it.` };
    const r = await lookup(ctx.db, code, ctx.now);
    if (!r) throw new Error("I couldn't reach the flight status service just now. Try again in a few minutes.");
    if ("error" in r) return { reply: r.error === "https_access_restricted" ? "The flight service's plan only answers over an unencrypted connection, which would expose the server's key, so I didn't ask it. A paid plan, or AVIATIONSTACK_ALLOW_HTTP=true if you accept the risk, turns it on." : /usage_limit|limit_reached/i.test(r.error) ? `The flight service says this month's free checks are used up. The airline's app will have ${code}.` : /invalid_access_key|missing_access_key|inactive_user/i.test(r.error) ? "The flight service turned the server's key away; it may need renewing." : `The flight service couldn't look up ${code} just now. Try again later.` };
    const target = local(ctx.now, ctx.user.tz).plus({ days: day === "tomorrow" ? 1 : day === "yesterday" ? -1 : 0 }).toISODate()!;
    const f = r.flights.find((x) => x.flight_date === target);
    if (!f) {
      if (day === "tomorrow") return { reply: `${code} isn't in the live data for tomorrow yet; flights usually show up on the day. If it's saved in a trip, I'll check it a few hours before it leaves.` };
      return { reply: r.flights.length ? `I can't see ${code} for ${day ?? "today"}. The latest I have: ${describe(r.flights[0])}` : `I can't find a flight ${code} in the live data. Check the number on your booking?` };
    }
    return { reply: describe(f) };
  },
});

const checks = defineAction({
  name: "flight.checks",
  tier: 1,
  description: "Turn the automatic status check (and its one ping) for flights saved in trips on or off.",
  schema: z.object({ on: z.boolean() }),
  async run(a, ctx) {
    const prev = homePrefs(ctx.user).flightChecks !== false;
    await setHome(ctx.db, ctx.user, { flightChecks: a.on });
    return { reply: a.on ? "I'll check flights saved in your trips a few hours before they leave." : `No more automatic flight checks. You can still ask, like "status of BA75".`, undo: { payload: { prev } } };
  },
  async undo(p, ctx) { await setHome(ctx.db, ctx.user, { flightChecks: p.prev }); return "Put back as it was."; },
});

register(status, checks);

addRules(
  [/^(?:what'?s\s+the\s+)?(?:flight\s+)?status\s+(?:of|for)\s+(?:flight\s+)?([a-z0-9]{2}\s?\d{1,4})(?:\s+(today|tomorrow|yesterday))?\??$|^flight\s+status\s+(?:of\s+|for\s+)?([a-z0-9]{2}\s?\d{1,4})(?:\s+(today|tomorrow|yesterday))?\??$|^(?:is|has)\s+(?:flight\s+)?([a-z0-9]{2}\s?\d{1,4})\s+(?:on time|delayed|late|landed|cancelled)(?:\s+(today|tomorrow|yesterday))?\??$|^(?:track|check)\s+(?:my\s+)?flight\s+([a-z0-9]{2}\s?\d{1,4})(?:\s+(today|tomorrow|yesterday))?$/i,
    (m) => { const c = m[1] ?? m[3] ?? m[5] ?? m[7]; const d = m[2] ?? m[4] ?? m[6] ?? m[8]; return { action: "flight.status", args: { flight: c.replace(/\s+/g, "").toUpperCase(), ...(d ? { day: d.toLowerCase() } : {}) } }; }],
  [/^(?:is\s+my\s+flight\s+(?:on time|delayed|late)|(?:my\s+)?flight\s+status|how'?s\s+my\s+flight(?:\s+looking)?)\??$/i, () => ({ action: "flight.status", args: {} })],
  [/^(stop|turn off|no more|start|turn on)\s+(?:the\s+)?(?:automatic\s+)?flight\s+(?:checks|status checks|status pings)$/i, (m) => ({ action: "flight.checks", args: { on: /^(?:start|turn on)$/i.test(m[1]) } })],
);
addExamples("flight.status", ["status of BA75 tomorrow", "flight status KQ532", "is ET900 on time", "is my flight on time"]);
addExamples("flight.checks", ["stop flight checks", "turn on flight checks"]);
addCues("flight", ["flight status", "on time", "delayed", "gate", "boarding", "departure", "landed", "flight number"]);
addCapability({
  key: "flight_status", name: "Flight status",
  cues: ["flight status", "on time", "delayed", "gate", "landed", "my flight"],
  what: "Live status for a flight number: on time or late, gate and terminal, landed or cancelled. Flights saved in a trip with their number get checked automatically a few hours before they leave.",
  say: ["status of BA75 tomorrow", "is my flight on time"],
  then: "The automatic check is one ping on the day; say \"stop flight checks\" to turn it off. Add the flight to your trip with its number, like \"add flight BA75 to the trip on dec 20 10:40\".",
  limits: "Needs an AviationStack key on the server; its free plan covers 100 checks a month, so I use them sparingly.",
}, "Your day");

addSystemJob("home_flights", "23 * * * *");
onJob("home_flights", async (_job, deps) => {
  if (!key()) return;
  const now = new Date();
  const soon = new Date(now.getTime() + 5 * 3_600_000);
  for (const user of await usersIn(deps.db, `SELECT DISTINCT t.user_id FROM trip_items ti JOIN trips t ON t.id=ti.trip_id WHERE ti.kind='flight' AND ti.at > $1 AND ti.at <= $2`, [now, soon])) {
    if (homePrefs(user).flightChecks === false) continue;
    for (const f of await tripFlights(deps.db, user, now, soon)) {
      const day = localDay(now, user.tz);
      if (!f.code || (await deps.db.one(`SELECT 1 FROM home_flight_checks WHERE item_id=$1 AND day=$2`, [f.id, day]))) continue;
      if ((await used(deps.db, now)) >= AUTO_MAX) return;
      const r = await lookup(deps.db, f.code, now);
      const target = local(f.at, user.tz).toISODate();
      const hit = r && "flights" in r ? r.flights.find((x) => x.flight_date === target) ?? null : null;
      const line = hit ? describe(hit) : null;
      await deps.db.query(`INSERT INTO home_flight_checks (item_id, day, user_id, line, checked_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [f.id, day, user.id, line, now]);
      if (line) await pingOnce(deps, user, "flight", `${line} Safe travels. Say "stop flight checks" to turn these off.`, { now });
    }
  }
});

addBriefSection({
  key: "home_flight", order: 15,
  async lines(db, user, now) {
    const L = local(now, user.tz);
    const fs = await tripFlights(db, user, now, L.endOf("day").toJSDate());
    if (!fs.length) return [];
    const f = fs[0];
    const checked = await db.one<{ line: string | null }>(`SELECT line FROM home_flight_checks WHERE item_id=$1 AND day=$2`, [f.id, localDay(now, user.tz)]);
    if (checked?.line) return [checked.line];
    const when = `${dayWord(local(f.at, user.tz), L)} at ${local(f.at, user.tz).toFormat("HH:mm")}`;
    return [`Flight ${f.code ?? f.title} ${when}.${f.code && key() ? " I'll check its status a few hours before." : ""}`];
  },
});
