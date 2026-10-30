/**
 * Releases and drops: "releasing my single Lagos Nights on 12 Dec" builds a backward checklist with
 * dates (music, books, NFT collections and a generic plan for shows, films, zines and the rest),
 * ticked off in words or with a button, with a brief line when a step is due.
 * Practice time: "drew for 45 minutes", "wrote 800 words", weekly totals and a kind run where one
 * rest day a week never breaks it, and streak freezes cover a missed day (the same rules as streakOf in src/modules/life.ts). No shame, ever.
 */
import { z } from "zod";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import type { Db } from "../../../core/db.js";
import { streakNote, streakOf } from "../../life.js";
import { addBriefItems, addCrButton, addDays, addPinger, byName, cap, clean, daysTo, ensureDaily, parseDay, refuseSecret, sayDay, shortDay, todayOf } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS crt_releases (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), title TEXT NOT NULL, kind TEXT NOT NULL, on_date DATE NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS crt_release_steps (id SERIAL PRIMARY KEY, release_id INT NOT NULL REFERENCES crt_releases(id) ON DELETE CASCADE, user_id INT NOT NULL REFERENCES users(id), label TEXT NOT NULL, due DATE NOT NULL, ord INT NOT NULL, done_on DATE);
CREATE TABLE IF NOT EXISTS crt_practice (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), activity TEXT NOT NULL, minutes INT, words INT, day DATE NOT NULL, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS crt_practice_user ON crt_practice (user_id, day)`);

/* =====================================================================
 * 7. Release and drop planner
 * ===================================================================== */

type Kind = "music" | "book" | "nft" | "other";
/** "for shopping", "for tomorrow", "for my boss": a list, a day or a person, not a release. */
const NOT_RELEASE = /^(?:the\s+|my\s+|our\s+)?(?:shopping|groceries|todo|to-?do|list|tomorrow|today|tonight|morning|evening|work|school|class|boss|manager|team|client|mum|mom|dad|kids|family|week|weekend|meeting|exam|test|homework|dinner|lunch|breakfast|party|trip|holiday)\b/i;
const tick = (step: string, title: string) => (NOT_RELEASE.test(title.trim()) ? null : { action: "release.tick", args: { step, title } });
/** Days before (negative) or after release day, and the step. Generic across countries and platforms. */
const PLANS: Record<Kind, [number, string][]> = {
  music: [[-35, "artwork done"], [-28, "upload to your distributor (4 weeks ahead leaves time for editorial pitching)"], [-21, "pitch to playlist editors"], [-21, "pre-save link live"], [-10, "teaser clip out"], [-7, "announce the date"], [0, "release day: share the link everywhere"], [2, "thank-you post"]],
  book: [[-60, "cover final"], [-45, "advance copies to reviewers"], [-30, "pre-order page live"], [-21, "announce the launch"], [-14, "launch event planned"], [-3, "reminder post"], [0, "launch day"], [3, "thank-you post"]],
  nft: [[-21, "art final"], [-14, "contract and metadata checked on a testnet"], [-10, "allowlist open"], [-7, "announce the date and price"], [-3, "allowlist closes"], [-1, "official mint link shared from your own accounts"], [0, "mint day"], [2, "reveal"]],
  other: [[-21, "final work done"], [-14, "announce it"], [-7, "teaser out"], [-1, "reminder post"], [0, "launch day"], [2, "thank-you post"]],
};
export const STEP_WORD: Record<string, string> = { artwork: "artwork", upload: "upload", distributor: "upload", pitch: "pitch", presave: "pre-save", "pre-save": "pre-save", teaser: "teaser", announce: "announce", cover: "cover", reviewers: "advance copies", arc: "advance copies", "pre-order": "pre-order", preorder: "pre-order", contract: "contract", metadata: "contract", allowlist: "allowlist", art: "art final", reveal: "reveal" };

export function kindOf(word?: string | null): Kind {
  const w = (word ?? "").toLowerCase();
  if (/single|ep\b|album|mixtape|track|song|record|lp\b|beat tape/.test(w)) return "music";
  if (/book|novel|memoir|poetry collection|anthology|comic|graphic novel/.test(w)) return "book";
  if (/nft|drop|pfp|generative|1\/1|edition/.test(w)) return "nft";
  return "other";
}

interface Step { id: number; release_id: number; label: string; due: string; ord: number; done_on: string | null; title?: string }
interface Rel { id: number; title: string; kind: Kind; on_date: string }
const relsOf = (db: Db, userId: number) => db.query<Rel>(`SELECT id, title, kind, to_char(on_date, 'YYYY-MM-DD') AS on_date FROM crt_releases WHERE user_id=$1 AND active ORDER BY on_date`, [userId]);
const stepsOf = (db: Db, releaseId: number) => db.query<Step>(`SELECT id, release_id, label, to_char(due, 'YYYY-MM-DD') AS due, ord, to_char(done_on, 'YYYY-MM-DD') AS done_on FROM crt_release_steps WHERE release_id=$1 ORDER BY due, ord`, [releaseId]);
const short = (label: string) => label.replace(/\s*\(.*\)$/, "");

const releaseAdd = defineAction({
  name: "release.add",
  tier: 1,
  description: "Plan a release or launch backwards from its date with a dated checklist: music (single, EP, album), a book, an NFT collection drop, or anything else (a show, film, zine, podcast). Steps already in the past are set for today. Saying the same title again moves the date.",
  schema: z.object({ title: z.string().min(1).max(100), kind: z.string().max(40).optional(), date: z.string().min(1).max(60) }),
  async run(a, ctx) {
    const bad = refuseSecret(a.title);
    if (bad) throw new Error(bad);
    const on = parseDay(a.date, ctx.user, ctx.now);
    if (!on) throw new Error(`I couldn't read a date in "${a.date}". When does it come out?`);
    const today = todayOf(ctx.user, ctx.now);
    if (on < today) throw new Error("That date has already passed. When does it come out?");
    const kind = kindOf(a.kind ?? a.title);
    const title = /^your\s/i.test(a.title.trim()) ? cap(a.title.trim()) : cap(clean(a.title));
    const prev = (await relsOf(ctx.db, ctx.user.id)).find((r) => r.title.toLowerCase() === title.toLowerCase());
    const doneBefore = prev ? new Set((await stepsOf(ctx.db, prev.id)).filter((s) => s.done_on).map((s) => s.label)) : new Set<string>();
    if (prev) await ctx.db.query(`UPDATE crt_releases SET active=false WHERE id=$1`, [prev.id]);
    const id = (await ctx.db.one<{ id: number }>(`INSERT INTO crt_releases (user_id, title, kind, on_date) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.user.id, title, kind, on]))!.id;
    let squeezed = 0;
    for (const [i, [off, label]] of PLANS[kind].entries()) {
      let due = addDays(on, off);
      if (due < today) { due = today; squeezed++; }
      await ctx.db.query(`INSERT INTO crt_release_steps (release_id, user_id, label, due, ord, done_on) VALUES ($1,$2,$3,$4,$5,$6)`, [id, ctx.user.id, label, due, i, doneBefore.has(label) ? today : null]);
    }
    await ensureDaily(ctx.db, ctx.user);
    const steps = await stepsOf(ctx.db, id);
    const lines = steps.map((s) => `- ${shortDay(s.due)}: ${s.label}${s.done_on ? " (done)" : ""}`);
    const tight = squeezed ? ` ${squeezed === 1 ? "One step is" : `${squeezed} steps are`} already due, so ${squeezed === 1 ? "it's" : "they're"} set for today; do what fits and skip the rest.` : "";
    return {
      reply: [`${title}, out ${sayDay(on, ctx.user, ctx.now)}. Your plan:`, ...lines, "", `I'll put each step in your brief on its day.${tight} Say "tick ${short(steps.find((s) => !s.done_on)?.label ?? "artwork").split(" ")[0]} for ${title}" as you go.`].join("\n"),
      undo: { payload: { id, prev: prev?.id ?? null } },
    };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM crt_releases WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    if (p.prev) await ctx.db.query(`UPDATE crt_releases SET active=true WHERE id=$1 AND user_id=$2`, [p.prev, ctx.user.id]);
    return "Plan taken back.";
  },
});

async function tickStep(db: Db, userId: number, stepId: number, today: string): Promise<string> {
  const s = await db.one<Step & { title: string; on_date: string }>(`SELECT s.id, s.label, r.title, to_char(r.on_date, 'YYYY-MM-DD') AS on_date, s.release_id FROM crt_release_steps s JOIN crt_releases r ON r.id=s.release_id WHERE s.id=$1 AND s.user_id=$2`, [stepId, userId]);
  if (!s) return "That step isn't there any more. Say \"my releases\" to see your plans.";
  await db.query(`UPDATE crt_release_steps SET done_on=$2 WHERE id=$1`, [stepId, today]);
  const next = (await stepsOf(db, s.release_id)).find((x) => !x.done_on);
  return `${s.title}: ${short(s.label)}, ticked.${next ? ` Next: ${short(next.label)}, ${next.due <= today ? "today" : `by ${shortDay(next.due)}`}.` : " That's the whole plan."}`;
}

const releaseTick = defineAction({
  name: "release.tick",
  tier: 1,
  description: "Tick off a step of a release plan ('artwork', 'upload', 'teaser', 'announce', 'allowlist'...). `title` picks the release when there's more than one.",
  schema: z.object({ step: z.string().min(1).max(80), title: z.string().max(100).optional() }),
  async run(a, ctx) {
    const rels = await relsOf(ctx.db, ctx.user.id);
    if (!rels.length) throw new Error("You don't have a release plan yet. Say \"releasing my single Lagos Nights on 12 Dec\" to make one.");
    const pick = a.title ? byName(rels, ["title"], a.title) : rels;
    if (a.title && !pick.length) throw new Error(`I don't have a release called ${clean(a.title)}. Say "my releases" to see them.`);
    const w = clean(a.step).toLowerCase();
    const word = STEP_WORD[w] ?? w;
    for (const r of pick) {
      const steps = (await stepsOf(ctx.db, r.id)).filter((s) => !s.done_on);
      const s = steps.find((x) => x.label.toLowerCase().startsWith(word)) ?? steps.find((x) => x.label.toLowerCase().includes(word));
      if (s) return { reply: await tickStep(ctx.db, ctx.user.id, s.id, todayOf(ctx.user, ctx.now)), undo: { payload: { id: s.id } } };
    }
    throw new Error(`I couldn't find a step like "${clean(a.step)}"${pick.length === 1 ? ` for ${pick[0].title}` : ""}. Say "my releases" to see the steps.`);
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE crt_release_steps SET done_on=NULL WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Unticked."; },
});

const releaseList = defineAction({
  name: "release.list",
  tier: 1,
  description: "Show the person's release and launch plans with each step's date and what's done.",
  schema: z.object({ title: z.string().max(100).optional() }),
  async run(a, ctx) {
    let rels = await relsOf(ctx.db, ctx.user.id);
    if (a.title) rels = byName(rels, ["title"], a.title);
    if (!rels.length) return { reply: a.title ? `I don't have a release called ${clean(a.title)}.` : "No release plans yet. Say \"releasing my single Lagos Nights on 12 Dec\" or \"my book launches 3 March\" and I'll plan it backwards from the date." };
    const out: string[] = [];
    for (const r of rels.slice(0, 3)) {
      const steps = await stepsOf(ctx.db, r.id);
      const left = steps.filter((s) => !s.done_on).length;
      out.push(`**${r.title}**, out ${sayDay(r.on_date, ctx.user, ctx.now)}: ${left ? `${left} of ${steps.length} steps to go` : "every step done"}`);
      out.push(...steps.map((s) => `- ${shortDay(s.due)}: ${short(s.label)}${s.done_on ? " (done)" : ""}`));
    }
    return { reply: out.join("\n") };
  },
});

addCrButton("rs", async (ctx, [id]) => ({ text: await tickStep(ctx.db, ctx.user.id, Number(id), todayOf(ctx.user, ctx.now)) }));

async function dueSteps(db: Db, userId: number, today: string): Promise<Step[]> {
  return db.query<Step>(`SELECT s.id, s.release_id, s.label, to_char(s.due, 'YYYY-MM-DD') AS due, s.ord, r.title FROM crt_release_steps s JOIN crt_releases r ON r.id=s.release_id WHERE s.user_id=$1 AND r.active AND s.done_on IS NULL AND s.due <= $2::date AND r.on_date >= $2::date - 7 ORDER BY s.due, s.ord`, [userId, today]);
}
addPinger("releases", async (db, user, today) => {
  const due = (await dueSteps(db, user.id, today)).filter((s) => s.due === today);
  if (!due.length) return [];
  const s = due[0];
  const more = due.length > 1 ? ` (and ${due.length - 1} more step${due.length > 2 ? "s" : ""})` : "";
  return [{ key: `rs:${s.id}:${today}`, text: `${s.title}: ${short(s.label)} is due today${more}.`, button: { label: `Done: ${short(s.label)}`.slice(0, 30), data: `cr:rs:${s.id}` } }];
});
addBriefItems(async (db, user, now) => {
  const today = todayOf(user, now);
  const due = await dueSteps(db, user.id, today);
  if (!due.length) return [];
  const by = new Map<string, Step[]>();
  for (const s of due) by.set(s.title!, [...(by.get(s.title!) ?? []), s]);
  return [...by].map(([t, ss]) => ({ p: 12, text: `${t}: ${ss.slice(0, 2).map((s) => short(s.label)).join(" and ")}${ss.length > 2 ? ` and ${ss.length - 2} more` : ""} ${ss.some((s) => s.due < today) ? "still to do" : "due today"}` }));
});

/* =====================================================================
 * 9. Practice time
 * ===================================================================== */

const VERB: Record<string, string> = {
  drew: "drawing", sketched: "sketching", painted: "painting", inked: "inking", sculpted: "sculpting", wrote: "writing", journaled: "journaling", journalled: "journaling",
  composed: "composing", produced: "producing", recorded: "recording", edited: "editing", designed: "design", animated: "animation", knitted: "knitting", crocheted: "crochet",
  sewed: "sewing", sewn: "sewing", danced: "dance", sang: "singing", rehearsed: "rehearsal", practised: "practice", practiced: "practice", played: "practice", shot: "shooting", photographed: "photography", modelled: "modelling", modeled: "modelling", beatboxed: "beatboxing",
};
/** "45 minutes", "2 hours", "1h30", "an hour", "half an hour", "1.5 hrs", "90 min". */
export function minutesOf(text: string): number | null {
  const t = text.toLowerCase().trim();
  if (/^(?:an?|one) hour$/.test(t)) return 60;
  if (/^half an hour$/.test(t)) return 30;
  if (/^(?:an?|one) hour and a half$/.test(t)) return 90;
  const m = /^(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)(?:\s*(?:and\s*)?(\d{1,2})\s*(?:m|mins?|minutes?)?)?$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60 + Number(m[2] ?? 0));
  const n = /^(\d{1,4})\s*(?:m|mins?|minutes?)$/.exec(t);
  return n ? Number(n[1]) : null;
}
const DUR = "((?:\\d+(?:\\.\\d+)?\\s*(?:h|hrs?|hours?)(?:\\s*(?:and\\s*)?\\d{1,2}\\s*(?:m|mins?|minutes?)?)?)|(?:\\d{1,4}\\s*(?:m|mins?|minutes?))|(?:an?|one) hour(?: and a half)?|half an hour)";
const hm = (mins: number) => { const h = Math.floor(mins / 60), m = mins % 60; return h ? `${h} hour${h === 1 ? "" : "s"}${m ? ` ${m} minutes` : ""}` : `${m} minute${m === 1 ? "" : "s"}`; };

const practiceLog = defineAction({
  name: "practice.log",
  tier: 1,
  description: "Log creative practice time or output: drawing, painting, writing, an instrument, dance, singing, design, editing and so on, in minutes, or words written. Shows the week so far and a kind run (one rest day a week keeps it going).",
  schema: z.object({ activity: z.string().min(1).max(60), minutes: z.number().int().min(1).max(1440).optional(), words: z.number().int().min(1).max(200_000).optional(), day: z.enum(["today", "yesterday"]).optional() }),
  async run(a, ctx) {
    if (!a.minutes && !a.words) throw new Error("How long, or how many words? Say it like \"drew for 45 minutes\" or \"wrote 800 words\".");
    const when = a.day === "yesterday" ? new Date(ctx.now.getTime() - 86_400_000) : ctx.now;
    const day = todayOf(ctx.user, when);
    const activity = clean(a.activity).toLowerCase();
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO crt_practice (user_id, activity, minutes, words, day) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.user.id, activity, a.minutes ?? null, a.words ?? null, day]);
    const s = await summary(ctx.db, ctx.user.id, todayOf(ctx.user, ctx.now));
    const what = a.words ? `${a.words.toLocaleString("en-US")} words of ${activity}` : `${hm(a.minutes!)} of ${activity}`;
    return { reply: `${cap(what)}, logged. ${s.line}`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM crt_practice WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Taken back."; },
});

/** This week (the last 7 days) and the run, said kindly. */
async function summary(db: Db, userId: number, today: string): Promise<{ line: string; minutes: number; words: number; days: number; run: number }> {
  const week = await db.query<{ minutes: number | null; words: number | null; day: string; activity: string }>(`SELECT minutes, words, to_char(day, 'YYYY-MM-DD') AS day, activity FROM crt_practice WHERE user_id=$1 AND day > $2::date - 7 AND day <= $2::date`, [userId, today]);
  const days = (await db.query<{ day: string }>(`SELECT DISTINCT to_char(day, 'YYYY-MM-DD') AS day FROM crt_practice WHERE user_id=$1 AND day <= $2::date ORDER BY day DESC LIMIT 800`, [userId, today])).map((r) => r.day);
  const minutes = week.reduce((s, r) => s + (r.minutes ?? 0), 0);
  const words = week.reduce((s, r) => s + (r.words ?? 0), 0);
  const nDays = new Set(week.map((r) => r.day)).size;
  const st = days.includes(today) ? streakOf(days, today) : null;
  const totals = [minutes ? hm(minutes) : "", words ? `${words.toLocaleString("en-US")} words` : ""].filter(Boolean).join(" and ");
  const run = st && st.run >= 2 ? ` ${st.run} days running.${streakNote(st)}` : "";
  return { line: `This week: ${totals} across ${nDays === 1 ? "1 day" : `${nDays} days`}.${run}`, minutes, words, days: nDays, run: st?.run ?? 0 };
}

const practiceShow = defineAction({
  name: "practice.show",
  tier: 1,
  description: "Show the person's creative practice for the last 7 days: total time and words, by activity, and their run.",
  schema: z.object({}),
  async run(_a, ctx) {
    const today = todayOf(ctx.user, ctx.now);
    const rows = await ctx.db.query<{ activity: string; minutes: string | null; words: string | null }>(`SELECT activity, sum(minutes)::text AS minutes, sum(words)::text AS words FROM crt_practice WHERE user_id=$1 AND day > $2::date - 7 AND day <= $2::date GROUP BY activity ORDER BY sum(coalesce(minutes,0)) DESC`, [ctx.user.id, today]);
    if (!rows.length) return { reply: "Nothing logged in the last week, and that's fine. Whenever you make something, say \"drew for 20 minutes\" or \"wrote 500 words\" and I'll keep count." };
    const s = await summary(ctx.db, ctx.user.id, today);
    const lines = rows.map((r) => `- ${cap(r.activity)}: ${[Number(r.minutes) ? hm(Number(r.minutes)) : "", Number(r.words) ? `${Number(r.words).toLocaleString("en-US")} words` : ""].filter(Boolean).join(", ")}`);
    return { reply: [s.line, ...lines].join("\n") };
  },
});

register(releaseAdd, releaseTick, releaseList, practiceLog, practiceShow);

/* ---------------- words ---------------- */

const RKIND = "(single|ep|album|mixtape|beat tape|track|song|record|lp|book|novel|memoir|poetry collection|comic|graphic novel|zine|nft collection|nft drop|nft|collection|pfp collection|drop|film|short film|documentary|music video|video|podcast|game|show|exhibition|solo show|play|photo book|photobook|clothing line|collection drop)";
const RDATE = "((?=.*?(?:\\d|\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|next|tomorrow|mon|tue|wed|thu|fri|sat|sun)[a-z]*\\b)).+)";
const relRule = (m: RegExpMatchArray, kindAt: number, titleAt: number, dateAt: number) => {
  const kind = m[kindAt];
  const t = (m[titleAt] ?? "").trim();
  const shown = kind.toLowerCase().replace(/\bnft\b/, "NFT").replace(/^(ep|lp)$/, (x) => x.toUpperCase());
  return { action: "release.add", args: { title: t || `your ${shown}`, kind, date: m[dateAt] } };
};
const PRACTICE_VERBS = "drew|sketched|painted|inked|sculpted|wrote|journall?ed|composed|produced|recorded|edited|designed|animated|knitted|crocheted|sewed|sewn|danced|sang|rehearsed|practi[sc]ed|beatboxed|photographed";
const INSTRUMENTS = "guitar|piano|keys|keyboard|drums|violin|viola|bass|sax|saxophone|cello|flute|trumpet|trombone|ukulele|uke|kora|talking drum|djembe|organ|harp|clarinet|oboe|mandolin|banjo|sitar|tabla|oud|erhu|gayageum|berimbau|cavaquinho|accordion";
addRules(
  [new RegExp(`^(?:i'?m\\s+|we'?re\\s+|i\\s+am\\s+)?(?:releasing|dropping|launching|publishing|putting out|premiering|opening)\\s+(?:my\\s+|our\\s+|the\\s+)?(?:new\\s+|debut\\s+|first\\s+)?${RKIND}(?:\\s+(?!on\\b|in\\b)(.+?))?\\s+(?:on|in|for)\\s+${RDATE}$`, "i"), (m) => relRule(m, 1, 2, 3)],
  [new RegExp(`^(?:my|our)\\s+(?:new\\s+|debut\\s+|first\\s+)?${RKIND}(?:\\s+(?!launches|comes|drops|releases|is|goes|premieres|opens)(.+?))?\\s+(?:launches|comes out|drops|releases|is out|is released|goes live|premieres|opens)\\s+(?:on\\s+)?${RDATE}$`, "i"), (m) => relRule(m, 1, 2, 3)],
  [/^(?:tick|ticked|done)\s+(?:off\s+)?(?!with\b)(?:the\s+)?(.+?)\s+(?:for|on)\s+(?!(?:\d|an?\s+hour|half|today|yesterday))(.+?)$/i, (m) => tick(m[1], m[2])],
  [/^mark\s+(?:off\s+)?(?:the\s+)?(.+?)\s+(?:for|on)\s+(.+?)\s+as\s+done$/i, (m) => ({ action: "release.tick", args: { step: m[1], title: m[2] } })],
  [/^(.+?)\s+(?:is\s+)?done\s+for\s+(?!(?:\d|an?\s+hour|today|yesterday))(.+)$/i, (m) => (/^(?:homework|the report|report|laundry|dishes|cleaning|work|it|that|this|everything)\b/i.test(m[1].trim()) ? null : tick(m[1], m[2]))],
  [/^(?:my\s+|show\s+my\s+)?(?:releases|release plans?|launch plans?|drop plans?)$|^(?:release|launch)\s+plan\s+for\s+(.+)$/i, (m) => ({ action: "release.list", args: m[1] ? { title: m[1] } : {} })],

  [new RegExp(`^(?:i\\s+)?(?:just\\s+)?(${PRACTICE_VERBS})(?:\\s+(?!for\\b)(.+?))?\\s+for\\s+${DUR}(?:\\s+(today|yesterday))?$`, "i"), (m) => {
    const v = m[1].toLowerCase();
    const obj = (m[2] ?? "").replace(/^(?:my|the|some|a|an)\s+/i, "").trim();
    const activity = /^practi[sc]ed$/.test(v) && obj ? obj : v === "rehearsed" ? "rehearsal" : obj && !/^(?:it|stuff|things)$/i.test(obj) && !/^(?:drew|sketched|painted|sang|danced)$/.test(v) ? `${VERB[v] ?? v} ${obj}`.replace(/^(\w+) (?:on |the )/, "$1 ") : VERB[v] ?? v;
    return { action: "practice.log", args: { activity, minutes: minutesOf(m[3]) ?? 0, ...(m[4] ? { day: m[4].toLowerCase() } : {}) } };
  }],
  [new RegExp(`^(?:i\\s+)?(?:just\\s+)?played\\s+(?:the\\s+|my\\s+)?(${INSTRUMENTS})\\s+for\\s+${DUR}(?:\\s+(today|yesterday))?$`, "i"), (m) => ({ action: "practice.log", args: { activity: m[1].toLowerCase(), minutes: minutesOf(m[2]) ?? 0, ...(m[3] ? { day: m[3].toLowerCase() } : {}) } })],
  [/^(?:i\s+)?(?:just\s+)?wrote\s+([\d,]+|\d+(?:\.\d)?k)\s+words(?:\s+(?:of|for|on|in)\s+(?:my\s+|the\s+)?(.+?))?(?:\s+(today|yesterday))?$/i, (m) => {
    const raw = m[1].replace(/,/g, "");
    return { action: "practice.log", args: { activity: m[2] ? `writing ${m[2]}` : "writing", words: /k$/i.test(raw) ? Math.round(Number(raw.slice(0, -1)) * 1000) : Number(raw), ...(m[3] ? { day: m[3].toLowerCase() } : {}) } };
  }],
  [/^(?:my\s+|show\s+my\s+)?(?:practice|practice time|creative time|studio time)(?:\s+this\s+week)?$|^how much (?:have i|did i) (?:practi[sc]ed?|drawn|painted|written|made art)(?:\s+this\s+week)?\??$/i, () => ({ action: "practice.show", args: {} })],
);

addExamples("release.add", ["releasing my single Lagos Nights on 12 Dec", "my book launches 3 March", "dropping my NFT collection on 20 Jan", "I'm premiering my short film Danfo on 30 Jan", "our EP Seoul Summer comes out on 14 Feb"]);
addExamples("release.tick", ["tick artwork for Lagos Nights", "upload done for Lagos Nights", "mark the teaser for Lagos Nights as done"]);
addExamples("release.list", ["my releases", "release plan for Lagos Nights"]);
addExamples("practice.log", ["drew for 45 minutes", "wrote 800 words", "practised guitar for 30 min", "painted for 2 hours yesterday", "played the kora for an hour", "sketched for 20 mins", "wrote 1.5k words of my novel"]);
addExamples("practice.show", ["my practice this week", "how much have I practised this week"]);

addCues("release", ["releasing", "release", "launch", "launches", "dropping", "single", "ep", "album", "book launch", "pre-save", "distributor", "release plan", "tick"]);
addCues("practice", ["drew", "painted", "sketched", "wrote", "words", "practised", "practiced", "rehearsed", "practice", "minutes", "studio time"]);

addCapability({
  key: "releases", name: "Releases and practice",
  cues: ["release", "releasing", "launch", "single", "album", "ep", "book launch", "drop", "pre-save", "practice", "drew", "wrote", "words", "practised"],
  what: "Tell me a release date and I plan it backwards: for music, artwork, the upload to your distributor about 4 weeks ahead for editorial pitching, the pre-save, teaser and announcement; for a book, cover, advance copies and pre-orders; for an NFT drop, art, contract checks, allowlist, mint day and reveal. Each step shows in your brief on its day. Log practice in plain words and I keep the week's total and a kind run, where a rest day a week never breaks it.",
  say: ["releasing my single Lagos Nights on 12 Dec", "my book launches 3 March", "dropping my NFT collection on 20 Jan", "tick artwork for Lagos Nights", "drew for 45 minutes", "wrote 800 words", "practised guitar for 30 min"],
  then: "Release steps go in the brief, with at most one creative ping a day for a step due. Practice never nags.",
}, "Creative and NFTs");

export const _test = { PLANS };
