/**
 * Home maintenance cycles: "service the AC every 6 months", "clean the water tank every 3 months",
 * "generator service every 100 hours" (counted from the generator log), "fumigate yearly".
 * A line in the brief when one is due, one ping on the day at most, and "serviced the AC" resets it.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import type { Db } from "../../../core/db.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema, addSystemJob } from "../../../core/plugins.js";
import { onJob } from "../../../core/scheduler.js";
import { andList, cap, dayWord, local, pingOnce, plural, usersIn } from "./util.js";
import { genHoursSince, pastTime } from "./utilities.js";

addSchema(`CREATE TABLE IF NOT EXISTS home_jobs (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT NOT NULL, every_n INT NOT NULL, unit TEXT NOT NULL, last_done TIMESTAMPTZ, pinged_key TEXT, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS home_job_log (id SERIAL PRIMARY KEY, job_id INT NOT NULL REFERENCES home_jobs(id), user_id INT NOT NULL REFERENCES users(id), done_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

type Unit = "day" | "week" | "month" | "year" | "hour";
interface Job { id: number; user_id: number; name: string; every_n: number; unit: Unit; last_done: string | null; pinged_key: string | null; created_at: string }
interface Due { job: Job; dueAt: Date | null; hoursLeft: number | null; key: string; state: "later" | "soon" | "due" }

const STOP = new Set(["the", "my", "a", "an", "our", "of", "to", "and", "in", "on", "out", "up", "it", "job", "every", "service", "servicing", "serviced", "clean", "cleaned", "cleaning", "change", "changed", "replace", "replaced", "check", "checked", "done", "fumigate", "fumigated", "fumigation", "flush", "flushed", "descale", "descaled", "wash", "washed", "drain", "drained", "inspect", "inspected", "test", "tested", "spray", "sprayed", "empty", "emptied", "treat", "treated", "defrost", "defrosted", "sweep", "swept", "oil", "oiled", "grease", "greased", "mow", "mowed", "trim", "trimmed", "home", "house"]);
const words = (s: string) => s.toLowerCase().replace(/air ?con(?:ditioner|ditioning)?|aircon/g, "ac").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
const stem = (s: string) => s.toLowerCase().match(/[a-z]+/g)?.[0]?.replace(/(?:ation|ated|ing|ed|e)$/, "") ?? "";
const UNIT_WORD: Record<Unit, string> = { day: "day", week: "week", month: "month", year: "year", hour: "hour" };

async function jobs(db: Db, userId: number): Promise<Job[]> {
  return db.query<Job>(`SELECT id, user_id, name, every_n, unit, last_done, pinged_key, created_at FROM home_jobs WHERE user_id=$1 AND active ORDER BY id`, [userId]);
}

/** When a job falls due: by the calendar, or by generator hours since it was last done. */
export async function dueOf(db: Db, job: Job, now: Date, tz: string): Promise<Due> {
  const base = new Date(job.last_done ?? job.created_at);
  if (job.unit === "hour") {
    const run = await genHoursSince(db, job.user_id, base, now);
    const left = job.every_n - run;
    return { job, dueAt: null, hoursLeft: left, key: `h${base.getTime()}`, state: left <= 0 ? "due" : left <= job.every_n * 0.1 ? "soon" : "later" };
  }
  const dueAt = local(base, tz).plus({ [`${job.unit}s`]: job.every_n } as any).toJSDate();
  const days = (dueAt.getTime() - now.getTime()) / 86_400_000;
  return { job, dueAt, hoursLeft: null, key: local(dueAt, tz).toISODate()!, state: days <= 0 ? "due" : days <= 3 ? "soon" : "later" };
}

function match(list: Job[], text: string): Job | null {
  const want = words(text);
  let best: { j: Job; s: number } | null = null;
  for (const j of list) {
    const have = words(j.name);
    let s = want.filter((w) => have.includes(w) || have.some((h) => h.startsWith(w) || w.startsWith(h))).length;
    if (!want.length && stem(text) && stem(j.name) === stem(text)) s = 1;
    if (!want.length && !s && stem(text).length > 3 && j.name.toLowerCase().includes(stem(text))) s = 1;
    if (s > 0 && (!best || s > best.s)) best = { j, s };
  }
  return best?.j ?? null;
}

/** "Clean the water tank" reads "clean the water tank" mid-sentence; "AC service" keeps its capitals. */
const soft = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const every = (n: number, u: Unit) => (n === 1 ? `every ${UNIT_WORD[u]}` : `every ${n} ${UNIT_WORD[u]}s`);
function dueWords(d: Due, tz: string, now: Date): string {
  if (d.hoursLeft !== null) return d.hoursLeft <= 0 ? "due now" : `due in about ${plural(Math.ceil(d.hoursLeft), "generator hour")}`;
  const D = local(d.dueAt!, tz), L = local(now, tz);
  if (d.state === "due") return Math.round(L.startOf("day").diff(D.startOf("day"), "days").days) === 0 ? "due today" : `was due ${D.toFormat("d LLL")}`;
  return `due ${dayWord(D, L)}`;
}

/* ---------------- actions ---------------- */

const add = defineAction({
  name: "homejob.add",
  tier: 1,
  description: "Keep a recurring home maintenance job: name (like 'Service the AC'), every (a number) and unit (day, week, month, year, or hour for generator running hours counted from the generator log). Optional 'last' is when it was last done.",
  schema: z.object({ name: z.string().min(2).max(60), every: z.number().int().min(1).max(1000), unit: z.enum(["day", "week", "month", "year", "hour"]), last: z.string().max(40).optional() }),
  async run(a, ctx) {
    const name = cap(a.name.trim().replace(/\s+/g, " "));
    const last = a.last ? pastTime(a.last, ctx.user.tz, ctx.now) : null;
    const same = match(await jobs(ctx.db, ctx.user.id), name);
    if (same && words(same.name).join(" ") === words(name).join(" ")) {
      await ctx.db.query(`UPDATE home_jobs SET every_n=$2, unit=$3, last_done=COALESCE($4, last_done) WHERE id=$1`, [same.id, a.every, a.unit, last]);
      return { reply: `${same.name}, now ${every(a.every, a.unit)}.`, undo: { payload: { restore: { id: same.id, every_n: same.every_n, unit: same.unit, last_done: same.last_done } } } };
    }
    const row = await ctx.db.one<Job>(`INSERT INTO home_jobs (user_id, name, every_n, unit, last_done, created_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, user_id, name, every_n, unit, last_done, pinged_key, created_at`, [ctx.user.id, name, a.every, a.unit, last, ctx.now]);
    const d = await dueOf(ctx.db, row!, ctx.now, ctx.user.tz);
    const when = a.unit === "hour"
      ? ` I count the hours from your generator log, so tell me runs like "ran the generator 4 hours".`
      : ` Next one ${d.state === "due" ? "is due now" : `due ${local(d.dueAt!, ctx.user.tz).toFormat("d LLL yyyy")}`}${last ? "" : " (counting from today)"}.`;
    return { reply: `${name}, ${every(a.every, a.unit)}.${when} It shows in your morning note when it's due. Say "${pastName(name)}" when it's done, or "stop the ${jobWord(name)} job" to drop it.`, undo: { payload: { drop: row!.id } } };
  },
  async undo(p, ctx) {
    if (p.drop) { await ctx.db.query(`DELETE FROM home_jobs WHERE id=$1 AND user_id=$2`, [p.drop, ctx.user.id]); return "Dropped it."; }
    const r = p.restore;
    await ctx.db.query(`UPDATE home_jobs SET every_n=$2, unit=$3, last_done=$4 WHERE id=$1 AND user_id=$5`, [r.id, r.every_n, r.unit, r.last_done, ctx.user.id]);
    return "Put back as it was.";
  },
});

/** The word people would use to name a job: "AC" for "Service the AC". */
const jobWord = (name: string) => { const k = words(name)[0]; return k ? name.split(/\s+/).find((w) => w.toLowerCase().replace(/[^a-z0-9]/g, "") === k) ?? k : name.split(" ")[0].toLowerCase(); };
/** "Service the AC" becomes "serviced the AC": what to say when it's done. */
function pastName(name: string): string {
  const [v, ...rest] = name.split(" ");
  const PAST: Record<string, string> = { service: "serviced", clean: "cleaned", change: "changed", replace: "replaced", check: "checked", fumigate: "fumigated", flush: "flushed", descale: "descaled", wash: "washed", drain: "drained", inspect: "inspected", test: "tested", spray: "sprayed", empty: "emptied", treat: "treated", defrost: "defrosted", sweep: "swept", oil: "oiled", grease: "greased", mow: "mowed", trim: "trimmed", paint: "painted", repaint: "repainted", vacuum: "vacuumed" };
  const p = PAST[v.toLowerCase()];
  return p ? [p, ...rest].join(" ") : `${name} done`.toLowerCase();
}

const done = defineAction({
  name: "homejob.done",
  tier: 1,
  description: "Mark a home maintenance job done ('serviced the AC', 'cleaned the water tank', 'fumigated'); 'match' names it, optional 'when'. Resets its cycle.",
  schema: z.object({ match: z.string().min(1).max(80), when: z.string().max(40).optional() }),
  async run(a, ctx) {
    const list = await jobs(ctx.db, ctx.user.id);
    const j = match(list, a.match);
    if (!j) return { reply: `Nice work. That isn't one of your home jobs${list.length ? ` (${andList(list.map((x) => soft(x.name)))})` : ""}. To keep it, say how often, like "clean the gutters every 6 months".` };
    const when = pastTime(a.when, ctx.user.tz, ctx.now) ?? ctx.now;
    await ctx.db.query(`UPDATE home_jobs SET last_done=$2, pinged_key=NULL WHERE id=$1`, [j.id, when]);
    const log = await ctx.db.one<{ id: number }>(`INSERT INTO home_job_log (job_id, user_id, done_at) VALUES ($1,$2,$3) RETURNING id`, [j.id, ctx.user.id, when]);
    const next = await dueOf(ctx.db, { ...j, last_done: when.toISOString() }, ctx.now, ctx.user.tz);
    const nextBit = j.unit === "hour" ? `next after ${plural(j.every_n, "generator hour")}` : `next ${local(next.dueAt!, ctx.user.tz).toFormat("d LLL yyyy")}`;
    return { reply: `${j.name}, done. ${cap(nextBit)}.`, undo: { payload: { id: j.id, last: j.last_done, pinged: j.pinged_key, log: log!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE home_jobs SET last_done=$2, pinged_key=$3 WHERE id=$1 AND user_id=$4`, [p.id, p.last, p.pinged, ctx.user.id]);
    await ctx.db.query(`DELETE FROM home_job_log WHERE id=$1`, [p.log]);
    return "Taken back.";
  },
});

const list = defineAction({
  name: "homejob.list",
  tier: 1,
  description: "List the person's recurring home maintenance jobs and when each is next due.",
  schema: z.object({}),
  async run(_a, ctx) {
    const all = await jobs(ctx.db, ctx.user.id);
    if (!all.length) return { reply: `No home jobs yet. Say "service the AC every 6 months", "clean the water tank every 3 months" or "generator service every 100 hours" and I'll keep the cycle.` };
    const ds = await Promise.all(all.map((j) => dueOf(ctx.db, j, ctx.now, ctx.user.tz)));
    ds.sort((x, y) => (x.dueAt?.getTime() ?? (ctx.now.getTime() + (x.hoursLeft ?? 0) * 3_600_000 * 4)) - (y.dueAt?.getTime() ?? (ctx.now.getTime() + (y.hoursLeft ?? 0) * 3_600_000 * 4)));
    return { reply: [`${all.length === 1 ? "One home job" : `${all.length} home jobs`}:`, ...ds.map((d) => `- ${d.job.name}, ${every(d.job.every_n, d.job.unit)}: ${dueWords(d, ctx.user.tz, ctx.now)}`)].join("\n") };
  },
});

const stop = defineAction({
  name: "homejob.stop",
  tier: 1,
  description: "Stop keeping a home maintenance job (by name), so it no longer shows or pings.",
  schema: z.object({ match: z.string().min(1).max(80) }),
  async run(a, ctx) {
    const j = match(await jobs(ctx.db, ctx.user.id), a.match);
    if (!j) return { reply: `I don't have a home job like "${a.match}". Say "my home jobs" to see them.` };
    await ctx.db.query(`UPDATE home_jobs SET active=false WHERE id=$1`, [j.id]);
    return { reply: `${j.name} is off the list.`, undo: { payload: { id: j.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE home_jobs SET active=true WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "It's back on the list."; },
});

register(add, done, list, stop);

/* ---------------- words ---------------- */

const VERB = "(service|clean|deep clean|fumigate|change|replace|flush|descale|inspect|check(?!\\s+(?:on|in|up)\\b)|test|drain|wash|sweep|spray|oil|grease|empty|treat|defrost|mow|trim|repaint|paint|vacuum)";
const NOUNS = "(?:ac|a\\/c|air ?con(?:ditioner)?|aircon|generator|gen|genset|water tank|tank|overhead tank|filters?|water filter|borehole|pump|gutters?|drains?|boiler|heater|water heater|geyser|chimney|septic(?: tank)?|soak ?away|fridge|freezer|smoke alarms?|alarm batter(?:y|ies)|roof|solar(?: panels?)?|inverter|batter(?:y|ies)|fans?|extractor|hood|oven|washing machine|dishwasher|mattress|curtains|carpets?|sofa|windows|compound|garden|lawn|hedge|pest control|fumigation|house|car|tyres|tires|locks)";
const PERIOD = "(?:every\\s+(\\d+|a|an|one|two|three|four|six|twelve)?\\s*(day|week|month|year|hour)s?|(daily|weekly|fortnightly|monthly|quarterly|yearly|annually|twice a year|once a year))";
const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, six: 6, twelve: 12 };
function period(n: string | undefined, u: string | undefined, word: string | undefined): { every: number; unit: Unit } {
  if (word) return ({ daily: { every: 1, unit: "day" }, weekly: { every: 1, unit: "week" }, fortnightly: { every: 2, unit: "week" }, monthly: { every: 1, unit: "month" }, quarterly: { every: 3, unit: "month" }, yearly: { every: 1, unit: "year" }, annually: { every: 1, unit: "year" }, "twice a year": { every: 6, unit: "month" }, "once a year": { every: 1, unit: "year" } } as Record<string, { every: number; unit: Unit }>)[word.toLowerCase()];
  return { every: n ? NUM[n.toLowerCase()] ?? Number(n) : 1, unit: (u ?? "month").toLowerCase() as Unit };
}
const LAST = "(?:,?\\s+(?:last\\s+(?:done|serviced|cleaned|changed|fumigated)|done last)\\s+(.+))?";

addRules(
  [new RegExp(`^${VERB}\\s+(.{2,40}?)\\s+${PERIOD}${LAST}$`, "i"), (m) => ({ action: "homejob.add", args: { name: `${m[1]} ${m[2]}`, ...period(m[3], m[4], m[5]), ...(m[6] ? { last: m[6] } : {}) } })],
  [new RegExp(`^${VERB}\\s+${PERIOD}${LAST}$`, "i"), (m) => ({ action: "homejob.add", args: { name: m[1], ...period(m[2], m[3], m[4]), ...(m[5] ? { last: m[5] } : {}) } })],
  [new RegExp(`^(?:the\\s+)?(${NOUNS})\\s+(service|servicing|cleaning|check|inspection|change|fumigation|wash)\\s+${PERIOD}${LAST}$`, "i"), (m) => ({ action: "homejob.add", args: { name: `${m[1]} ${m[2]}`, ...period(m[3], m[4], m[5]), ...(m[6] ? { last: m[6] } : {}) } })],
  [new RegExp(`^(?:i\\s+|we\\s+)?(?:just\\s+)?(serviced|cleaned|deep cleaned|fumigated|changed|replaced|flushed|descaled|inspected|checked|tested|drained|washed|sprayed|emptied|treated|defrosted|mowed|trimmed|repainted|painted)\\s+(?:the\\s+|my\\s+|our\\s+)?(${NOUNS}(?:\\s+(?!today|yesterday|last\\b)[a-z]+)?)(?:\\s+(today|yesterday|last week))?$`, "i"), (m) => ({ action: "homejob.done", args: { match: `${m[1]} ${m[2]}`, ...(m[3] ? { when: m[3] } : {}) } })],
  [/^(?:we\s+|i\s+)?(?:just\s+)?(?:fumigated|had (?:the house )?fumigated|had pest control)(?:\s+(today|yesterday|last week))?$/i, (m) => ({ action: "homejob.done", args: { match: "fumigate", ...(m[1] ? { when: m[1] } : {}) } })],
  [new RegExp(`^(?:the\\s+)?(${NOUNS}(?:\\s+(?:service|cleaning|check|change))?)\\s+(?:is\\s+)?(?:done|serviced|cleaned)(?:\\s+(today|yesterday))?$|^mark\\s+(?:the\\s+)?(.{2,40}?)\\s+(?:as\\s+)?done$`, "i"), (m) => ({ action: "homejob.done", args: { match: m[1] ?? m[3], ...(m[2] ? { when: m[2] } : {}) } })],
  [/^(?:show\s+)?(?:my\s+)?(?:home|house)\s+(?:jobs|maintenance|chores)$|^(?:what'?s|anything)\s+due\s+(?:at|in|around)\s+(?:the\s+)?(?:home|house)$/i, () => ({ action: "homejob.list", args: {} })],
  [/^(?:stop|drop|delete|remove|cancel)\s+(?:the\s+|my\s+)?(.{2,40}?)\s+(?:home\s+)?job$/i, (m) => ({ action: "homejob.stop", args: { match: m[1] } })],
);
addExamples("homejob.add", ["service the AC every 6 months", "clean the water tank every 3 months", "generator service every 100 hours", "fumigate yearly", "change the water filter every 2 months, last done in august"]);
addExamples("homejob.done", ["serviced the AC", "cleaned the water tank yesterday", "fumigated", "AC service done", "mark the gutters done"]);
addExamples("homejob.list", ["my home jobs", "home maintenance"]);
addExamples("homejob.stop", ["stop the AC job", "drop the gutters job"]);
addCues("homejob", ["service", "serviced", "maintenance", "fumigate", "fumigation", "water tank", "filter", "ac", "air con", "gutters", "borehole", "every 6 months", "every 3 months", "yearly", "home jobs"]);
addCapability({
  key: "homejobs", name: "Home maintenance",
  cues: ["maintenance", "service the", "serviced", "fumigate", "water tank", "air con", "ac service", "generator service", "home jobs", "gutters", "filter"],
  what: "I keep the cycles of looking after a home: the AC every 6 months, the water tank every 3, fumigation yearly, the generator every 100 running hours counted from your generator log.",
  say: ["service the AC every 6 months", "generator service every 100 hours", "serviced the AC", "my home jobs"],
  then: "When one comes due it's a line in your morning note and one ping on the day. Say \"serviced the AC\" to reset it, or \"stop the AC job\" to drop it.",
}, "Home and paperwork");

/* ---------------- the brief and the ping ---------------- */

async function dueList(db: Db, user: User, now: Date, states: Due["state"][]): Promise<Due[]> {
  const out: Due[] = [];
  for (const j of await jobs(db, user.id)) {
    const d = await dueOf(db, j, now, user.tz);
    // Overdue things are mentioned for a week, kindly, then they wait quietly in "my home jobs".
    if (d.dueAt && (now.getTime() - d.dueAt.getTime()) > 7 * 86_400_000) continue;
    if (states.includes(d.state)) out.push(d);
  }
  return out;
}

addBriefSection({
  key: "home_jobs", order: 40,
  async lines(db, user, now) {
    const ds = await dueList(db, user, now, ["soon", "due"]);
    if (!ds.length) return [];
    const bits = ds.slice(0, 3).map((d, i) => `${i ? soft(d.job.name) : d.job.name} ${dueWords(d, user.tz, now)}`);
    return [`Home: ${andList(bits)}${ds.length > 3 ? `, and ${ds.length - 3} more` : ""}.`];
  },
});

addSystemJob("home_upkeep", "27 * * * *");
onJob("home_upkeep", async (_job, deps) => {
  const now = new Date();
  for (const user of await usersIn(deps.db, `SELECT DISTINCT user_id FROM home_jobs WHERE active`)) {
    const h = local(now, user.tz).hour;
    if (h < 9 || h > 19) continue;
    const ds = (await dueList(deps.db, user, now, ["due"])).filter((d) => d.job.pinged_key !== d.key);
    if (!ds.length) continue;
    const first = ds[0].job;
    const text = ds.length === 1
      ? `${first.name} ${((w) => (/^was/.test(w) ? w : `is ${w}`))(dueWords(ds[0], user.tz, now))}. Say "${pastName(first.name)}" when it's done, or "stop the ${jobWord(first.name)} job" to drop it.`
      : `Home jobs due: ${andList(ds.map((d) => soft(d.job.name)))}. Say "${pastName(first.name)}" as each is done, or "stop the ... job" to drop one.`;
    const buttons = ds.length === 1 ? [{ label: "Done", data: `hm:job:done:${first.id}` }, { label: "Not now", data: `hm:job:later:${first.id}` }] : undefined;
    if (await pingOnce(deps, user, "jobs", text, { buttons, now })) {
      for (const d of ds) await deps.db.query(`UPDATE home_jobs SET pinged_key=$2 WHERE id=$1`, [d.job.id, d.key]);
    }
  }
});

export async function jobButton(db: Db, user: User, parts: string[], now: Date): Promise<string | null> {
  const [kind, verb, id] = parts;
  if (kind !== "job") return null;
  const j = await db.one<Job>(`SELECT id, user_id, name, every_n, unit, last_done, pinged_key, created_at FROM home_jobs WHERE id=$1 AND user_id=$2 AND active`, [Number(id), user.id]);
  if (!j) return "That home job isn't on the list any more.";
  if (verb === "later") return `No rush. ${j.name} waits in "my home jobs" whenever you get to it.`;
  await db.query(`UPDATE home_jobs SET last_done=$2, pinged_key=NULL WHERE id=$1`, [j.id, now]);
  await db.query(`INSERT INTO home_job_log (job_id, user_id, done_at) VALUES ($1,$2,$3)`, [j.id, user.id, now]);
  const next = await dueOf(db, { ...j, last_done: now.toISOString() }, now, user.tz);
  return `${j.name}, done. ${j.unit === "hour" ? `Next after ${plural(j.every_n, "generator hour")}` : `Next ${DateTime.fromJSDate(next.dueAt!).setZone(user.tz).toFormat("d LLL yyyy")}`}.`;
}
