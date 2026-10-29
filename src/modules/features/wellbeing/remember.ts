/**
 * Remembering: grief and remembrance dates, the time capsule, and on this day.
 *
 * Remembrance dates are kept quietly. On the day, one gentle message in the person's own words, only
 * if they asked for it, per date. They never appear in on this day, Wrapped or anything cheerful.
 * A time capsule is delivered once, on its date, exactly as written. On this day offers at most one
 * gentle memory a day in the brief, from the person's own trips, notes and confirmed memories, and
 * never anything about grief, health, cycles or quitting.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import { onJob, push, schedule } from "../../../core/scheduler.js";
import type { Db } from "../../../core/db.js";
import { parseLoose } from "../../../intent/loose.js";
import { parseByRules } from "../../../intent/rules.js";
import { parseWhen } from "../../../core/time.js";
import { yours } from "../../life.js";
import { cancelJob, dayMonth, isCalm, iso, MONTHS, nextYearly, onButton, personName, rx, setWb, today, wb } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS well_remembrance (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), who TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'passing', month INT NOT NULL, day INT NOT NULL, year INT, words TEXT, notify BOOLEAN NOT NULL DEFAULT false, job_id INT, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS well_remembrance_user ON well_remembrance(user_id);
CREATE TABLE IF NOT EXISTS well_capsules (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), body TEXT NOT NULL, deliver_on DATE NOT NULL, delivered_at TIMESTAMPTZ, job_id INT, created_at TIMESTAMPTZ DEFAULT now())`);

/* =====================================================================
 * 6. Remembrance
 * ===================================================================== */

interface Rem { id: number; who: string; kind: "passing" | "birthday" | "day"; month: number; day: number; year: number | null; words: string | null; notify: boolean; job_id: number | null }
const sayMD = (r: { month: number; day: number }) => `${r.day} ${MONTHS[r.month - 1].replace(/^./, (c) => c.toUpperCase())}`;
async function findRem(db: Db, user: User, who: string): Promise<Rem | undefined> {
  const w = personName(who).toLowerCase().replace(/'s(?: birthday)?$/, "");
  const rows = await db.query<Rem>(`SELECT * FROM well_remembrance WHERE user_id=$1 ORDER BY id DESC`, [user.id]);
  return rows.find((r) => r.who.toLowerCase() === w) ?? rows.find((r) => r.who.toLowerCase().startsWith(w) || w.startsWith(r.who.toLowerCase()));
}

/** Arm (or re-arm) the one gentle message for the next time the day comes round. */
async function arm(db: Db, user: User, r: Rem, now: Date) {
  if (r.job_id) await cancelJob(db, r.job_id);
  if (!r.notify) { await db.query(`UPDATE well_remembrance SET job_id=NULL WHERE id=$1`, [r.id]); return; }
  const id = await schedule(db, { userId: user.id, kind: "well_remember", payload: { id: r.id }, runAt: nextYearly(r.month, r.day, user, now, 10) });
  await db.query(`UPDATE well_remembrance SET job_id=$2 WHERE id=$1`, [r.id, id]);
}

const remText = (r: Rem) => {
  const lead = r.kind === "birthday" ? `Today is ${r.who}'s birthday. Thinking of you.` : `Thinking of ${r.who} with you today.`;
  return r.words ? `${lead} You wrote:\n\n"${r.words}"` : `${lead} Go gently.`;
};

const remAdd = defineAction({
  name: "remembrance.add",
  tier: 1,
  description: "Keep a grief or remembrance date quietly: the day someone died ('Dad passed on 4 June 2019') or a day to remember them ('remembrance: Grandma's birthday, 12 August'). Nothing is sent unless the person then asks for one gentle message on the day. `kind` passing, birthday or day.",
  schema: z.object({ who: z.string().min(1).max(40), on: z.string().min(3).max(40), kind: z.enum(["passing", "birthday", "day"]).optional(), words: z.string().max(500).optional() }),
  async run(args, ctx) {
    const d = dayMonth(args.on, ctx.user, ctx.now);
    if (!d) throw new Error(`I couldn't read a day in "${args.on}". Which day should I keep, like 4 June?`);
    const kind = args.kind ?? "passing";
    const who = personName(args.who).replace(/'s$/i, "");
    await ctx.db.query(`DELETE FROM well_remembrance WHERE user_id=$1 AND lower(who)=lower($2) AND kind=$3`, [ctx.user.id, who, kind]);
    const r = await ctx.db.one<Rem>(`INSERT INTO well_remembrance (user_id, who, kind, month, day, year, words, notify) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [ctx.user.id, who, kind, d.month, d.day, d.year, args.words ?? null, Boolean(args.words)]);
    if (r!.notify) await arm(ctx.db, ctx.user, r!, ctx.now);
    const lead = kind === "passing" ? `I'm so sorry about ${who}. I've kept ${sayMD(d)}, quietly.` : `I've kept ${who}${kind === "birthday" ? "'s birthday" : "'s day"}, ${sayMD(d)}, quietly.`;
    if (r!.notify) return { reply: `${lead} On the day I'll send you your words, and nothing else.`, undo: { payload: { id: r!.id } } };
    return {
      reply: `${lead} It won't show up anywhere unless you want it to. Would you like one gentle message from me on the day?`,
      buttons: [{ label: "Yes, on the day", data: `wb:r:on:${r!.id}` }, { label: "No, just keep it", data: `wb:r:off:${r!.id}` }],
      undo: { payload: { id: r!.id } },
    };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE jobs SET active=false WHERE kind='well_remember' AND user_id=$1 AND payload->>'id'=$2`, [ctx.user.id, String(p.id)]);
    await ctx.db.query(`DELETE FROM well_remembrance WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Taken back.";
  },
});

const remWords = defineAction({
  name: "remembrance.words",
  tier: 1,
  description: "The person's own words for a remembrance day ('words for Dad: ...'). Turns on the one gentle message for that day, which carries these words.",
  schema: z.object({ who: z.string().min(1).max(40), words: z.string().min(1).max(500) }),
  async run(args, ctx) {
    const r = await findRem(ctx.db, ctx.user, args.who);
    if (!r) return { reply: `I don't have a day kept for ${personName(args.who)}. Tell me the day first, like "${personName(args.who)} passed on 4 June".` };
    await ctx.db.query(`UPDATE well_remembrance SET words=$2, notify=true WHERE id=$1`, [r.id, args.words.trim()]);
    await arm(ctx.db, ctx.user, { ...r, words: args.words, notify: true }, ctx.now);
    return { reply: `Kept. On ${sayMD(r)} I'll send you your words, and nothing else.` };
  },
});

const remNotify = defineAction({
  name: "remembrance.notify",
  tier: 1,
  description: "Turn the one gentle message on a remembrance day on or off, for one person.",
  schema: z.object({ who: z.string().min(1).max(40), on: z.boolean() }),
  async run(args, ctx) {
    const r = await findRem(ctx.db, ctx.user, args.who);
    if (!r) return { reply: `I don't have a day kept for ${personName(args.who)}.` };
    return { reply: await setNotify(ctx.db, ctx.user, r, args.on, ctx.now) };
  },
});
async function setNotify(db: Db, user: User, r: Rem, on: boolean, now: Date): Promise<string> {
  await db.query(`UPDATE well_remembrance SET notify=$2 WHERE id=$1`, [r.id, on]);
  await arm(db, user, { ...r, notify: on }, now);
  return on
    ? `I'll send you one gentle message on ${sayMD(r)}.${r.words ? "" : ` If there are words you'd like to hear that day, say "words for ${r.who}: ..."`}`
    : `I'll keep ${sayMD(r)} quietly and won't send anything.`;
}
onButton("r", async (db, user, [k, id], now) => {
  const r = await db.one<Rem>(`SELECT * FROM well_remembrance WHERE id=$1 AND user_id=$2`, [Number(id), user.id]);
  if (!r) return { text: "I don't have that day any more." };
  return { text: await setNotify(db, user, r, k === "on", now) };
});

const remList = defineAction({
  name: "remembrance.list",
  tier: 1,
  description: "Show the remembrance dates the person has kept.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<Rem>(`SELECT * FROM well_remembrance WHERE user_id=$1 ORDER BY month, day`, [ctx.user.id]);
    if (!rows.length) return { reply: "There are no remembrance dates kept." };
    return { reply: rows.map((r) => `- ${r.who}${r.kind === "birthday" ? "'s birthday" : ""}, ${sayMD(r)}${r.notify ? ", a gentle message on the day" : ", kept quietly"}`).join("\n") };
  },
});

onJob("well_remember", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const r = await deps.db.one<Rem>(`SELECT * FROM well_remembrance WHERE id=$1`, [job.payload.id]);
  if (!r || !r.notify) return;
  // A quiet day holds it; calm mode moves it into the morning brief (see below).
  await push(deps, user, "well_remember", remText(r));
  await arm(deps.db, user, r, new Date(Date.now() + 86_400_000));
});

/** Only in calm mode, where pings wait for the brief, and only on the day, and only if asked for. */
addBriefSection({
  key: "well_remembrance", order: 15,
  async lines(db, user, now) {
    if (!isCalm(user)) return [];
    const t = today(user, now);
    const rows = await db.query<Rem>(`SELECT * FROM well_remembrance WHERE user_id=$1 AND notify AND month=$2 AND day=$3`, [user.id, t.month, t.day]);
    return rows.slice(0, 1).map(remText).map((s) => s.replace(/\n+/g, " "));
  },
});

/* =====================================================================
 * 9. Time capsule
 * ===================================================================== */

/** The person's own birthday, if they told me ("my birthday is 3 May") or keep it in their dates. */
async function ownBirthday(db: Db, user: User): Promise<{ month: number; day: number } | null> {
  const b = wb(user).birthday as { month: number; day: number } | undefined;
  if (b?.month && b?.day) return b;
  const r = await db.one<{ m: number; d: number }>(`SELECT extract(month from on_date)::int AS m, extract(day from on_date)::int AS d FROM dates WHERE user_id=$1 AND label ~* '^(my )?(own )?(birthday|bday)$' ORDER BY id DESC LIMIT 1`, [user.id]);
  return r ? { month: r.m, day: r.d } : null;
}

/** When a capsule should arrive, as an ISO day, or "birthday" when it needs the person's birthday first. */
async function capsuleDay(db: Db, user: User, when: string, now: Date): Promise<string | "birthday" | null> {
  const t0 = today(user, now);
  const w = when.toLowerCase().trim();
  if (/\bbirthday|bday\b/.test(w)) {
    const b = await ownBirthday(db, user);
    if (!b) return "birthday";
    let d = DateTime.fromJSDate(nextYearly(b.month, b.day, user, now, 0)).setZone(user.tz).startOf("day");
    if (d <= t0) d = d.plus({ years: 1 });
    if (/next year/.test(w) && d.year === t0.year) d = d.plus({ years: 1 });
    return iso(d);
  }
  const m = /^(?:in\s+)?(\d+|a|an|one|two|three|six|twelve)\s+(days?|weeks?|months?|years?)$/.exec(w.replace(/^in\s+/, "in "));
  if (m) {
    const n = ({ a: 1, an: 1, one: 1, two: 2, three: 3, six: 6, twelve: 12 } as Record<string, number>)[m[1]] ?? Number(m[1]);
    return iso(t0.plus({ [m[2].replace(/s$/, "") + "s"]: n }));
  }
  if (/^(?:next year|a year from now|this time next year)$/.test(w)) return iso(t0.plus({ years: 1 }));
  const d = parseWhen(w, user.tz, now);
  return d ? iso(DateTime.fromJSDate(d).setZone(user.tz).startOf("day")) : null;
}

const capsuleAdd = defineAction({
  name: "capsule.add",
  tier: 1,
  description: "A time capsule: a message or letter to the person's future self, delivered once on a date, exactly as written. `when` in words: 'in 6 months', 'next year', 'on my birthday next year', '1 January 2028'. `body` is their message.",
  schema: z.object({ when: z.string().min(2).max(60), body: z.string().max(4000).optional() }),
  async needs(args, ctx) {
    const d = await capsuleDay(ctx.db, ctx.user, args.when, ctx.now);
    if (d === "birthday") return { need: "birthday", question: "When's your birthday? I'll deliver it then." };
    if (!d) return { need: "when", question: `I couldn't read a date in "${args.when}". When should it arrive?` };
    if (!args.body?.trim()) return { need: "body", question: "What would you like to say to future you? Write it all in one message." };
    return null;
  },
  fill(need, answer, _args, ctx) {
    if (need === "body") return answer.trim() && !parseByRules(answer) && !parseLoose(answer) ? { body: answer } : null;
    if (need === "when") return parseWhen(answer, ctx.user.tz, ctx.now) ? { when: answer } : null;
    if (need === "birthday") {
      const d = dayMonth(answer, ctx.user, ctx.now);
      if (!d) return null;
      const prefs = { ...ctx.user.prefs, wb: { ...wb(ctx.user), birthday: { month: d.month, day: d.day } } };
      ctx.user.prefs = prefs;
      void ctx.db.query(`UPDATE users SET prefs = jsonb_set(prefs, '{wb}', $2::jsonb, true) WHERE id=$1`, [ctx.user.id, JSON.stringify(prefs.wb)]);
      return {};
    }
    return null;
  },
  async run(args, ctx) {
    const day = await capsuleDay(ctx.db, ctx.user, args.when, ctx.now);
    if (!day || day === "birthday") throw new Error("I couldn't work out when to send it. When should it arrive?");
    const t0 = today(ctx.user, ctx.now);
    if (day <= iso(t0)) throw new Error("That day is already here. Pick a day in the future and I'll keep it sealed until then.");
    if (day > iso(t0.plus({ years: 25 }))) throw new Error("That's further than I can promise to keep it. Pick a day within 25 years?");
    if (!args.body?.trim()) throw new Error("What would you like to say to future you?");
    // Untouched: the sentence parser trims a closing full stop, so take the words from the message itself when they're in it.
    const src = (ctx.sourceMessage ?? "").replace(/^\[[^\]]+\]\s*/, "");
    const at = src.indexOf(args.body);
    const body = at >= 0 ? src.slice(at) : args.body;
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO well_capsules (user_id, body, deliver_on) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, body, day]);
    const runAt = DateTime.fromISO(day, { zone: ctx.user.tz }).set({ hour: 9, minute: 0 }).toJSDate();
    const jobId = await schedule(ctx.db, { userId: ctx.user.id, kind: "well_capsule", payload: { id: r!.id }, runAt });
    await ctx.db.query(`UPDATE well_capsules SET job_id=$2 WHERE id=$1`, [r!.id, jobId]);
    const d = DateTime.fromISO(day, { zone: ctx.user.tz });
    return { reply: `Sealed. I'll send it to you on ${d.toFormat("ccc d LLLL yyyy")}, exactly as you wrote it, and not before.`, undo: { payload: { id: r!.id, job: jobId } } };
  },
  async undo(p, ctx) {
    await cancelJob(ctx.db, p.job);
    await ctx.db.query(`DELETE FROM well_capsules WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Unsealed and gone.";
  },
});

const capsuleList = defineAction({
  name: "capsule.list",
  tier: 1,
  description: "Show sealed time capsules: only when each arrives, never what's inside.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ deliver_on: string }>(`SELECT to_char(deliver_on,'YYYY-MM-DD') AS deliver_on FROM well_capsules WHERE user_id=$1 AND delivered_at IS NULL ORDER BY deliver_on`, [ctx.user.id]);
    if (!rows.length) return { reply: `Nothing sealed. Say "a letter to myself in 6 months: ..." to write one.` };
    const days = rows.map((r) => DateTime.fromISO(r.deliver_on).toFormat("d LLL yyyy"));
    return { reply: `${rows.length === 1 ? "One sealed letter" : `${rows.length} sealed letters`}, arriving ${days.join(", ")}. What's inside stays sealed until then.` };
  },
});

onJob("well_capsule", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const c = await deps.db.one<{ id: number; body: string; created_at: string; delivered_at: string | null }>(`SELECT id, body, created_at, delivered_at FROM well_capsules WHERE id=$1`, [job.payload.id]);
  if (!c || c.delivered_at) return;
  const written = DateTime.fromJSDate(new Date(c.created_at)).setZone(user.tz).toFormat("d LLLL yyyy");
  // The person set this up themselves, for this day: it comes like their own reminder. The words go inside a block so nothing reformats them.
  const ok = await push(deps, user, "reminder", `A letter from you, written on ${written}:\n\n\`\`\`\n${c.body.replace(/```/g, "'''")}\n\`\`\``, { exempt: true });
  if (ok) await deps.db.query(`UPDATE well_capsules SET delivered_at=now() WHERE id=$1`, [c.id]);
  else await schedule(deps.db, { userId: user.id, kind: "well_capsule", payload: { id: c.id }, runAt: new Date(Date.now() + 3 * 3_600_000) });
});

/* =====================================================================
 * 10. On this day
 * ===================================================================== */

/** Never grief, health, cycles, quitting or heartbreak, even in the person's own notes. */
const SENSITIVE = /\b(?:died|dead|death|passed|funeral|grave|grief|griev\w*|mourn\w*|condolence\w*|rip|cancer|tumou?r|diagnos\w*|hospital\w*|surgery|operation|doctor|clinic|sick|ill|illness|pain|symptom\w*|pills?|meds?|medication|therapy|therapist|depress\w*|anxiety|panic|period|cycle|pregnan\w*|miscarr\w*|fertility|ivf|quit|quitting|relapse\w*|slipped|sober|sobriety|rehab|smok\w*|drink\w*|betting|gambl\w*|divorce\w*|breakup|broke up|ex|no contact|fired|redundan\w*|debt|overdraft)\b/i;

export async function onThisDay(db: Db, user: User, now: Date): Promise<string | null> {
  const t = today(user, now);
  const md = t.toFormat("MM-dd");
  const names = (await db.query<{ who: string }>(`SELECT who FROM well_remembrance WHERE user_id=$1`, [user.id])).map((r) => r.who.toLowerCase());
  const safe = (s: string) => !SENSITIVE.test(s) && !names.some((n) => s.toLowerCase().includes(n));
  const years = (y: number) => (t.year - y === 1 ? "A year ago today" : `${t.year - y} years ago today`);
  const trips = await db.query<{ destination: string; y: number }>(
    `SELECT destination, extract(year from starts_on)::int AS y FROM trips WHERE user_id=$1 AND status<>'cancelled' AND starts_on IS NOT NULL AND extract(year from starts_on) < $2
       AND to_char(starts_on,'MM-DD') <= $3 AND to_char(COALESCE(ends_on, starts_on),'MM-DD') >= $3 AND extract(year from COALESCE(ends_on, starts_on)) = extract(year from starts_on) ORDER BY starts_on DESC LIMIT 3`, [user.id, t.year, md]);
  const notes = await db.query<{ text: string; y: number }>(`SELECT text, extract(year from created_at AT TIME ZONE $2)::int AS y FROM notes WHERE user_id=$1 AND to_char(created_at AT TIME ZONE $2,'MM-DD')=$3 AND extract(year from created_at AT TIME ZONE $2) < $4 ORDER BY id DESC LIMIT 5`, [user.id, user.tz, md, t.year]);
  const mems = await db.query<{ text: string; y: number }>(`SELECT fact AS text, extract(year from created_at AT TIME ZONE $2)::int AS y FROM memories WHERE user_id=$1 AND confirmed AND to_char(created_at AT TIME ZONE $2,'MM-DD')=$3 AND extract(year from created_at AT TIME ZONE $2) < $4 ORDER BY id DESC LIMIT 5`, [user.id, user.tz, md, t.year]);
  const options = [
    ...trips.filter((x) => safe(x.destination)).map((x) => `${years(x.y)} you were in ${x.destination.replace(/\b[a-z]/g, (c) => c.toUpperCase())}.`),
    ...notes.filter((x) => safe(x.text)).map((x) => `${years(x.y)} you noted: "${clip(x.text)}"`),
    ...mems.filter((x) => safe(x.text)).map((x) => `${years(x.y)} you told me ${clip(yours(x.text))}.`),
  ];
  return options.length ? options[t.ordinal % options.length] : null;
}
const clip = (s: string) => (s.length > 100 ? `${s.slice(0, 97).trimEnd()}...` : s);

const otdSettings = defineAction({
  name: "onthisday.settings",
  tier: 1,
  description: "Turn 'on this day' in the morning brief on or off: one gentle memory a day at most, from the person's own trips, notes and memories from a year or more ago.",
  schema: z.object({ on: z.boolean() }),
  async run(args, ctx) {
    await setWb(ctx.db, ctx.user, { otdOff: args.on ? null : true });
    return { reply: args.on ? "On this day is back in your morning brief, when there's something gentle to show." : "No more on this day in your brief. Say \"start on this day\" if you want it back." };
  },
});

const otdShow = defineAction({
  name: "onthisday.show",
  tier: 1,
  description: "Show today's 'on this day' memory, from the person's own trips, notes and confirmed memories a year or more ago.",
  schema: z.object({}),
  async run(_a, ctx) {
    return { reply: (await onThisDay(ctx.db, ctx.user, ctx.now)) ?? "Nothing from this day in earlier years yet. Notes, trips and things you tell me now become the memories later." };
  },
});

addBriefSection({
  key: "well_otd", order: 80,
  async lines(db, user, now) {
    if (wb(user).otdOff) return [];
    const s = await onThisDay(db, user, now);
    return s ? [s] : [];
  },
});

register(remAdd, remWords, remNotify, remList, capsuleAdd, capsuleList, otdSettings, otdShow);

/* ---------------- words ---------------- */

const DATE = String.raw`((?:\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?)(?:,?\s+\d{4})?)`;

addRules(
  // Things die too ("my phone died on 3 March", "the deadline passed on 4 June"): those are not losses to remember.
  [rx(String.raw`(?:my\s+)?(?!(?:the|a|an|my|our)?\s*(?:phone|laptop|battery|car|tv|computer|pc|plant|plants|deadline|offer|bill|exam|test|power|lights?|generator|engine|hard ?drive|printer|router|wifi|internet|dream|project|sale|deal|visa|card|account|app|game|show|series|vote|motion|law|bill|storm|fever|cold)s?\b)(.{1,30}?)\s+(?:passed away|passed|died|left us)\s+(?:on\s+)?${DATE}`), (m) => ({ action: "remembrance.add", args: { who: m[1], on: m[2], kind: "passing" } })],
  [rx(String.raw`(?:we|i) lost (?:my\s+|our\s+)?(.{1,30}?)\s+on\s+${DATE}`), (m) => ({ action: "remembrance.add", args: { who: m[1], on: m[2], kind: "passing" } })],
  [rx(String.raw`(?:remembrance(?: day)?|in memory(?: of)?|keep in remembrance)[:,]?\s+(?:my\s+)?(.{1,30}?)(?:'s)?\s+(birthday|day)?[,]?\s*(?:on\s+|is\s+)?${DATE}`), (m) => ({ action: "remembrance.add", args: { who: m[1], on: m[3], kind: m[2]?.toLowerCase() === "birthday" ? "birthday" : "day" } })],
  [rx(String.raw`(?:remembrance(?: day)?|in memory(?: of)?|keep in remembrance)[:,]?\s+${DATE}[,:]?\s+(?:for\s+)?(?:my\s+)?(.{1,30}?)(?:'s)?(?:\s+(birthday|day))?`), (m) => ({ action: "remembrance.add", args: { who: m[2], on: m[1], kind: m[3]?.toLowerCase() === "birthday" ? "birthday" : "day" } })],
  [rx(String.raw`(?:words|a message|my words) for (?:my\s+)?(.{1,30}?)(?:'s day)?\s*[:,-]\s*(.{1,500})`), (m) => ({ action: "remembrance.words", args: { who: m[1], words: m[2] } })],
  [rx(String.raw`(?:no message|don'?t (?:send|message) me|stop the message|no messages?) (?:for|about|on) (?:my\s+)?(.{1,30}?)(?:'s day)?`), (m) => ({ action: "remembrance.notify", args: { who: m[1], on: false } })],
  [rx(String.raw`(?:send me a (?:gentle )?message|message me) on (?:my\s+)?(.{1,30}?)(?:'s)? day`), (m) => ({ action: "remembrance.notify", args: { who: m[1], on: true } })],
  [rx(String.raw`(?:my )?remembrance(?: dates| days)?|(?:show )?(?:my )?remembrance list`), () => ({ action: "remembrance.list", args: {} })],

  [rx(String.raw`(?:send (?:this|it) to me|a letter to (?:myself|me|future me)|(?:a )?time capsule|a note to (?:myself|future me)|write to (?:myself|future me))\s+((?:in|on|for)\s+.{2,40}?|next year)\s*[:,-]\s*([\s\S]{1,4000})`), (m) => ({ action: "capsule.add", args: { when: m[1].replace(/^(?:on|for)\s+/i, ""), body: m[2] } })],
  [rx(String.raw`(?:a letter to (?:myself|me|future me)|(?:a )?time capsule|a note to (?:myself|future me)|write to (?:myself|future me))\s+((?:in|on|for)\s+.{2,40}?|next year)`), (m) => ({ action: "capsule.add", args: { when: m[1].replace(/^(?:on|for)\s+/i, "") } })],
  [rx(String.raw`(?:my )?(?:time capsules|sealed letters|letters to (?:myself|future me))`), () => ({ action: "capsule.list", args: {} })],

  [rx(String.raw`(stop|start|turn off|turn on|no more|pause|resume) (?:the )?on this day`), (m) => ({ action: "onthisday.settings", args: { on: /^(?:start|turn on|resume)$/i.test(m[1]) } })],
  [rx(String.raw`(?:what happened )?on this day|(?:show me )?on this day`), () => ({ action: "onthisday.show", args: {} })],
);

addExamples("remembrance.add", ["Dad passed on 4 June 2019", "remembrance: 12 August, Grandma's birthday", "in memory of Grandpa on 9 May", "we lost Mum on 3 March 2021"]);
addExamples("remembrance.words", ["words for Dad: you taught me to be brave"]);
addExamples("remembrance.notify", ["no message for Dad", "send me a message on Dad's day"]);
addExamples("remembrance.list", ["my remembrance dates"]);
addExamples("capsule.add", ["a letter to myself in 6 months: be proud of how far you've come", "time capsule for next year: did you start the band?", "send this to me in 2 years: hello future me"]);
addExamples("capsule.list", ["my time capsules"]);
addExamples("onthisday.settings", ["stop on this day", "start on this day"]);
addExamples("onthisday.show", ["on this day"]);

addCues("remembrance", ["passed away", "passed", "died", "lost my", "anniversary of", "remembrance", "in memory", "grief"]);
addCues("capsule", ["time capsule", "letter to myself", "future me", "future self"]);
addCues("onthisday", ["on this day", "a year ago", "memories"]);

addCapability({
  key: "remembrance", name: "Remembrance dates",
  cues: ["passed away", "remembrance", "anniversary of", "grief", "in memory"],
  what: "Keep the days that matter for someone you've lost, quietly. If you'd like, one gentle message on the day, in your own words.",
  say: ["Dad passed on 4 June 2019", "remembrance: 12 August, Grandma's birthday", "words for Dad: you taught me to be brave"],
  then: "Nothing is sent unless you ask, date by date. These days never appear in on this day, Wrapped or anything cheerful.",
}, "Body and mind");
addCapability({
  key: "time_capsule", name: "Time capsule",
  cues: ["time capsule", "letter to myself", "future me", "future self"],
  what: "Write to your future self. I keep it sealed and send it once, on the day you chose, exactly as you wrote it.",
  say: ["a letter to myself in 6 months: ...", "time capsule for my birthday: ...", "my time capsules"],
  then: "Your letter stays sealed; even the list shows only the dates.",
}, "Your day");
addCapability({
  key: "on_this_day", name: "On this day",
  cues: ["on this day", "a year ago today", "memories"],
  what: "Some mornings, one gentle memory in your brief from a year or more ago: a trip, a note, something you told me.",
  say: ["on this day", "stop on this day"],
  then: "Never anything about grief, health, your cycle or quitting.",
}, "Your day");
