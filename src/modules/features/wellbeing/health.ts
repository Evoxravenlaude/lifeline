/**
 * Health admin: checkup reminders on the person's own schedule, a private symptom log, and a one-page
 * plain summary of the last 90 days to show a doctor. The summary reports what was logged and nothing
 * else: no interpretation, no diagnosis, no advice.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import type { Db } from "../../../core/db.js";
import { canEmail, sendEmail } from "../../../core/email.js";
import { cycleRows, cyclePicture, cyclePrefs } from "../../cycle.js";
import { cap, daysBetween, first, iso, monthOf, MONTHS, pastDay, rx, sayDay, toNum, today } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS well_checkups (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT NOT NULL, every_months INT, month INT, next_due DATE NOT NULL, last_done DATE, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS well_checkups_user ON well_checkups(user_id, active);
CREATE TABLE IF NOT EXISTS well_symptoms (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), what TEXT NOT NULL, severity TEXT, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS well_symptoms_user ON well_symptoms(user_id, at)`);

/* ---------------- checkups ---------------- */

/** Words that make something a health appointment, so "gym every week" never becomes a checkup. */
export const HEALTH_WORD = String.raw`(?:check ?-?ups?|checks?|tests?|screenings?|jabs?|shots?|vaccin\w*|boosters?|exams?|scans?|smears?|pap|mammograms?|dentist|dental|hygienist|eye|eyes|optician|hearing|physio|blood ?work|bloods|blood pressure|cholesterol|prostate|skin|mole|colonoscopy|appointment|review)`;

interface Checkup { id: number; name: string; every_months: number | null; month: number | null; next_due: string; last_done: string | null }
const CHECKUPS = `SELECT id, name, every_months, month, to_char(next_due,'YYYY-MM-DD') AS next_due, to_char(last_done,'YYYY-MM-DD') AS last_done FROM well_checkups WHERE user_id=$1 AND active`;

const sayInterval = (c: { every_months: number | null; month: number | null }) =>
  c.month ? `every ${cap(MONTHS[c.month - 1])}` : c.every_months === 1 ? "every month" : c.every_months === 12 ? "every year" : c.every_months! % 12 === 0 ? `every ${c.every_months! / 12} years` : `every ${c.every_months} months`;

/** The next due day after `from` (inclusive of this month when it's the named month and nothing's been done yet). */
function nextDue(c: { every_months: number | null; month: number | null }, from: DateTime, fresh: boolean): string {
  if (c.month) {
    let d = from.set({ month: c.month, day: 1 });
    if (fresh ? d.plus({ months: 1 }) <= from : d <= from) d = d.plus({ years: 1 });
    return iso(d);
  }
  return iso(from.plus({ months: c.every_months ?? 12 }));
}

const words = (s: string) => new Set(s.toLowerCase().replace(/dentist/g, "dental").replace(/eyes|optician/g, "eye").replace(/check ?-?ups?|checks?/g, "check").split(/[^a-z]+/).filter((w) => w.length > 2 && !["the", "my", "and", "for"].includes(w)));
async function findCheckup(db: Db, user: User, name: string): Promise<Checkup | undefined> {
  const all = await db.query<Checkup>(`${CHECKUPS} ORDER BY id`, [user.id]);
  const want = words(name);
  const score = (c: Checkup) => [...words(c.name)].filter((w) => want.has(w) && w !== "check" && w !== "test").length * 2 + [...words(c.name)].filter((w) => want.has(w)).length;
  return all.map((c) => ({ c, s: score(c) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s)[0]?.c;
}

const checkupAdd = defineAction({
  name: "checkup.add",
  tier: 1,
  description: "A health checkup reminder on the person's own schedule: 'dental checkup every 6 months', 'eye test yearly', 'smear test every 3 years', 'flu jab every October'. `every_months` for an interval, or `month` 1-12 for a fixed month each year. Shown in the morning brief when due; never advice.",
  schema: z.object({ name: z.string().min(2).max(60), every_months: z.number().int().min(1).max(120).optional(), month: z.number().int().min(1).max(12).optional() }),
  async run(args, ctx) {
    if (!args.every_months && !args.month) throw new Error(`How often is the ${args.name}? Say "every 6 months", "yearly" or "every October".`);
    const name = cap(args.name.trim().replace(/^(?:my|a|an|the)\s+/i, ""));
    const c = { every_months: args.month ? null : args.every_months!, month: args.month ?? null };
    const due = nextDue(c, today(ctx.user, ctx.now), true);
    await ctx.db.query(`UPDATE well_checkups SET active=false WHERE user_id=$1 AND lower(name)=lower($2)`, [ctx.user.id, name]);
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO well_checkups (user_id, name, every_months, month, next_due) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.user.id, name, c.every_months, c.month, due]);
    const when = DateTime.fromISO(due).toFormat(DateTime.fromISO(due).year === today(ctx.user, ctx.now).year ? "LLLL" : "LLLL yyyy");
    return {
      reply: `${name}, ${sayInterval(c)}. I'll mention it in your morning brief when it's due, around ${when}.${c.month ? "" : ` If you had one recently, say "had my ${name.toLowerCase()} in March" and I'll count from then.`}`,
      undo: { payload: { id: r!.id } },
    };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE well_checkups SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Taken back."; },
});

const checkupDone = defineAction({
  name: "checkup.done",
  tier: 1,
  description: "Record that a checkup happened ('had my dental checkup', 'had my eye test in March'), which sets when the next one is due.",
  schema: z.object({ name: z.string().min(2).max(60), when: z.string().optional() }),
  async run(args, ctx) {
    const c = await findCheckup(ctx.db, ctx.user, args.name);
    if (!c) return { reply: `I'm not keeping a reminder for that. Say "${args.name.replace(/^my\s+/i, "")} every year" (or however often) to start one.` };
    const day = pastDay(args.when, ctx.user, ctx.now) ?? iso(today(ctx.user, ctx.now));
    const next = nextDue(c, DateTime.fromISO(day, { zone: ctx.user.tz }), false);
    await ctx.db.query(`UPDATE well_checkups SET last_done=$2, next_due=$3 WHERE id=$1`, [c.id, day, next]);
    return { reply: `${c.name}, done. The next one is due around ${sayDay(next, ctx.user.tz, ctx.now)}.`, undo: { payload: { id: c.id, last: c.last_done, due: c.next_due } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE well_checkups SET last_done=$2, next_due=$3 WHERE id=$1 AND user_id=$4`, [p.id, p.last, p.due, ctx.user.id]); return "Taken back."; },
});

const checkupList = defineAction({
  name: "checkup.list",
  tier: 1,
  description: "List health checkup reminders and when each is next due.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<Checkup>(`${CHECKUPS} ORDER BY next_due`, [ctx.user.id]);
    if (!rows.length) return { reply: `No checkups yet. Say things like "dental checkup every 6 months" or "flu jab every October".` };
    return { reply: rows.map((c) => `- ${c.name}, ${sayInterval(c)}: next ${c.next_due <= iso(today(ctx.user, ctx.now)) ? "due now" : `around ${sayDay(c.next_due, ctx.user.tz, ctx.now)}`}${c.last_done ? `, last ${sayDay(c.last_done, ctx.user.tz, ctx.now)}` : ""}`).join("\n") };
  },
});

const checkupRemove = defineAction({
  name: "checkup.remove",
  tier: 1,
  description: "Stop one health checkup reminder.",
  schema: z.object({ name: z.string().min(2) }),
  async run(args, ctx) {
    const c = await findCheckup(ctx.db, ctx.user, args.name);
    if (!c) return { reply: "I wasn't keeping a reminder like that." };
    await ctx.db.query(`UPDATE well_checkups SET active=false WHERE id=$1`, [c.id]);
    return { reply: `No more reminders for the ${c.name.toLowerCase()}.`, undo: { payload: { id: c.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE well_checkups SET active=true WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Back on."; },
});

/** A week ahead, on the day, then once a month while it's still open. Never daily. */
addBriefSection({
  key: "well_checkups", order: 30,
  async lines(db, user, now) {
    const t = iso(today(user, now));
    const rows = await db.query<Checkup>(`${CHECKUPS} ORDER BY next_due`, [user.id]);
    const say = rows.flatMap((c) => {
      const d = daysBetween(t, c.next_due);
      if (d === 7) return [`${c.name} is due next week.`];
      if (d === 0) return [`${c.name} is due now.`];
      if (d < 0 && -d % 30 === 0) return [`${c.name} is still open, no rush.`];
      return [];
    });
    if (!say.length) return [];
    return [`${say.slice(0, 2).join(" ")} Say "had my ${rows.find((c) => say[0].startsWith(c.name))!.name.toLowerCase()}" once it's done.`];
  },
});

/* ---------------- symptoms ---------------- */

const SEVERITY = /(?:[,;\s]+(?:it'?s\s+|it was\s+)?(very mild|mild|slight|moderate|bad|very bad|severe|awful|\d{1,2}\s*\/\s*10))$/i;

const symptomLog = defineAction({
  name: "symptom.log",
  tier: 1,
  description: "Log a symptom to the person's private symptom log ('log symptom: headache, mild'). `severity` in their words. For a doctor summary later; never interpreted.",
  schema: z.object({ what: z.string().min(2).max(120), severity: z.string().max(30).optional() }),
  async run(args, ctx) {
    let what = args.what.trim(), sev = args.severity?.trim();
    const m = !sev ? SEVERITY.exec(what) : null;
    if (m) { sev = m[1].replace(/\s+/g, ""); what = what.slice(0, m.index).trim(); }
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO well_symptoms (user_id, what, severity, at) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.user.id, what.toLowerCase(), sev?.toLowerCase() ?? null, ctx.now]);
    return { reply: `${cap(what)}${sev ? `, ${sev.toLowerCase()}` : ""}, kept privately. Ask for "my doctor summary" before an appointment and it'll be in there.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM well_symptoms WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Taken off."; },
});

const symptomList = defineAction({
  name: "symptom.list",
  tier: 1,
  description: "Show the private symptom log for the last 30 days.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ what: string; severity: string | null; at: string }>(`SELECT what, severity, at FROM well_symptoms WHERE user_id=$1 AND at >= $2::timestamptz - interval '30 days' ORDER BY at DESC LIMIT 20`, [ctx.user.id, ctx.now]);
    if (!rows.length) return { reply: `Nothing in your symptom log this month. Say "log symptom: headache, mild" to add one.` };
    return { reply: rows.map((r) => `- ${DateTime.fromJSDate(new Date(r.at)).setZone(ctx.user.tz).toFormat("d LLL")}: ${r.what}${r.severity ? `, ${r.severity}` : ""}`).join("\n") };
  },
});

/* ---------------- the doctor summary ---------------- */

const n1 = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

/** The last 90 days, as logged, in plain lines. Exported for tests. No interpretation. */
export async function healthSummary(db: Db, user: User, now: Date): Promise<string | null> {
  const t0 = today(user, now);
  const since = t0.minus({ days: 90 });
  const fmt = (d: string | Date) => DateTime.fromJSDate(new Date(d)).setZone(user.tz).toFormat("d LLL");
  const body: string[] = [];
  const m = await db.query<{ name: string; value: string | null; unit: string | null; note: string | null; at: string }>(
    `SELECT name, value::text, unit, note, at FROM measures WHERE user_id=$1 AND at >= $2 AND name IN ('blood pressure','weight','sleep','mood','heart rate','blood sugar') ORDER BY at`, [user.id, since.toJSDate()]);
  const of = (name: string) => m.filter((r) => r.name === name);
  const bp = of("blood pressure").filter((r) => r.note && /\d+\/\d+/.test(r.note));
  if (bp.length) {
    const sys = (r: typeof bp[number]) => Number(r.note!.split("/")[0]);
    const lo = bp.reduce((a, b) => (sys(b) < sys(a) ? b : a)), hi = bp.reduce((a, b) => (sys(b) > sys(a) ? b : a)), last = bp[bp.length - 1];
    body.push(`Blood pressure: ${bp.length} reading${bp.length === 1 ? "" : "s"}, lowest ${lo.note}, highest ${hi.note}, latest ${last.note} (${fmt(last.at)}).`);
  }
  for (const [name, label] of [["weight", "Weight"], ["heart rate", "Resting heart rate"], ["blood sugar", "Blood sugar"]] as const) {
    const rows = of(name).filter((r) => r.value != null);
    if (!rows.length) continue;
    const vals = rows.map((r) => Number(r.value)), unit = rows[rows.length - 1].unit ? ` ${rows[rows.length - 1].unit}` : "";
    body.push(`${label}: ${rows.length} reading${rows.length === 1 ? "" : "s"}, ${n1(Math.min(...vals))} to ${n1(Math.max(...vals))}${unit}, latest ${n1(vals[vals.length - 1])}${unit} (${fmt(rows[rows.length - 1].at)}).`);
  }
  const sleep = of("sleep").filter((r) => r.value != null).map((r) => Number(r.value));
  if (sleep.length) body.push(`Sleep: ${sleep.length} night${sleep.length === 1 ? "" : "s"} logged, average ${n1(sleep.reduce((s, v) => s + v, 0) / sleep.length)} hours (${n1(Math.min(...sleep))} to ${n1(Math.max(...sleep))}).`);
  const mood = of("mood").map(moodScore).filter((v): v is number => v != null);
  if (mood.length) body.push(`Mood (self-rated): ${mood.length} entr${mood.length === 1 ? "y" : "ies"}, average ${n1(mood.reduce((s, v) => s + v, 0) / mood.length)} out of 5.`);

  const meds = await db.query<{ name: string; dose: string | null; times: string[]; active: boolean; taken: string; skipped: string; open: string }>(
    `SELECT m.name, m.dose, m.times, m.active,
       count(*) FILTER (WHERE l.status='taken')::text AS taken, count(*) FILTER (WHERE l.status='skipped')::text AS skipped, count(*) FILTER (WHERE l.status='pending')::text AS open
     FROM medications m LEFT JOIN medication_logs l ON l.medication_id=m.id AND l.scheduled_for >= $2
     WHERE m.user_id=$1 GROUP BY m.id HAVING m.active OR count(l.id) > 0 ORDER BY m.name`, [user.id, since.toJSDate()]);
  if (meds.length) {
    body.push("", "Medication:");
    for (const x of meds) {
      const t = Number(x.taken), s = Number(x.skipped), o = Number(x.open);
      body.push(`- ${x.name}${x.dose ? ` (${x.dose})` : ""}, ${x.times.join(" and ")}${x.active ? "" : ", stopped"}${t + s + o ? `: ${t} taken, ${s} skipped, ${o} not answered` : ""}.`);
    }
  }

  const cyc = await cycleRows(db, user.id);
  if (cyc.some((c) => c.started_on >= iso(since.minus({ days: 90 })))) {
    const pic = cyclePicture(cyc, cyclePrefs(user), iso(t0));
    body.push("", `Cycle: about ${pic.length} days on average, periods about ${pic.periodLength} days, last started ${sayDay(pic.lastStart!, user.tz, now)}.`);
    const cs = await db.query<{ value: string; n: string }>(`SELECT lower(value) AS value, count(DISTINCT day)::text AS n FROM cycle_logs WHERE user_id=$1 AND kind='symptom' AND day >= $2::date GROUP BY lower(value) ORDER BY count(*) DESC LIMIT 6`, [user.id, iso(since)]);
    if (cs.length) body.push(`Logged with the cycle: ${cs.map((c) => `${c.value} (${c.n} day${c.n === "1" ? "" : "s"})`).join(", ")}.`);
  }

  const sym = await db.query<{ what: string; severity: string | null; at: string }>(`SELECT what, severity, at FROM well_symptoms WHERE user_id=$1 AND at >= $2 ORDER BY at DESC`, [user.id, since.toJSDate()]);
  if (sym.length) {
    body.push("", "Symptoms logged:");
    body.push(...sym.slice(0, 15).map((s) => `- ${fmt(s.at)}: ${s.what}${s.severity ? `, ${s.severity}` : ""}`));
    if (sym.length > 15) body.push(`- and ${sym.length - 15} more`);
  }
  if (!body.length) return null;
  const who = user.name ?? "me";
  return [`Health summary for ${who}, ${since.toFormat("d LLL")} to ${t0.toFormat("d LLL yyyy")}`, "As logged in lifeline. Not a diagnosis or an interpretation.", "", ...body.filter((l, i, a) => !(l === "" && a[i - 1] === ""))].join("\n").replace(/```/g, "'''");
}

/** A mood entry on a 1 to 5 scale, whichever scale it was given on. */
export function moodScore(r: { value: string | number | null; note: string | null }): number | null {
  const f = /(\d{1,2})\s*\/\s*(\d{1,2})/.exec(r.note ?? "");
  if (f && Number(f[2]) > 0) return Math.round((Number(f[1]) / Number(f[2])) * 50) / 10;
  if (r.value == null) return null;
  const v = Number(r.value);
  return v <= 5 ? v : v <= 10 ? v / 2 : null;
}

const summary = defineAction({
  name: "health.summary",
  tier: 1,
  description: "A one-page plain summary of the last 90 days to show a doctor: blood pressure, weight, sleep, mood, medication and doses taken, cycle, symptoms, as logged. Emailed too if the person has a confirmed email. No interpretation.",
  schema: z.object({}),
  async run(_a, ctx) {
    const s = await healthSummary(ctx.db, ctx.user, ctx.now);
    if (!s) return { reply: `There's nothing logged from the last 90 days yet, so the summary would be empty. Things like "bp 120/80", "slept 7 hours" and "log symptom: headache, mild" all go in it.` };
    const to = typeof ctx.user.prefs.emailVerified === "string" ? (ctx.user.prefs.emailVerified as string) : null;
    const mailed = to && canEmail() ? await sendEmail(to, `Health summary${first(ctx.user) ? ` for ${first(ctx.user)}` : ""}`, s) : false;
    const after = mailed ? `I've emailed a copy to ${to} too.` : to ? "" : `Want it by email next time? Say "my email is ..." and confirm the code.`;
    return { reply: `Your last 90 days, as you logged them. Copy it or show it as it is.\n\n\`\`\`\n${s}\n\`\`\`${after ? `\n\n${after}` : ""}` };
  },
});

register(checkupAdd, checkupDone, checkupList, checkupRemove, symptomLog, symptomList, summary);

/* ---------------- words ---------------- */

const INTERVAL = String.raw`every\s+(\d+|two|three|four|five|six|twelve)\s+(months?|years?)|every\s+(month|year|other year)|(yearly|annually|monthly|once a year|every year|twice a year)`;
function interval(m: RegExpMatchArray, at: number): { every_months?: number; month?: number } {
  const [n, unit, word, adverb] = [m[at], m[at + 1], m[at + 2], m[at + 3]];
  if (n) { const k = toNum(n) ?? 1; return { every_months: /year/i.test(unit) ? k * 12 : k }; }
  const w = (word ?? adverb ?? "").toLowerCase();
  if (/other year/.test(w)) return { every_months: 24 };
  if (/twice a year/.test(w)) return { every_months: 6 };
  if (/month/.test(w)) return { every_months: 1 };
  return { every_months: 12 };
}

addRules(
  [rx(String.raw`(?:remind me (?:about|of) )?(?:my |a |an |the )?(.{0,30}?\b${HEALTH_WORD}\b.{0,20}?)\s+(?:${INTERVAL})`), (m) => ({ action: "checkup.add", args: { name: m[1], ...interval(m, 2) } })],
  [rx(String.raw`(?:my |a |an |the )?(.{0,30}?\b${HEALTH_WORD}\b.{0,20}?)\s+every\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)`), (m) => ({ action: "checkup.add", args: { name: m[1], month: monthOf(m[2])! } })],
  [rx(String.raw`(?:i\s+)?(?:had|got|went for|went to|did)\s+(?:my|the|a|an)\s+(.{0,30}?\b${HEALTH_WORD}\b.{0,20}?)(?:\s+((?:today|yesterday|last \w+|this morning|in \w+|on .{3,20}|\d.{2,20})))?`), (m) => ({ action: "checkup.done", args: { name: m[1], ...(m[2] ? { when: m[2].replace(/^(?:in|on)\s+/i, "") } : {}) } })],
  [rx(String.raw`(?:my |show my |list my )?(?:check ?-?ups|health admin|health reminders|screenings)`), () => ({ action: "checkup.list", args: {} })],
  [rx(String.raw`(?:stop|cancel|remove) (?:my |the )?(.{0,30}?\b${HEALTH_WORD}\b.{0,10}?) reminders?`), (m) => ({ action: "checkup.remove", args: { name: m[1] } })],
  [rx(String.raw`(?:log|add|track|record|note)\s+(?:a\s+)?symptoms?[:,\s]+(.{2,120})|symptoms?:\s*(.{2,120})`), (m) => ({ action: "symptom.log", args: { what: (m[1] ?? m[2]).trim() } })],
  [rx(String.raw`(?:my |show my |show me my )?symptoms?(?: log)?`), () => ({ action: "symptom.list", args: {} })],
  [/^(?=.{0,120}$)(?=.*\b(?:doctor|gp|clinic|nurse|physician|specialist|consultant|midwife)\b)(?=.*\bsummar(?:y|ies|ise|ize)\b).*$|^(?:my )?(?:health|medical) summary$/i, () => ({ action: "health.summary", args: {} })],
);

addExamples("checkup.add", ["dental checkup every 6 months", "eye test yearly", "smear test every 3 years", "blood pressure check monthly", "flu jab every October"]);
addExamples("checkup.done", ["had my dental checkup", "had my eye test in March"]);
addExamples("checkup.list", ["my checkups"]);
addExamples("checkup.remove", ["stop the eye test reminders"]);
addExamples("symptom.log", ["log symptom: headache, mild", "symptom: dizzy after standing"]);
addExamples("symptom.list", ["my symptoms"]);
addExamples("health.summary", ["doctor on Friday, give me my summary", "summary for my doctor", "my health summary"]);

addCues("checkup", ["checkup", "check-up", "dentist", "dental", "eye test", "smear", "screening", "flu jab", "vaccine", "booster"]);
addCues("symptom", ["symptom", "symptoms", "headache", "dizzy", "nausea", "rash"]);
addCues("health", ["doctor", "gp", "appointment", "summary", "clinic"]);

addCapability({
  key: "health_admin", name: "Health admin and a doctor summary",
  cues: ["checkup", "check-up", "dentist", "smear test", "doctor summary", "symptom log", "flu jab"],
  what: "Checkup reminders on your own schedule, a private symptom log, and before an appointment a plain one-page summary of the last 90 days: blood pressure, weight, sleep, mood, medication and doses, cycle and symptoms, as you logged them.",
  say: ["dental checkup every 6 months", "flu jab every October", "log symptom: headache, mild", "doctor on Friday, give me my summary"],
  then: "Reminders come as a line in your morning brief. The summary comes as text to copy or show, and by email if you've confirmed one.",
  limits: "It reports what you logged. It never interprets it or gives medical advice.",
}, "Body and mind");
