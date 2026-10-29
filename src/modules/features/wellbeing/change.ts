/**
 * Change, gently: quit and no-contact counters, and the dreaded-task breaker.
 *
 * Counters are private by default: they appear in the brief only if the person asks. A slip resets
 * kindly and the longest run stays on the record. Milestones are marked quietly, once each.
 * The task breaker turns one dreaded thing into a few five-minute steps, one at a time.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import { onJob, push, schedule } from "../../../core/scheduler.js";
import type { Db } from "../../../core/db.js";
import { money, userCurrency } from "../../../core/money.js";
import { parseMoney } from "../../../core/time.js";
import { yours } from "../../life.js";
import { cap, cheers, daysBetween, iso, keepDaily, onButton, pastDay, rx, sayDay, setWb, stopHint, think, today, wb } from "./shared.js";
import { parseJson } from "../../../core/media.js";

addSchema(`CREATE TABLE IF NOT EXISTS well_quits (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), kind TEXT NOT NULL DEFAULT 'quit', what TEXT NOT NULL, started_on DATE NOT NULL, cost_per_day NUMERIC, currency TEXT, reason TEXT, longest INT NOT NULL DEFAULT 0, slips INT NOT NULL DEFAULT 0, milestone INT NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS well_quits_user ON well_quits(user_id, active);
CREATE TABLE IF NOT EXISTS well_tasks (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), title TEXT NOT NULL, steps JSONB NOT NULL, idx INT NOT NULL DEFAULT 0, skipped INT NOT NULL DEFAULT 0, done_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`);

/* =====================================================================
 * 5. Quit and no-contact counters
 * ===================================================================== */

interface Quit { id: number; kind: "quit" | "nocontact"; what: string; started_on: string; cost_per_day: string | null; currency: string | null; reason: string | null; longest: number; slips: number; milestone: number }
const QUITS = `SELECT id, kind, what, to_char(started_on,'YYYY-MM-DD') AS started_on, cost_per_day::text, currency, reason, longest, slips, milestone FROM well_quits WHERE user_id=$1 AND active`;
const quits = (db: Db, user: User) => db.query<Quit>(`${QUITS} ORDER BY id`, [user.id]);
async function pickQuit(db: Db, user: User, what?: string): Promise<Quit | undefined> {
  const all = await quits(db, user);
  if (!what) return all[all.length - 1];
  const w = what.toLowerCase().replace(/^(?:my|on|with|the)\s+/, "");
  return all.find((q) => q.what.toLowerCase().includes(w) || w.includes(q.what.toLowerCase().replace(/^my\s+/, ""))) ?? undefined;
}
const daysOf = (q: Quit, user: User, now: Date) => Math.max(0, daysBetween(q.started_on, iso(today(user, now))));
const label = (q: Quit) => (q.kind === "nocontact" ? `No contact with ${yours(q.what)}` : cap(q.what));
const MILESTONES = [1, 3, 7, 14, 21, 30, 60, 90, 100, 180, 365];
export const isMilestone = (d: number) => MILESTONES.includes(d) || (d > 365 && d % 365 === 0);
const dayWord = (d: number) => (d === 0 ? "starting today" : `${d} day${d === 1 ? "" : "s"}`);

function line(q: Quit, user: User, now: Date): string {
  const d = daysOf(q, user, now);
  const saved = q.cost_per_day && Number(q.cost_per_day) > 0 && d > 0 ? `, about ${money(Math.round(d * Number(q.cost_per_day)), q.currency ?? userCurrency(user))} not spent on it` : "";
  const best = q.longest > d ? `. Longest run ${q.longest} days` : "";
  return `${label(q)}: ${dayWord(d)}${d ? ` since ${sayDay(q.started_on, user.tz, now)}` : ""}${saved}${best}.`;
}

/** "a pack is 12", "I spend 20 a week on it", "12 euros a day" → money per day. */
export function readCost(text: string): { cost: number; per: "day" | "week" | "month"; currency?: string } | null {
  const t = text.toLowerCase();
  const m = /(?:^|\b)(?:an?|one|each)\s+[a-z ]{2,20}?\s+(?:is|costs?|was|cost me)\s+(?:about\s+|around\s+)?(.+?)$/.exec(t) ?? /(?:i\s+)?(?:spent|spend|spending|it costs?(?: me)?|costs? me|that'?s)\s+(?:about\s+|around\s+)?(.+?)$/.exec(t) ?? /^(?:about\s+)?([$€£₦]?\s*\d.*)$/.exec(t);
  if (!m) return null;
  const rest = m[1];
  const per = /\b(?:a|per|each|every)\s+week\b/.test(rest) ? "week" : /\b(?:a|per|each|every)\s+month\b/.test(rest) ? "month" : "day";
  const pm = parseMoney(rest);
  const n = pm?.amount ?? Number(/(\d[\d,]*(?:\.\d+)?)/.exec(rest)?.[1]?.replace(/,/g, "") ?? NaN);
  if (!(n > 0)) return null;
  return { cost: n, per, ...(pm?.currency ? { currency: pm.currency } : {}) };
}

const quitStart = defineAction({
  name: "quit.start",
  tier: 1,
  description: "Start a private counter for something the person quit or stopped (smoking, drinking, betting) or a no-contact run (an ex): days since, money not spent, quiet milestones. `kind` 'quit' or 'nocontact'; `since` in words; `cost` and `per` (day, week, month) for money saved, with the person's currency unless they said one.",
  schema: z.object({ what: z.string().min(2).max(60), kind: z.enum(["quit", "nocontact"]).optional(), since: z.string().max(40).optional(), cost: z.number().positive().optional(), per: z.enum(["day", "week", "month"]).optional(), currency: z.string().length(3).optional() }),
  async run(args, ctx) {
    const kind = args.kind ?? "quit";
    const started = pastDay(args.since, ctx.user, ctx.now);
    if (!started) throw new Error(`I couldn't read when you started from "${args.since}". When was your first day?`);
    const what = args.what.trim().replace(/[.!]+$/, "").toLowerCase().replace(/\bmy\s+ex\b/, "my ex");
    const perDay = args.cost ? args.cost / (args.per === "week" ? 7 : args.per === "month" ? 30 : 1) : null;
    const cur = (args.currency ?? userCurrency(ctx.user)).toUpperCase();
    await ctx.db.query(`UPDATE well_quits SET active=false WHERE user_id=$1 AND lower(what)=$2 AND active`, [ctx.user.id, what]);
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO well_quits (user_id, kind, what, started_on, cost_per_day, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.user.id, kind, what, started, perDay, cur]);
    await keepDaily(ctx.db, ctx.user, "well_quit", "43 19 * * *");
    const q = (await ctx.db.one<Quit>(`${QUITS} AND id=$2`, [ctx.user.id, r!.id]))!;
    const after = kind === "nocontact"
      ? `I'll keep count, privately. When it's hard, say "talk me down".`
      : `I'll count quietly and mark the milestones. If you tell me why you're doing it ("my reason: ..."), I'll show it to you when it's hard. "Talk me down" is there for cravings.`;
    return { reply: `${line(q, ctx.user, ctx.now)} ${after}`, buttons: [{ label: "Talk me down", data: `wb:q:t:${q.id}` }], undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM well_quits WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Taken back."; },
});

const quitReason = defineAction({
  name: "quit.reason",
  tier: 1,
  description: "Keep the person's own reason for quitting or no contact, shown back when they ask to be talked down.",
  schema: z.object({ text: z.string().min(2).max(300), what: z.string().optional() }),
  async run(args, ctx) {
    const q = await pickQuit(ctx.db, ctx.user, args.what);
    if (!q) return { reply: `Start a counter first, like "I quit smoking on 1 Oct" or "no contact with my ex since Monday", and then tell me your reason.` };
    await ctx.db.query(`UPDATE well_quits SET reason=$2 WHERE id=$1`, [q.id, args.text.trim()]);
    return { reply: "Kept. I'll show you this when it's hard.", undo: { payload: { id: q.id, prev: q.reason } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE well_quits SET reason=$2 WHERE id=$1 AND user_id=$3`, [p.id, p.prev, ctx.user.id]); return "Taken back."; },
});

const quitStatus = defineAction({
  name: "quit.status",
  tier: 1,
  description: "Show the person's quit and no-contact counters: days, money not spent, longest run.",
  schema: z.object({ what: z.string().optional() }),
  async run(args, ctx) {
    const all = args.what ? [await pickQuit(ctx.db, ctx.user, args.what)].filter((q): q is Quit => Boolean(q)) : await quits(ctx.db, ctx.user);
    if (!all.length) return { reply: `No counters yet. Say "I quit smoking on 1 Oct, a pack is 12" or "no contact with my ex since Monday".` };
    const milestone = all.some((q) => isMilestone(daysOf(q, ctx.user, ctx.now)));
    return { reply: all.map((q) => line(q, ctx.user, ctx.now)).join("\n"), buttons: all.length === 1 ? [{ label: "Talk me down", data: `wb:q:t:${all[0].id}` }] : undefined, sticker: milestone ? cheers(ctx.user) : undefined };
  },
});

const quitSlip = defineAction({
  name: "quit.slip",
  tier: 1,
  description: "The person slipped (smoked, drank, made contact). Reset the counter kindly, with no shame, keeping the longest run on the record.",
  schema: z.object({ what: z.string().optional() }),
  async run(args, ctx) {
    const all = await quits(ctx.db, ctx.user);
    const q = args.what ? await pickQuit(ctx.db, ctx.user, args.what) : all.length === 1 ? all[0] : undefined;
    if (!q) return { reply: all.length ? `Thank you for telling me. Which one, ${all.map((x) => x.what).join(" or ")}? Say "slipped on ${all[0].what}".` : "Thank you for telling me. There's no counter running, so there's nothing to reset." };
    const d = daysOf(q, ctx.user, ctx.now), longest = Math.max(q.longest, d);
    await ctx.db.query(`UPDATE well_quits SET started_on=$2, longest=$3, slips=slips+1, milestone=0 WHERE id=$1`, [q.id, iso(today(ctx.user, ctx.now)), longest]);
    const kept = d > 0 ? ` ${d} day${d === 1 ? "" : "s"} still happened, and your longest run, ${longest} days, stays on the record.` : longest ? ` Your longest run, ${longest} days, stays on the record.` : "";
    return { reply: `Thank you for telling me. A slip isn't a failure.${kept} Today is day one again, and that's allowed.`, undo: { payload: { id: q.id, started: q.started_on, longest: q.longest, milestone: q.milestone } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE well_quits SET started_on=$2, longest=$3, milestone=$4, slips=GREATEST(slips-1,0) WHERE id=$1 AND user_id=$5`, [p.id, p.started, p.longest, p.milestone, ctx.user.id]); return "Taken back. The counter's as it was."; },
});

function talkDown(q: Quit, user: User, now: Date): string {
  const d = daysOf(q, user, now);
  const lead = q.kind === "nocontact"
    ? "The pull to reach out is strong right now, and it will ease. Put the phone face down for ten minutes."
    : "Breathe in for four, hold for four, out for six. Do it three times. A craving rises and passes, usually within a few minutes, and you don't have to act on it.";
  const why = q.reason ? `\n\nYou wrote: "${q.reason}"` : "";
  return `${lead}${why}\n\n${d ? `${d} day${d === 1 ? "" : "s"} so far.` : "You started today."} You've got this one too.`;
}

const quitTalk = defineAction({
  name: "quit.talk",
  tier: 1,
  description: "Talk the person down from a craving or the urge to make contact: a short grounding message and the reason they wrote down.",
  schema: z.object({ what: z.string().optional() }),
  async run(args, ctx) {
    const q = await pickQuit(ctx.db, ctx.user, args.what);
    if (!q) return { reply: "Breathe in for four, hold for four, out for six. Do it three times. Whatever the urge is, it rises and passes. I'm here." };
    return { reply: talkDown(q, ctx.user, ctx.now) };
  },
});

const quitStop = defineAction({
  name: "quit.stop",
  tier: 1,
  description: "Stop one quit or no-contact counter (the record is kept until the person deletes it).",
  schema: z.object({ what: z.string().min(1) }),
  async run(args, ctx) {
    const q = await pickQuit(ctx.db, ctx.user, args.what);
    if (!q) return { reply: "I'm not counting anything like that." };
    await ctx.db.query(`UPDATE well_quits SET active=false WHERE id=$1`, [q.id]);
    return { reply: `I've stopped counting ${q.kind === "nocontact" ? `no contact with ${yours(q.what)}` : q.what}. "delete my quit counters" removes the record too.`, undo: { payload: { id: q.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE well_quits SET active=true WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Counting again."; },
});

const quitSettings = defineAction({
  name: "quit.settings",
  tier: 1,
  description: "Counters are private by default. `in_brief` true shows them in the morning brief; `milestones` false stops the quiet milestone messages.",
  schema: z.object({ in_brief: z.boolean().optional(), milestones: z.boolean().optional() }),
  async run(args, ctx) {
    const patch: Record<string, unknown> = {};
    if (args.in_brief !== undefined) patch.quitBrief = args.in_brief ? true : null;
    if (args.milestones !== undefined) patch.quitQuiet = args.milestones ? null : true;
    await setWb(ctx.db, ctx.user, patch);
    const bits = [args.in_brief === true ? "Your counters will show in your morning brief." : args.in_brief === false ? "Your counters stay out of the brief." : "", args.milestones === false ? "No more milestone messages." : args.milestones === true ? "I'll mark the milestones again." : ""].filter(Boolean);
    return { reply: bits.join(" ") || "Nothing to change." };
  },
});

onButton("q", async (db, user, [k, id], now) => {
  const q = await db.one<Quit>(`${QUITS} AND id=$2`, [user.id, Number(id)]);
  if (!q) return { text: "That counter's gone." };
  if (k === "t") return { text: talkDown(q, user, now) };
  return { text: "That button's moved on." };
});

/** Milestones, once each, quietly. Through push(), so calm mode and quiet days hold them. */
onJob("well_quit", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user || wb(user).quitQuiet) return;
  const now = new Date();
  for (const q of await quits(deps.db, user)) {
    const d = daysOf(q, user, now);
    if (!isMilestone(d) || q.milestone >= d) continue;
    const hint = await stopHint(deps.db, user, "quit", "stop milestone messages");
    const text = q.kind === "nocontact" ? `${d} day${d === 1 ? "" : "s"} of no contact with ${yours(q.what)}. That takes strength.` : `${d} day${d === 1 ? "" : "s"} without ${q.what} today. Quietly proud of you.`;
    const ok = await push(deps, user, "well_quit", `${text}${hint}`, { buttons: [{ label: "Talk me down", data: `wb:q:t:${q.id}` }] });
    if (ok) await deps.db.query(`UPDATE well_quits SET milestone=$2 WHERE id=$1`, [q.id, d]);
    break; // one a day at most
  }
});

addBriefSection({
  key: "well_quit", order: 55,
  async lines(db, user, now) {
    if (wb(user).quitBrief !== true) return [];
    const all = await quits(db, user);
    return all.length ? [all.map((q) => `${label(q)}: ${dayWord(daysOf(q, user, now))}.`).join(" ")] : [];
  },
});

/* =====================================================================
 * 8. Dreaded-task breaker
 * ===================================================================== */

const GENERIC: [RegExp, string[]][] = [
  [/\b(?:clean|tidy|kitchen|bathroom|room|dishes|laundry|declutter|wardrobe|closet|garage|fridge|hoover|vacuum)\b/i, ["Put on music or a podcast and set a five-minute timer.", "Clear one surface completely, just one.", "Gather everything that lives somewhere else into one pile.", "Deal with the sink or the floor, whichever bothers you most.", "Wipe down the surface you cleared.", "Take the rubbish out."]],
  [/\b(?:tax|taxes|admin|forms?|paperwork|bills?|insurance|application|visa|passport|bank|pension|benefits|claim|invoice|accounts?)\b/i, ["Find last year's papers or letters and put them in one place.", "Open the website or the form and just log in.", "Write down what it asks for, nothing more.", "Fill in the easy parts you already know.", "Note the one or two things you're missing and where to get them.", "Save it, even half done."]],
  [/\b(?:emails?|inbox|messages|reply|replies|dms?)\b/i, ["Open your inbox and only look, no replying yet.", "Archive anything you don't need to answer.", "Reply to the quickest one, two lines is fine.", "Reply to the one you've been dreading, short and honest.", "Flag what's left for tomorrow."]],
  [/\b(?:essay|thesis|report|write|writing|study|revise|revision|homework|assignment|project|cv|resume|cover letter|deck|presentation)\b/i, ["Open the document and give it a working title.", "Write three bullet points of what it needs to say.", "Write one rough paragraph. Badly is fine.", "Find one source, note or example you need.", "Read back what you wrote and fix one thing.", "Write down where to start next time."]],
];
const DEFAULT_STEPS = ["Get out everything you need for it.", "Set a five-minute timer and start the smallest part.", "Do the next small piece.", "Do one more small piece.", "Write down where you stopped and what comes next."];
export const genericSteps = (task: string) => GENERIC.find(([re]) => re.test(task))?.[1] ?? DEFAULT_STEPS;

interface Task { id: number; title: string; steps: string[]; idx: number; skipped: number; done_at: string | null }
const stepButtons = (t: { id: number }) => [{ label: "Done", data: `wb:t:d:${t.id}` }, { label: "Skip", data: `wb:t:s:${t.id}` }, { label: "Check in at 25 min", data: `wb:t:c:${t.id}` }];
const stepText = (t: Task) => `**Step ${t.idx + 1} of ${t.steps.length}**\n${t.steps[t.idx]}`;

const taskBreak = defineAction({
  name: "task.break",
  tier: 1,
  description: "Break a dreaded or put-off task ('help me do my taxes', 'I keep putting off cleaning the kitchen') into 3 to 6 five-minute steps, shown one at a time with Done and Skip, and an optional check-in after 25 minutes.",
  schema: z.object({ task: z.string().min(2).max(120) }),
  async run(args, ctx) {
    const task = args.task.trim().replace(/[.!?]+$/, "");
    const j = parseJson((await think(ctx.db, ctx.user, `Someone keeps putting off: "${task}". Break it into 3 to 6 tiny steps, each doable in about five minutes, concrete and kind, easiest first. JSON: {"steps": [string]}. Each step under 15 words. No emoji.`, { json: true, max: 300 })) ?? "");
    const fromModel = Array.isArray(j?.steps) ? j.steps.map((s: unknown) => String(s).trim()).filter((s: string) => s && s.length < 140).slice(0, 6) : [];
    const steps: string[] = fromModel.length >= 3 ? fromModel : genericSteps(task);
    const title = cap(yours(task.replace(/^(?:to\s+|do\s+|doing\s+)/i, "")));
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO well_tasks (user_id, title, steps) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, title, JSON.stringify(steps)]);
    const t: Task = { id: r!.id, title, steps, idx: 0, skipped: 0, done_at: null };
    return { reply: `${title}, in ${steps.length} small steps of about five minutes. Just this one for now:\n\n${stepText(t)}`, buttons: stepButtons(t) };
  },
});

async function loadTask(db: Db, user: User, id: number): Promise<Task | undefined> {
  const t = await db.one<Task>(`SELECT id, title, steps, idx, skipped, done_at FROM well_tasks WHERE id=$1 AND user_id=$2`, [id, user.id]);
  if (t && typeof t.steps === "string") t.steps = JSON.parse(t.steps);
  return t;
}

onButton("t", async (db, user, [k, id], now) => {
  const t = await loadTask(db, user, Number(id));
  if (!t || t.done_at) return { text: "That one's already finished." };
  if (k === "c") {
    const at = new Date(now.getTime() + 25 * 60_000);
    await schedule(db, { userId: user.id, kind: "well_task_check", payload: { taskId: t.id, idx: t.idx }, runAt: at });
    return { text: `I'll check in at ${DateTime.fromJSDate(at).setZone(user.tz).toFormat("HH:mm")}. Keep going with this one.`, buttons: stepButtons(t).slice(0, 2) };
  }
  const idx = t.idx + 1, skipped = t.skipped + (k === "s" ? 1 : 0);
  if (idx >= t.steps.length) {
    await db.query(`UPDATE well_tasks SET idx=$2, skipped=$3, done_at=$4 WHERE id=$1`, [t.id, idx, skipped, now]);
    return skipped
      ? { text: `That's the list. You got through it; the skipped bits can wait for another day.`, sticker: cheers(user) }
      : { text: `That's all of it. ${t.title}, done. That was the hard part, and you did it.`, sticker: cheers(user) };
  }
  await db.query(`UPDATE well_tasks SET idx=$2, skipped=$3 WHERE id=$1`, [t.id, idx, skipped]);
  const next = { ...t, idx };
  return { text: `${k === "s" ? "Skipped, that's fine." : "Nice."} Next:\n\n${stepText(next)}`, buttons: stepButtons(next) };
});

onJob("well_task_check", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const t = await loadTask(deps.db, user, job.payload.taskId);
  if (!t || t.done_at) return;
  // They asked for this check-in, so it comes like a reminder they set.
  await push(deps, user, "reminder", `25 minutes. How's ${t.title.charAt(0).toLowerCase()}${t.title.slice(1)} going? You're on step ${t.idx + 1} of ${t.steps.length}.`, { exempt: true, buttons: stepButtons(t).slice(0, 2) });
});

register(quitStart, quitReason, quitStatus, quitSlip, quitTalk, quitStop, quitSettings, taskBreak);

/* ---------------- words ---------------- */

const QUIT_THINGS = String.raw`(?:smoking|vaping|drinking|alcohol|booze|sugar|caffeine|coffee|energy drinks|soda|fizzy drinks|betting|gambling|porn|weed|cannabis|nicotine|cigarettes|cigs|social media|doomscrolling|tiktok|instagram|junk food|fast food|online shopping|biting my nails|nail biting)`; // no catch-all: "I stopped caring" or "I stopped eating" must never become a counter with milestones
const WHEN = String.raw`(?:\s+(?:on|since|from)\s+(.{2,30}?)|\s+(today|yesterday|last \w+|this morning|\d+ days? ago|a week ago))?`;
const COST = String.raw`(?:[,;.]\s*(.{3,60}))?`;
function quitArgs(what: string, since: string | undefined, cost: string | undefined, kind: "quit" | "nocontact") {
  const c = cost ? readCost(cost) : null;
  return { action: "quit.start", args: { what, kind, ...(since ? { since } : {}), ...(c ? { cost: c.cost, per: c.per, ...(c.currency && /^[A-Z]{3}$/.test(c.currency) ? { currency: c.currency } : {}) } : {}) } };
}
const QUIT_HOOK = String.raw`(?:talk me down|i'?m (?:really )?craving (?:a |some |one )?(?:cigarette|cig|smoke|vape|drink|beer|wine|bet|joint|weed)s?|i really want (?:a |to )(?:smoke|drink|cigarette|vape|bet|text (?:him|her|them)|call (?:him|her|them)))`;

addRules(
  [rx(String.raw`(?:i\s+)?(?:have\s+|'ve\s+)?(?:quit|stopped|gave up|given up)\s+(${QUIT_THINGS})${WHEN}${COST}`), (m) => quitArgs(m[1], m[2] ?? m[3], m[4], "quit")],
  // Needs a start ("since Monday", "today"): "no contact with the client yet" is just news.
  [rx(String.raw`(?:i'?m\s+)?(?:on\s+|going\s+|gone\s+)?(?:no contact|no-contact)\s+(?:with\s+)?(.{2,30}?)(?:\s+(?:on|since|from)\s+(.{2,30}?)|\s+(today|yesterday|last \w+|this morning|\d+ days? ago|a week ago))`), (m) => quitArgs(m[1], m[2] ?? m[3], undefined, "nocontact")],
  [rx(String.raw`(?:my )?reason(?: for quitting| for (?:no contact|this))?\s*(?:is)?\s*[:,-]\s*(.{2,300})`), (m) => ({ action: "quit.reason", args: { text: m[1] } })],
  [rx(String.raw`(?:my )?(?:quit |no-contact |no contact )?counters?|how am i doing (?:on|with) (?:the )?(${QUIT_THINGS}|no contact)|how long since i (?:quit|stopped|gave up) (.{2,30})`), (m) => ({ action: "quit.status", args: m[1] ?? m[2] ? { what: m[1] ?? m[2] } : {} })],
  // "I slipped on the ice" is a fall, not a slip: plain "slipped" needs the thing it was ("slipped with smoking").
  [rx(String.raw`(?:i\s+)?(?:relapsed|had a slip|had a relapse)(?:\s+(?:today|yesterday|last night))?(?:\s+(?:on|with)\s+(.{2,30}))?`), (m) => ({ action: "quit.slip", args: m[1] ? { what: m[1] } : {} })],
  [rx(String.raw`(?:i\s+)?slipped(?:\s+(?:today|yesterday|last night))?\s+(?:on|with)\s+(${QUIT_THINGS}|no contact)(?:\s+(?:today|yesterday|last night))?`), (m) => ({ action: "quit.slip", args: { what: m[1] } })],
  [rx(QUIT_HOOK), () => ({ action: "quit.talk", args: {} })],
  [rx(String.raw`(?:stop|end) (?:the |my )?(?:counter|counting) (?:for |on )?(.{2,30})`), (m) => ({ action: "quit.stop", args: { what: m[1] } })],
  [rx(String.raw`(show|put|keep|leave) my (?:quit )?counters (?:in|out of) (?:the|my) (?:morning )?brief`), (m) => ({ action: "quit.settings", args: { in_brief: !/out of/i.test(m[0]) } })],
  [rx(String.raw`(stop|start) (?:the )?milestone messages`), (m) => ({ action: "quit.settings", args: { milestones: /start/i.test(m[1]) } })],

  [rx(String.raw`help me (?:to )?(?:do|start|get through|tackle|get started on|finish)\s+(.{2,80})`), (m) => ({ action: "task.break", args: { task: m[1] } })],
  [rx(String.raw`i (?:keep|kept) putting off\s+(.{2,80})|i(?:'ve| have) been putting off\s+(.{2,80})|break (?:down|into (?:small )?steps)[:\s]\s*(.{2,80})`), (m) => ({ action: "task.break", args: { task: m[1] ?? m[2] ?? m[3] } })],
);

addExamples("quit.start", ["I quit smoking on 1 Oct, a pack is 12", "no contact with my ex since Monday", "stopped betting today", "I gave up drinking 3 days ago"]);
addExamples("quit.reason", ["my reason: I want to run with my kids"]);
addExamples("quit.status", ["my counters", "how am I doing on smoking"]);
addExamples("quit.slip", ["had a slip today", "I relapsed", "I slipped on smoking"]);
addExamples("quit.talk", ["talk me down", "I'm craving a cigarette"]);
addExamples("quit.stop", ["stop the counter for betting"]);
addExamples("quit.settings", ["show my counters in the brief", "stop milestone messages"]);
addExamples("task.break", ["help me do my taxes", "I keep putting off cleaning the kitchen", "I've been putting off my emails"]);

addCues("quit", ["quit", "stopped", "gave up", "no contact", "craving", "slipped", "relapse", "sober", "days since"]);
addCues("task", ["putting off", "avoiding", "dreading", "procrastinat", "overwhelming", "break it down", "small steps"]);

addCapability({
  key: "quit_counters", name: "Quit and no-contact counters",
  cues: ["quit smoking", "stopped drinking", "no contact", "sober", "days since", "craving"],
  what: "A private count of the days since you quit or stopped something, or went no contact, with the money not spent, quiet milestones, and a \"talk me down\" for the hard moments that shows you your own reason.",
  say: ["I quit smoking on 1 Oct, a pack is 12", "no contact with my ex since Monday", "talk me down", "slipped today"],
  then: "A slip resets the count kindly and your longest run stays on the record. Private by default; \"show my counters in the brief\" if you want them there.",
}, "Body and mind");
addCapability({
  key: "task_breaker", name: "Dreaded-task breaker",
  cues: ["putting off", "procrastinating", "dreading", "avoiding", "can't start"],
  what: "Tell me the thing you keep putting off and I'll split it into a few five-minute steps, then hand them to you one at a time with Done and Skip.",
  say: ["help me do my taxes", "I keep putting off cleaning the kitchen"],
  then: "Tap \"Check in at 25 min\" and I'll look in on you, like someone working alongside you.",
}, "Body and mind");
