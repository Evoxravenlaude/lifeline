/**
 * Following the conversation. People talk to an assistant the way they talk to a person:
 *   "What are my reminders?"  then  "Cancel the second one and remind me of Bunmi's birthday in 2 days"
 *   "Remind me of Evelyn's birthday on the 5th"  then  "Remind me at 6am instead"
 * Before this, "6am instead" became a new reminder called "at 6am instead", and "Cancel the second one and ..."
 * became a birthday named "Cancel the second one and remind me of bunmis birthday".
 *
 * This module gives lifeline three things: a memory of what it just listed and set (core/focus.ts), words that
 * point back at those ("the second one", "that", "instead"), and requests with two asks in one sentence, run in order.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type Ctx } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { addExamples, addRules } from "../core/plugins.js";
import { focusOf, ordinal, setFocus, type Thing } from "../core/focus.js";
import { human, parseClock, parseWhen, parseWhenOrMorning } from "../core/time.js";
import { nextCron, schedule } from "../core/scheduler.js";
import type { Intent } from "../intent/rules.js";

/* ---------------- tidy names ---------------- */

/** Names that end in s on their own, so "james birthday" stays James's, not Jame's. */
const S_NAMES = new Set("chris louis lewis travis dennis alexis boris doris iris francis curtis otis elvis morris harris james charles thomas nicholas douglas marcus julius agnes frances lucas jonas andreas carlos moses amos silas tobias elias matthias cyrus darius atlas".split(" "));

/** "remind me of bunmis birthday" → "Bunmi's birthday". Exported for tests. */
export function cleanLabel(label: string): string {
  let l = label.trim()
    .replace(/^(?:please\s+)?(?:remind me (?:of|about)|don'?t let me forget|(?:save|add|remember|note|keep)(?: that)?|it'?s|its)\s+/i, "")
    .replace(/^(?:the|my)\s+(?=\S+\s+(?:birthday|bday|anniversary))/i, "");
  // A possessive typed without its apostrophe: "bunmis birthday", "evelyns bday".
  l = l.replace(/\b([\p{L}]{2,})s'?\s+(birthday|bday|anniversary)\b/iu, (m, stem: string, what: string) => {
    const word = `${stem}s`.toLowerCase();
    if (/'s\s/i.test(m)) return m;
    return S_NAMES.has(word) ? `${stem}s's ${what}` : `${stem}'s ${what}`;
  });
  l = l.replace(/\bbday\b/i, "birthday");
  return l.charAt(0).toUpperCase() + l.slice(1);
}

/* ---------------- what's coming up, in one numbered order ---------------- */

export interface Upcoming { kind: Thing["kind"]; id: number; at: Date; label: string; repeats: boolean }

/** Reminders and saved dates (birthdays, countdowns) in the next two months, soonest first: one list, one numbering. */
export async function upcoming(ctx: Pick<Ctx, "db" | "user" | "now">): Promise<Upcoming[]> {
  const rems = await ctx.db.query<{ id: number; text: string; due_at: string; cron: string | null }>(
    `SELECT id, text, due_at, cron FROM reminders WHERE user_id=$1 AND NOT deleted AND NOT done ORDER BY due_at LIMIT 20`, [ctx.user.id]);
  const dates = await ctx.db.query<{ id: number; label: string; on_date: string; yearly: boolean }>(
    `SELECT id, label, to_char(on_date,'YYYY-MM-DD') AS on_date, yearly FROM dates WHERE user_id=$1`, [ctx.user.id]).catch(() => []);
  const today = DateTime.fromJSDate(ctx.now).setZone(ctx.user.tz).startOf("day");
  const out: Upcoming[] = rems.map((r) => ({ kind: "reminder", id: r.id, at: new Date(r.due_at), label: r.text, repeats: Boolean(r.cron) }));
  // A birthday saved as a reminder too shouldn't show twice.
  const named = new Set(out.map((u) => u.label.toLowerCase()));
  for (const d of dates) {
    let when = DateTime.fromISO(d.on_date, { zone: ctx.user.tz }).set({ hour: 9 });
    if (d.yearly) { when = when.set({ year: today.year }); if (when < today) when = when.plus({ years: 1 }); }
    if (when < today || when.diff(today, "days").days > 62 || named.has(d.label.toLowerCase())) continue;
    out.push({ kind: "date", id: d.id, at: when.toJSDate(), label: d.label, repeats: d.yearly });
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, 20);
}

/* ---------------- changing and dropping ---------------- */

const CLOCK_ONLY = /^(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|noon|midday|midnight|12\s*noon)$/i;

/** The reminder a "that" or an "instead" means: the one just set or touched, else the newest made in the last two hours. */
async function lastReminder(ctx: Ctx): Promise<number | null> {
  const f = focusOf(ctx.user, ctx.now);
  if (f?.last?.kind === "reminder") return f.last.id;
  const r = await ctx.db.one<{ id: number }>(`SELECT id FROM reminders WHERE user_id=$1 AND NOT deleted AND created_at > $2 ORDER BY id DESC LIMIT 1`, [ctx.user.id, new Date(ctx.now.getTime() - 2 * 3_600_000)]).catch(() => undefined);
  return r?.id ?? null;
}

const update = defineAction({
  name: "reminder.update",
  tier: 1,
  description: "Change when an existing reminder rings ('make it 6am', 'move the dentist one to Friday', '6am instead'). `id` or `match` (words from it) picks the reminder; with neither, the one just set. `when` is the new time in their words.",
  schema: z.object({ id: z.number().int().optional(), nth: z.number().int().min(1).max(20).optional(), match: z.string().max(80).optional(), when: z.string().min(1).max(80) }),
  async run(args, ctx) {
    // "the second one": the list they were shown, or the same list as it stands now.
    const fromList = async (n: number) => {
      const list = focusOf(ctx.user, ctx.now)?.list ?? (await upcoming(ctx)).map((u) => ({ kind: u.kind, id: u.id }));
      const it = list[n - 1];
      return it?.kind === "reminder" ? it.id : undefined;
    };
    const id = args.id ?? (args.nth ? await fromList(args.nth) : undefined) ?? (args.nth ? undefined : args.match
      ? (await ctx.db.one<{ id: number }>(`SELECT id FROM reminders WHERE user_id=$1 AND NOT deleted AND text ILIKE $2 ORDER BY due_at LIMIT 1`, [ctx.user.id, `%${args.match}%`]))?.id
      : await lastReminder(ctx));
    const row = id ? await ctx.db.one<{ id: number; text: string; due_at: string; cron: string | null; job_id: number | null }>(
      `SELECT id, text, due_at, cron, job_id FROM reminders WHERE id=$1 AND user_id=$2 AND NOT deleted`, [id, ctx.user.id]) : undefined;
    if (!row) return { reply: "Which reminder should I move? Say \"my reminders\", then something like \"move the second one to 6am\"." };
    const when = args.when.trim().replace(/\s+instead$/i, "");
    const clock = CLOCK_ONLY.exec(when);
    const cap = row.text.charAt(0).toUpperCase() + row.text.slice(1);
    let due: Date;
    let cron = row.cron;
    if (row.cron) {
      // A repeating one keeps its pattern; only the time of day changes.
      const hm = clock ? parseClock(clock[1]) : null;
      const f = row.cron.split(/\s+/);
      if (!hm || f.length !== 5) return { reply: `${cap} repeats, so tell me just the new time of day, like "make it 7am".` };
      f[0] = String(hm[1]); f[1] = String(hm[0]);
      cron = f.join(" ");
      due = nextCron(cron, ctx.user.tz, ctx.now);
    } else if (clock) {
      // "6am" alone keeps the day it was on.
      const hm = parseClock(clock[1]);
      if (!hm) return { reply: `I couldn't read a time in "${args.when}".` };
      let local = DateTime.fromJSDate(new Date(row.due_at)).setZone(ctx.user.tz).set({ hour: hm[0], minute: hm[1], second: 0, millisecond: 0 });
      if (local.toJSDate() <= ctx.now) local = local.plus({ days: 1 });
      due = local.toJSDate();
    } else {
      const d = parseWhenOrMorning(when, ctx.user.tz, ctx.now);
      if (!d) return { reply: `I couldn't read a time in "${args.when}". Try "tomorrow at 6am" or "Friday 5pm".` };
      due = d;
    }
    await ctx.db.query(`UPDATE reminders SET due_at=$2, cron=$3, done=false WHERE id=$1`, [row.id, due, cron]);
    if (row.job_id) await ctx.db.query(`UPDATE jobs SET run_at=$2, cron=$3, active=true, attempts=0 WHERE id=$1`, [row.job_id, due, cron]);
    else {
      const jobId = await schedule(ctx.db, { userId: ctx.user.id, kind: "reminder", payload: { reminderId: row.id }, runAt: cron ? undefined : due, cron: cron ?? undefined, tz: ctx.user.tz });
      await ctx.db.query(`UPDATE reminders SET job_id=$2 WHERE id=$1`, [row.id, jobId]);
    }
    await setFocus(ctx.db, ctx.user, { last: { kind: "reminder", id: row.id } }, ctx.now);
    return {
      reply: `Moved. ${cap}, ${cron ? `repeating, next ${human(due, ctx.user.tz, ctx.now)}` : human(due, ctx.user.tz, ctx.now)}.`,
      undo: { payload: { id: row.id, due_at: row.due_at, cron: row.cron, jobId: row.job_id } },
    };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE reminders SET due_at=$2, cron=$3 WHERE id=$1 AND user_id=$4`, [p.id, p.due_at, p.cron, ctx.user.id]);
    if (p.jobId) await ctx.db.query(`UPDATE jobs SET run_at=$2, cron=$3, active=true WHERE id=$1`, [p.jobId, p.cron ? nextCron(p.cron, ctx.user.tz, ctx.now) : p.due_at, p.cron]);
    return "Put back where it was.";
  },
});

const dateDelete = defineAction({
  name: "date.delete",
  tier: 1,
  description: "Forget a saved birthday, anniversary or countdown. `id`, or `match` with words from its name.",
  schema: z.object({ id: z.number().int().optional(), match: z.string().max(80).optional() }),
  async run(args, ctx) {
    const row = args.id
      ? await ctx.db.one<{ id: number; label: string; kind: string; on_date: string; yearly: boolean }>(`SELECT id, label, kind, on_date, yearly FROM dates WHERE id=$1 AND user_id=$2`, [args.id, ctx.user.id])
      : await ctx.db.one<{ id: number; label: string; kind: string; on_date: string; yearly: boolean }>(`SELECT id, label, kind, on_date, yearly FROM dates WHERE user_id=$1 AND label ILIKE $2 ORDER BY id DESC LIMIT 1`, [ctx.user.id, `%${args.match ?? ""}%`]);
    if (!row) return { reply: "I couldn't find a date like that. Say \"my dates\" to see what's saved." };
    await ctx.db.query(`UPDATE jobs SET active=false WHERE kind='date_alert' AND payload->>'dateId'=$1`, [String(row.id)]);
    await ctx.db.query(`DELETE FROM dates WHERE id=$1`, [row.id]);
    return { reply: `Dropped ${row.label}.`, undo: { payload: row } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`INSERT INTO dates (id, user_id, kind, label, on_date, yearly) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [p.id, ctx.user.id, p.kind, p.label, p.on_date, p.yearly]);
    await ctx.db.query(`UPDATE jobs SET active=true WHERE kind='date_alert' AND payload->>'dateId'=$1 AND run_at > now()`, [String(p.id)]);
    return "Back on the list.";
  },
});

register(update, dateDelete);

/* ---------------- words that point back ---------------- */

const ORD = "(first|second|third|fourth|fifth|sixth|seventh|last|final|top|bottom|1st|2nd|3rd|4th|5th|6th|7th|#?\\d{1,2}|number\\s+\\d{1,2})";
const DROP = "(?:cancel|delete|remove|drop|scrap|clear|forget|bin|kill)";
const LEAD = "(?:(?:no|nah|actually|sorry|wait|oh|oops|hmm|ok|okay)[,.!]?\\s+)?(?:please\\s+)?";

const dropFor = (t: Thing): Intent => (t.kind === "date" ? { action: "date.delete", args: { id: t.id } } : { action: "reminder.delete", args: { id: t.id } });

/**
 * A message that points at something said before. Null when it doesn't. Needs the person (what was just listed or
 * set), so it runs in the handler before the plain rules. Exported for tests.
 */
export async function resolveReference(ctx: Ctx, text: string): Promise<Intent | null> {
  const t = text.trim().replace(/[.!?]+$/, "");
  const nth = async (word: string): Promise<Thing | null> => {
    // The list they were shown, or, if it's been a while, the same list as it stands now.
    const list = focusOf(ctx.user, ctx.now)?.list ?? (await upcoming(ctx)).map((u) => ({ kind: u.kind, id: u.id }));
    const n = ordinal(word, list.length);
    return n && n <= list.length ? list[n - 1] : null;
  };

  // "cancel the second one", "delete number 3"
  let m = new RegExp(`^${LEAD}${DROP}\\s+(?:the\\s+)?${ORD}(?:\\s+(?:one|reminder|item|date|birthday))?(?:\\s+please)?$`, "i").exec(t);
  if (m) { const it = await nth(m[1]); return it ? dropFor(it) : null; }

  // "cancel that", "delete it"
  m = new RegExp(`^${LEAD}${DROP}\\s+(?:that|it|this)(?:\\s+(?:one|reminder))?(?:\\s+please)?$`, "i").exec(t);
  if (m) {
    const f = focusOf(ctx.user, ctx.now);
    if (f?.last) return dropFor(f.last);
    const id = await lastReminder(ctx);
    return id ? { action: "reminder.delete", args: { id } } : null;
  }

  // "move the second one to 7am", "change number 2 to Friday"
  m = new RegExp(`^${LEAD}(?:move|change|push|shift|set|make|reschedule)\\s+(?:the\\s+)?${ORD}(?:\\s+(?:one|reminder))?\\s+(?:to|for|at)\\s+(.+)$`, "i").exec(t);
  if (m) {
    const it = await nth(m[1]);
    return it?.kind === "reminder" ? { action: "reminder.update", args: { id: it.id, when: m[2] } } : null;
  }

  // "remind me at 6am instead", "6am instead", "no, make it 7"
  m = new RegExp(`^${LEAD}(?:(?:remind me|ring me|ping me|do it|make it|have it)\\s+)?(?:at|on|by|for)?\\s*(.+?)\\s+instead$`, "i").exec(t)
    ?? new RegExp(`^${LEAD}(?:make|change|move|push|shift|set|reschedule)\\s+(?:it|that|this|the time|the reminder)\\s+(?:to\\s+|for\\s+|at\\s+)?(.+?)(?:\\s+instead)?$`, "i").exec(t);
  if (m) {
    const when = m[1].trim();
    if (!CLOCK_ONLY.test(when) && !parseWhen(when, ctx.user.tz, ctx.now)) return null;
    const id = await lastReminder(ctx);
    return id ? { action: "reminder.update", args: { id, when } } : null;
  }
  return null;
}

/* ---------------- two asks in one sentence ---------------- */

const NEXT_ASK = "(?:remind me\\b|ping me\\b|(?:cancel|delete|remove|drop|scrap)\\s+(?:the|that|it|this|my|number)\\b|(?:move|change|make|push|reschedule)\\s+(?:it|that|the)\\b|set (?:a|an|another) (?:reminder|alarm|timer)\\b|add\\b.{1,60}\\bto (?:my |the )?[\\w ]{1,20}list\\b|what(?:'s| is| are)\\b|show (?:me )?my\\b)";
const SPLIT = new RegExp(`\\s*(?:[,;]\\s*)?\\b(?:and then|then|and also|also|and|plus)\\s+(?=${NEXT_ASK})`, "i");

/** "Cancel the second one and remind me of Bunmi's birthday in 2 days" → the two asks. Null for a single ask. */
export function splitAsks(text: string): string[] | null {
  const parts = text.split(SPLIT).map((p) => p.trim()).filter(Boolean);
  return parts.length > 1 && parts.length <= 3 ? parts : null;
}

/* ---------------- words ---------------- */

addRules(
  // Every way of asking for the list: "what are the reminders I've given you", "what have I asked you to remind me".
  [/^(?:what|which)\s+(?:are\s+)?(?:the\s+|my\s+|all\s+(?:of\s+)?(?:the\s+|my\s+)?)?reminders(?:\s+(?:do i have|have i (?:got|given|set|asked for)(?: you)?|i'?ve (?:given|set|asked for|got)(?: you)?|you have(?: for me)?|are (?:set|there|coming up|on)|(?:are )?left|for (?:today|this week|me)))?\??$|^(?:show|list|tell me|give me|read)\s+(?:me\s+)?(?:all\s+)?(?:of\s+)?(?:my|the)\s+reminders\??$|^(?:any|do i have any|got any)\s+reminders\??$|^what (?:have i asked|did i ask|have i told|did i tell) you to remind me(?: of| about)?\??$|^what(?:'s| is) (?:coming up|on my list|left on my list)\??$/i,
    () => ({ action: "reminder.list", args: {} })],
  // "remind me of Bunmi's birthday in 2 days": a birthday to keep every year, not a one-off note.
  [/^(?:please\s+)?remind me (?:of|about)\s+(.+?(?:birthday|bday|anniversary))\s+(?:is\s+)?(?:on\s+)?(.+)$/i, (m) => ({ action: "date.add", args: { label: cleanLabel(m[1]), on: m[2] } })],
);
/** Words that say a time ("6am", "Friday", "tomorrow at 5"), so "use tea instead" or "make it spicy" stay out. */
const TIMEY = /\d|\b(?:noon|midday|midnight|morning|afternoon|evening|tonight|tomorrow|today|next|week|weekend|month|mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i;

// The same words without the conversation (the model path, other channels): resolved when the action runs.
addRules(
  [new RegExp(`^${LEAD}(?:move|change|push|shift|set|make|reschedule)\\s+(?:the\\s+)?${ORD}(?:\\s+(?:one|reminder))?\\s+(?:to|for|at)\\s+(.+)$`, "i"),
    (m) => { const n = ordinal(m[1], 20); return n && n < 20 ? { action: "reminder.update", args: { nth: n, when: m[2] } } : null; }],
  [new RegExp(`^${LEAD}(?:(?:remind me|ring me|ping me|do it|make it|have it)\\s+)?(?:at|on|by|for)?\\s*(.+?)\\s+instead$|^${LEAD}(?:make|change|move|push|shift|reschedule)\\s+(?:it|that|this|the time|the reminder)\\s+(?:to\\s+|for\\s+|at\\s+)?(.+?)(?:\\s+instead)?$`, "i"),
    (m) => { const when = (m[1] ?? m[2]).trim(); return TIMEY.test(when) ? { action: "reminder.update", args: { when } } : null; }],
  [/^(?:please\s+)?(?:forget|delete|remove|drop|cancel)\s+(.+?(?:'s|s')?\s+(?:birthday|bday|anniversary))$/i, (m) => ({ action: "date.delete", args: { match: m[1].replace(/^(?:the|my)\s+/i, "").trim() } })],
);
addExamples("reminder.update", ["make it 6am instead", "move the second one to Friday at 5"]);
addExamples("date.delete", ["forget Ada's birthday"]);
