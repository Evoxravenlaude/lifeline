/**
 * Measures: anything a person wants to keep a number (or a word) on over
 * time. Weight, sleep, water, mood, steps, blood pressure, lifts, routines.
 * One table, names normalised so "slept 7 hours" and "sleep 7h" land together.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { parseWhen } from "../core/time.js";

/** Common ways of naming the same thing. */
const NAMES: [RegExp, string, string | null][] = [
  [/^(?:weigh(?:t|ed|s)?|body ?weight)$/i, "weight", "kg"],
  [/^(?:slept|sleep|sleeping)$/i, "sleep", "hours"],
  [/^(?:water|drank|drink|hydration)$/i, "water", "litres"],
  [/^mood$/i, "mood", null],
  [/^(?:steps?|walked)$/i, "steps", "steps"],
  [/^(?:bp|blood ?pressure)$/i, "blood pressure", "mmHg"],
  [/^(?:bench(?:ed)?|bench ?press)$/i, "bench press", "kg"],
  [/^(?:squat(?:ted)?|squats)$/i, "squat", "kg"],
  [/^(?:dead ?lift(?:ed)?|deadlifts)$/i, "deadlift", "kg"],
  [/^(?:ohp|pressed|overhead press|military press)$/i, "overhead press", "kg"],
  [/^(?:resting )?(?:heart ?rate|hr|pulse)$/i, "heart rate", "bpm"],
  [/^(?:(?:blood )?sugar|glucose)$/i, "blood sugar", null],
];

export function normaliseMeasure(name: string): { name: string; unit: string | null } {
  const n = name.trim().toLowerCase().replace(/^my\s+/, "").replace(/\s+/g, " ");
  for (const [re, canon, unit] of NAMES) if (re.test(n)) return { name: canon, unit };
  return { name: n, unit: null };
}

const UNIT: Record<string, string> = { kg: "kg", kgs: "kg", kilo: "kg", kilos: "kg", lb: "lb", lbs: "lb", pound: "lb", pounds: "lb", h: "hours", hr: "hours", hrs: "hours", hour: "hours", hours: "hours", l: "litres", litre: "litres", litres: "litres", liter: "litres", liters: "litres", ml: "ml", glass: "glasses", glasses: "glasses", cup: "cups", cups: "cups", bottle: "bottles", bottles: "bottles", step: "steps", steps: "steps", bpm: "bpm" };
export const normaliseUnit = (u?: string | null) => (u ? UNIT[u.toLowerCase()] ?? u : null);

const num = (v: number) => (Number.isInteger(v) ? v.toLocaleString("en-US") : v.toLocaleString("en-US", { maximumFractionDigits: 1 }));
/** "72.4 kg", "120/80 mmHg", "80 kg, x5", "10,000" (steps say themselves), or the word for a word-only entry. */
const say = (v: number | null, unit: string | null, note: string | null) => {
  const u = unit && unit !== "steps" ? ` ${unit}` : "";
  if (v == null) return note ?? "";
  if (note && /\//.test(note)) return `${note}${unit === "mmHg" ? u : ""}`;
  return `${num(v)}${u}${note ? `, ${note}` : ""}`;
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const logIt = defineAction({
  name: "measure.log",
  tier: 1,
  description: "Log a measurement or yes/no for anything tracked over time: weight, sleep hours, water, mood (number or word), steps, blood pressure (value=systolic, note='120/80'), lifts (value=weight, note='x5'), routines like skincare (no value). Optional `when` in words.",
  schema: z.object({ name: z.string().min(1).max(60), value: z.number().optional(), unit: z.string().max(20).optional(), note: z.string().max(120).optional(), when: z.string().optional() }),
  async run(args, ctx) {
    const { name, unit: defUnit } = normaliseMeasure(args.name);
    const unit = normaliseUnit(args.unit) ?? (args.value != null ? defUnit : null);
    const at = (args.when && parseWhen(args.when, ctx.user.tz, ctx.now)) || ctx.now;
    const when = at > ctx.now ? ctx.now : at;
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO measures (user_id, name, value, unit, note, at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.user.id, name, args.value ?? null, unit, args.note ?? null, when]);
    let compare = "";
    if (args.value != null) {
      const weekAgo = await ctx.db.one<{ value: string; unit: string | null }>(`SELECT value::text, unit FROM measures WHERE user_id=$1 AND name=$2 AND value IS NOT NULL AND id<>$3 AND at <= $4::timestamptz - interval '6 days' ORDER BY at DESC LIMIT 1`, [ctx.user.id, name, r!.id, when]);
      const prev = weekAgo ?? (await ctx.db.one<{ value: string; unit: string | null }>(`SELECT value::text, unit FROM measures WHERE user_id=$1 AND name=$2 AND value IS NOT NULL AND id<>$3 ORDER BY at DESC LIMIT 1`, [ctx.user.id, name, r!.id]));
      if (prev && (prev.unit ?? null) === unit) {
        const d = args.value - Number(prev.value);
        const word = weekAgo ? "on last week" : "on last time";
        compare = d === 0 ? ` Same as ${weekAgo ? "last week" : "last time"}.` : ` That's ${num(Math.abs(d))}${unit && unit !== "steps" ? ` ${unit}` : ""} ${d > 0 ? "up" : "down"} ${word}.`;
      }
    }
    const what = args.value == null && !args.note ? `${cap(name)}, done for today` : args.value == null ? `${cap(name)}: ${args.note}` : `${cap(name)} ${say(args.value, unit, args.note ?? null)}`;
    return { reply: `${what}. Logged.${compare}`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM measures WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Taken off.";
  },
});

const show = defineAction({
  name: "measure.show",
  tier: 1,
  description: "Show how one tracked measure has gone: average, low, high and change, over `days` (default 7; 30 for 'this month').",
  schema: z.object({ name: z.string().min(1), days: z.number().int().min(1).max(365).optional() }),
  async run(args, ctx) {
    const { name } = normaliseMeasure(args.name);
    const days = args.days ?? 7;
    const rows = await ctx.db.query<{ value: string | null; unit: string | null; note: string | null; at: string }>(
      `SELECT value::text, unit, note, at FROM measures WHERE user_id=$1 AND name=$2 AND at >= $3::timestamptz - ($4::int * interval '1 day') ORDER BY at`,
      [ctx.user.id, name, ctx.now, days],
    );
    const period = days === 7 ? "this week" : days === 30 ? "this month" : `in the last ${days} days`;
    if (!rows.length) {
      const any = await ctx.db.one(`SELECT 1 FROM measures WHERE user_id=$1 AND name=$2`, [ctx.user.id, name]);
      return { reply: any ? `Nothing logged for ${name} ${period}.` : `I'm not tracking ${name} yet. Log one, like "${name === "weight" ? "weight 72kg" : name === "sleep" ? "slept 7 hours" : `${name} ...`}", and I'll keep the trend.` };
    }
    const vals = rows.filter((r) => r.value != null).map((r) => Number(r.value));
    const unit = rows.find((r) => r.unit)?.unit ?? null;
    const u = unit && unit !== "steps" ? ` ${unit}` : "";
    const fmtAt = (at: string) => DateTime.fromJSDate(new Date(at)).setZone(ctx.user.tz).toFormat("ccc d LLL");
    let head: string;
    if (vals.length) {
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      const change = vals.length > 1 ? vals[vals.length - 1] - vals[0] : 0;
      head = `${cap(name)} ${period}: about ${num(avg)}${u} on average, low ${num(Math.min(...vals))}, high ${num(Math.max(...vals))}.${vals.length > 1 ? ` ${change === 0 ? "No change" : `${change > 0 ? "Up" : "Down"} ${num(Math.abs(change))}${u}`} from first to last.` : ""}`;
    } else head = `${cap(name)} ${period}: ${rows.length} time${rows.length === 1 ? "" : "s"}.`;
    const recent = rows.slice(-7).reverse().map((r) => `${fmtAt(r.at)}: ${say(r.value == null ? null : Number(r.value), r.unit, r.note) || "done"}`);
    return { reply: [head, ...recent].join("\n") };
  },
});

const list = defineAction({
  name: "measure.list",
  tier: 1,
  description: "List everything the user is tracking as measures, with the latest value of each.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ name: string; value: string | null; unit: string | null; note: string | null; n: string }>(
      `SELECT DISTINCT ON (name) name, value::text, unit, note, (SELECT count(*) FROM measures m2 WHERE m2.user_id=m.user_id AND m2.name=m.name)::text AS n FROM measures m WHERE user_id=$1 ORDER BY name, at DESC`,
      [ctx.user.id],
    );
    if (!rows.length) return { reply: `Nothing tracked yet. Say things like "weight 72kg", "slept 7 hours" or "mood 4/5" and I'll keep the trend.` };
    return { reply: [rows.length === 1 ? "One thing tracked." : `${rows.length} things tracked.`, ...rows.map((r) => `${cap(r.name)}: last ${say(r.value == null ? null : Number(r.value), r.unit, r.note) || "done"}, ${r.n} entr${r.n === "1" ? "y" : "ies"}`)].join("\n") };
  },
});

const forget = defineAction({
  name: "measure.forget",
  tier: 2,
  description: "Delete every entry for one tracked measure.",
  schema: z.object({ name: z.string().min(1) }),
  echo: (a) => `This deletes every ${normaliseMeasure(a.name).name} entry you've logged. It can't be undone.`,
  async run(args, ctx) {
    const { name } = normaliseMeasure(args.name);
    const r = await ctx.db.query(`DELETE FROM measures WHERE user_id=$1 AND name=$2 RETURNING id`, [ctx.user.id, name]);
    return { reply: r.length ? `Deleted ${r.length} ${name} entr${r.length === 1 ? "y" : "ies"}.` : `There was nothing logged for ${name}.` };
  },
});

register(logIt, show, list, forget);
