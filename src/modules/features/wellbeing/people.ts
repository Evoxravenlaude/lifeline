/**
 * People: keep in touch, caregiver reminders by text, and accountability buddies.
 *
 * Keep in touch speaks through the morning brief unless the person asked for a ping. A conversation
 * starter comes from their own notes and confirmed memories that mention the name.
 * Caregiver reminders reach someone outside lifeline by SMS, so they start only after that person
 * texts YES to a one-time consent message. Their replies come in through handleCareSms (see the core
 * hook in docs/features/wellbeing.md).
 * Buddies are two people in the circle who both said yes; each sees only the other's check-ins for
 * the one habit they share.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { propose } from "../../../policy/engine.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema, addTextReplyHandler } from "../../../core/plugins.js";
import { onJob, push, schedule } from "../../../core/scheduler.js";
import type { Db } from "../../../core/db.js";
import { normalisePhone, sendSms, smsProvider } from "../../../channels/sms.js";
import { yours } from "../../life.js";
import { cancelJob, dayOf, daysBetween, escRe, first, iso, keepDaily, onButton, personName, readClock, rx, sayDay, setWb, stopHint, tell, toNum, today, wb, weekdayOf, WEEKDAYS, clockOf } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS well_people (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT NOT NULL, every_days INT NOT NULL DEFAULT 14, weekday INT, ping BOOLEAN NOT NULL DEFAULT false, last_contact DATE, nudged_on DATE, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS well_people_user ON well_people(user_id, active);
CREATE TABLE IF NOT EXISTS well_care (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), who TEXT NOT NULL, phone TEXT NOT NULL, task TEXT NOT NULL, at_time TEXT NOT NULL, tz TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', job_id INT, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS well_care_phone ON well_care(phone, status);
CREATE TABLE IF NOT EXISTS well_care_logs (id SERIAL PRIMARY KEY, care_id INT NOT NULL REFERENCES well_care(id), sent_at TIMESTAMPTZ NOT NULL, taken_at TIMESTAMPTZ, alerted BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS well_buddies (id SERIAL PRIMARY KEY, from_user INT NOT NULL REFERENCES users(id), to_user INT NOT NULL REFERENCES users(id), habit TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'asked', created_at TIMESTAMPTZ DEFAULT now(), ended_at TIMESTAMPTZ)`);

/* =====================================================================
 * 1. Keep in touch
 * ===================================================================== */

interface Person { id: number; name: string; every_days: number; weekday: number | null; ping: boolean; last_contact: string | null; nudged_on: string | null; created: string }
const PEOPLE = `SELECT id, name, every_days, weekday, ping, to_char(last_contact,'YYYY-MM-DD') AS last_contact, to_char(nudged_on,'YYYY-MM-DD') AS nudged_on, to_char(created_at AT TIME ZONE $2,'YYYY-MM-DD') AS created FROM well_people WHERE user_id=$1 AND active`;
const people = (db: Db, user: User) => db.query<Person>(`${PEOPLE} ORDER BY id`, [user.id, user.tz]);
async function findPerson(db: Db, user: User, name: string): Promise<Person | undefined> {
  const n = personName(name).toLowerCase();
  const all = await people(db, user);
  return all.find((p) => p.name.toLowerCase() === n) ?? all.find((p) => p.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0]);
}

/** "Sunday", "2 weeks", "month", "few weeks", "fortnight" → a cadence. */
export function readEvery(text: string): { every_days: number; weekday?: number } | null {
  const t = text.trim().toLowerCase().replace(/^(?:every|each|once a|once every)\s+/, "").replace(/\s+or so$/, "");
  const wd = /^(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)s?$/.test(t) ? weekdayOf(t) : null;
  if (wd !== null) return { every_days: 7, weekday: wd };
  if (/^(?:day|daily)$/.test(t)) return { every_days: 1 };
  if (/^(?:week|weekly)$/.test(t)) return { every_days: 7 };
  if (/^(?:fortnight|other week|two weeks)$/.test(t)) return { every_days: 14 };
  if (/^(?:month|monthly)$/.test(t)) return { every_days: 30 };
  if (/^(?:year|yearly)$/.test(t)) return { every_days: 365 };
  const m = /^(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a couple of|couple of|a few|few)\s+(days?|weeks?|months?)$/.exec(t);
  if (!m) return null;
  const n = toNum(m[1].replace(/ of$/, "")) ?? 1;
  const days = m[2].startsWith("day") ? n : m[2].startsWith("week") ? n * 7 : n * 30;
  return days >= 1 && days <= 365 ? { every_days: days } : null;
}
const sayEvery = (p: { every_days: number; weekday: number | null }) =>
  p.weekday != null ? `every ${WEEKDAYS[p.weekday].replace(/^./, (c) => c.toUpperCase())}` : p.every_days === 1 ? "every day" : p.every_days === 7 ? "every week" : p.every_days === 14 ? "every two weeks" : p.every_days % 30 === 0 ? (p.every_days === 30 ? "every month" : `every ${p.every_days / 30} months`) : p.every_days % 7 === 0 ? `every ${p.every_days / 7} weeks` : `every ${p.every_days} days`;

/** Is this person due today, and since when have they been due? */
function dueOf(p: Person, t0: DateTime): { due: boolean; next: DateTime } {
  if (p.weekday != null) {
    let d = t0;
    while (d.weekday % 7 !== p.weekday) d = d.minus({ days: 1 });
    const created = dayOf(p.created, t0.zoneName ?? "UTC");
    const due = d >= created && (!p.last_contact || dayOf(p.last_contact, t0.zoneName ?? "UTC") < d);
    let next = t0.plus({ days: 1 });
    while (next.weekday % 7 !== p.weekday) next = next.plus({ days: 1 });
    return { due, next: due ? t0 : next };
  }
  const base = dayOf(p.last_contact ?? p.created, t0.zoneName ?? "UTC");
  const next = base.plus({ days: p.every_days });
  return { due: next <= t0, next };
}

/** Something to talk about, from the person's own notes and confirmed memories that mention the name. */
async function starter(db: Db, userId: number, name: string): Promise<string | null> {
  const re = `\\m${escRe(name.toLowerCase())}\\M`;
  const n = await db.one<{ text: string }>(`SELECT text FROM notes WHERE user_id=$1 AND lower(text) ~ $2 ORDER BY id DESC LIMIT 1`, [userId, re]);
  const m = n ? null : await db.one<{ text: string }>(`SELECT fact AS text FROM memories WHERE user_id=$1 AND confirmed AND lower(fact) ~ $2 ORDER BY id DESC LIMIT 1`, [userId, re]);
  const t = (n ?? m)?.text?.trim();
  if (!t) return null;
  const s = yours(t);
  return s.length > 90 ? `${s.slice(0, 87).trimEnd()}...` : s;
}

const touchAdd = defineAction({
  name: "touch.add",
  tier: 1,
  description: "Keep in touch with someone: a gentle nudge when it's time to call, text or see them. `every_days` is how often (7 weekly, 14, 30 monthly), `weekday` 0=Sunday..6 for a fixed day like 'every Sunday'. `ping` true only if they asked to be pinged; otherwise the nudge is one line in the morning brief.",
  schema: z.object({ name: z.string().min(1).max(40), every_days: z.number().int().min(1).max(365).optional(), weekday: z.number().int().min(0).max(6).optional(), ping: z.boolean().optional() }),
  async run(args, ctx) {
    const name = personName(args.name);
    const every = args.weekday != null ? 7 : args.every_days ?? 14;
    const old = await findPerson(ctx.db, ctx.user, name);
    if (old) await ctx.db.query(`UPDATE well_people SET active=false WHERE id=$1`, [old.id]);
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO well_people (user_id, name, every_days, weekday, ping) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.user.id, name, every, args.weekday ?? null, args.ping === true]);
    if (args.ping) await keepDaily(ctx.db, ctx.user, "well_touch", "13 17 * * *");
    const how = args.ping ? "I'll ping you when it's time" : "I'll mention it in your morning brief when it's time";
    return {
      reply: `${name}, ${sayEvery({ every_days: every, weekday: args.weekday ?? null })}. ${how}. Say "talked to ${name}" after you catch up and the clock starts again, or "stop keeping in touch with ${name}" to stop.`,
      undo: { payload: { id: r!.id, old: old?.id ?? null } },
    };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE well_people SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    if (p.old) await ctx.db.query(`UPDATE well_people SET active=true WHERE id=$1 AND user_id=$2`, [p.old, ctx.user.id]);
    return "Taken back.";
  },
});

const touchLog = defineAction({
  name: "touch.log",
  tier: 1,
  description: "Record that the person called, texted, saw or talked to someone they keep in touch with, which resets that person's nudge. `when` is 'today' (default) or 'yesterday'.",
  schema: z.object({ name: z.string().min(1).max(40), when: z.enum(["today", "yesterday"]).optional() }),
  async run(args, ctx) {
    const p = await findPerson(ctx.db, ctx.user, args.name);
    const name = personName(args.name);
    if (!p) return { reply: `Lovely. I'm not keeping track of ${name} for you; say "keep in touch with ${name} every 2 weeks" if you'd like a nudge.` };
    const t0 = today(ctx.user, ctx.now);
    const day = iso(args.when === "yesterday" ? t0.minus({ days: 1 }) : t0);
    await ctx.db.query(`UPDATE well_people SET last_contact=$2, nudged_on=NULL WHERE id=$1`, [p.id, day]);
    const next = dueOf({ ...p, last_contact: day }, t0).next;
    return { reply: `Nice. I've started ${p.name}'s clock again; next nudge around ${next.toFormat("ccc d LLL")}.`, undo: { payload: { id: p.id, prev: p.last_contact, nudged: p.nudged_on } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE well_people SET last_contact=$2, nudged_on=$3 WHERE id=$1 AND user_id=$4`, [p.id, p.prev, p.nudged, ctx.user.id]);
    return "Taken back.";
  },
});

const touchDue = defineAction({
  name: "touch.due",
  tier: 1,
  description: "Who the person should catch up with: everyone they keep in touch with, who's due now first, with a conversation starter from their own notes.",
  schema: z.object({}),
  async run(_a, ctx) {
    const all = await people(ctx.db, ctx.user);
    if (!all.length) return { reply: `Nobody on your list yet. Say "call Mum every Sunday" or "check in with Ese if we haven't talked in 3 weeks" and I'll nudge you gently.` };
    const t0 = today(ctx.user, ctx.now);
    const rows = all.map((p) => ({ p, ...dueOf(p, t0) })).sort((a, b) => Number(b.due) - Number(a.due) || a.next.toMillis() - b.next.toMillis());
    const due = rows.filter((r) => r.due);
    const lines = rows.slice(0, 8).map(({ p, due: d, next }) => `- ${p.name}: ${d ? "due now" : `around ${next.toFormat("ccc d LLL")}`}${p.last_contact ? `, last time ${daysBetween(p.last_contact, iso(t0)) === 0 ? "today" : `${daysBetween(p.last_contact, iso(t0))} days ago`}` : ""}`);
    const head = due.length ? `${due.length === 1 ? `${due[0].p.name} is` : `${due.map((r) => r.p.name).slice(0, 3).join(" and ")} are`} due a catch-up.` : "Nobody's due just now.";
    const s = due.length ? await starter(ctx.db, ctx.user.id, due[0].p.name) : null;
    return { reply: [head, s ? `Something to ask ${due[0].p.name} about: "${s}"` : "", "", ...lines].filter((l, i) => l || i === 2).join("\n").trim() };
  },
});

const touchRemove = defineAction({
  name: "touch.remove",
  tier: 1,
  description: "Stop the keep-in-touch nudges for one person.",
  schema: z.object({ name: z.string().min(1) }),
  async run(args, ctx) {
    const p = await findPerson(ctx.db, ctx.user, args.name);
    if (!p) return { reply: `I wasn't nudging you about ${personName(args.name)}.` };
    await ctx.db.query(`UPDATE well_people SET active=false WHERE id=$1`, [p.id]);
    return { reply: `No more nudges about ${p.name}.`, undo: { payload: { id: p.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE well_people SET active=true WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Back on the list."; },
});

/** Those who asked for a ping get one, at most once a day, through push(). */
onJob("well_touch", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const t0 = today(user, new Date());
  const due = (await people(deps.db, user)).filter((p) => p.ping && p.nudged_on !== iso(t0) && dueOf(p, t0).due);
  if (!due.length) return;
  const p = due[0];
  const s = await starter(deps.db, user.id, p.name);
  const more = due.length > 1 ? ` ${due.slice(1, 3).map((x) => x.name).join(" and ")} too.` : "";
  const hint = await stopHint(deps.db, user, "touch", `stop keeping in touch with ${p.name}`);
  const ok = await push(deps, user, "well_touch", `${p.name} is due a catch-up.${more}${s ? ` Something to ask about: "${s}"` : ""}${hint}`, { buttons: [{ label: `Talked to ${p.name}`.slice(0, 40), data: `wb:p:${p.id}` }] });
  if (ok) await deps.db.query(`UPDATE well_people SET nudged_on=$2 WHERE id = ANY($1::int[])`, [due.map((x) => x.id), iso(t0)]);
});
onButton("p", async (db, user, [id]) => {
  const p = await db.one<{ id: number; name: string }>(`SELECT id, name FROM well_people WHERE id=$1 AND user_id=$2 AND active`, [Number(id), user.id]);
  if (!p) return { text: "I'm not nudging you about them any more." };
  await db.query(`UPDATE well_people SET last_contact=$2, nudged_on=NULL WHERE id=$1`, [p.id, iso(today(user, new Date()))]);
  return { text: `Nice. ${p.name}'s clock starts again.` };
});

/** The brief: who's due, once, with something to talk about. Mentioned again a week later at most. */
addBriefSection({
  key: "well_touch", order: 40,
  async lines(db, user, now, opts) {
    const t0 = today(user, now);
    const due = (await people(db, user)).filter((p) => !p.ping && dueOf(p, t0).due && (!p.nudged_on || p.nudged_on === iso(t0) || daysBetween(p.nudged_on, iso(t0)) >= 7));
    if (!due.length) return [];
    if (!opts?.peek) await db.query(`UPDATE well_people SET nudged_on=$2 WHERE id = ANY($1::int[]) AND (nudged_on IS NULL OR nudged_on <> $2)`, [due.map((p) => p.id), iso(t0)]);
    const names = due.slice(0, 3).map((p) => p.name);
    const s = await starter(db, user.id, due[0].name);
    return [`${names.length === 1 ? `${names[0]} is` : `${names.join(" and ")} are`} due a catch-up.${s ? ` Something to ask ${due[0].name} about: "${s}"` : ""}`];
  },
});

/* =====================================================================
 * 7. Caregiver mode
 * ===================================================================== */

const pronouns = (s: string) => s.replace(/\b(?:her|his|their)\b/gi, "your").replace(/\b(?:she|he|they)\b/gi, "you").replace(/\bthemselves|herself|himself\b/gi, "yourself");
const careText = (task: string) => { const t = pronouns(task.trim().replace(/[.!]+$/, "")); return /^(?:take|check|do|drink|eat|use|measure|go|call)\b/i.test(t) ? t : `take ${t}`; };
const PHONE = /^\+?[\d\s().-]{7,20}$/;

interface Care { id: number; user_id: number; who: string; phone: string; task: string; at_time: string; tz: string; status: string; job_id: number | null }

const careAdd = defineAction({
  name: "care.add",
  tier: 1,
  description: "Set up a daily text-message reminder for someone else (a parent, a partner) who isn't on lifeline: 'remind Mum to take her blood pressure pill at 8am by text'. `phone` is their mobile with the country code. Nothing is sent until they agree: this proposes a one-time consent text for the person to confirm.",
  schema: z.object({ who: z.string().min(1).max(40), task: z.string().min(2).max(120), time: z.string().min(1).max(20), phone: z.string().max(30).optional() }),
  needs(args) {
    if (args.phone && PHONE.test(args.phone) && args.phone.replace(/\D/g, "").length >= 7) return null;
    return { need: "phone", question: `What's ${personName(args.who)}'s mobile number? Include the country code, like +44 7700 900123.` };
  },
  fill(need, answer) {
    if (need !== "phone") return null;
    const a = answer.trim();
    return PHONE.test(a) && a.replace(/\D/g, "").length >= 7 ? { phone: a } : null;
  },
  async run(args, ctx) {
    const who = personName(args.who);
    if (!smsProvider()) return { reply: `Reminders for ${who} would go by text message, and text messages aren't switched on here yet. Whoever runs lifeline can turn them on (docs/SMS.md); ask me again once they have.` };
    const clock = readClock(args.time);
    if (!clock) throw new Error(`I couldn't read a time in "${args.time}". What time each day, like 8am or 20:00?`);
    const phone = normalisePhone(args.phone!);
    const at = clockOf(clock[0], clock[1]);
    await ctx.db.query(`UPDATE well_care SET status='replaced' WHERE user_id=$1 AND lower(who)=lower($2) AND status IN ('draft','asked')`, [ctx.user.id, who]);
    await ctx.db.query(`INSERT INTO well_care (user_id, who, phone, task, at_time, tz) VALUES ($1,$2,$3,$4,$5,$6)`, [ctx.user.id, who, phone, careText(args.task), at, ctx.user.tz]);
    const d = await propose(ctx, "care.consent", { who, phone, task: careText(args.task), time: at });
    if (d.kind === "pending") return { reply: `${d.echo}\n\nGo ahead? This waits ten minutes for a yes.`, buttons: [{ label: "Yes, send it", data: `confirm:${d.pendingId}` }, { label: "No", data: `cancel:${d.pendingId}` }] };
    return { reply: "reply" in d ? d.reply : "I couldn't set that up just now. Try again in a moment?" };
  },
});

const consentBody = (owner: string | null, c: { who: string; task: string; at_time: string }) =>
  `Hi ${c.who}, this is lifeline, a reminder service. ${owner ?? "Someone who cares about you"} would like me to text you each day at ${c.at_time}: "Time to ${c.task}." Reply YES to agree, or NO if you'd rather not. Reply STOP any time to end it.`;

const careConsent = defineAction({
  name: "care.consent",
  tier: 2,
  description: "Send (or send again) the one-time consent text to someone set up for caregiver reminders. Only after they reply YES do the daily texts start.",
  schema: z.object({ who: z.string().min(1), phone: z.string().optional(), task: z.string().optional(), time: z.string().optional() }),
  echo: (a, ctx) => a.phone && a.task
    ? `This texts ${personName(a.who)} at ${a.phone} once, to ask if they're happy to get a daily text at ${a.time}: "Time to ${a.task}. Reply TAKEN when you have." Nothing else is sent unless they reply YES.\n\nThe message:\n\`\`\`\n${consentBody(first(ctx.user), { who: personName(a.who), task: a.task, at_time: a.time ?? "" })}\n\`\`\``
    : `This texts ${personName(a.who)} the consent message again, at the number you gave. Nothing else is sent unless they reply YES.`,
  async run(args, ctx) {
    if (!smsProvider()) throw new Error("Text messages aren't switched on here, so nothing was sent. Whoever runs lifeline can turn them on (docs/SMS.md).");
    const c = await ctx.db.one<Care>(`SELECT * FROM well_care WHERE user_id=$1 AND lower(who)=lower($2) AND status IN ('draft','asked','declined') ORDER BY id DESC LIMIT 1`, [ctx.user.id, personName(args.who)]);
    if (!c) throw new Error(`I don't have a reminder set up for ${personName(args.who)}. Say something like "remind ${personName(args.who)} to take her pill at 8am by text".`);
    try { await sendSms(c.phone, consentBody(first(ctx.user), c)); }
    catch { throw new Error(`The text to ${c.who} didn't go through. Check the number and try again?`); }
    await ctx.db.query(`UPDATE well_care SET status='asked' WHERE id=$1`, [c.id]);
    return { reply: `Sent. Nothing starts until ${c.who} replies YES, and I'll tell you either way.` };
  },
});

const careStop = defineAction({
  name: "care.stop",
  tier: 1,
  description: "Stop caregiver text reminders for someone.",
  schema: z.object({ who: z.string().min(1) }),
  async run(args, ctx) {
    const rows = await ctx.db.query<Care>(`UPDATE well_care SET status='stopped' WHERE user_id=$1 AND lower(who)=lower($2) AND status IN ('draft','asked','active') RETURNING *`, [ctx.user.id, personName(args.who)]);
    for (const r of rows) if (r.job_id) await cancelJob(ctx.db, r.job_id);
    return { reply: rows.length ? `Stopped. I won't text ${rows[0].who} any more.` : `I wasn't texting ${personName(args.who)}.` };
  },
});

const careList = defineAction({
  name: "care.list",
  tier: 1,
  description: "Show caregiver text reminders: who, what, when, and whether they've agreed.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<Care>(`SELECT * FROM well_care WHERE user_id=$1 AND status IN ('asked','active','declined') ORDER BY id`, [ctx.user.id]);
    if (!rows.length) return { reply: `No reminders for anyone else yet. Say "remind Mum to take her blood pressure pill at 8am by text" to set one up; they agree first.` };
    const word: Record<string, string> = { asked: "waiting for their YES", active: "on", declined: "they said no thanks" };
    return { reply: rows.map((r) => `- ${r.who}: ${r.task}, ${r.at_time} daily, ${word[r.status]}`).join("\n") };
  },
});

/**
 * Core hook: an inbound SMS from a number that has a caregiver reminder. Returns the text to send back,
 * or null when the message isn't one of ours (core carries on as normal). Handles YES, NO, STOP and TAKEN.
 */
export async function handleCareSms(db: Db, from: string, text: string, now = new Date()): Promise<string | null> {
  const phone = normalisePhone(from);
  const rows = await db.query<Care>(`SELECT * FROM well_care WHERE phone=$1 AND status IN ('asked','active') ORDER BY id`, [phone]);
  if (!rows.length) return null;
  const t = text.trim().toUpperCase().replace(/[.!]+$/, "").replace(/\s+/g, " ");
  const asked = rows.filter((r) => r.status === "asked"), active = rows.filter((r) => r.status === "active");
  if (/^(?:YES|Y|YES PLEASE|OK|OKAY|SURE|I AGREE|AGREE)$/.test(t) && asked.length) {
    // One yes answers one ask: the most recent. Someone else's request waits for its own yes.
    const latest = asked[asked.length - 1];
    for (const c of [latest]) {
      const [h, m] = c.at_time.split(":").map(Number);
      const jobId = await schedule(db, { userId: c.user_id, kind: "well_care_dose", cron: `${m} ${h} * * *`, tz: c.tz, payload: { careId: c.id } });
      await db.query(`UPDATE well_care SET status='active', job_id=$2 WHERE id=$1`, [c.id, jobId]);
      await tell(db, c.user_id, `${c.who} said yes. I'll text them at ${c.at_time} each day: "Time to ${c.task}." If they haven't replied TAKEN within two hours, I'll tell you quietly.`, { exempt: true, kind: "well_care" });
    }
    const others = asked.length - 1;
    return `Thank you. I'll text you at ${latest.at_time} each day. Reply TAKEN when it's done, or STOP to end these any time.${others ? " Someone else asked as well; reply YES again to agree to theirs too." : ""}`;
  }
  if (/^(?:NO|N|NO THANKS|NO THANK YOU)$/.test(t) && asked.length) {
    for (const c of [asked[asked.length - 1]]) {
      await db.query(`UPDATE well_care SET status='declined' WHERE id=$1`, [c.id]);
      await tell(db, c.user_id, `${c.who} said no thanks to the daily texts, so I won't send any.`, { exempt: true, kind: "well_care" });
    }
    return "No problem. I won't text you again.";
  }
  if (/^(?:STOP|STOP ALL|UNSUBSCRIBE|END|CANCEL|QUIT)$/.test(t)) {
    for (const c of rows) {
      await db.query(`UPDATE well_care SET status='stopped' WHERE id=$1`, [c.id]);
      if (c.job_id) await cancelJob(db, c.job_id);
      await tell(db, c.user_id, `${c.who} asked to stop the daily texts, so they've stopped.`, { exempt: true, kind: "well_care" });
    }
    return "Stopped. You won't get any more texts from lifeline.";
  }
  if (/^(?:TAKEN|DONE|TOOK IT|YES TAKEN|TAKEN IT|DID IT)$/.test(t) && active.length) {
    const log = await db.one<{ id: number }>(`SELECT l.id FROM well_care_logs l WHERE l.care_id = ANY($1::int[]) AND l.taken_at IS NULL AND l.sent_at > $2::timestamptz - interval '18 hours' ORDER BY l.id DESC LIMIT 1`, [active.map((c) => c.id), now]);
    if (!log) return "Thank you. Nothing's waiting just now.";
    await db.query(`UPDATE well_care_logs SET taken_at=$2 WHERE id=$1`, [log.id, now]);
    return "Thank you, noted.";
  }
  return null;
}

onJob("well_care_dose", async (job, deps) => {
  const c = await deps.db.one<Care>(`SELECT * FROM well_care WHERE id=$1`, [job.payload.careId]);
  if (!c || c.status !== "active") return;
  const owner = await deps.getUser(c.user_id);
  if (!owner) return;
  try {
    await sendSms(c.phone, `Hi ${c.who}, time to ${c.task}. Reply TAKEN when you have.`);
  } catch {
    await push(deps, owner, "well_care", `I couldn't text ${c.who} the ${c.at_time} reminder. The number or the text service may need a look.`, { exempt: true });
    return;
  }
  const l = await deps.db.one<{ id: number }>(`INSERT INTO well_care_logs (care_id, sent_at) VALUES ($1, now()) RETURNING id`, [c.id]);
  await schedule(deps.db, { userId: c.user_id, kind: "well_care_check", payload: { logId: l!.id }, runAt: new Date(Date.now() + 2 * 3_600_000) });
});

onJob("well_care_check", async (job, deps) => {
  const l = await deps.db.one<{ id: number; taken_at: string | null; alerted: boolean; who: string; task: string; at_time: string; user_id: number; status: string }>(
    `SELECT l.id, l.taken_at, l.alerted, c.who, c.task, c.at_time, c.user_id, c.status FROM well_care_logs l JOIN well_care c ON c.id=l.care_id WHERE l.id=$1`, [job.payload.logId]);
  if (!l || l.taken_at || l.alerted || l.status !== "active") return;
  const owner = await deps.getUser(l.user_id);
  if (!owner) return;
  // Something the person set up themselves and that can't wait: it comes even on a quiet day.
  await push(deps, owner, "well_care", `No reply from ${l.who} yet about the ${l.at_time} reminder (${l.task.replace(/\byour\b/g, "their")}). You might want to check in.`, { exempt: true });
  await deps.db.query(`UPDATE well_care_logs SET alerted=true WHERE id=$1`, [l.id]);
});

/* =====================================================================
 * 12. Accountability buddies
 * ===================================================================== */

/** Someone in the circle by @handle (their buddy name or Telegram username), or by name if only one matches. Never yourself. */
export async function findMember(db: Db, who: string, selfId: number): Promise<User | null> {
  const w = who.trim().replace(/^@/, "").toLowerCase();
  if (!w) return null;
  const rows = await db.query<User>(
    `SELECT * FROM users WHERE id<>$1 AND (lower(coalesce(prefs->'wb'->>'handle','')) = $2 OR lower(coalesce(prefs->>'username','')) = $2 OR lower(coalesce(name,'')) = $2 OR lower(split_part(coalesce(name,''),' ',1)) = $2) ORDER BY id`,
    [selfId, w],
  );
  const handle = rows.filter((r) => String((r.prefs as any)?.wb?.handle ?? "").toLowerCase() === w || String(r.prefs?.username ?? "").toLowerCase() === w);
  if (handle.length === 1) return handle[0];
  return rows.length === 1 ? rows[0] : null;
}
const nameOf = (u: User) => first(u) ?? (wb(u).handle ? `@${wb(u).handle}` : "Your buddy");
const habitWord = (h: string) => h.trim().toLowerCase().replace(/^(?:my|the)\s+/, "");

interface Pair { id: number; from_user: number; to_user: number; habit: string; status: string }

const buddyHandle = defineAction({
  name: "buddy.handle",
  tier: 1,
  description: "Set the name friends use to find this person for accountability buddies ('my buddy name is tolu').",
  schema: z.object({ handle: z.string().regex(/^@?[A-Za-z0-9_.-]{2,30}$/) }),
  async run(args, ctx) {
    const h = args.handle.replace(/^@/, "").toLowerCase();
    const taken = await ctx.db.one(`SELECT 1 FROM users WHERE id<>$1 AND lower(coalesce(prefs->'wb'->>'handle',''))=$2`, [ctx.user.id, h]);
    if (taken) throw new Error(`Someone here already uses @${h}. Try another?`);
    await setWb(ctx.db, ctx.user, { handle: h });
    return { reply: `You're @${h} here. A friend can say "buddy up on running with @${h}", and you'll get to say yes or no.` };
  },
});

const buddyRequest = defineAction({
  name: "buddy.request",
  tier: 2,
  description: "Ask another lifeline user to be accountability buddies on one habit ('buddy up on running with @tolu'). They get Yes and No; once paired, each sees the other's check-ins for that habit in the brief, nothing else.",
  schema: z.object({ habit: z.string().min(2).max(40), who: z.string().min(2).max(40) }),
  async needs(args, ctx) {
    if (await findMember(ctx.db, args.who, ctx.user.id)) return null;
    const w = args.who.replace(/^@/, "");
    return { need: "who", question: `I can't find @${w} here. Ask them to tell me "my buddy name is ${w.toLowerCase()}", then try again, or tell me the name they use with me.` };
  },
  fill(need, answer) {
    return need === "who" && /^@?[A-Za-z0-9_.-]{2,30}$/.test(answer.trim()) ? { who: answer.trim() } : null;
  },
  echo: (a) => `This sends @${a.who.replace(/^@/, "")} a request to be ${habitWord(a.habit)} buddies. If they say yes, you'll each see the other's ${habitWord(a.habit)} check-ins in your morning brief, and nothing else. Either of you can end it any time.`,
  async run(args, ctx) {
    const other = await findMember(ctx.db, args.who, ctx.user.id);
    if (!other) throw new Error(`I can't find @${args.who.replace(/^@/, "")} here any more. Check the name and try again?`);
    const habit = habitWord(args.habit);
    const dup = await ctx.db.one(`SELECT 1 FROM well_buddies WHERE status IN ('asked','active') AND lower(habit)=$3 AND ((from_user=$1 AND to_user=$2) OR (from_user=$2 AND to_user=$1))`, [ctx.user.id, other.id, habit]);
    if (dup) return { reply: `You and ${nameOf(other)} already have a ${habit} pairing, or a request waiting.` };
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO well_buddies (from_user, to_user, habit) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, other.id, habit]);
    await tell(ctx.db, other.id, `${first(ctx.user) ?? "Someone in the circle"} would like to be ${habit} buddies with you. You'd each see the other's ${habit} check-ins in your morning brief, nothing else, and either of you can end it any time.`, { buttons: [{ label: "Yes", data: `wb:b:y:${r!.id}` }, { label: "No thanks", data: `wb:b:n:${r!.id}` }], kind: "well_buddy" });
    return { reply: `Sent. I'll tell you when ${nameOf(other)} answers.` };
  },
});

async function answerPair(db: Db, user: User, pair: Pair | undefined, yes: boolean): Promise<string> {
  if (!pair || pair.to_user !== user.id || pair.status !== "asked") return "That request has already been answered, or it's gone.";
  const from = await db.one<User>(`SELECT * FROM users WHERE id=$1`, [pair.from_user]);
  await db.query(`UPDATE well_buddies SET status=$2 WHERE id=$1`, [pair.id, yes ? "active" : "declined"]);
  const fname = from ? nameOf(from) : "them";
  if (yes) {
    await tell(db, pair.from_user, `${first(user) ?? "Your friend"} said yes. You're ${pair.habit} buddies now; you'll see each other's check-ins in the morning brief. Say "end ${pair.habit} buddies" any time.`, { kind: "well_buddy" });
    return `You're ${pair.habit} buddies with ${fname}. Check in as usual ("did ${pair.habit}") and you'll see each other's in the morning brief. Say "end ${pair.habit} buddies" any time.`;
  }
  await tell(db, pair.from_user, `${first(user) ?? "Your friend"} passed on ${pair.habit} buddies for now. Your own streak carries on.`, { kind: "well_buddy" });
  return `No problem. I've let ${fname} know, kindly.`;
}

const buddyAnswer = defineAction({
  name: "buddy.answer",
  tier: 1,
  description: "Say yes or no to a buddy request someone sent. `who` is the person who asked (optional if there's only one).",
  schema: z.object({ yes: z.boolean(), who: z.string().optional() }),
  async run(args, ctx) {
    const rows = await ctx.db.query<Pair & { name: string | null; prefs: any }>(`SELECT b.*, u.name, u.prefs FROM well_buddies b JOIN users u ON u.id=b.from_user WHERE b.to_user=$1 AND b.status='asked' ORDER BY b.id DESC`, [ctx.user.id]);
    const w = args.who?.replace(/^@/, "").replace(/'s$/i, "").toLowerCase();
    const pair = w ? rows.find((r) => (r.name ?? "").toLowerCase().split(" ")[0] === w || (r.name ?? "").toLowerCase() === w || String(r.prefs?.wb?.handle ?? "").toLowerCase() === w || String(r.prefs?.username ?? "").toLowerCase() === w) : rows[0];
    if (!pair) return { reply: rows.length ? `I can't find a request from ${args.who}.` : "There's no buddy request waiting for you." };
    return { reply: await answerPair(ctx.db, ctx.user, pair, args.yes) };
  },
});

async function activePairs(db: Db, userId: number): Promise<(Pair & { other: number })[]> {
  const rows = await db.query<Pair>(`SELECT * FROM well_buddies WHERE status='active' AND (from_user=$1 OR to_user=$1) ORDER BY id`, [userId]);
  return rows.map((r) => ({ ...r, other: r.from_user === userId ? r.to_user : r.from_user }));
}

const buddyEnd = defineAction({
  name: "buddy.end",
  tier: 1,
  description: "End an accountability buddy pairing, by habit or by the buddy's name. The other person is told kindly.",
  schema: z.object({ habit: z.string().optional(), who: z.string().optional() }),
  async run(args, ctx) {
    const pairs = await activePairs(ctx.db, ctx.user.id);
    let pick = pairs;
    if (args.habit) pick = pick.filter((p) => p.habit === habitWord(args.habit!));
    if (args.who) {
      const o = await findMember(ctx.db, args.who, ctx.user.id);
      pick = o ? pick.filter((p) => p.other === o.id) : [];
    }
    if (!pick.length) return { reply: "You don't have a buddy pairing like that." };
    for (const p of pick) {
      await ctx.db.query(`UPDATE well_buddies SET status='ended', ended_at=now() WHERE id=$1`, [p.id]);
      await tell(ctx.db, p.other, `Your ${p.habit} buddy pairing with ${first(ctx.user) ?? "your friend"} has ended. Your own streak carries on, and I'm still counting.`, { kind: "well_buddy" });
    }
    return { reply: `Ended. ${pick.length === 1 ? "I've let them know, kindly." : "I've let them each know, kindly."}` };
  },
});

const buddyCheer = defineAction({
  name: "buddy.cheer",
  tier: 1,
  description: "Send a buddy a short cheer for the habit you share. Only works with someone who agreed to be your buddy.",
  schema: z.object({ who: z.string().min(1) }),
  async run(args, ctx) {
    const o = await findMember(ctx.db, args.who, ctx.user.id);
    const p = o ? (await activePairs(ctx.db, ctx.user.id)).find((x) => x.other === o.id) : undefined;
    if (!o || !p) return { reply: `You can cheer a buddy once you've paired up. Say "buddy up on running with @${args.who.replace(/^@/, "")}".` };
    await tell(ctx.db, o.id, `${first(ctx.user) ?? "Your buddy"} is cheering you on with ${p.habit}. Rest days count too.`, { kind: "well_buddy" });
    return { reply: `Sent your cheer to ${nameOf(o)}.` };
  },
});

const buddyList = defineAction({
  name: "buddy.list",
  tier: 1,
  description: "Show accountability buddies and any requests waiting.",
  schema: z.object({}),
  async run(_a, ctx) {
    const pairs = await activePairs(ctx.db, ctx.user.id);
    const asks = await ctx.db.query<{ habit: string; name: string | null }>(`SELECT b.habit, u.name FROM well_buddies b JOIN users u ON u.id=b.from_user WHERE b.to_user=$1 AND b.status='asked'`, [ctx.user.id]);
    if (!pairs.length && !asks.length) return { reply: `No buddies yet. Say "buddy up on running with @tolu" to ask someone; they say yes first. Your own buddy name: ${wb(ctx.user).handle ? `@${wb(ctx.user).handle}` : `not set, say "my buddy name is ..."`}.` };
    const lines: string[] = [];
    for (const p of pairs) { const o = await ctx.db.one<User>(`SELECT * FROM users WHERE id=$1`, [p.other]); lines.push(`- ${cap1(p.habit)} with ${o ? nameOf(o) : "a friend"}`); }
    for (const a of asks) lines.push(`- ${a.name?.split(" ")[0] ?? "Someone"} asked to be ${a.habit} buddies. Say "yes to ${a.name?.split(" ")[0] ?? "their"} buddy request" or "no to ${a.name?.split(" ")[0] ?? "their"} buddy request".`);
    return { reply: lines.join("\n") };
  },
});
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

onButton("b", async (db, user, [yn, id]) => {
  const pair = await db.one<Pair>(`SELECT * FROM well_buddies WHERE id=$1`, [Number(id)]);
  return { text: await answerPair(db, user, pair, yn === "y") };
});

/** Did this person check in on a habit like this on a day? */
async function checkedIn(db: Db, userId: number, habit: string, day: string): Promise<boolean> {
  return Boolean(await db.one(`SELECT 1 FROM habit_checkins c JOIN habits h ON h.id=c.habit_id WHERE h.user_id=$1 AND (lower(h.name) LIKE $2 OR $3 LIKE '%' || lower(h.name) || '%') AND c.day=$4::date`, [userId, `%${habit}%`, habit, day]));
}

/** The brief: what your buddy did yesterday. A skipped day gets a cheer, never a count of misses. */
addBriefSection({
  key: "well_buddies", order: 50,
  async lines(db, user, now) {
    const out: string[] = [];
    const y = iso(today(user, now).minus({ days: 1 }));
    for (const p of (await activePairs(db, user.id)).slice(0, 2)) {
      const o = await db.one<User>(`SELECT * FROM users WHERE id=$1`, [p.other]);
      if (!o) continue;
      const them = await checkedIn(db, o.id, p.habit, y), me = await checkedIn(db, user.id, p.habit, y);
      const n = nameOf(o);
      out.push(them && me ? `${cap1(p.habit)} with ${n}: you both checked in yesterday.` : them ? `${cap1(p.habit)} with ${n}: ${n} checked in yesterday. Rest days count too.` : `${cap1(p.habit)} with ${n}: ${n} took a rest day yesterday. Say "cheer ${n}" to send a kind word.`);
    }
    const asks = await db.query<{ habit: string; name: string | null }>(`SELECT b.habit, u.name FROM well_buddies b JOIN users u ON u.id=b.from_user WHERE b.to_user=$1 AND b.status='asked' ORDER BY b.id LIMIT 1`, [user.id]);
    for (const a of asks) { const n = a.name?.split(" ")[0] ?? "Someone"; out.push(`${n} asked to be ${a.habit} buddies. Say "yes to ${n}'s buddy request" or "no to ${n}'s buddy request".`); }
    return out.slice(0, 2);
  },
});

register(touchAdd, touchLog, touchDue, touchRemove, careAdd, careConsent, careStop, careList, buddyHandle, buddyRequest, buddyAnswer, buddyEnd, buddyCheer, buddyList);

/* ---------------- words ---------------- */

const PING = String.raw`(?:[,\s]+(?:and\s+)?(ping me|send me a ping|ping me about it))?`;
const VERBS = String.raw`(?:keep in touch with|stay in touch with|call|ring|phone|visit|see|text|message|check in (?:with|on)|catch up with|reach out to)`;
/** A person's name, not "it", "the doctor" or "back". */
const WHO = String.raw`(?!(?:it|that|this|them|him|her|you|me|us|back|home|work|someone|anyone|everyone|nobody|no one|up|out|over|the|a|an|my (?:bank|landlord|boss|doctor|dentist))\b)`;
/** One to three words of a name ("Mum", "my sister", "Uncle Femi"), never a phrase like "Tolu at the market". */
const NAME = String.raw`((?:my\s+)?[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'.-]*(?:\s+(?!(?:at|in|on|for|about|with|and|to|from|today|yesterday|tonight|last|this|every|once|each|if|weekly|monthly|daily)\b)[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ'.-]*){0,2})`;
const every = (name: string, cadence: string, ping?: string) => { const e = readEvery(cadence) ?? (/\b(?:morning|evening|night|day|afternoon)\b/i.test(cadence) ? { every_days: 1 } : /\b(?:weekend|saturday|sunday|monday|tuesday|wednesday|thursday|friday)s?\b/i.test(cadence) ? { every_days: 7 } : null); return { action: "touch.add", args: { name: name.trim(), ...(e ?? { every_days: 14 }), ...(ping ? { ping: true } : {}) } }; };

addRules(
  [rx(String.raw`${VERBS}\s+${WHO}${NAME}\s+(every\s+.+?|once a (?:week|month|fortnight)|weekly|monthly|daily|each (?:week|month))${PING}`), (m) => every(m[1], m[2], m[3])],
  [rx(String.raw`(?:check in with|catch up with|keep in touch with|remind me about|nudge me about|call|ring|text)\s+${WHO}${NAME}\s+if (?:we|i) haven'?t (?:talked|spoken|caught up|been in touch|seen (?:each other|them|him|her))(?:\s+(?:to each other))?\s+(?:in|for)\s+(?:over\s+|more than\s+)?(.+?)${PING}`), (m) => every(m[1], m[2], m[3])],
  [rx(String.raw`(?:i\s+)?(?:just\s+)?(?:called|rang|phoned|talked to|talked with|spoke to|spoke with|caught up with|texted|messaged|facetimed|video called)\s+${WHO}${NAME}(?:\s+(today|yesterday|last night|this morning|this evening|tonight))?`), (m) => ({ action: "touch.log", args: { name: m[1].trim(), when: /yesterday|last night/i.test(m[2] ?? "") ? "yesterday" : "today" } })],
  [rx(String.raw`who should i (?:catch up with|call|check in (?:with|on)|reach out to|get in touch with|message)|who(?:'s| is) due (?:a call|a catch[- ]up)|who haven'?t i (?:talked to|spoken to|called)(?: in a while)?|(?:my )?keep in touch list`), () => ({ action: "touch.due", args: {} })],
  [rx(String.raw`(?:stop|no more) (?:keeping in touch with|reminding me (?:to call|about)|nudging me about|the nudges? (?:about|for)) (.{1,30})`), (m) => ({ action: "touch.remove", args: { name: m[1] } })],

  [rx(String.raw`remind\s+(?!me\b)(.{1,30}?)\s+to\s+(.{2,80}?)\s+(?:at|every day at|each day at|daily at)\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s+(?:every day|daily|each day))?\s+(?:by|via|over|with a)\s+(?:text|sms|text message)(?:\s+(?:on|at|to)\s+(\+?[\d\s().-]{7,20}))?`), (m) => ({ action: "care.add", args: { who: m[1], task: m[2], time: m[3], ...(m[4] ? { phone: m[4].trim() } : {}) } })],
  [rx(String.raw`(?:re-?send|send) (?:the )?consent (?:text|message) to (.{1,30}?)(?: again)?`), (m) => ({ action: "care.consent", args: { who: m[1] } })],
  [rx(String.raw`(?:stop|cancel|end) (?:the )?(?:texts|text reminders|daily texts) (?:for|to) (.{1,30})`), (m) => ({ action: "care.stop", args: { who: m[1] } })],
  [rx(String.raw`(?:who am i (?:reminding|texting)|(?:my )?caregiver reminders|(?:my )?reminders for (?:other people|others))`), () => ({ action: "care.list", args: {} })],

  [rx(String.raw`my buddy name is @?([A-Za-z0-9_.-]{2,30})|call me @([A-Za-z0-9_.-]{2,30}) for buddies`), (m) => ({ action: "buddy.handle", args: { handle: m[1] ?? m[2] } })],
  [rx(String.raw`(?:buddy up|be buddies|pair up|team up)\s+(?:on|for)\s+(.{2,40}?)\s+with\s+(@?[A-Za-z0-9_.-]{2,30})`), (m) => ({ action: "buddy.request", args: { habit: m[1], who: m[2] } })],
  [rx(String.raw`(?:buddy up|pair up|team up)\s+with\s+(@?[A-Za-z0-9_.-]{2,30})\s+(?:on|for)\s+(.{2,40}?)`), (m) => ({ action: "buddy.request", args: { habit: m[2], who: m[1] } })],
  [rx(String.raw`(yes|no)(?: thanks)?(?:,)? to (@?[A-Za-z0-9_.-]{2,30}?)(?:'s)? buddy request|(accept|decline) (?:the )?buddy request(?: from (@?[A-Za-z0-9_.-]{2,30}))?`), (m) => ({ action: "buddy.answer", args: { yes: /^(?:yes|accept)$/i.test(m[1] ?? m[3]), ...(m[2] ?? m[4] ? { who: m[2] ?? m[4] } : {}) } })],
  [rx(String.raw`(?:end|stop|cancel) (?:the |my )?(.{2,30}?) buddies|(?:end|stop) (?:being )?buddies with (@?[A-Za-z0-9_.-]{2,30})`), (m) => ({ action: "buddy.end", args: m[1] ? { habit: m[1] } : { who: m[2] } })],
  [rx(String.raw`(?:send (?:a )?cheer to|cheer(?: on)?) (?!(?:up|me|us)\b)(@?[A-Za-z0-9_.-]{2,30})`), (m) => ({ action: "buddy.cheer", args: { who: m[1] } })],
  [rx(String.raw`(?:my )?(?:accountability )?buddies|buddy requests`), () => ({ action: "buddy.list", args: {} })],
);

addExamples("touch.add", ["call Mum every Sunday", "check in with Ese if we haven't talked in 3 weeks", "keep in touch with Tolu every 2 weeks and ping me", "visit Grandpa once a month"]);
addExamples("touch.log", ["called Mum", "talked to Ese", "I caught up with Tolu yesterday"]);
addExamples("touch.due", ["who should I catch up with", "who haven't I talked to in a while"]);
addExamples("touch.remove", ["stop keeping in touch with Tolu"]);
addExamples("care.add", ["remind Mum to take her blood pressure pill at 8am by text", "remind Dad to check his sugar at 7pm by text on +44 7700 900123"]);
addExamples("care.consent", ["resend the consent text to Mum"]);
addExamples("care.stop", ["stop the texts for Mum"]);
addExamples("care.list", ["who am I reminding"]);
addExamples("buddy.handle", ["my buddy name is tolu"]);
addExamples("buddy.request", ["buddy up on running with @tolu", "pair up with @ana on reading"]);
addExamples("buddy.answer", ["yes to Ada's buddy request", "decline buddy request"]);
addExamples("buddy.end", ["end running buddies", "stop being buddies with @tolu"]);
addExamples("buddy.cheer", ["cheer Tolu", "send a cheer to @ana"]);
addExamples("buddy.list", ["my buddies"]);

addCues("touch", ["keep in touch", "catch up", "called", "talked to", "haven't talked", "check in with", "reach out"]);
addCues("care", ["by text", "remind mum", "remind dad", "caregiver", "consent text", "taken"]);
addCues("buddy", ["buddy", "buddies", "accountability", "pair up", "cheer"]);

addCapability({
  key: "keep_in_touch", name: "Keeping in touch",
  cues: ["keep in touch", "catch up with", "call my mum", "haven't talked", "lose touch"],
  what: "Tell me who you want to stay close to and how often, and I'll mention it in your morning brief when it's time, with something to ask about from your own notes.",
  say: ["call Mum every Sunday", "check in with Ese if we haven't talked in 3 weeks", "talked to Ese", "who should I catch up with"],
  then: "Say \"ping me\" if you'd rather a ping than a line in the brief. \"stop keeping in touch with Ese\" ends it.",
}, "People");
addCapability({
  key: "caregiver", name: "Reminders for someone you care for",
  cues: ["caregiver", "remind my mum", "remind my dad", "by text", "elderly parent"],
  what: "I can text someone who isn't on lifeline a daily reminder, like a pill at 8am, and ask them to reply TAKEN. If they haven't within two hours, I tell you quietly.",
  say: ["remind Mum to take her blood pressure pill at 8am by text", "who am I reminding", "stop the texts for Mum"],
  then: "They get one consent text first and nothing starts until they reply YES. They can reply STOP any time.",
  limits: "Needs text messages switched on for this lifeline.",
}, "People");
addCapability({
  key: "buddies", name: "Accountability buddies",
  cues: ["buddy", "accountability", "pair up", "workout partner"],
  what: "Pair up with a friend on lifeline for one habit. Each morning you see whether they checked in, and a rest day gets a cheer, never a telling-off.",
  say: ["buddy up on running with @tolu", "my buddy name is tolu", "cheer Tolu", "end running buddies"],
  then: "They say yes first. Either of you can end it any time, and the other is told kindly.",
}, "People");

/* Caregiver replies (YES, TAKEN, STOP) arrive as texts from people who aren't lifeline users. */
addTextReplyHandler(async (db, channel, from, text) => {
  if (channel !== "sms") return null;
  // Someone who also uses lifeline by text keeps their own yes, no and stop; only TAKEN is read as a caregiver reply.
  const linked = await db.one(`SELECT 1 FROM identities WHERE channel='sms' AND external_id=$1`, [from]);
  if (linked && !/^(?:TAKEN|TOOK IT|YES TAKEN|TAKEN IT)[.!]*$/i.test(text.trim())) return null;
  return handleCareSms(db, from, text);
});
