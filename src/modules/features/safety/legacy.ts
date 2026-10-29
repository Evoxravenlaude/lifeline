/**
 * "If something happens to me": messages and where-to-find-things notes the person writes for chosen
 * people, sent only after a long silence. The highest-risk feature, so it is slow and explicit:
 *  - setup is tier 2, and the yes lists exactly who receives what; new messages wait for another yes
 *  - the window is at least 14 days of no messages at all
 *  - then three pings two days apart, then a final 72 hours, and only then anything is sent
 *  - any message from the person, at any point, resets everything (the sweep reads the messages table)
 *  - passwords, seed phrases and private keys are refused, never stored
 * Never in the brief; "legacy status" says where it stands when asked.
 */
import { z } from "zod";
import { inQuietHours } from "../../../core/time.js";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import type { Db } from "../../../core/db.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema, addSystemJob, type ButtonReply } from "../../../core/plugins.js";
import { onJob, push, type SchedulerDeps } from "../../../core/scheduler.js";
import { canEmail, sendEmail } from "../../../core/email.js";
import { log } from "../../../core/log.js";
import { EMAIL, SECRET_REFUSAL, findMember, first, fullName, keepEnding, looksSecret } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS safety_legacy (user_id INT PRIMARY KEY REFERENCES users(id), window_days INT NOT NULL DEFAULT 30, status TEXT NOT NULL DEFAULT 'off', stage INT NOT NULL DEFAULT 0, stage_at TIMESTAMPTZ, ping_msg_id INT, alive_at TIMESTAMPTZ DEFAULT now(), released_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS safety_legacy_items (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), kind TEXT NOT NULL DEFAULT 'message', to_kind TEXT NOT NULL, to_target TEXT NOT NULL, to_label TEXT NOT NULL, body TEXT NOT NULL, confirmed BOOLEAN NOT NULL DEFAULT false, sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`);

export const MIN_DAYS = 14;
const PING_GAP_H = 48;
const FINAL_WAIT_H = 72;
const H = 3_600_000;

interface Plan { user_id: number; window_days: number; status: string; stage: number; stage_at: string | null; ping_msg_id: number | null; alive_at: string; released_at: string | null }
interface Item { id: number; user_id: number; kind: string; to_kind: "email" | "user"; to_target: string; to_label: string; body: string; confirmed: boolean; sent_at: string | null }

const plan = (db: Db, userId: number) => db.one<Plan>(`SELECT * FROM safety_legacy WHERE user_id=$1`, [userId]);
const items = (db: Db, userId: number) => db.query<Item>(`SELECT * FROM safety_legacy_items WHERE user_id=$1 AND sent_at IS NULL ORDER BY id`, [userId]);
const day = (d: Date | string, tz: string) => DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat("ccc d LLL");
const preview = (s: string) => (s.length > 70 ? `${s.slice(0, 67).trimEnd()}...` : s);

const legacyAdd = defineAction({
  name: "legacy.add",
  tier: 1,
  description: "Add to the person's 'if something happens to me' plan: a message or a where-to-find-things note ('kind' message or note) for one person ('to': an email address or the name of someone in lifeline). Nothing is sent now. Never passwords, seed phrases or private keys.",
  schema: z.object({ to: z.string().min(2), text: z.string().min(2), kind: z.enum(["message", "note"]).optional() }),
  async run(args, ctx) {
    const secret = looksSecret(args.text);
    if (secret) return { reply: SECRET_REFUSAL(secret) };
    const to = args.to.trim().replace(/^@/, "").replace(/[:,.]+$/, "");
    let target: { kind: "email" | "user"; id: string; label: string };
    if (EMAIL.test(to)) target = { kind: "email", id: to.toLowerCase(), label: to.toLowerCase() };
    else {
      const m = await findMember(ctx.db, ctx.user, to);
      if (m.many) throw new Error(`More than one person in lifeline is called ${to}. Say their full name, or use an email address.`);
      if (!m.found) throw new Error(`I can't find ${to} in lifeline. Use their email address instead, like "legacy message for ${to.toLowerCase().split(" ")[0]}@example.com: ...".`);
      target = { kind: "user", id: String(m.found.id), label: m.found.name ?? to };
    }
    const kind = args.kind ?? (/\b(?:where|find|kept|stored|located|is in|are in|folder|drawer|safe|lawyer|will|deed|documents?)\b/i.test(args.text) ? "note" : "message");
    const row = (await ctx.db.one<{ id: number }>(`INSERT INTO safety_legacy_items (user_id, kind, to_kind, to_target, to_label, body) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.user.id, kind, target.kind, target.id, target.label, keepEnding(args.text, ctx.sourceMessage).slice(0, 4000)]))!;
    const p = await plan(ctx.db, ctx.user.id);
    const on = p && ["on", "paused"].includes(p.status);
    return {
      reply: `Kept for ${target.label}. Nothing is sent now. ${on ? "Say \"turn on my legacy plan\" again to include it; until you do, it stays a draft." : `When you're ready, say "turn on my legacy plan after 30 days" (at least ${MIN_DAYS}) and I'll show you exactly who gets what before it starts.`}`,
      undo: { payload: { id: row.id } },
    };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM safety_legacy_items WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Taken out of your legacy plan."; },
});

const ECHOES = new WeakMap<object, string>();
/** The echo for turning it on is built before the yes, from what's in the plan right now. */
async function onEcho(db: Db, user: User, days: number): Promise<string | null> {
  const list = await items(db, user.id);
  if (!list.length) return null;
  const lines = list.map((i) => `- ${i.to_label}${i.to_kind === "email" ? " (by email)" : " (in lifeline)"}: ${i.kind === "note" ? "a note" : "a message"}, "${preview(i.body)}"`);
  return `This turns on your legacy plan. If you send me nothing at all for ${days} days, I'll ask you three times over four days, then wait 72 more hours. Only if every one goes unanswered, I send:\n${lines.join("\n")}\n\nAny message from you, at any point, resets it.`;
}

const legacyOn = defineAction({
  name: "legacy.on",
  tier: 2,
  description: "Turn on the person's 'if something happens to me' plan with an inactivity window in days (at least 14). Shows exactly who receives what before the yes.",
  schema: z.object({ days: z.number().int().min(1).max(365).optional(), ids: z.array(z.number()).optional() }),
  async needs(args, ctx) {
    const list = await items(ctx.db, ctx.user.id);
    if (!list.length) return { need: "message", question: "There's nothing in your legacy plan yet. Who is the first message for, and what does it say? Like \"legacy message for ada@example.com: ...\"." };
    if (args.days !== undefined && args.days < MIN_DAYS) return { need: "days", question: `The shortest window is ${MIN_DAYS} days, so a holiday or a hard week never sets it off. How many days?` };
    // The yes covers exactly what was shown: these items, this window. Kept with the pending action.
    args.ids = list.map((i) => i.id);
    ECHOES.set(args, (await onEcho(ctx.db, ctx.user, args.days ?? 30))!);
    return null;
  },
  fill: (need, answer) => { if (need !== "days") return null; const n = Number(/\d+/.exec(answer)?.[0]); return n >= MIN_DAYS ? { days: n } : null; },
  echo: (a) => ECHOES.get(a) ?? `This turns on your legacy plan with a ${a.days ?? 30}-day window. Say "legacy status" first to see who gets what.`,
  async run(args, ctx) {
    const days = Math.max(MIN_DAYS, args.days ?? 30);
    const list = await items(ctx.db, ctx.user.id);
    if (!list.length) return { reply: "There's nothing in your legacy plan to send, so I haven't turned it on." };
    const ids = args.ids ?? list.map((i) => i.id);
    await ctx.db.query(`UPDATE safety_legacy_items SET confirmed=true WHERE user_id=$1 AND sent_at IS NULL AND id = ANY($2::int[])`, [ctx.user.id, ids]);
    await ctx.db.query(`INSERT INTO safety_legacy (user_id, window_days, status, stage, alive_at, updated_at) VALUES ($1,$2,'on',0,$3,$3)
      ON CONFLICT (user_id) DO UPDATE SET window_days=$2, status='on', stage=0, stage_at=NULL, ping_msg_id=NULL, alive_at=$3, released_at=NULL, updated_at=$3`, [ctx.user.id, days, ctx.now]);
    return { reply: `Your legacy plan is on. If I hear nothing from you for ${days} days, I'll start checking in here first. Say "pause my legacy plan" before a long trip, or "legacy status" any time.` };
  },
});

const legacyPause = defineAction({
  name: "legacy.pause",
  tier: 1,
  description: "Pause the 'if something happens to me' plan (nothing is checked or sent until resumed), or resume it with resume=true.",
  schema: z.object({ resume: z.boolean().optional() }),
  async run(args, ctx) {
    const p = await plan(ctx.db, ctx.user.id);
    if (!p || !["on", "paused"].includes(p.status)) return { reply: "Your legacy plan isn't on, so there's nothing to pause." };
    await ctx.db.query(`UPDATE safety_legacy SET status=$2, stage=0, stage_at=NULL, ping_msg_id=NULL, alive_at=$3, updated_at=$3 WHERE user_id=$1`, [ctx.user.id, args.resume ? "on" : "paused", ctx.now]);
    return args.resume
      ? { reply: `Your legacy plan is back on, counting ${p.window_days} days from now.` }
      : { reply: "Your legacy plan is paused. Nothing is checked or sent until you say \"resume my legacy plan\".", undo: { payload: {} } };
  },
  async undo(_p, ctx) { await ctx.db.query(`UPDATE safety_legacy SET status='on', alive_at=$2 WHERE user_id=$1`, [ctx.user.id, ctx.now]); return "Back on."; },
});

const legacyCancel = defineAction({
  name: "legacy.cancel",
  tier: 1,
  description: "Cancel the 'if something happens to me' plan and delete every message and note in it.",
  schema: z.object({}),
  async run(_a, ctx) {
    const p = await plan(ctx.db, ctx.user.id);
    const list = await ctx.db.query<Item>(`SELECT * FROM safety_legacy_items WHERE user_id=$1`, [ctx.user.id]);
    if (!p && !list.length) return { reply: "You don't have a legacy plan." };
    await ctx.db.query(`DELETE FROM safety_legacy_items WHERE user_id=$1`, [ctx.user.id]);
    await ctx.db.query(`DELETE FROM safety_legacy WHERE user_id=$1`, [ctx.user.id]);
    return { reply: `Your legacy plan is cancelled, and ${list.length === 1 ? "its message is" : `all ${list.length} messages and notes are`} deleted.`, undo: { payload: { plan: p, items: list } } };
  },
  async undo(pl, ctx) {
    for (const i of pl.items as Item[]) await ctx.db.query(`INSERT INTO safety_legacy_items (user_id, kind, to_kind, to_target, to_label, body, confirmed, sent_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [ctx.user.id, i.kind, i.to_kind, i.to_target, i.to_label, i.body, i.confirmed, i.sent_at]);
    const p = pl.plan as Plan | null;
    if (p) await ctx.db.query(`INSERT INTO safety_legacy (user_id, window_days, status, alive_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [ctx.user.id, p.window_days, p.status, ctx.now]);
    return "Your legacy plan is back as it was.";
  },
});

const legacyStatus = defineAction({
  name: "legacy.status",
  tier: 1,
  description: "Say where the person's 'if something happens to me' plan stands: on, paused or off, the next check date, and who it's for.",
  schema: z.object({}),
  async run(_a, ctx) {
    const p = await plan(ctx.db, ctx.user.id);
    const list = await items(ctx.db, ctx.user.id);
    const who = [...new Set(list.map((i) => i.to_label))];
    const forWho = who.length ? ` ${list.length} ${list.length === 1 ? "message" : "messages and notes"}, for ${who.join(", ")}.` : "";
    const drafts = list.filter((i) => !i.confirmed).length;
    const draftLine = drafts && p?.status === "on" ? ` ${drafts} new ${drafts === 1 ? "one is" : "ones are"} still drafts; say "turn on my legacy plan" to include them.` : "";
    if (!p || p.status === "off") return { reply: `Legacy plan: off.${forWho}${list.length ? ` Say "turn on my legacy plan after 30 days" when you're ready.` : ""}` };
    if (p.status === "paused") return { reply: `Legacy plan: paused.${forWho} Say "resume my legacy plan" to turn it back on.` };
    if (p.status === "released") return { reply: `Legacy plan: sent on ${day(p.released_at ?? ctx.now, ctx.user.tz)}. Say "cancel my legacy plan" to clear it, or add new messages to start again.` };
    const last = await lastActive(ctx.db, p);
    const next = new Date(last.getTime() + p.window_days * 86_400_000);
    return { reply: `Legacy plan: on, next check by ${day(next, ctx.user.tz)} if I don't hear from you.${forWho}${draftLine}` };
  },
});

register(legacyAdd, legacyOn, legacyPause, legacyCancel, legacyStatus);

/* ---------------- the sweep ---------------- */

/** The last sign of life: a message, or a tap on any button (the core keeps prefs.lastTap). */
async function lastActive(db: Db, p: Plan): Promise<Date> {
  const m = await db.one<{ at: string | null; tap: string | null }>(`SELECT (SELECT max(created_at)::text FROM messages WHERE user_id=$1 AND role='user') AS at, (SELECT prefs->>'lastTap' FROM users WHERE id=$1) AS tap`, [p.user_id]);
  return new Date(Math.max(new Date(p.alive_at).getTime(), m?.at ? new Date(m.at).getTime() : 0, Number(m?.tap ?? 0) || 0));
}

/** One plan, one step. Exported for tests. */
export async function sweepOne(deps: SchedulerDeps, p: Plan, now: Date): Promise<void> {
  const db = deps.db;
  const user = await deps.getUser(p.user_id);
  if (!user) return;
  // Any message since the first ping: everything resets.
  if (p.stage > 0) {
    const newer = await db.one(`SELECT 1 FROM messages WHERE user_id=$1 AND role='user' AND id > $2 LIMIT 1`, [p.user_id, p.ping_msg_id ?? 0]);
    const tapped = p.stage_at && Number(user.prefs?.lastTap ?? 0) > new Date(p.stage_at).getTime();
    if (newer || tapped) { await db.query(`UPDATE safety_legacy SET stage=0, stage_at=NULL, ping_msg_id=NULL, alive_at=$2 WHERE user_id=$1`, [p.user_id, now]); return; }
  }
  const since = p.stage_at ? now.getTime() - new Date(p.stage_at).getTime() : 0;
  const buttons = [{ label: "I'm here", data: "sf:lg:here" }];
  const set = (stage: number, extra = "") => db.query(`UPDATE safety_legacy SET stage=$2, stage_at=$3${extra} WHERE user_id=$1`, [p.user_id, stage, now]);
  // Check-ins wait for the person's waking hours, and a stage only moves on once its message actually reached them.
  const night = inQuietHours(now, user.tz, user.quiet_start, user.quiet_end);
  const ask = (text: string) => push(deps, user, "safety_legacy", text, { exempt: true, buttons, now });
  if (p.stage === 0) {
    const last = await lastActive(db, p);
    if (now.getTime() - last.getTime() < p.window_days * 86_400_000 || night) return;
    const mid = await db.one<{ id: number | null }>(`SELECT max(id) AS id FROM messages WHERE user_id=$1 AND role='user'`, [p.user_id]);
    if (!(await ask(`It's been ${p.window_days} days since I heard from you. Tap I'm here, or send me anything, and your "if something happens to me" plan stays on hold. If I don't hear back, I'll ask twice more over the next few days before anything is sent.`))) return;
    await db.query(`UPDATE safety_legacy SET stage=1, stage_at=$2, ping_msg_id=$3 WHERE user_id=$1`, [p.user_id, now, mid?.id ?? 0]);
  } else if (p.stage === 1 && since >= PING_GAP_H * H && !night) {
    if (await ask("Checking in again. Tap I'm here or send any message. Nothing is sent while you answer.")) await set(2);
  } else if (p.stage === 2 && since >= PING_GAP_H * H && !night) {
    const who = [...new Set((await items(db, p.user_id)).filter((i) => i.confirmed).map((i) => first({ name: i.to_label })))];
    if (await ask(`Last check. If I don't hear from you in the next 3 days, I'll send the messages you wrote${who.length ? ` for ${who.join(", ")}` : ""}. Tap I'm here or send anything to stop that.`)) await set(3);
  } else if (p.stage === 3 && since >= FINAL_WAIT_H * H) {
    await release(deps, user, p, now);
  }
}

async function release(deps: SchedulerDeps, user: User, p: Plan, now: Date) {
  const db = deps.db;
  await db.query(`UPDATE safety_legacy SET status='released', stage=4, released_at=$2 WHERE user_id=$1`, [user.id, now]);
  const days = Math.round((now.getTime() - (await lastActive(db, p)).getTime()) / 86_400_000);
  const name = fullName(user), f = first(user);
  const intro = `${name} wrote this in lifeline, to reach you if they stopped answering for a long time. They haven't replied for ${days} days, despite several check-ins. That might mean something has happened, or only that they've been away.`;
  for (const i of (await items(db, user.id)).filter((x) => x.confirmed)) {
    let ok = false;
    try {
      const text = `${intro}\n\n${i.kind === "note" ? `Where to find things, from ${f}:` : `${f}'s message for you:`}\n\n${i.body}`;
      if (i.to_kind === "email") ok = canEmail() && (await sendEmail(i.to_target, `A message from ${name}`, text));
      else { const u = await deps.getUser(Number(i.to_target)); if (u) ok = await deps.send(u, { text }); }
    } catch (e: any) { log.warn({ err: e?.message, item: i.id }, "legacy send failed"); }
    if (ok) await db.query(`UPDATE safety_legacy_items SET sent_at=$2 WHERE id=$1`, [i.id, now]);
  }
}

addSystemJob("safety_legacy_sweep", "37 * * * *");
onJob("safety_legacy_sweep", async (job, deps) => {
  const now = new Date(Math.max(Date.now(), new Date(job.run_at).getTime()));
  for (const p of await deps.db.query<Plan>(`SELECT * FROM safety_legacy WHERE status='on'`)) {
    try { await sweepOne(deps, p, now); } catch (e: any) { log.warn({ err: e?.message, user: p.user_id }, "legacy sweep failed"); }
  }
});

export async function legacyButton(db: Db, user: User, verb: string, now: Date): Promise<ButtonReply> {
  if (verb !== "here") return { text: "That button doesn't do anything any more." };
  const r = await db.query(`UPDATE safety_legacy SET stage=0, stage_at=NULL, ping_msg_id=NULL, alive_at=$2 WHERE user_id=$1 AND status='on' RETURNING user_id`, [user.id, now]);
  return { text: r.length ? "Thank you. Everything's reset, and your plan stays on hold." : "Thanks. Your legacy plan isn't running, so there's nothing to reset." };
}

/* ---------------- words ---------------- */

addRules(
  [/^(?:if something happens to me|if anything happens to me|legacy(?: message| note)?)[,:]?\s+(?:(?:send|tell|give|for)\s+)?(?:a (?:message|note) (?:to|for)\s+)?(\S+@\S+|[\p{L}'-]+(?: [\p{L}'-]+)?)\s*[:,]\s*([\s\S]{2,})$/iu, (m) => ({ action: "legacy.add", args: { to: m[1], text: m[2] } })],
  [/^(?:legacy )?(message|note) for (\S+@\S+|[\p{L}'-]+(?: [\p{L}'-]+)?) if something happens to me[:,]\s*([\s\S]{2,})$/iu, (m) => ({ action: "legacy.add", args: { to: m[2], text: m[3], kind: m[1].toLowerCase() as "message" | "note" } })],
  [/^(?:turn on|start|activate|switch on) (?:my )?(?:legacy plan|dead ?man'?s switch|if something happens to me plan)(?: (?:after|with|at|for) (\d{1,3})(?: days?)?)?$/i, (m) => ({ action: "legacy.on", args: m[1] ? { days: Number(m[1]) } : {} })],
  [/^pause (?:my )?(?:legacy plan|dead ?man'?s switch)$/i, () => ({ action: "legacy.pause", args: {} })],
  [/^(?:resume|unpause) (?:my )?(?:legacy plan|dead ?man'?s switch)$/i, () => ({ action: "legacy.pause", args: { resume: true } })],
  [/^(?:cancel|delete|stop|turn off|forget) (?:my )?(?:legacy plan|dead ?man'?s switch)$/i, () => ({ action: "legacy.cancel", args: {} })],
  [/^(?:legacy (?:plan )?status|my legacy plan|show my legacy plan|is my legacy plan on\??)$/i, () => ({ action: "legacy.status", args: {} })],
);
addExamples("legacy.add", ["if something happens to me, tell ada@example.com: I love you, and the cat goes to Bisi", "legacy note for tunde@example.com: the deed is in the blue folder in my desk"]);
addExamples("legacy.on", ["turn on my legacy plan after 30 days", "start my legacy plan"]);
addExamples("legacy.pause", ["pause my legacy plan", "resume my legacy plan"]);
addExamples("legacy.cancel", ["cancel my legacy plan"]);
addExamples("legacy.status", ["legacy status", "is my legacy plan on"]);
addCues("legacy", ["if something happens to me", "if anything happens to me", "dead man", "legacy", "when i die", "after i'm gone", "digital legacy", "inactivity"]);
addCapability({
  key: "legacy_plan", name: "If something happens to me",
  cues: ["if something happens to me", "dead man's switch", "digital legacy", "legacy plan", "when i die"],
  what: "Write messages and where-to-find-things notes for the people you choose. They're sent only after a long silence you pick (at least 14 days), three check-ins and a final three-day wait. Any message from you resets it.",
  say: ["if something happens to me, tell ada@example.com: …", "turn on my legacy plan after 30 days", "legacy status"],
  then: "You see exactly who gets what before it starts. I never keep passwords, seed phrases or keys; say where to find them instead.",
}, "Safety");
