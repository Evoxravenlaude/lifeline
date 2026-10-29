/**
 * Safety contacts and check-ins. "Check on me: walking home, 25 min" sets a deadline; "I'm safe" ends it.
 * At the deadline the person gets a gentle ping; only after a grace period with no answer are their
 * confirmed contacts told, with the last shared location. Nobody is ever alerted unless the person
 * started a check-in, and only contacts who agreed (or, for email and phone, were told and can opt out).
 * This never replaces emergency services, and every message says so.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import type { Db } from "../../../core/db.js";
import { register } from "../../../policy/registry.js";
import { addBriefSection, addButtons, addCapability, addCues, addExamples, addFirstLook, addLocationHandler, addRules, addSchema, type ButtonReply } from "../../../core/plugins.js";
import { cancelJob, onJob, push, schedule, type SchedulerDeps } from "../../../core/scheduler.js";
import { dispatch } from "../../../core/dispatch.js";
import { canEmail, sendEmail } from "../../../core/email.js";
import { sendSms, smsProvider } from "../../../channels/sms.js";
import { parseWhen } from "../../../core/time.js";
import { parseByRules } from "../../../intent/rules.js";
import { log } from "../../../core/log.js";
import { config } from "../../../core/config.js";
import { addTextReplyHandler } from "../../../core/plugins.js";
import { EMAIL, PHONE, emergencyNumber, findMember, first, fullName, mapLink, ownEmail } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS safety_contacts (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, target TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, kind, target));
CREATE TABLE IF NOT EXISTS safety_checkins (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), about TEXT, due_at TIMESTAMPTZ NOT NULL, grace_min INT NOT NULL DEFAULT 10, status TEXT NOT NULL DEFAULT 'active', due_job INT, alert_job INT, lat DOUBLE PRECISION, lon DOUBLE PRECISION, loc_at TIMESTAMPTZ, alerted_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS safety_checkins_user ON safety_checkins (user_id, status)`);

interface Contact { id: number; user_id: number; kind: "user" | "email" | "phone"; target: string; label: string; status: string }
interface Checkin { id: number; user_id: number; about: string | null; due_at: string; grace_min: number; status: string; due_job: number | null; alert_job: number | null; lat: number | null; lon: number | null; loc_at: string | null }

const GRACE = 10;
const hhmm = (d: Date | string, tz: string) => DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat("HH:mm");
/** Contacts who may be alerted: only those who said yes, by button, text or email reply. */
const alertable = (db: Db, userId: number) => db.query<Contact>(`SELECT * FROM safety_contacts WHERE user_id=$1 AND status='confirmed' ORDER BY id`, [userId]);
const names = (cs: Contact[]) => { const l = cs.map((c) => c.label); return l.length <= 1 ? (l[0] ?? "") : `${l.slice(0, -1).join(", ")} and ${l[l.length - 1]}`; };
const active = (db: Db, userId: number) => db.one<Checkin>(`SELECT * FROM safety_checkins WHERE user_id=$1 AND status IN ('active','alerted') ORDER BY id DESC LIMIT 1`, [userId]);

/* ---------------- contacts ---------------- */

type Who = { kind: "email"; target: string; label: string } | { kind: "phone"; target: string; label: string } | { kind: "user"; target: string; label: string; user: User };
async function resolveWho(db: Db, me: User, raw: string): Promise<Who | string> {
  const who = raw.trim().replace(/^(?:my |the )/i, "").replace(/[.!]+$/, "");
  if (EMAIL.test(who)) return canEmail() ? { kind: "email", target: who.toLowerCase(), label: who.toLowerCase() } : "Email isn't switched on for this circle yet, so I can't reach an address. Someone who uses lifeline works.";
  if (PHONE.test(who) && who.replace(/\D/g, "").length >= 8) {
    if (!smsProvider()) return "Texts aren't switched on here, so I can't reach a phone number. Is there an email address, or someone in lifeline, I can use instead?";
    if (!/^(?:\+|00)/.test(who)) return "What's the number with its country code, like +44 7700 900123? Then I reach the right phone.";
    const e164 = `+${who.replace(/\D/g, "").replace(/^00/, "")}`;
    return { kind: "phone", target: e164, label: e164 };
  }
  const m = await findMember(db, me, who);
  if (m.many) return `More than one person in lifeline is called ${who}. What's their full name?`;
  if (!m.found) return `I can't find ${who} in lifeline. Could you give me their email address${smsProvider() ? " or phone number with its country code" : ""} instead? Or ask them to join first.`;
  return { kind: "user", target: String(m.found.id), label: m.found.name ?? who, user: m.found };
}

const contactAdd = defineAction({
  name: "safety.contact_add",
  tier: 2,
  description: "Add a safety contact who is alerted if a safety check-in runs out: someone in lifeline (by name or @username, they get Yes/No buttons to agree), an email address, or a phone number with country code (they get a one-time notice). 'who' is the name, address or number.",
  schema: z.object({ who: z.string().min(2) }),
  async needs(args, ctx) {
    const r = await resolveWho(ctx.db, ctx.user, args.who);
    return typeof r === "string" ? { need: "who", question: r } : null;
  },
  fill: (_need, answer) => (answer.trim().length < 80 && !/\?\s*$/.test(answer) && !parseByRules(answer) ? { who: answer.trim() } : null),
  echo: (a) => EMAIL.test(a.who.trim())
    ? `This emails ${a.who.trim()} once to ask them to be your safety contact and explain what that means. Only if they reply YES would they ever get an alert.`
    : /^\+|^00/.test(a.who.trim())
      ? `This texts ${a.who.trim()} once to ask them to be your safety contact and explain what that means. Only if they reply YES would they ever get an alert.`
      : `This asks ${a.who.trim().replace(/^@/, "")} in lifeline to be your safety contact, with Yes and No buttons. Only if they say yes would they ever get an alert.`,
  async run(args, ctx) {
    const w = await resolveWho(ctx.db, ctx.user, args.who);
    if (typeof w === "string") throw new Error(w);
    const dup = await ctx.db.one<Contact>(`SELECT * FROM safety_contacts WHERE user_id=$1 AND kind=$2 AND target=$3`, [ctx.user.id, w.kind, w.target]);
    if (dup && dup.status !== "declined") return { reply: `${w.label} is already ${dup.status === "pending" ? "waiting to answer" : "one of your safety contacts"}.` };
    if (dup) await ctx.db.query(`DELETE FROM safety_contacts WHERE id=$1`, [dup.id]);
    const row = (await ctx.db.one<{ id: number }>(`INSERT INTO safety_contacts (user_id, kind, target, label, status) VALUES ($1,$2,$3,$4,'pending') RETURNING id`, [ctx.user.id, w.kind, w.target, w.label]))!;
    const me = fullName(ctx.user), f = first(ctx.user);
    const what = `If ${f} starts a safety check-in (walking home, a taxi, a first date) and doesn't confirm they're safe in time, lifeline sends you one message with what they were doing and where they last were. Nothing else is ever sent to you.`;
    let ok = false;
    if (w.kind === "user") {
      ok = await dispatch(ctx.db, w.user, { text: `${me} would like you as a safety contact in lifeline.\n\n${what}\n\nYou can stop any time by saying "stop being a safety contact".`, buttons: [{ label: "Yes, I'll do it", data: `sf:ct:y:${row.id}` }, { label: "No, sorry", data: `sf:ct:n:${row.id}` }] });
    } else if (w.kind === "email") {
      const reply = await ownEmail(ctx.db, ctx.user);
      const inbox = config.inboundEmail;
      ok = await sendEmail(w.target, `${me} would like you as a safety contact`, `Hello,\n\n${me} would like you as a safety contact in lifeline, a personal assistant.\n\n${what}\n\n${inbox ? `To agree, reply to this email with YES. To say no, or to stop at any time, reply STOP.` : `If you agree, tell ${f}${reply ? ` (${reply})` : ""}; they'll add you in lifeline once you've said yes.`} Nothing is sent to you unless you agree. This isn't an emergency service.`, { replyTo: inbox || reply || undefined });
    } else {
      try { await sendSms(w.target, `${me} would like you as a safety contact in lifeline. If ${f} starts a check-in and doesn't confirm they're safe in time, you'd get one text with where they last were. Nothing else. Reply YES to agree, or STOP to say no.`); ok = true; } catch (e: any) { log.warn({ err: e?.message }, "safety contact sms failed"); }
    }
    if (!ok) { await ctx.db.query(`DELETE FROM safety_contacts WHERE id=$1`, [row.id]); return { reply: `The message to ${w.label} didn't go out, so I haven't added them. Try again in a minute?` }; }
    if (w.kind !== "user") await ctx.db.query(`UPDATE safety_contacts SET status='asked' WHERE id=$1`, [row.id]);
    const manual = w.kind === "email" && !config.inboundEmail;
    return { reply: w.kind === "user" ? `Asked ${first(w.user)}. I'll tell you when they answer; they're only alerted once they say yes.`
      : manual ? `I've emailed ${w.label} to ask. When they tell you yes, say "${w.label} agreed to be my safety contact" and I'll switch them on.`
      : `Asked ${w.label}. They're only alerted once they reply YES; I'll tell you when they do.` };
  },
});

const contactList = defineAction({
  name: "safety.contacts",
  tier: 1,
  description: "List the person's safety contacts and whether each has agreed.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<Contact>(`SELECT * FROM safety_contacts WHERE user_id=$1 ORDER BY id`, [ctx.user.id]);
    if (!rows.length) return { reply: "You have no safety contacts yet. Say \"add my safety contact\" with a name in lifeline, an email address or a phone number." };
    const st = (c: Contact) => c.status === "confirmed" ? "said yes" : c.status === "declined" ? "said no" : "hasn't answered yet";
    return { reply: `Your safety contacts:\n${rows.map((c) => `- ${c.label}, ${st(c)}`).join("\n")}` };
  },
});

const contactRemove = defineAction({
  name: "safety.contact_remove",
  tier: 1,
  description: "Remove one of the person's safety contacts by name, email or number.",
  schema: z.object({ who: z.string().min(1) }),
  async run(args, ctx) {
    const w = args.who.trim().replace(/^@/, "").toLowerCase();
    const rows = await ctx.db.query<Contact>(`SELECT * FROM safety_contacts WHERE user_id=$1`, [ctx.user.id]);
    const hit = rows.filter((c) => c.label.toLowerCase() === w || c.label.toLowerCase().split(" ")[0] === w || c.target === w || c.target.replace(/\D/g, "") === w.replace(/\D/g, "") && w.replace(/\D/g, "").length > 6);
    if (!hit.length) return { reply: `${args.who} isn't one of your safety contacts. Say "my safety contacts" to see who is.` };
    await ctx.db.query(`DELETE FROM safety_contacts WHERE id = ANY($1::int[])`, [hit.map((c) => c.id)]);
    return { reply: `${hit[0].label} isn't your safety contact any more.`, undo: { payload: { rows: hit } } };
  },
  async undo(p, ctx) {
    for (const c of p.rows as Contact[]) await ctx.db.query(`INSERT INTO safety_contacts (user_id, kind, target, label, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [ctx.user.id, c.kind, c.target, c.label, c.status]);
    return "Put back.";
  },
});

const contactLeave = defineAction({
  name: "safety.contact_leave",
  tier: 1,
  description: "Stop being someone else's safety contact ('name' optional: whose). The other person is told kindly.",
  schema: z.object({ name: z.string().optional() }),
  async run(args, ctx) {
    const rows = await ctx.db.query<Contact & { owner: string | null }>(`SELECT c.*, u.name AS owner FROM safety_contacts c JOIN users u ON u.id=c.user_id WHERE c.kind='user' AND c.target=$1`, [String(ctx.user.id)]);
    const n = args.name?.trim().toLowerCase();
    const hit = n ? rows.filter((r) => (r.owner ?? "").toLowerCase() === n || (r.owner ?? "").toLowerCase().split(" ")[0] === n) : rows;
    if (!hit.length) return { reply: n ? `You aren't ${args.name}'s safety contact.` : "You aren't anyone's safety contact." };
    await ctx.db.query(`DELETE FROM safety_contacts WHERE id = ANY($1::int[])`, [hit.map((c) => c.id)]);
    for (const c of hit) {
      const owner = await ctx.db.one<User>(`SELECT * FROM users WHERE id=$1`, [c.user_id]);
      if (owner) await dispatch(ctx.db, owner, { text: `${first(ctx.user)} can't be your safety contact any more. Say "my safety contacts" to see who's left.` }).catch(() => false);
    }
    return { reply: `Done. You won't get safety alerts from ${hit.length === 1 ? first({ name: hit[0].owner }) : "anyone"} now.` };
  },
});

/* ---------------- check-ins ---------------- */

/** "walking home, 25 min" → when and what. Durations or a clock time; anything else is the trip. */
export function parseCheckin(text: string, tz: string, now: Date): { due: Date | null; about: string } {
  let t = ` ${text.trim()} `;
  let due: Date | null = null;
  const dur = /\s(?:in|for|after)?\s*(\d+(?:\.\d+)?|an?|half an?)\s*(minutes?|mins?|m|hours?|hrs?|h)\b/i.exec(t);
  if (dur) {
    const n = /^half/i.test(dur[1]) ? 0.5 : /^an?$/i.test(dur[1]) ? 1 : Number(dur[1]);
    due = new Date(now.getTime() + n * (/^h/i.test(dur[2]) ? 60 : 1) * 60_000);
    t = t.replace(dur[0], " ");
  } else if (/\bhalf an hour\b/i.test(t)) { due = new Date(now.getTime() + 30 * 60_000); t = t.replace(/\b(?:in )?half an hour\b/i, " "); }
  else {
    const clock = /\s(?:at|by|around|before)?\s*((?:\d{1,2}(?::\d{2})?\s*(?:am|pm))|(?:\d{1,2}:\d{2})|midnight|noon)\b/i.exec(t);
    if (clock) {
      const d = parseWhen(clock[1].replace(/^midnight$/i, "11:59pm").replace(/^noon$/i, "12pm"), tz, now);
      if (d) { due = d < now ? new Date(d.getTime() + 86_400_000) : d; t = t.replace(clock[0], " "); }
    }
  }
  const about = t.replace(/\bcheck (?:on|in on) me\b|\bcheck in\b/gi, " ").replace(/\s+/g, " ").replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "").replace(/^(?:i'?m|i am)\s+/i, "").trim();
  return { due, about };
}

async function startCheckin(ctx: { db: Db; user: User; now: Date }, due: Date, about: string) {
  const prev = await active(ctx.db, ctx.user.id);
  if (prev) await endCheckin(ctx.db, prev, "cancelled");
  const row = (await ctx.db.one<{ id: number }>(`INSERT INTO safety_checkins (user_id, about, due_at, grace_min) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.user.id, about || null, due, GRACE]))!;
  const job = await schedule(ctx.db, { userId: ctx.user.id, kind: "safety_checkin_due", runAt: due, payload: { id: row.id } });
  await ctx.db.query(`UPDATE safety_checkins SET due_job=$2 WHERE id=$1`, [row.id, job]);
  return row.id;
}

async function endCheckin(db: Db, c: Checkin, status: "safe" | "cancelled") {
  await db.query(`UPDATE safety_checkins SET status=$2, lat=NULL, lon=NULL, loc_at=NULL WHERE id=$1`, [c.id, status]);
  for (const j of [c.due_job, c.alert_job]) if (j) await cancelJob(db, j);
}

const checkinStart = defineAction({
  name: "checkin.start",
  tier: 1,
  description: "Start a safety check-in: the person is doing something (walking home, a taxi, a date) and wants checking on. 'text' is what they said, like 'walking home, 25 min' or 'taxi to the airport in 40 minutes' or 'at 11pm'. If they don't tap I'm safe by then and a 10-minute grace, their confirmed safety contacts are told with the last location.",
  schema: z.object({ text: z.string().optional(), minutes: z.number().min(1).max(1440).optional() }),
  async needs(args, ctx) {
    if (args.minutes) return null;
    return parseCheckin(args.text ?? "", ctx.user.tz, ctx.now).due ? null : { need: "when", question: "When should I check on you? Say something like \"in 30 minutes\" or \"at 11pm\"." };
  },
  fill: (_need, answer, args, ctx) => (parseCheckin(answer, ctx.user.tz, ctx.now).due ? { text: `${args.text ?? ""}, ${answer}` } : null),
  async run(args, ctx) {
    const p = parseCheckin(args.text ?? "", ctx.user.tz, ctx.now);
    const due = args.minutes ? new Date(ctx.now.getTime() + args.minutes * 60_000) : p.due;
    if (!due) throw new Error("I couldn't tell when to check on you. Say something like \"check on me in 30 minutes\".");
    const mins = (due.getTime() - ctx.now.getTime()) / 60_000;
    if (mins < 2) throw new Error("That's too soon for a check-in. Give me at least a few minutes, like \"in 15 minutes\".");
    if (mins > 24 * 60) throw new Error("Check-ins run for up to a day. Pick a time within the next 24 hours?");
    const id = await startCheckin(ctx, due, p.about);
    const cs = await alertable(ctx.db, ctx.user.id);
    const tz = ctx.user.tz;
    const who = cs.length
      ? `If you don't answer by ${hhmm(new Date(due.getTime() + GRACE * 60_000), tz)}, I'll tell ${names(cs)} what you were doing and where you last were.`
      : "No safety contact has agreed yet, so at that point it's only me checking on you. Say \"add my safety contact\" to add someone.";
    return {
      reply: `I'll check on you at ${hhmm(due, tz)}${p.about ? `, ${p.about}` : ""}. Tap I'm safe when you're there. ${who} Share your live location here if you want it included.\n\nThis doesn't replace emergency services. If you're in danger, call ${emergencyNumber(ctx.user)} straight away.`,
      buttons: [{ label: "I'm safe", data: `sf:ci:safe:${id}` }, { label: "Cancel check-in", data: `sf:ci:cancel:${id}` }],
    };
  },
});

async function safeNow(db: Db, user: User): Promise<string> {
  const c = await active(db, user.id);
  if (!c) return "Good to hear. There's no check-in running, so there's nothing to stop.";
  const wasAlerted = c.status === "alerted";
  await endCheckin(db, c, "safe");
  if (wasAlerted) {
    const cs = await alertable(db, user.id);
    await tellContacts(db, user, cs, `${fullName(user)} says they're safe now. Thank you for looking out for them.`, null);
    return `Glad you're safe. I've told ${names(cs) || "your contacts"} you're OK, ended the check-in and deleted your location.`;
  }
  return "Glad you're safe. Check-in ended, and I've deleted your location. Thanks for letting me know.";
}

const checkinSafe = defineAction({
  name: "checkin.safe",
  tier: 1,
  description: "The person is safe: end their running safety check-in, delete their location, and if contacts were alerted tell them they're OK.",
  schema: z.object({}),
  async run(_a, ctx) { return { reply: await safeNow(ctx.db, ctx.user) }; },
});

const checkinCancel = defineAction({
  name: "checkin.cancel",
  tier: 1,
  description: "Cancel the running safety check-in without alerting anyone; deletes the shared location.",
  schema: z.object({}),
  async run(_a, ctx) {
    const c = await active(ctx.db, ctx.user.id);
    if (!c) return { reply: "There's no check-in running." };
    if (c.status === "alerted") return { reply: await safeNow(ctx.db, ctx.user) }; // contacts were already told: they hear it's over
    await endCheckin(ctx.db, c, "cancelled");
    return { reply: "Check-in cancelled. Nothing will be sent, and your location is deleted." };
  },
});

async function extend(db: Db, user: User, minutes: number, now: Date): Promise<string> {
  const c = await active(db, user.id);
  if (!c) return "There's no check-in running. Say \"check on me in 20 minutes\" to start one.";
  for (const j of [c.due_job, c.alert_job]) if (j) await cancelJob(db, j);
  const base = Math.max(now.getTime(), new Date(c.due_at).getTime());
  const due = new Date(base + minutes * 60_000);
  const job = await schedule(db, { userId: user.id, kind: "safety_checkin_due", runAt: due, payload: { id: c.id } });
  await db.query(`UPDATE safety_checkins SET due_at=$2, due_job=$3, alert_job=NULL, status='active' WHERE id=$1`, [c.id, due, job]);
  return `Okay, I'll check on you at ${hhmm(due, user.tz)} instead.`;
}

const checkinExtend = defineAction({
  name: "checkin.extend",
  tier: 1,
  description: "Give the running safety check-in more time: 'minutes' to add (default 15).",
  schema: z.object({ minutes: z.number().min(1).max(600).optional() }),
  async run(args, ctx) { return { reply: await extend(ctx.db, ctx.user, args.minutes ?? 15, ctx.now) }; },
});

/** When email replies can't reach lifeline, the person tells us their contact agreed (they asked them themselves). */
const contactAgreed = defineAction({
  name: "safety.contact_agreed",
  tier: 1,
  description: "Mark an email safety contact as having agreed, when they told the person yes directly. 'who' is their address.",
  schema: z.object({ who: z.string().min(3) }),
  async run(args, ctx) {
    const t = args.who.trim().toLowerCase();
    const r = await ctx.db.one<Contact>(`UPDATE safety_contacts SET status='confirmed' WHERE user_id=$1 AND kind='email' AND status='asked' AND (target=$2 OR lower(label)=$2) RETURNING *`, [ctx.user.id, t]);
    return { reply: r ? `${r.label} is one of your safety contacts now.` : `I don't have a request out to ${args.who.trim()}. Say "add my safety contact" with their address first.` };
  },
});
register(contactAdd, contactList, contactRemove, contactLeave, contactAgreed, checkinStart, checkinSafe, checkinCancel, checkinExtend);

/* ---------------- the deadline ---------------- */

/** Send to each contact on their own channel. Returns who was reached. */
async function tellContacts(db: Db, user: User, cs: Contact[], text: string, deps: SchedulerDeps | null): Promise<Contact[]> {
  const reached: Contact[] = [];
  for (const c of cs) {
    try {
      let ok = false;
      if (c.kind === "user") {
        const u = deps ? await deps.getUser(Number(c.target)) : await db.one<User>(`SELECT * FROM users WHERE id=$1`, [Number(c.target)]);
        if (u) ok = deps ? await deps.send(u, { text }) : await dispatch(db, u, { text });
      } else if (c.kind === "email") ok = await sendEmail(c.target, `Safety check-in: ${fullName(user)}`, text);
      else if (smsProvider()) { await sendSms(c.target, text); ok = true; }
      if (ok) reached.push(c);
    } catch (e: any) { log.warn({ err: e?.message, contact: c.id }, "safety alert failed"); }
  }
  return reached;
}

onJob("safety_checkin_due", async (job, deps) => {
  const c = await deps.db.one<Checkin>(`SELECT * FROM safety_checkins WHERE id=$1 AND status='active'`, [job.payload.id]);
  if (!c) return;
  const user = await deps.getUser(c.user_id);
  if (!user) return;
  // A job that ran late (the server was down) still gives the person the full grace period.
  const alertAt = new Date(Math.max(new Date(c.due_at).getTime(), Date.now()) + c.grace_min * 60_000);
  const last = await deps.db.one<{ id: number | null }>(`SELECT max(id) AS id FROM messages WHERE user_id=$1 AND role='user'`, [user.id]);
  const aj = await schedule(deps.db, { userId: user.id, kind: "safety_checkin_alert", runAt: alertAt, payload: { id: c.id, after: last?.id ?? 0 } });
  await deps.db.query(`UPDATE safety_checkins SET alert_job=$2 WHERE id=$1`, [c.id, aj]);
  const cs = await alertable(deps.db, user.id);
  await push(deps, user, "safety", `Are you OK? Tap I'm safe${cs.length ? `, or I'll let ${names(cs)} know at ${hhmm(alertAt, user.tz)}` : ""}. If you're in danger, call ${emergencyNumber(user)}.`, {
    exempt: true, buttons: [{ label: "I'm safe", data: `sf:ci:safe:${c.id}` }, { label: "15 more minutes", data: `sf:ci:more:${c.id}` }],
  });
});

onJob("safety_checkin_alert", async (job, deps) => {
  const c = await deps.db.one<Checkin>(`SELECT * FROM safety_checkins WHERE id=$1 AND status='active'`, [job.payload.id]);
  if (!c) return;
  const user = await deps.getUser(c.user_id);
  if (!user) return;
  const cs = await alertable(deps.db, user.id);
  // They've written to me since the "Are you OK?" but haven't tapped I'm safe: ask once more, plainly, before anyone is told.
  if (job.payload.after != null && !job.payload.asked && cs.length) {
    const spoke = await deps.db.one(`SELECT 1 FROM messages WHERE user_id=$1 AND role='user' AND id > $2 LIMIT 1`, [user.id, job.payload.after]);
    if (spoke) {
      const again = new Date(Math.max(Date.now(), new Date(job.run_at).getTime()) + c.grace_min * 60_000);
      const aj = await schedule(deps.db, { userId: user.id, kind: "safety_checkin_alert", runAt: again, payload: { id: c.id, after: job.payload.after, asked: true } });
      await deps.db.query(`UPDATE safety_checkins SET alert_job=$2 WHERE id=$1`, [c.id, aj]);
      await push(deps, user, "safety", `You're here, but your check-in is still running. Tap I'm safe if you are, or I'll let ${names(cs)} know at ${hhmm(again, user.tz)}.`, { exempt: true, buttons: [{ label: "I'm safe", data: `sf:ci:safe:${c.id}` }, { label: "15 more minutes", data: `sf:ci:more:${c.id}` }] });
      return;
    }
  }
  await deps.db.query(`UPDATE safety_checkins SET status='alerted', alerted_at=now() WHERE id=$1`, [c.id]);
  const tz = user.tz;
  const due = DateTime.fromJSDate(new Date(c.due_at)).setZone(tz);
  const where = c.lat != null && c.lon != null ? `Their last shared location, at ${hhmm(c.loc_at ?? c.due_at, tz)}: ${mapLink(c.lat, c.lon)}` : "They didn't share a location.";
  const text = `${fullName(user)} asked lifeline to check on them${c.about ? ` (${c.about})` : ""} at ${due.toFormat("HH:mm")} ${due.toFormat("ZZZZ")}, and they haven't answered.\n\n${where}\n\nPlease try to reach them. If you think they're in danger, call the local emergency number where they are. You're getting this because ${first(user)} chose you as a safety contact.`;
  const reached = await tellContacts(deps.db, user, cs, text, deps);
  // The location isn't kept forever: two days after an alert the check-in closes and the point is deleted.
  await schedule(deps.db, { userId: user.id, kind: "safety_checkin_expire", runAt: new Date(Math.max(Date.now(), new Date(job.run_at).getTime()) + 48 * 3_600_000), payload: { id: c.id } });
  await push(deps, user, "safety", reached.length
    ? `I didn't hear back, so I've let ${names(reached)} know. Tap I'm safe as soon as you can and I'll tell them you're OK.`
    : `I didn't hear back, and there's no safety contact I could reach. If you need help, call ${emergencyNumber(user)}. Tap I'm safe when you can.`, { exempt: true, buttons: [{ label: "I'm safe", data: `sf:ci:safe:${c.id}` }] });
});

onJob("safety_checkin_expire", async (job, deps) => {
  await deps.db.query(`UPDATE safety_checkins SET status='expired', lat=NULL, lon=NULL, loc_at=NULL WHERE id=$1 AND status='alerted'`, [job.payload.id]);
});

/* ---------------- buttons, location, brief ---------------- */

addButtons("sf", async (db, user, data, now): Promise<ButtonReply> => {
  const [, kind, verb, idRaw] = data.split(":");
  const id = Number(idRaw);
  if (kind === "ci") {
    if (verb === "safe") return { text: await safeNow(db, user) };
    if (verb === "more") return { text: await extend(db, user, 15, now) };
    if (verb === "cancel") {
      const c = await db.one<Checkin>(`SELECT * FROM safety_checkins WHERE id=$1 AND user_id=$2 AND status IN ('active','alerted')`, [id, user.id]);
      if (!c) return { text: "That check-in has already ended." };
      if (c.status === "alerted") return { text: await safeNow(db, user) };
      await endCheckin(db, c, "cancelled");
      return { text: "Check-in cancelled. Nothing will be sent, and your location is deleted." };
    }
  }
  if (kind === "ct") {
    const c = await db.one<Contact>(`SELECT * FROM safety_contacts WHERE id=$1 AND kind='user' AND target=$2`, [id, String(user.id)]);
    if (!c || c.status !== "pending") return { text: c ? "You've already answered that one." : "That request isn't there any more." };
    const yes = verb === "y";
    await db.query(`UPDATE safety_contacts SET status=$2 WHERE id=$1`, [id, yes ? "confirmed" : "declined"]);
    const owner = await db.one<User>(`SELECT * FROM users WHERE id=$1`, [c.user_id]);
    if (owner) await dispatch(db, owner, { text: yes ? `${first(user)} said yes to being your safety contact.` : `${first(user)} can't be your safety contact right now. That's okay; you can add someone else.` }).catch(() => false);
    return { text: yes ? `Thank you. If ${first(owner)} starts a check-in and doesn't answer in time, I'll message you here. Say "stop being a safety contact" whenever you need to.` : "No problem. I've let them know, kindly." };
  }
  if (kind === "sc" && verb === "report") {
    const { propose } = await import("../../../policy/engine.js");
    const d = await propose({ db, user, now, sourceMessage: `[button ${data}]` }, "scam.report", {});
    return d.kind === "ran" ? { text: d.reply, buttons: d.undoId ? [{ label: "Undo", data: `undo:${d.undoId}` }] : undefined } : { text: "reply" in d ? d.reply : "That didn't go through. Say \"report this as a scam\"." };
  }
  if (kind === "lg") { const { legacyButton } = await import("./legacy.js"); return legacyButton(db, user, verb, now); }
  return { text: "That button doesn't do anything any more." };
});

addLocationHandler(async (db, user, loc, now) => {
  const c = await active(db, user.id);
  if (!c) return null;
  const firstPoint = c.lat == null;
  await db.query(`UPDATE safety_checkins SET lat=$2, lon=$3, loc_at=$4 WHERE id=$1`, [c.id, loc.lat, loc.lon, now]);
  return firstPoint ? { text: "Got your location for the check-in. I keep only the latest point and delete it when the check-in ends." } : null;
});

/** After "Are you OK?", the natural answers ("I'm ok", "yes", "fine thanks") count as I'm safe. */
const OKAY = /^(?:(?:yes|yeah|yep|yup|ok|okay)(?:[,\s]+(?:i'?m|im) (?:ok|okay|fine|good|safe|home|here|alright|all right))?|(?:i'?m|im|i am) (?:ok|okay|fine|good|safe|home|here|alright|all right|back)(?: now)?|all good|all fine|fine|safe|got home|made it)(?:[,\s]+(?:thanks|thank you|thx|ty))?[.! ]*$/i;
addFirstLook(async (db, user, text) => {
  if (!OKAY.test(text.trim())) return null;
  const c = await active(db, user.id);
  if (!c || (c.status === "active" && !c.alert_job)) return null; // only once the "Are you OK?" has gone out
  if (/^(?:yes|yeah|yep|yup|ok|okay)\b/i.test(text.trim()) && (await db.one(`SELECT 1 FROM pending_actions WHERE user_id=$1 AND resolved IS NULL AND expires_at > now() LIMIT 1`, [user.id]))) return null; // a yes for something waiting on it
  return safeNow(db, user);
});

addBriefSection({
  key: "safety_checkin", order: 10,
  async lines(db, user, now) {
    const c = await db.one<Checkin>(`SELECT * FROM safety_checkins WHERE user_id=$1 AND status='active' AND due_at > $2 ORDER BY id DESC LIMIT 1`, [user.id, now]);
    return c ? [`Safety check-in running until ${hhmm(c.due_at, user.tz)}.`] : [];
  },
});

/* ---------------- words ---------------- */

addRules(
  [/^add (?:a |my )?safety contact[:,]?\s+(.+)$/i, (m) => ({ action: "safety.contact_add", args: { who: m[1] } })],
  [/^(?:add|make) (.+?) (?:as )?(?:a |my )?safety contact$/i, (m) => ({ action: "safety.contact_add", args: { who: m[1] } })],
  [/^(?:show |list )?(?:my |who are my )?safety contacts\??$/i, () => ({ action: "safety.contacts", args: {} })],
  [/^(?:remove|delete) (?:my )?safety contact[:,]?\s+(.+)$/i, (m) => ({ action: "safety.contact_remove", args: { who: m[1] } })],
  [/^remove (.+?) as (?:a |my )?safety contact$/i, (m) => ({ action: "safety.contact_remove", args: { who: m[1] } })],
  [/^(?:stop|i don'?t want to) be(?:ing)? (?:a |the |their )?safety contact(?: for (.+))?$/i, (m) => ({ action: "safety.contact_leave", args: { name: m[1] } })],
  [/^check (?:on|in on) me$|^(?:start )?(?:a )?safety check-?in$/i, () => ({ action: "checkin.start", args: {} })],
  [/^(?:please )?check (?:on|in on) me\b[:,]?\s*(.+)$/i, (m) => ({ action: "checkin.start", args: { text: m[1] } })],
  [/^(?:start )?(?:a )?safety check-?in[:,]?\s+(.+)$/i, (m) => ({ action: "checkin.start", args: { text: m[1] } })],
  [/^(.{3,120}?)[,.;]?\s+(?:please )?check (?:on|in on) me\s+((?:in|at|by|after)\s+.+)$/i, (m) => ({ action: "checkin.start", args: { text: `${m[1]}, ${m[2]}` } })],
  [/^check in (?:at|by|in) ((?:\d{1,2}(?::\d{2})?\s*(?:am|pm)?)|(?:\d+\s*(?:minutes?|mins?|hours?|h)))$/i, (m) => ({ action: "checkin.start", args: { text: `at ${m[1]}`.replace(/^at (\d+\s*(?:minutes?|mins?|hours?|h))$/i, "in $1") } })],
  [/^(?:i'?m|i am|im) (?:safe|home safe|home|safe now|safe and sound|back home safe)$|^(?:home safe|got home(?: safe)?|made it home(?: safe)?|arrived safe(?:ly)?|all good,? i'?m safe)$/i, () => ({ action: "checkin.safe", args: {} })],
  [/^(?:cancel|stop|end) (?:the |my )?(?:safety )?check-?in$/i, () => ({ action: "checkin.cancel", args: {} })],
  [/^(?:extend|push back) (?:the |my )?(?:safety )?check-?in(?: by (\d+)\s*(?:minutes?|mins?))?$|^give me (\d+) more minutes$/i, (m) => ({ action: "checkin.extend", args: { minutes: Number(m[1] ?? m[2] ?? 15) } })],
);
addExamples("safety.contact_add", ["add my safety contact @tunde", "add my safety contact ada@example.com", "add Bisi as my safety contact"]);
addRules([/^(\S+@\S+\.\w+) (?:agreed|said yes) to be my safety contact$/i, (m) => ({ action: "safety.contact_agreed", args: { who: m[1] } })]);
addExamples("safety.contact_agreed", ["ada@example.com agreed to be my safety contact"]);
addExamples("safety.contacts", ["my safety contacts", "who are my safety contacts"]);
addExamples("safety.contact_remove", ["remove my safety contact ada@example.com", "remove Bisi as my safety contact"]);
addExamples("safety.contact_leave", ["stop being a safety contact", "stop being a safety contact for Ada"]);
addExamples("checkin.start", ["check on me: walking home, 25 min", "I'm in a taxi to the airport, check on me in 40 minutes", "check in at 11pm", "check on me"]);
addExamples("checkin.safe", ["I'm safe", "home safe", "made it home"]);
addExamples("checkin.cancel", ["cancel the check-in", "stop my check-in"]);
addExamples("checkin.extend", ["extend my check-in by 20 minutes", "give me 15 more minutes"]);
addCues("checkin", ["check on me", "check in on me", "walking home", "taxi", "uber", "first date", "get home", "safe", "check-in", "checkin", "going out alone"]);
addCues("safety", ["safety contact", "safety contacts", "emergency contact", "alert my", "if i don't"]);
addCapability({
  key: "safety_checkin", name: "Safety check-ins",
  cues: ["check on me", "walking home", "safety check", "safety contact", "get home safe", "check in on me"],
  what: "Tell me what you're doing and when to check on you. If you don't tap I'm safe in time, I tell the people you chose what you were doing and where you last were. Contacts agree first.",
  say: ["add my safety contact @tunde", "check on me: walking home, 25 min", "I'm safe"],
  then: "This doesn't replace emergency services. If you're in danger, call your local emergency number first.",
}, "Safety");

/* ---------------- a contact's own yes or stop, by text or email ---------------- */

/** A text or email reply from someone asked to be a safety contact: YES agrees to the most recent ask, STOP opts out of all. */
export async function contactReply(db: Db, channel: "sms" | "imessage" | "email", from: string, text: string): Promise<string | null> {
  const kind = channel === "email" ? "email" : channel === "sms" ? "phone" : null;
  if (!kind) return null;
  const target = kind === "email" ? from.trim().toLowerCase().replace(/^.*<([^>]+)>.*$/, "$1") : `+${from.replace(/\D/g, "").replace(/^00/, "")}`;
  const word = text.trim().split(/\n/)[0].trim().toUpperCase().replace(/[.!]+$/, "");
  if (!/^(?:YES|Y|STOP|NO|UNSUBSCRIBE)$/.test(word)) return null;
  const rows = await db.query<Contact>(`SELECT * FROM safety_contacts WHERE kind=$1 AND target=$2 AND status IN ('asked','confirmed') ORDER BY id DESC`, [kind, target]);
  if (!rows.length) return null;
  const ownerOf = async (c: Contact) => db.one<User>(`SELECT * FROM users WHERE id=$1`, [c.user_id]);
  if (/^(?:STOP|NO|UNSUBSCRIBE)$/.test(word)) {
    await db.query(`UPDATE safety_contacts SET status='declined' WHERE kind=$1 AND target=$2`, [kind, target]);
    for (const c of rows) { const o = await ownerOf(c); if (o) await dispatch(db, o, { text: `${c.label} said no to being a safety contact, so they won't be alerted. Say "my safety contacts" to see who is.` }).catch(() => {}); }
    return "Done. You won't hear from lifeline about anyone's safety check-ins. Thanks for letting us know.";
  }
  const ask = rows.find((c) => c.status === "asked");
  if (!ask) return "You're already a safety contact. Reply STOP any time to stop.";
  await db.query(`UPDATE safety_contacts SET status='confirmed' WHERE id=$1`, [ask.id]);
  const o = await ownerOf(ask);
  if (o) await dispatch(db, o, { text: `${ask.label} said yes. They're one of your safety contacts now.` }).catch(() => {});
  const more = rows.filter((c) => c.status === "asked" && c.id !== ask.id).length;
  return `Thank you. You're ${o ? `${first(o)}'s` : "a"} safety contact now. You'd only hear from lifeline if a check-in runs out. Reply STOP any time to stop.${more ? " Someone else asked too; reply YES again for them." : ""}`;
}
addTextReplyHandler(contactReply);
