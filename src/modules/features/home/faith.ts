/**
 * Faith rhythms, only for people who ask, any faith or none. Prayer times from Aladhan for the person's
 * city; Fajr-to-Isha reminders they choose; suhoor and iftar in Ramadan when they ask; and plain reminders
 * for any practice they describe ("Sunday service at 10", "Shabbat candle lighting Friday sunset",
 * "daily devotional at 6am"), with sunrise and sunset from Open-Meteo. Nothing here assumes a religion.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import type { Db } from "../../../core/db.js";
import type { Place } from "../../../core/geo.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema, addSystemJob } from "../../../core/plugins.js";
import { onJob, push, schedule } from "../../../core/scheduler.js";
import { localDay, parseClock } from "../../../core/time.js";
import { andList, cacheGet, cached, cap, getJson, homePlace, homePrefs, local, setHome, usersIn } from "./util.js";

addSchema(`CREATE TABLE IF NOT EXISTS home_faith (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, label TEXT NOT NULL, spec JSONB NOT NULL DEFAULT '{}'::jsonb, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS home_faith_plans (user_id INT NOT NULL REFERENCES users(id), day TEXT NOT NULL, PRIMARY KEY (user_id, day))`);

export const PRAYERS = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"] as const;
const PRAYER_ALIAS: Record<string, string> = { fajr: "Fajr", subh: "Fajr", dhuhr: "Dhuhr", zuhr: "Dhuhr", duhr: "Dhuhr", asr: "Asr", maghrib: "Maghrib", isha: "Isha", ishaa: "Isha" };
const LEAD_WORDS = /\b(?:service|mass|church|jumu'?ah|jummah|synagogue|temple|gurdwara|fellowship|bible study|candle)/i;
interface Item { id: number; kind: "prayer" | "ramadan" | "practice"; label: string; spec: any }
interface Timings { times: Record<string, string>; hijriMonth: number | null; tz: string }

/* ---------------- sources ---------------- */

/** Aladhan's timings for a day at a place: GET /v1/timings/{DD-MM-YYYY}?latitude=&longitude=. */
export async function prayerTimes(db: Db, place: Place, day: DateTime, user?: User): Promise<Timings | null> {
  const date = day.setZone(place.tz).toFormat("dd-MM-yyyy");
  const method = user ? homePrefs(user).prayerMethod : undefined;
  const key = `aladhan:${place.lat.toFixed(3)},${place.lon.toFixed(3)}:${date}:${method ?? ""}`;
  return cached<Timings>(db, key, 3 * 86_400_000, async () => {
    const r = await getJson(`https://api.aladhan.com/v1/timings/${date}?latitude=${place.lat}&longitude=${place.lon}${method !== undefined ? `&method=${Number(method)}` : ""}`);
    const t = r?.data?.data?.timings;
    if (!t || r!.status >= 400) return null;
    const times: Record<string, string> = {};
    for (const k of ["Imsak", "Fajr", "Sunrise", "Dhuhr", "Asr", "Sunset", "Maghrib", "Isha"]) if (typeof t[k] === "string") times[k] = t[k].slice(0, 5);
    return { times, hijriMonth: Number(r!.data.data.date?.hijri?.month?.number) || null, tz: r!.data.data.meta?.timezone || place.tz };
  });
}

/** Open-Meteo's sunrise and sunset for a day at a place (local clock times). */
export async function sunTimes(db: Db, place: Place, day: DateTime): Promise<{ sunrise: string; sunset: string } | null> {
  const iso = day.setZone(place.tz).toISODate()!;
  const all = await cached<Record<string, { sunrise: string; sunset: string }>>(db, `sun:${place.lat.toFixed(2)},${place.lon.toFixed(2)}:${iso}`, 2 * 86_400_000, async () => {
    const r = await getJson(`https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}&daily=sunrise,sunset&timezone=auto&forecast_days=7`);
    const d = r?.data?.daily;
    if (!d?.time || r!.status >= 400) return null;
    const out: Record<string, { sunrise: string; sunset: string }> = {};
    d.time.forEach((t: string, i: number) => { out[t] = { sunrise: String(d.sunrise[i]).slice(11, 16), sunset: String(d.sunset[i]).slice(11, 16) }; });
    return out;
  });
  return all?.[iso] ?? null;
}

const at = (day: DateTime, hhmm: string, tz: string) => { const [h, m] = hhmm.split(":").map(Number); return day.setZone(tz).set({ hour: h, minute: m, second: 0, millisecond: 0 }); };

/* ---------------- planning a day ---------------- */

async function items(db: Db, userId: number): Promise<Item[]> {
  return (await db.query<any>(`SELECT id, kind, label, spec FROM home_faith WHERE user_id=$1 AND active ORDER BY id`, [userId])).map((r) => ({ ...r, spec: typeof r.spec === "string" ? JSON.parse(r.spec) : r.spec }));
}

/** Today's pings for one person, scheduled as one-off jobs. Returns false when a source couldn't be reached (the hourly job tries again). */
export async function planDay(db: Db, user: User, now: Date): Promise<{ ok: boolean; timings: Timings | null; place: Place | null }> {
  const list = await items(db, user.id);
  const place = await homePlace(db, user);
  const today = local(now, user.tz);
  let ok = true;
  const needsPrayer = list.some((i) => i.kind !== "practice");
  const timings = needsPrayer && place ? await prayerTimes(db, place, today, user) : null;
  if (needsPrayer && !timings) ok = false;
  const pings: { at: DateTime; text: string; item: number; stop: string }[] = [];
  for (const it of list) {
    if (it.kind === "prayer" && timings) {
      for (const p of (it.spec.prayers?.length ? it.spec.prayers : PRAYERS) as string[]) if (timings.times[p]) pings.push({ at: at(today, timings.times[p], timings.tz), text: `${p}, ${timings.times[p]}.`, item: it.id, stop: "stop the prayer reminders" });
    }
    if (it.kind === "ramadan" && timings && timings.hijriMonth === 9) {
      const fajr = timings.times.Fajr, mag = timings.times.Maghrib;
      if (fajr) pings.push({ at: at(today, fajr, timings.tz).minus({ minutes: 45 }), text: `Suhoor: Fajr is at ${fajr}, about 45 minutes from now.`, item: it.id, stop: "stop the ramadan reminders" });
      if (mag) pings.push({ at: at(today, mag, timings.tz), text: `Iftar time, Maghrib ${mag}.`, item: it.id, stop: "stop the ramadan reminders" });
    }
    if (it.kind === "practice" && (it.spec.days ?? [1, 2, 3, 4, 5, 6, 7]).includes(today.weekday)) {
      let base: DateTime | null = null;
      if (it.spec.time) base = at(today, it.spec.time, user.tz);
      else if (it.spec.anchor && place) {
        const sun = await sunTimes(db, place, today);
        if (sun) base = at(today, it.spec.anchor === "sunrise" ? sun.sunrise : sun.sunset, place.tz).plus({ minutes: Number(it.spec.offset ?? 0) });
        else ok = false;
      }
      if (base) {
        const lead = Number(it.spec.lead ?? 0);
        const when = base.setZone(user.tz).toFormat("HH:mm");
        pings.push({ at: base.minus({ minutes: lead }), text: lead ? `${it.label} at ${when}, in ${lead} minutes.` : `${it.label}, ${when}.`, item: it.id, stop: `stop the ${it.label.toLowerCase()} reminder` });
      }
    }
  }
  await db.query(`UPDATE jobs SET active=false WHERE user_id=$1 AND kind='home_faith_ping' AND active AND run_at > $2`, [user.id, now]);
  for (const p of pings) if (p.at.toJSDate() > now) await schedule(db, { userId: user.id, kind: "home_faith_ping", runAt: p.at.toJSDate(), payload: { text: p.text, item: p.item, stop: p.stop } });
  if (ok) await db.query(`INSERT INTO home_faith_plans (user_id, day) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, localDay(now, user.tz)]);
  return { ok, timings, place };
}

onJob("home_faith_ping", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  if (!(await deps.db.one(`SELECT 1 FROM home_faith WHERE id=$1 AND active`, [job.payload.item]))) return;
  const hinted = homePrefs(user).faithHinted === true;
  // The person set these themselves, like a reminder: they come through quiet days, and the first one says how to stop them.
  const ok = await push(deps, user, "reminder", `${job.payload.text}${hinted ? "" : ` Say "${job.payload.stop}" to turn these off.`}`, { exempt: true });
  if (ok && !hinted) await setHome(deps.db, user, { faithHinted: true });
});

addSystemJob("home_faith", "11 * * * *");
onJob("home_faith", async (_job, deps) => {
  const now = new Date();
  for (const user of await usersIn(deps.db, `SELECT DISTINCT user_id FROM home_faith WHERE active`)) {
    if (await deps.db.one(`SELECT 1 FROM home_faith_plans WHERE user_id=$1 AND day=$2`, [user.id, localDay(now, user.tz)])) continue;
    await planDay(deps.db, user, now);
  }
});

/* ---------------- reading a practice ---------------- */

const DAYS: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };
export function readPractice(text: string): { label: string; days: number[]; time?: string; anchor?: "sunrise" | "sunset"; offset?: number; lead: number } | null {
  const t = text.trim();
  const anchor = /\b(sunset|sundown|nightfall|dusk)\b/i.test(t) ? "sunset" : /\b(sunrise|dawn)\b/i.test(t) ? "sunrise" : undefined;
  const tm = /(?:\bat\s+|@\s*)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}\.\d{2})\s*$/i.exec(t) ?? /\bat\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i.exec(t);
  const clock = tm ? parseClock(tm[1].replace(".", ":")) : null;
  if (!clock && !anchor) return null;
  let days: number[] = [];
  if (/\bweekdays\b/i.test(t)) days = [1, 2, 3, 4, 5];
  else if (/\bweekends?\b/i.test(t)) days = [6, 7];
  for (const m of t.matchAll(/\b(mon|tue|wed|thu|fri|sat|sun)(?:day|nesday|sday|rsday|urday)?s?\b/gi)) { const d = DAYS[m[1].toLowerCase()]; if (d && !days.includes(d)) days.push(d); }
  if (!days.length) days = [1, 2, 3, 4, 5, 6, 7];
  let label = t.replace(tm?.[0] ?? "\u0000", " ").replace(/\b(?:at\s+)?(?:sunset|sundown|nightfall|dusk|sunrise|dawn)\b/gi, " ")
    .replace(/\b(?:daily|every day|each day|every|weekly|on|at)\b/gi, " ").replace(/\b(?:weekdays|weekends?)\b/gi, " ");
  // A day name inside the label stays when it opens it ("Sunday service"); a trailing one ("candle lighting Friday") goes.
  label = label.replace(/\s+(?:mon|tues|wednes|thurs|fri|satur|sun)days?\s*$/i, " ").replace(/\s+/g, " ").trim();
  if (label.length < 2) return null;
  const offset = anchor && /\bcandle/i.test(t) && anchor === "sunset" ? -18 : 0;
  return { label: cap(label).slice(0, 60), days: days.sort(), ...(clock ? { time: `${String(clock[0]).padStart(2, "0")}:${String(clock[1]).padStart(2, "0")}` } : {}), ...(anchor ? { anchor } : {}), ...(offset ? { offset } : {}), lead: LEAD_WORDS.test(t) ? 30 : 0 };
}
const dayNames = (days: number[]) => (days.length === 7 ? "every day" : days.join() === "1,2,3,4,5" ? "weekdays" : days.join() === "6,7" ? "weekends" : andList(days.map((d) => DateTime.fromObject({ weekday: d as any }).toFormat("cccc") + "s")));

/* ---------------- actions ---------------- */

const CITY_Q = { need: "city", question: `Which city should I use? Say the city, like Kano, Birmingham or Jakarta.` };
const hasPlace = (u: User, city?: string) => Boolean(city || homePrefs(u).place || u.prefs.city);

const times = defineAction({
  name: "faith.times",
  tier: 1,
  description: "Islamic prayer times (Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha) for today or tomorrow in the person's city or a named one, from Aladhan; 'which' can name one (also iftar, suhoor, sunset, sunrise).",
  schema: z.object({ which: z.string().max(20).optional(), day: z.enum(["today", "tomorrow"]).optional(), city: z.string().max(60).optional() }),
  needs: (a, ctx) => (hasPlace(ctx.user, a.city) ? null : CITY_Q),
  fill: (need, answer) => (need === "city" && answer.length < 60 ? { city: answer } : null),
  async run(a, ctx) {
    const place = await homePlace(ctx.db, ctx.user, a.city);
    if (!place) throw new Error(`I couldn't find a place called "${a.city ?? ctx.user.prefs.city}". Try the city with its country?`);
    const day = local(ctx.now, place.tz).plus({ days: a.day === "tomorrow" ? 1 : 0 });
    const t = await prayerTimes(ctx.db, place, day, ctx.user);
    if (!t) throw new Error("I couldn't reach the prayer times service just now. Try again in a few minutes.");
    const when = a.day === "tomorrow" ? "tomorrow" : "today";
    const w = (a.which ?? "").toLowerCase();
    if (w) {
      if (/iftar/.test(w)) return { reply: `Iftar in ${place.name} ${when} is at Maghrib, ${t.times.Maghrib}.` };
      if (/suhoor|sehri|suhur/.test(w)) return { reply: `Suhoor in ${place.name} ${when} ends at Fajr, ${t.times.Fajr}${t.times.Imsak ? ` (Imsak ${t.times.Imsak})` : ""}.` };
      const k = PRAYER_ALIAS[w] ?? (w === "sunset" ? "Sunset" : w === "sunrise" ? "Sunrise" : null);
      if (k && t.times[k]) return { reply: `${k} in ${place.name} ${when} is at ${t.times[k]}.` };
    }
    return { reply: `Prayer times ${when} in ${place.name}: ${["Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha"].filter((k) => t.times[k]).map((k) => `${k} ${t.times[k]}`).join(", ")}.` };
  },
});

const prayers = defineAction({
  name: "faith.prayers",
  tier: 1,
  description: "Opt in to Islamic prayer time reminders at the person's city's times: 'prayers' lists which of Fajr, Dhuhr, Asr, Maghrib, Isha (empty means all five). Only when they ask.",
  schema: z.object({ prayers: z.array(z.string()).max(5).optional(), city: z.string().max(60).optional() }),
  needs: (a, ctx) => (hasPlace(ctx.user, a.city) ? null : CITY_Q),
  fill: (need, answer) => (need === "city" && answer.length < 60 ? { city: answer } : null),
  async run(a, ctx) {
    const place = await homePlace(ctx.db, ctx.user, a.city);
    if (!place) throw new Error(`I couldn't find a place called "${a.city ?? ctx.user.prefs.city}". Try the city with its country?`);
    const chosen = [...new Set((a.prayers ?? []).map((p) => PRAYER_ALIAS[p.toLowerCase().trim()]).filter(Boolean))];
    const list = chosen.length ? PRAYERS.filter((p) => chosen.includes(p)) : [...PRAYERS];
    const prev = await ctx.db.one<{ id: number; spec: any }>(`SELECT id, spec FROM home_faith WHERE user_id=$1 AND kind='prayer' AND active`, [ctx.user.id]);
    let id: number;
    if (prev) { id = prev.id; await ctx.db.query(`UPDATE home_faith SET spec=$2 WHERE id=$1`, [id, JSON.stringify({ prayers: list })]); }
    else id = (await ctx.db.one<{ id: number }>(`INSERT INTO home_faith (user_id, kind, label, spec) VALUES ($1,'prayer','Prayer times',$2) RETURNING id`, [ctx.user.id, JSON.stringify({ prayers: list })]))!.id;
    const { timings } = await planDay(ctx.db, ctx.user, ctx.now);
    const names = list.length === 5 ? "All five prayer" : `${andList(list)}`;
    const today = timings ? ` Today: ${list.map((p) => `${p} ${timings.times[p]}`).join(", ")}.` : " I couldn't reach the prayer times service just now; I'll try again within the hour.";
    return { reply: `${names} reminders, by the times in ${place.name}.${today} I'll ping you at each one. Say "stop the prayer reminders" to turn them off.`, undo: { payload: prev ? { id, spec: typeof prev.spec === "string" ? JSON.parse(prev.spec) : prev.spec } : { id, drop: true } } };
  },
  async undo(p, ctx) {
    if (p.drop) await ctx.db.query(`UPDATE home_faith SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    else await ctx.db.query(`UPDATE home_faith SET spec=$2 WHERE id=$1 AND user_id=$3`, [p.id, JSON.stringify(p.spec), ctx.user.id]);
    await planDay(ctx.db, ctx.user, ctx.now);
    return "Taken back.";
  },
});

const ramadan = defineAction({
  name: "faith.ramadan",
  tier: 1,
  description: "Opt in to Ramadan reminders: suhoor 45 minutes before Fajr and iftar at Maghrib, at the person's city's times, only during Ramadan (checked against the Islamic calendar each day).",
  schema: z.object({ city: z.string().max(60).optional() }),
  needs: (a, ctx) => (hasPlace(ctx.user, a.city) ? null : CITY_Q),
  fill: (need, answer) => (need === "city" && answer.length < 60 ? { city: answer } : null),
  async run(a, ctx) {
    const place = await homePlace(ctx.db, ctx.user, a.city);
    if (!place) throw new Error(`I couldn't find a place called "${a.city ?? ctx.user.prefs.city}". Try the city with its country?`);
    const prev = await ctx.db.one<{ id: number }>(`SELECT id FROM home_faith WHERE user_id=$1 AND kind='ramadan' AND active`, [ctx.user.id]);
    const id = prev?.id ?? (await ctx.db.one<{ id: number }>(`INSERT INTO home_faith (user_id, kind, label) VALUES ($1,'ramadan','Suhoor and iftar') RETURNING id`, [ctx.user.id]))!.id;
    const { timings } = await planDay(ctx.db, ctx.user, ctx.now);
    const head = `Suhoor and iftar reminders for ${place.name}.`;
    const body = !timings ? " I couldn't reach the prayer times service just now; I'll try again within the hour."
      : timings.hijriMonth === 9 ? ` I'll ping you 45 minutes before Fajr (${timings.times.Fajr} today) and at Maghrib (${timings.times.Maghrib}).`
      : " They'll start when Ramadan does; I check the Islamic calendar each day.";
    return { reply: `${head}${body} Say "stop the ramadan reminders" to turn them off.`, undo: prev ? undefined : { payload: { id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE home_faith SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); await planDay(ctx.db, ctx.user, ctx.now); return "Taken back."; },
});

const practice = defineAction({
  name: "faith.practice",
  tier: 1,
  description: "A reminder for any faith practice the person describes, at a clock time or at sunrise or sunset where they live: 'Sunday service at 10', 'Shabbat candle lighting Friday sunset', 'daily devotional at 6am'. 'text' is their words.",
  schema: z.object({ text: z.string().min(3).max(120), city: z.string().max(60).optional() }),
  needs(a, ctx) {
    const p = readPractice(a.text);
    if (!p) return { need: "text", question: `When is it? Say it with a time or sunset, like "Sunday service at 10".` };
    return p.anchor && !hasPlace(ctx.user, a.city) ? CITY_Q : null;
  },
  fill: (need, answer, args) => (need === "city" && answer.length < 60 ? { city: answer } : need === "text" ? { text: `${args.text} ${answer}` } : null),
  async run(a, ctx) {
    const p = readPractice(a.text);
    if (!p) throw new Error(`I couldn't find a time in that. Say it like "Sunday service at 10" or "candle lighting Friday sunset".`);
    if (a.city && !(await homePlace(ctx.db, ctx.user, a.city))) throw new Error(`I couldn't find a place called "${a.city}". Try the city with its country?`);
    const { label, ...spec } = p;
    const row = await ctx.db.one<{ id: number }>(`INSERT INTO home_faith (user_id, kind, label, spec) VALUES ($1,'practice',$2,$3) RETURNING id`, [ctx.user.id, label, JSON.stringify(spec)]);
    await planDay(ctx.db, ctx.user, ctx.now);
    const when = p.time ? `at ${p.time}` : `${p.offset ? `${Math.abs(p.offset)} minutes before ` : "at "}${p.anchor}`;
    return { reply: `${label}, ${dayNames(p.days)} ${when}. I'll ping you ${p.lead ? `${p.lead} minutes before` : "then"}. Say "stop the ${label.toLowerCase()} reminder" to stop it.`, undo: { payload: { id: row!.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE home_faith SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); await planDay(ctx.db, ctx.user, ctx.now); return "Taken back."; },
});

const list = defineAction({
  name: "faith.list",
  tier: 1,
  description: "The faith reminders the person has set (prayer times, Ramadan, practices).",
  schema: z.object({}),
  async run(_a, ctx) {
    const all = await items(ctx.db, ctx.user.id);
    if (!all.length) return { reply: `None set. You can say "Fajr and Maghrib reminders", "Sunday service at 10" or "daily devotional at 6am", for any practice you keep.` };
    return { reply: all.map((i) => `- ${i.kind === "prayer" ? `Prayer times: ${andList(i.spec.prayers ?? PRAYERS)}` : i.kind === "ramadan" ? "Suhoor and iftar in Ramadan" : `${i.label}, ${dayNames(i.spec.days ?? [1, 2, 3, 4, 5, 6, 7])} ${i.spec.time ? `at ${i.spec.time}` : `at ${i.spec.anchor}`}`}`).join("\n") };
  },
});

const stop = defineAction({
  name: "faith.stop",
  tier: 1,
  description: "Stop faith reminders: 'which' is 'prayer', 'ramadan', a practice's name, or 'all'.",
  schema: z.object({ which: z.string().min(2).max(60) }),
  async run(a, ctx) {
    const w = a.which.toLowerCase().trim();
    const all = await items(ctx.db, ctx.user.id);
    const hit = /^(?:all|faith|every)/.test(w) ? all : /prayer|salah|salat|adhan|azan|namaz/.test(w) ? all.filter((i) => i.kind === "prayer") : /ramadan|suhoor|iftar|sehri/.test(w) ? all.filter((i) => i.kind === "ramadan")
      : all.filter((i) => i.kind === "practice" && (i.label.toLowerCase().includes(w) || w.includes(i.label.toLowerCase())));
    if (!hit.length) return { reply: all.length ? `I don't have a reminder like "${a.which}". Say "my faith reminders" to see them.` : "There are no faith reminders to stop." };
    await ctx.db.query(`UPDATE home_faith SET active=false WHERE id = ANY($1)`, [hit.map((i) => i.id)]);
    await planDay(ctx.db, ctx.user, ctx.now);
    return { reply: `Stopped: ${andList(hit.map((i) => (i.kind === "prayer" ? "prayer time reminders" : i.kind === "ramadan" ? "suhoor and iftar" : i.label.toLowerCase())))}.`, undo: { payload: { ids: hit.map((i) => i.id) } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE home_faith SET active=true WHERE id = ANY($1) AND user_id=$2`, [p.ids, ctx.user.id]); await planDay(ctx.db, ctx.user, ctx.now); return "They're back on."; },
});

register(times, prayers, ramadan, practice, list, stop);

/* ---------------- words ---------------- */

const P = "(?:fajr|subh|dhuhr|zuhr|duhr|asr|maghrib|isha)";
const KEYWORDS = "(?:service|mass|church|devotions?|devotional|prayers?|bible|quran|qur'an|worship|jumu'?ah|jummah|temple|puja|pooja|synagogue|shabbat|sabbath|candle lighting|havdalah|rosary|vespers|fellowship|satsang|gurdwara|kirtan|aarti|dhikr|zikr|tahajjud|novena|angelus|quiet time|meditation|sangha|mincha|maariv|shacharit)";
const RECUR = "(?:^(?:every\\s+)?(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\\b|\\b(?:daily|every|weekly|each|weekdays|weekends?)\\b|\\b(?:shabbat|sabbath|candle lighting|devotional|devotions|jumu'?ah|jummah|quiet time|havdalah)\\b)";
const IN = "(?:\\s+(?:in|for)\\s+(.{2,40}?))?";

addRules(
  [/^(?:my|show my|list my)\s+(?:faith|prayer|worship|church|religious|devotional)\s+reminders$|^(?:faith|religious)\s+reminders$/i, () => ({ action: "faith.list", args: {} })],
  [new RegExp(`^(?:(?:turn on|set up|start|add|give me)\\s+)?(?:the\\s+|my\\s+|all\\s+(?:the\\s+)?|all five\\s+|five\\s+|daily\\s+)?(?:prayer|salah|salat|adhan|azan|namaz)(?:\\s+times?)?\\s+(?:reminders|alerts|notifications)(?:\\s+for\\s+((?:${P})(?:(?:\\s*,\\s*|\\s+and\\s+|\\s*&\\s*)${P})*))?${IN}$`, "i"),
    (m) => ({ action: "faith.prayers", args: { prayers: m[1] ? m[1].split(/\s*(?:,|and|&)\s*/i) : [], ...(m[2] ? { city: m[2] } : {}) } })],
  [new RegExp(`^remind me (?:of|about|for)\\s+((?:${P})(?:(?:\\s*,\\s*|\\s+and\\s+|\\s*&\\s*)${P})*)(?:\\s+prayers?)?${IN}$`, "i"), (m) => ({ action: "faith.prayers", args: { prayers: m[1].split(/\s*(?:,|and|&)\s*/i), ...(m[2] ? { city: m[2] } : {}) } })],
  [new RegExp(`^((?:${P})(?:(?:\\s*,\\s*|\\s+and\\s+|\\s*&\\s*)${P})*)\\s+(?:prayer\\s+)?(?:reminders|alerts)${IN}$`, "i"), (m) => ({ action: "faith.prayers", args: { prayers: m[1].split(/\s*(?:,|and|&)\s*/i), ...(m[2] ? { city: m[2] } : {}) } })],
  [new RegExp(`^(?:(?:turn on|set up|start)\\s+)?(?:ramadan|suhoor and iftar|iftar and suhoor|sehri and iftar|suhoor|iftar)\\s+(?:reminders|alerts)${IN}$`, "i"), (m) => ({ action: "faith.ramadan", args: m[1] ? { city: m[1] } : {} })],
  [new RegExp(`^(?:(?:today'?s|the)\\s+)?(?:prayer|salah|salat|namaz)\\s+times(?:\\s+(today|tomorrow))?${IN}(?:\\s+(today|tomorrow))?$`, "i"), (m) => ({ action: "faith.times", args: { ...(m[1] ?? m[3] ? { day: (m[1] ?? m[3]).toLowerCase() } : {}), ...(m[2] ? { city: m[2] } : {}) } })],
  [new RegExp(`^(?:what time is|when is|when'?s|what time'?s)\\s+(${P}|iftar|suhoor|sehri)(?:\\s+(today|tomorrow))?(?:\\s+in\\s+(.{2,40}?))?(?:\\s+(today|tomorrow))?$`, "i"), (m) => ({ action: "faith.times", args: { which: m[1].toLowerCase(), ...(m[2] ?? m[4] ? { day: (m[2] ?? m[4]).toLowerCase() } : {}), ...(m[3] ? { city: m[3] } : {}) } })],
  [new RegExp(`^(?!.*\\b(?:remind|reminders?|wedding|funeral|meeting|appointment)\\b)(?=.*\\b${KEYWORDS}\\b)(?=.*${RECUR})(?=.*(?:\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?\\s*$|\\bat\\s+\\d|\\b(?:sunset|sundown|sunrise|dawn|nightfall)\\b)).{3,100}$`, "i"), (m) => ({ action: "faith.practice", args: { text: m[0] } })],
  [new RegExp(`^(?:stop|turn off|no more|end)\\s+(?:the\\s+|my\\s+|all\\s+(?:the\\s+|my\\s+)?)?(?:(faith|prayer|prayer time|salah|ramadan|suhoor|iftar|suhoor and iftar)\\s+reminders|((?=[^]*\\b${KEYWORDS}\\b).{2,50}?)\\s+reminders?)$`, "i"), (m) => ({ action: "faith.stop", args: { which: (m[1] ?? m[2]).trim() } })],
);
addExamples("faith.prayers", ["remind me of Fajr and Maghrib", "prayer reminders", "Fajr and Maghrib reminders", "prayer time reminders for fajr and isha", "all five prayer reminders in Kano"]);
addExamples("faith.ramadan", ["suhoor and iftar reminders", "ramadan reminders"]);
addExamples("faith.times", ["prayer times today", "prayer times in Nairobi", "when is maghrib", "what time is iftar"]);
addExamples("faith.practice", ["Sunday service at 10", "Shabbat candle lighting Friday sunset", "daily devotional at 6am", "Friday prayers at 1pm"]);
addExamples("faith.list", ["my faith reminders", "my prayer reminders"]);
addExamples("faith.stop", ["stop the prayer reminders", "stop the ramadan reminders", "stop the Sunday service reminder"]);
addCues("faith", ["prayer", "prayers", "pray", "fajr", "dhuhr", "asr", "maghrib", "isha", "salah", "ramadan", "suhoor", "iftar", "church", "service", "mass", "devotional", "shabbat", "candle lighting", "sabbath", "worship", "temple", "puja", "faith"]);
addCapability({
  key: "faith", name: "Faith rhythms",
  cues: ["prayer", "prayer times", "fajr", "maghrib", "ramadan", "suhoor", "iftar", "church", "service", "devotional", "shabbat", "sabbath", "faith", "worship"],
  what: "If you keep a practice, I can keep its rhythm: prayer times for your city with the reminders you choose, suhoor and iftar in Ramadan, or any practice you describe, at a time or at sunset where you live. Only when you ask.",
  say: ["Fajr and Maghrib reminders", "Sunday service at 10", "Shabbat candle lighting Friday sunset", "prayer times today"],
  then: "I use your city (\"my city is ...\") for prayer times and sunsets. Say \"stop the prayer reminders\" or \"my faith reminders\" any time.",
  limits: "Prayer times come from Aladhan's calculation for your location; your local mosque's timetable may differ by a few minutes.",
}, "Your day");

addBriefSection({
  key: "home_faith", order: 50,
  async lines(db, user, now) {
    const kinds = (await db.query<{ kind: string }>(`SELECT DISTINCT kind FROM home_faith WHERE user_id=$1 AND active AND kind IN ('prayer','ramadan')`, [user.id])).map((r) => r.kind);
    const place = homePrefs(user).place as Place | undefined;
    if (!kinds.length || !place) return [];
    const date = local(now, place.tz).toFormat("dd-MM-yyyy");
    const t = await cacheGet<Timings>(db, `aladhan:${place.lat.toFixed(3)},${place.lon.toFixed(3)}:${date}:${homePrefs(user).prayerMethod ?? ""}`, 3 * 86_400_000, now);
    if (!t) return [];
    if (kinds.includes("ramadan") && t.hijriMonth === 9) return [`Ramadan in ${place.name}: suhoor until Fajr at ${t.times.Fajr}, iftar at ${t.times.Maghrib}.`];
    return kinds.includes("prayer") ? [`Prayer times in ${place.name}: ${PRAYERS.filter((p) => t.times[p]).map((p) => `${p} ${t.times[p]}`).join(", ")}.`] : [];
  },
});
