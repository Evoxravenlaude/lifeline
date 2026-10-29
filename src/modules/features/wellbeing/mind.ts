/**
 * Mind: mood check-ins, a quiet burnout radar, three good things, plain patterns, and the crisis path.
 * Everything here is opt-in and private. Low days get kindness and fewer words. Nothing here appears in
 * the brief unless the person turned it on, and never in Wrapped or anything shared.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema, addFirstLook } from "../../../core/plugins.js";
import { onJob, push } from "../../../core/scheduler.js";
import type { Db } from "../../../core/db.js";
import { setThread } from "../../../intent/thread.js";
import { parseByRules } from "../../../intent/rules.js";
import { parseLoose } from "../../../intent/loose.js";
import { userCurrency } from "../../../core/money.js";
import { moodScore } from "./health.js";
import { CRISIS, clockOf, crisisReply, dailyCron, ensureCron, iso, onButton, readClock, rx, sayDay, setWb, stopHint, stopJobs, today, wb } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS well_good (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), text TEXT NOT NULL, day DATE NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS well_good_user ON well_good(user_id, day)`);

/** A message that reads as a request rather than an answer to an open question. */
const isRequest = (t: string) => Boolean(parseByRules(t) ?? parseLoose(t));

/* ---------------- crisis ---------------- */

const crisis = defineAction({
  name: "crisis.help",
  tier: 1,
  description: "When a message suggests the person may harm themselves or not want to be alive: a warm reply pointing to findahelpline.com (free, confidential, worldwide) and the local emergency number. Nothing is stored.",
  schema: z.object({}),
  async run(_a, ctx) { return { reply: crisisReply(ctx.user) }; },
});

/* ---------------- mood check-ins ---------------- */

const moodCheckins = defineAction({
  name: "mood.checkins",
  tier: 1,
  description: "Turn opt-in mood check-ins on or off: a 1 to 5 tap in the evening (daily) or once a week, with room for a few words. `hour` 0-23 local. Also watches, privately, for mood and sleep dipping together for two weeks.",
  schema: z.object({ on: z.boolean(), cadence: z.enum(["daily", "weekly"]).optional(), hour: z.number().int().min(0).max(23).optional(), minute: z.number().int().min(0).max(59).optional() }),
  async run(args, ctx) {
    if (!args.on) {
      await stopJobs(ctx.db, ctx.user.id, "well_mood");
      await stopJobs(ctx.db, ctx.user.id, "well_radar");
      await setWb(ctx.db, ctx.user, { mood: null, radar: null });
      return { reply: `Mood check-ins are off. What you logged stays private; "delete my mood data" removes it.` };
    }
    const cadence = args.cadence ?? "daily";
    const hour = args.hour ?? (cadence === "weekly" ? 19 : 20), minute = args.minute ?? (args.hour == null ? 3 : 0);
    await ensureCron(ctx.db, ctx.user, "well_mood", dailyCron(hour, minute, cadence === "weekly" ? "0" : "*"));
    await ensureCron(ctx.db, ctx.user, "well_radar", dailyCron(17, 41, "0"));
    await setWb(ctx.db, ctx.user, { mood: { cadence, hour, minute }, radar: true });
    const shown = clockOf(hour, args.minute ?? 0);
    const when = cadence === "weekly" ? `every Sunday at ${shown}` : `every evening at ${shown}`;
    return { reply: `I'll check in ${when} with a quick 1 to 5. Tap a number, add a few words if you like, or ignore it. It stays between us. Say "stop mood check-ins" any time.` };
  },
});

const moodNote = defineAction({
  name: "mood.note",
  tier: 1,
  description: "Add a few private words to today's mood ('mood note: long day but okay').",
  schema: z.object({ words: z.string().min(1).max(500), id: z.number().int().optional() }),
  fill(need, answer) {
    if (need !== "words" || answer.length > 500 || isRequest(answer)) return null;
    return { words: answer };
  },
  async run(args, ctx) {
    if (CRISIS.test(args.words)) return { reply: crisisReply(ctx.user) };
    const row = args.id
      ? await ctx.db.one<{ id: number; note: string | null }>(`SELECT id, note FROM measures WHERE id=$1 AND user_id=$2`, [args.id, ctx.user.id])
      : await ctx.db.one<{ id: number; note: string | null }>(`SELECT id, note FROM measures WHERE user_id=$1 AND name='mood' AND at >= $2 ORDER BY at DESC LIMIT 1`, [ctx.user.id, today(ctx.user, ctx.now).toJSDate()]);
    if (row) {
      await ctx.db.query(`UPDATE measures SET note=$2 WHERE id=$1`, [row.id, `${row.note ? `${row.note}, ` : ""}${args.words.trim()}`]);
      return { reply: "Kept, just for you.", undo: { payload: { id: row.id, note: row.note, created: false } } };
    }
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO measures (user_id, name, note, at) VALUES ($1,'mood',$2,$3) RETURNING id`, [ctx.user.id, args.words.trim(), ctx.now]);
    return { reply: "Kept, just for you.", undo: { payload: { id: r!.id, created: true } } };
  },
  async undo(p, ctx) {
    if (p.created) await ctx.db.query(`DELETE FROM measures WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    else await ctx.db.query(`UPDATE measures SET note=$2 WHERE id=$1 AND user_id=$3`, [p.id, p.note, ctx.user.id]);
    return "Taken back.";
  },
});

const moodRadar = defineAction({
  name: "mood.radar",
  tier: 1,
  description: "Turn the private burnout radar on or off: one soft message if mood and sleep both trend down for two weeks.",
  schema: z.object({ on: z.boolean() }),
  async run(args, ctx) {
    if (!args.on) { await stopJobs(ctx.db, ctx.user.id, "well_radar"); await setWb(ctx.db, ctx.user, { radar: false }); return { reply: "I'll stop watching for that." }; }
    await ensureCron(ctx.db, ctx.user, "well_radar", dailyCron(17, 41, "0"));
    await setWb(ctx.db, ctx.user, { radar: true });
    return { reply: `I'll keep a quiet eye on your mood and sleep. If both dip for a couple of weeks, I'll say so once, gently, just to you. Say "stop watching my mood" any time.` };
  },
});

const MOOD_BTNS = [1, 2, 3, 4, 5].map((n) => ({ label: String(n), data: `wb:m:${n}` }));

onJob("well_mood", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user || !wb(user).mood) return;
  // The radar spoke today: no more words than that.
  if (wb(user).radarAt === iso(today(user, new Date()))) return;
  const weekly = wb(user).mood?.cadence === "weekly";
  const hint = await stopHint(deps.db, user, "mood", "stop mood check-ins");
  await push(deps, user, "well_mood", `${weekly ? "How was your week" : "How was today"}, 1 to 5? Tap a number, or ignore this.${hint}`, { buttons: [...MOOD_BTNS, { label: "Stop these", data: "wb:m:stop" }] });
});

onButton("m", async (db, user, [v], now) => {
  if (v === "stop") {
    await stopJobs(db, user.id, "well_mood");
    await setWb(db, user, { mood: null });
    return { text: "Mood check-ins are off. Say \"check on my mood every evening\" if you ever want them back." };
  }
  const n = Number(v);
  if (!(n >= 1 && n <= 5)) return { text: "That button's moved on." };
  const r = await db.one<{ id: number }>(`INSERT INTO measures (user_id, name, value, note, at) VALUES ($1,'mood',$2,$3,$4) RETURNING id`, [user.id, n, `${n}/5`, now]);
  await setThread(db, user, { action: "mood.note", args: { id: r!.id }, need: "words", question: "a few words about today, if you like", askedAt: now.getTime() });
  if (n <= 2) {
    const g = await db.one(`SELECT 1 FROM well_good WHERE user_id=$1 AND day < $2::date - 1 LIMIT 1`, [user.id, iso(today(user, now))]);
    return { text: "Thank you for telling me. Go gently tonight. If you want to say more, I'm listening.", buttons: g ? [{ label: "Something you wrote", data: "wb:g:one" }] : undefined };
  }
  return { text: n === 3 ? "Thanks. A middling day counts too. Add a few words if you like." : "Good to hear. Add a few words if you like." };
});

/* ---------------- the burnout radar ---------------- */

const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;

/** Mood and sleep both lower than the person's own usual, in each of the last two weeks. Needs enough data to be fair. */
export async function radarSees(db: Db, user: User, now: Date): Promise<boolean> {
  const t0 = today(user, now).plus({ days: 1 });
  const rows = await db.query<{ name: string; value: string | null; note: string | null; at: string }>(
    `SELECT name, value::text, note, at FROM measures WHERE user_id=$1 AND name IN ('mood','sleep') AND at >= $2 AND at < $3`, [user.id, t0.minus({ days: 42 }).toJSDate(), t0.toJSDate()]);
  const bucket = (name: string, from: number, to: number) => rows.filter((r) => r.name === name).filter((r) => { const d = t0.diff(DateTime.fromJSDate(new Date(r.at)), "days").days; return d > from && d <= to; })
    .map((r) => (name === "mood" ? moodScore(r) : r.value == null ? null : Number(r.value))).filter((v): v is number => v != null);
  const check = (name: string, gap: number) => {
    const w1 = bucket(name, 0, 7), w2 = bucket(name, 7, 14), base = bucket(name, 14, 42);
    return w1.length >= 2 && w2.length >= 2 && base.length >= 4 && mean(w1) <= mean(base) - gap && mean(w2) <= mean(base) - gap;
  };
  return check("mood", 0.5) && check("sleep", 0.5);
}

export const RADAR_TEXT = "Something I noticed, just between us: your mood and your sleep have both been lower than usual for about two weeks. That's okay. Hard stretches happen. If it would help to talk to someone, a doctor or someone you trust is a good start, and https://findahelpline.com lists free, confidential support near you.";

onJob("well_radar", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user || wb(user).radar !== true) return;
  const last = wb(user).radarAt as string | undefined;
  const now = new Date();
  if (last && DateTime.fromISO(last) > today(user, now).minus({ days: 28 })) return;
  if (!(await radarSees(deps.db, user, now))) return;
  const ok = await push(deps, user, "well_radar", RADAR_TEXT);
  // Held back (calm mode, a quiet day): it waits, once, in the person's own morning brief.
  await setWb(deps.db, user, { radarAt: iso(today(user, now)), radarHeld: ok ? null : true });
});

addBriefSection({
  key: "well_radar", order: 20,
  async lines(db, user, _now, opts) {
    if (wb(user).radar !== true || !wb(user).radarHeld) return [];
    if (!opts?.peek) await setWb(db, user, { radarHeld: null });
    return [RADAR_TEXT];
  },
});

/* ---------------- three good things ---------------- */

const goodSettings = defineAction({
  name: "good.settings",
  tier: 1,
  description: "Turn the opt-in evening 'three good things' prompt on or off. `hour` 0-23 local (default 21).",
  schema: z.object({ on: z.boolean(), hour: z.number().int().min(0).max(23).optional(), minute: z.number().int().min(0).max(59).optional() }),
  async run(args, ctx) {
    if (!args.on) { await stopJobs(ctx.db, ctx.user.id, "well_good"); await setWb(ctx.db, ctx.user, { good: null }); return { reply: `No more good-things prompts. What you wrote stays private; "my good things" shows it.` }; }
    const hour = args.hour ?? 21, minute = args.minute ?? 0;
    await ensureCron(ctx.db, ctx.user, "well_good", dailyCron(hour, minute === 0 ? 2 : minute));
    await setWb(ctx.db, ctx.user, { good: { hour, minute } });
    return { reply: `Every evening at ${clockOf(hour, minute)} I'll ask for three good things from your day. Small ones count. Reply in words or a voice note, or skip it. Say "stop good things" any time.` };
  },
});

const goodAdd = defineAction({
  name: "good.add",
  tier: 1,
  description: "Save the person's good things from today, privately ('good things: the bus was on time, lunch with Ada, finished the book').",
  schema: z.object({ text: z.string().min(1).max(1000) }),
  fill(need, answer) {
    if (need !== "text" || answer.length > 1000 || isRequest(answer)) return null;
    return { text: answer };
  },
  async run(args, ctx) {
    if (CRISIS.test(args.text)) return { reply: crisisReply(ctx.user) };
    const items = args.text.split(/\n+|;\s*|,\s*|\s+(?=\d[.)]\s)/).map((s) => s.trim().replace(/^(?:[-*•]|\d[.)])\s*/, "").replace(/^and\s+/i, "").replace(/[.]+$/, "")).filter((s) => s.length > 1).slice(0, 6);
    if (!items.length) throw new Error("I didn't catch the good things in that. Say them in a line, like \"good things: a long walk, a call with Mum\".");
    const day = iso(today(ctx.user, ctx.now));
    const ids: number[] = [];
    for (const t of items) ids.push((await ctx.db.one<{ id: number }>(`INSERT INTO well_good (user_id, text, day) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, t, day]))!.id);
    return { reply: items.length >= 3 ? "Kept, all of them. Sleep well." : items.length === 2 ? "Kept, both. Sleep well." : "Kept. Sleep well.", undo: { payload: { ids } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM well_good WHERE id = ANY($1::int[]) AND user_id=$2`, [p.ids, ctx.user.id]); return "Taken back."; },
});

const goodList = defineAction({
  name: "good.list",
  tier: 1,
  description: "Show the person's recent good things.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ text: string; day: string }>(`SELECT text, to_char(day,'YYYY-MM-DD') AS day FROM well_good WHERE user_id=$1 ORDER BY day DESC, id DESC LIMIT 12`, [ctx.user.id]);
    if (!rows.length) return { reply: `Nothing yet. Say "good things: ..." any evening, or "ask me for three good things at 9pm" and I'll ask.` };
    return { reply: rows.map((r) => `- ${sayDay(r.day, ctx.user.tz, ctx.now)}: ${r.text}`).join("\n") };
  },
});

onJob("well_good", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user || !wb(user).good) return;
  const hint = await stopHint(deps.db, user, "good", "stop good things");
  const ok = await push(deps, user, "well_good", `Three good things from today? Small ones count. Just reply with them.${hint}`, { buttons: [{ label: "Not tonight", data: "wb:g:skip" }, { label: "Stop these", data: "wb:g:stop" }] });
  if (ok) await setThread(deps.db, user, { action: "good.add", args: {}, need: "text", question: "three good things from today", askedAt: Date.now() });
});

onButton("g", async (db, user, [v]) => {
  if (v === "stop") { await stopJobs(db, user.id, "well_good"); await setWb(db, user, { good: null }); return { text: "No more good-things prompts. Say \"ask me for three good things at 9pm\" if you want them back." }; }
  if (v === "skip") { await setThread(db, user, null); return { text: "That's fine. Rest well." }; }
  const rows = await db.query<{ text: string; day: string }>(`SELECT text, to_char(day,'YYYY-MM-DD') AS day FROM well_good WHERE user_id=$1 ORDER BY id DESC LIMIT 40`, [user.id]);
  if (!rows.length) return { text: "Nothing saved yet." };
  const r = rows[Math.floor(Math.random() * rows.length)];
  return { text: `On ${sayDay(r.day, user.tz, new Date())} you wrote: "${r.text}"` };
});

/* ---------------- patterns ---------------- */

interface Day { sleep?: number; mood?: number; spend?: number; habit?: boolean }

/** Plain patterns that hold across the whole period and both halves of it. Patterns, never causes. Exported for tests. */
export async function patterns(db: Db, user: User, now: Date): Promise<string[]> {
  const t0 = today(user, now).plus({ days: 1 });
  const from = t0.minus({ days: 56 });
  const days = new Map<string, Day>();
  const at = (d: string | Date) => iso(DateTime.fromJSDate(new Date(d)).setZone(user.tz));
  const get = (k: string) => { let d = days.get(k); if (!d) days.set(k, (d = {})); return d; };
  const ms = await db.query<{ name: string; value: string | null; note: string | null; at: string }>(`SELECT name, value::text, note, at FROM measures WHERE user_id=$1 AND name IN ('sleep','mood') AND at >= $2 AND at < $3`, [user.id, from.toJSDate(), t0.toJSDate()]);
  const acc = new Map<string, number[]>();
  for (const m of ms) { const v = m.name === "mood" ? moodScore(m) : m.value == null ? null : Number(m.value); if (v == null) continue; const k = `${m.name}|${at(m.at)}`; acc.set(k, [...(acc.get(k) ?? []), v]); }
  for (const [k, v] of acc) { const [name, d] = k.split("|"); (get(d) as any)[name] = mean(v); }
  const cur = userCurrency(user);
  const sp = await db.query<{ amount: string; currency: string; spent_at: string }>(`SELECT amount::text, currency, spent_at FROM spend WHERE user_id=$1 AND spent_at >= $2 AND spent_at < $3`, [user.id, from.toJSDate(), t0.toJSDate()]);
  const main = sp.length ? [...sp.reduce((m, s) => m.set(s.currency, (m.get(s.currency) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0][0] : cur;
  for (const s of sp.filter((x) => x.currency === main)) { const d = get(at(s.spent_at)); d.spend = (d.spend ?? 0) + Number(s.amount); }
  const hc = await db.query<{ day: string }>(`SELECT DISTINCT to_char(c.day,'YYYY-MM-DD') AS day FROM habit_checkins c JOIN habits h ON h.id=c.habit_id WHERE h.user_id=$1 AND c.day >= $2::date`, [user.id, iso(from)]);
  const hasHabits = hc.length > 0;
  for (const h of hc) get(h.day).habit = true;

  const all = [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
  const span = all.length ? daysBetweenIso(all[0][0], all[all.length - 1][0]) : 0;
  if (span < 21) return [];
  const mid = all[Math.floor(all.length / 2)][0];
  /** The difference in `y` between days where `split` is true and false, if it's big enough and points the same way in both halves. */
  const compare = (y: keyof Day, split: (d: Day) => boolean | null, minDiff: number): number | null => {
    const pick = (rows: [string, Day][]) => {
      const a = rows.filter(([, d]) => d[y] != null && split(d) === true).map(([, d]) => d[y] as number);
      const b = rows.filter(([, d]) => d[y] != null && split(d) === false).map(([, d]) => d[y] as number);
      return { a, b, diff: a.length && b.length ? mean(a) - mean(b) : null };
    };
    const whole = pick(all), h1 = pick(all.filter(([k]) => k < mid)), h2 = pick(all.filter(([k]) => k >= mid));
    if (whole.a.length < 6 || whole.b.length < 6 || whole.diff == null || Math.abs(whole.diff) < minDiff) return null;
    if (h1.diff == null || h2.diff == null || Math.sign(h1.diff) !== Math.sign(whole.diff) || Math.sign(h2.diff) !== Math.sign(whole.diff)) return null;
    return whole.diff;
  };
  const out: string[] = [];
  const spends = all.map(([, d]) => d.spend).filter((v): v is number => v != null).sort((a, b) => a - b);
  if (spends.length >= 6) {
    const usual = mean(spends);
    const d = compare("sleep", (x) => (x.sleep == null ? null : (x.spend ?? 0) > usual), 25 / 60);
    if (d != null) out.push(`You slept about ${Math.round((Math.abs(d) * 60) / 5) * 5} minutes ${d < 0 ? "less" : "more"} on days you spent more than usual.`);
  }
  const sleeps = all.map(([, d]) => d.sleep).filter((v): v is number => v != null).sort((a, b) => a - b);
  if (sleeps.length >= 12) {
    const cut = Math.round(sleeps[Math.floor(sleeps.length / 2)] * 2) / 2;
    const d = compare("mood", (x) => (x.sleep == null ? null : x.sleep >= cut), 0.4);
    if (d != null) out.push(`Your mood was about ${(Math.round(Math.abs(d) * 10) / 10).toFixed(1)} points ${d > 0 ? "higher" : "lower"} (out of 5) on days you slept ${cut} hours or more.`);
  }
  if (hasHabits) {
    const d = compare("mood", (x) => Boolean(x.habit), 0.4);
    if (d != null) out.push(`Your mood was about ${(Math.round(Math.abs(d) * 10) / 10).toFixed(1)} points ${d > 0 ? "higher" : "lower"} (out of 5) on days you checked in a habit.`);
  }
  return out;
}
const daysBetweenIso = (a: string, b: string) => Math.round(DateTime.fromISO(b).diff(DateTime.fromISO(a), "days").days);

const insightSettings = defineAction({
  name: "insight.settings",
  tier: 1,
  description: "Turn opt-in life patterns on or off: at most weekly, one plain pattern from what's tracked (sleep, mood, spending, habits) that has held for several weeks. Always a pattern, never a cause.",
  schema: z.object({ on: z.boolean() }),
  async run(args, ctx) {
    await setWb(ctx.db, ctx.user, { insights: args.on ? true : null });
    if (!args.on) return { reply: "No more patterns." };
    const p = await patterns(ctx.db, ctx.user, ctx.now);
    return { reply: `${p.length ? `Here's one that holds right now: ${p[0]} A pattern, not a cause.\n\n` : "Nothing holds steadily enough yet; it takes a few weeks of sleep, mood, spending or habits. "}I'll look once a week and put anything new in your Monday brief. Say "stop the patterns" any time.` };
  },
});

addBriefSection({
  key: "well_insight", order: 70,
  async lines(db, user, now) {
    if (wb(user).insights !== true || DateTime.fromJSDate(now).setZone(user.tz).weekday !== 1) return [];
    const p = await patterns(db, user, now);
    if (!p.length) return [];
    return [`A pattern from the last few weeks: ${p[DateTime.fromJSDate(now).weekNumber % p.length]} A pattern, not a cause.`];
  },
});

register(crisis, moodCheckins, moodNote, moodRadar, goodSettings, goodAdd, goodList, insightSettings);

/* ---------------- words ---------------- */

const AT = String.raw`(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?`;
const at = (s?: string) => { const c = readClock(s); return c ? { hour: c[0], minute: c[1] } : {}; };

addRules(
  // The crisis path is checked before anything else in this area, anywhere in a message.
  [new RegExp(`^(?!\\s*(?:remind|search|google|look up|find)\\b)[\\s\\S]*?(?:${CRISIS.source})`, "i"), () => ({ action: "crisis.help", args: {} })],
  [rx(String.raw`(?:check (?:in )?on my mood|mood check-?ins?(?: on)?|ask (?:me )?how i'?m (?:feeling|doing))(?:\s+(every evening|every night|every day|daily|nightly|each evening|weekly|every week|once a week|every sunday))?${AT}`), (m) => ({ action: "mood.checkins", args: { on: true, cadence: /week|sunday/i.test(m[1] ?? "") ? "weekly" : "daily", ...at(m[2]) } })],
  [rx(String.raw`(?:stop|turn off|pause|no more|end|cancel) (?:the |my )?mood check-?ins?|stop (?:checking|asking) (?:on|about) my mood|mood check-?ins? off`), () => ({ action: "mood.checkins", args: { on: false } })],
  [rx(String.raw`(?:mood note|note (?:on|for) my mood|about my mood today)[:,]\s*(.{1,500})`), (m) => ({ action: "mood.note", args: { words: m[1] } })],
  [rx(String.raw`(?:watch|keep an eye on) (?:my )?(?:mood and sleep|burnout|for burnout)|(?:turn on |start )?(?:the )?burnout radar(?: on)?`), () => ({ action: "mood.radar", args: { on: true } })],
  [rx(String.raw`stop watching (?:my mood|for burnout)|(?:turn off|stop) (?:the )?burnout radar|burnout radar off`), () => ({ action: "mood.radar", args: { on: false } })],

  [rx(String.raw`(?:ask me for|remind me of|prompt me for|start) (?:three|3) good things(?: every (?:evening|night|day))?${AT}`), (m) => ({ action: "good.settings", args: { on: true, ...at(m[1]) } })],
  [rx(String.raw`(?:stop|no more|turn off|pause) (?:the )?(?:three |3 )?good things(?: prompts?)?`), () => ({ action: "good.settings", args: { on: false } })],
  [rx(String.raw`(?:(?:three|3|my|today'?s) )?good things?(?: today)?\s*[:,-]\s*([\s\S]{2,1000})`), (m) => ({ action: "good.add", args: { text: m[1] } })],
  [rx(String.raw`(?:show )?(?:me )?my good things|(?:my )?good things list|what were my good things`), () => ({ action: "good.list", args: {} })],

  [rx(String.raw`show me (?:my )?patterns|(?:turn on|start) (?:life )?(?:patterns|insights)|(?:life )?(?:patterns|insights) on|find patterns in my (?:life|week|data)`), () => ({ action: "insight.settings", args: { on: true } })],
  [rx(String.raw`(?:stop|no more|turn off) (?:the )?(?:life )?(?:patterns|insights)`), () => ({ action: "insight.settings", args: { on: false } })],
);

addExamples("crisis.help", ["I want to kill myself", "I don't want to be alive anymore", "i keep thinking about ending my life"]);
addExamples("mood.checkins", ["check on my mood every evening", "check on my mood weekly", "mood check-ins every evening at 9pm", "stop mood check-ins"]);
addExamples("mood.note", ["mood note: long day but okay"]);
addExamples("mood.radar", ["watch for burnout", "stop watching my mood"]);
addExamples("good.settings", ["ask me for three good things at 9pm", "stop good things"]);
addExamples("good.add", ["good things: the bus was on time, lunch with Ada, finished my book", "three good things: sunshine; a nap; Mum called"]);
addExamples("good.list", ["my good things"]);
addExamples("insight.settings", ["show me patterns", "stop the patterns"]);

addCues("crisis", ["kill myself", "suicide", "suicidal", "self harm", "want to die", "end my life", "hurt myself", "not worth living"]);
addCues("mood", ["mood", "feeling", "check in on my mood", "burnout", "how i'm doing", "low", "down"]);
addCues("good", ["good things", "gratitude", "grateful", "thankful"]);
addCues("insight", ["patterns", "insights", "correlation", "trend"]);

addCapability({
  key: "mood_checkins", name: "Mood check-ins",
  cues: ["mood check", "check on my mood", "how i'm feeling", "burnout", "mental health"],
  what: "If you'd like, I check in each evening or once a week with a 1 to 5 tap and room for a few words. If your mood and sleep both dip for a couple of weeks, I tell you once, gently, and where support is.",
  say: ["check on my mood every evening", "check on my mood weekly", "mood note: long day but okay", "stop mood check-ins"],
  then: "Only you see it. It never goes in Wrapped or anything shared. If things get very dark, findahelpline.com finds free, confidential help wherever you are.",
  limits: "I'm not a therapist and I never diagnose.",
}, "Body and mind");
addCapability({
  key: "good_things", name: "Three good things",
  cues: ["good things", "gratitude", "gratitude journal", "grateful"],
  what: "An evening prompt for three good things from your day, small ones count, kept privately. On a hard day I can offer one of your own lines back.",
  say: ["ask me for three good things at 9pm", "good things: a long walk, a call with Mum", "my good things", "stop good things"],
  then: "Answer in words or a voice note. Skip any evening; nothing counts against you.",
}, "Body and mind");
addCapability({
  key: "patterns", name: "Patterns in your life",
  cues: ["patterns", "insights", "correlation", "what affects my mood"],
  what: "From what you already track, at most once a week, one plain pattern that has held for several weeks, like \"you slept about 40 minutes less on days you spent more than usual\".",
  say: ["show me patterns", "stop the patterns"],
  then: "It goes in your Monday brief. Always a pattern, never a cause.",
}, "Body and mind");

/* Seen before anything else reads the message: an open question or a "note:" never swallows this. */
addFirstLook(async (_db, user, text) => {
  if (!CRISIS.test(text)) return null;
  // Only a bare word like "suicide" in a clear request ("remind me to call the suicide prevention line for my friend")
  // lets the request through; anything in the first person, or not a clear request, gets the gentle reply.
  const weakOnly = !CRISIS.test(text.replace(/\b(?:suicid\w*|self[- ]?harm\w*)/gi, " "));
  if (weakOnly && !/\b(?:i|i'm|im|myself)\b/i.test(text.replace(/^(?:remind me|tell me|ask me)\b/i, "")) && parseByRules(text) && parseByRules(text)!.action !== "crisis.help") return null;
  return crisisReply(user);
});
