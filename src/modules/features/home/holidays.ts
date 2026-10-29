/**
 * Public holidays and long weekends from Nager.Date (free, no key, about 120 countries) for the
 * person's own country. "next public holiday", "long weekends this year" (where a day or two off makes
 * a long break, with the country's own weekend), and a line in the brief a week before and the day before.
 * Countries Nager.Date doesn't cover are named plainly.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import type { Db } from "../../../core/db.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSystemJob } from "../../../core/plugins.js";
import { onJob } from "../../../core/scheduler.js";
import { countryOf } from "../../../core/money.js";
import { cacheGet, cached, getJson, local, plural, setPrefs } from "./util.js";

const NAGER = "https://date.nager.at/api/v3";
interface Holiday { date: string; localName: string; name: string; global: boolean; counties: string[] | null; types?: string[] }

/** Weekends that aren't Saturday and Sunday (luxon weekdays: 5 Friday, 6 Saturday, 7 Sunday). */
const WEEKEND: Record<string, number[]> = { SA: [5, 6], EG: [5, 6], KW: [5, 6], QA: [5, 6], BH: [5, 6], OM: [5, 6], JO: [5, 6], IQ: [5, 6], IL: [5, 6], DZ: [5, 6], LY: [5, 6], SD: [5, 6], YE: [5, 6], SY: [5, 6], BD: [5, 6], MV: [5, 6], IR: [5], AF: [4, 5], NP: [6] };
const weekendOf = (cc: string) => WEEKEND[cc] ?? [6, 7];

const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
export const countryName = (cc: string) => { try { return regionNames?.of(cc) ?? cc; } catch { return cc; } };
const NAME_TO_CODE: Map<string, string> = (() => {
  const m = new Map<string, string>();
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of A) for (const b of A) { const cc = a + b; const n = countryName(cc); if (n && n !== cc && !/unknown/i.test(n)) m.set(n.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, ""), cc); }
  const alias: Record<string, string> = { uk: "GB", "great britain": "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB", usa: "US", us: "US", america: "US", "united states of america": "US", uae: "AE", emirates: "AE", drc: "CD", "dr congo": "CD", "congo kinshasa": "CD", "congo brazzaville": "CG", "ivory coast": "CI", "cote d'ivoire": "CI", holland: "NL", "the netherlands": "NL", "south korea": "KR", korea: "KR", russia: "RU", czechia: "CZ", "czech republic": "CZ", turkey: "TR", turkiye: "TR", swaziland: "SZ", eswatini: "SZ", "cape verde": "CV", burma: "MM", vatican: "VA" };
  for (const [k, v] of Object.entries(alias)) m.set(k, v);
  return m;
})();
export function resolveCountry(s: string): string | null {
  const t = s.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/^the\s+/, "").replace(/[.!?]$/, "");
  if (/^[a-z]{2}$/.test(t) && countryName(t.toUpperCase()) !== t.toUpperCase()) return t.toUpperCase();
  return NAME_TO_CODE.get(t) ?? NAME_TO_CODE.get(`the ${t}`) ?? null;
}

/** Which country, and whether it's a guess from the time zone. */
function countryFor(user: User, said?: string): { cc: string | null; guessed: boolean } {
  if (said) return { cc: resolveCountry(said), guessed: false };
  if (typeof user.prefs.country === "string" && user.prefs.country) return { cc: String(user.prefs.country).toUpperCase(), guessed: false };
  return { cc: countryOf(user), guessed: true };
}
/** A tz-only guess is solid for zones in money.ts's table; "America/..." and "Europe/..." fallbacks are not, so the brief waits for the person to say. */
const solid = (user: User) => (typeof user.prefs.country === "string" && !!user.prefs.country) || (!!countryOf(user) && !/^(?:America|Europe)\//.test(user.tz));

async function covered(db: Db, cc: string): Promise<boolean | null> {
  const list = await cached<string[]>(db, "nager:countries", 30 * 86_400_000, async () => {
    const r = await getJson(`${NAGER}/AvailableCountries`);
    return r && r.status < 400 && Array.isArray(r.data) ? r.data.map((c: any) => String(c.countryCode)) : null;
  });
  return list ? list.includes(cc) : null;
}
export async function holidays(db: Db, cc: string, year: number): Promise<Holiday[] | null> {
  return cached<Holiday[]>(db, `nager:${cc}:${year}`, 7 * 86_400_000, async () => {
    const r = await getJson(`${NAGER}/PublicHolidays/${year}/${cc}`);
    if (!r || r.status >= 400 || (r.status !== 204 && !Array.isArray(r.data))) return null;
    return (Array.isArray(r.data) ? r.data : []).filter((h: any) => !h.types || h.types.includes("Public")).map((h: any) => ({ date: h.date, localName: h.localName, name: h.name, global: h.global !== false, counties: h.counties ?? null, types: h.types }));
  });
}

/** A holiday's stretch of days off, and where a day or two of leave would join it to the next weekend. */
export interface Break { holiday: Holiday; start: DateTime; end: DateTime; days: number; take?: DateTime[]; joined?: { start: DateTime; end: DateTime; days: number } }
export function longBreaks(list: Holiday[], cc: string, from: DateTime): Break[] {
  const wk = weekendOf(cc);
  const off = new Set(list.filter((h) => h.global).map((h) => h.date));
  const isOff = (d: DateTime) => wk.includes(d.weekday) || off.has(d.toISODate()!);
  const run = (d: DateTime) => { let s = d, e = d; while (isOff(s.minus({ days: 1 }))) s = s.minus({ days: 1 }); while (isOff(e.plus({ days: 1 }))) e = e.plus({ days: 1 }); return { s, e }; };
  const out: Break[] = [];
  const seen = new Set<string>();
  for (const h of list.filter((x) => x.global)) {
    if (h.date < from.toISODate()!) continue;
    const d = DateTime.fromISO(h.date, { zone: "UTC" });
    const { s, e } = run(d);
    if (seen.has(s.toISODate()!)) continue;
    seen.add(s.toISODate()!);
    const days = Math.round(e.diff(s, "days").days) + 1;
    const b: Break = { holiday: h, start: s, end: e, days };
    // A bridge: one or two working days next to the break that reach another day off.
    let best: Break["joined"] & { take: DateTime[] } | null = null;
    for (const dir of [1, -1]) for (const k of [1, 2]) {
      const take: DateTime[] = [];
      let edge = dir > 0 ? e : s, ok = true;
      for (let i = 1; i <= k; i++) { const x = edge.plus({ days: dir * i }); if (isOff(x)) { ok = false; break; } take.push(x); }
      if (!ok) continue;
      const beyond = edge.plus({ days: dir * (k + 1) });
      if (!isOff(beyond)) continue;
      const r = run(beyond);
      const ns = dir > 0 ? s : r.s, ne = dir > 0 ? r.e : e;
      const total = Math.round(ne.diff(ns, "days").days) + 1;
      if (total >= 4 && (!best || total / take.length > best.days / best.take.length)) best = { start: ns, end: ne, days: total, take: take.sort((a, z) => a.toMillis() - z.toMillis()) };
    }
    if (best) { b.take = best.take; b.joined = { start: best.start, end: best.end, days: best.days }; }
    if (days >= 3 || b.take) out.push(b);
  }
  return out;
}
const dd = (d: DateTime) => d.toFormat("ccc d LLL");
const takeWords = (t: DateTime[]) => (t.length === 1 ? dd(t[0]) : `${t[0].toFormat("ccc d")} and ${dd(t[1])}`);
const breakLine = (b: Break) => b.take
  ? `${dd(DateTime.fromISO(b.holiday.date))} (${b.holiday.name}): take ${takeWords(b.take)} off for ${b.joined!.days} days in a row.`
  : `${dd(DateTime.fromISO(b.holiday.date))} (${b.holiday.name}): ${b.days} days off, ${b.start.toFormat("ccc")} to ${b.end.toFormat("ccc")}.`;

/* ---------------- actions ---------------- */

const ASK = { need: "country", question: "Which country should I use for public holidays? The name or a two-letter code works, like Kenya or FR." };
const askNeeded = (a: { country?: string }, ctx: { user: User }) => (a.country || countryFor(ctx.user).cc ? null : ASK);
const fillCountry = (need: string, answer: string) => { if (need !== "country") return null; const cc = resolveCountry(answer); return cc ? { country: cc, remember: true } : null; };

async function prepare(db: Db, user: User, a: { country?: string; remember?: boolean }): Promise<{ cc: string; note: string }> {
  const { cc, guessed } = countryFor(user, a.country);
  if (!cc) throw new Error(a.country ? `I don't know a country called "${a.country}". Try its English name or its two-letter code?` : ASK.question);
  if (a.remember && !user.prefs.country) await setPrefs(db, user, { country: cc });
  const cov = await covered(db, cc);
  if (cov === false) throw new Error(`Nager.Date, where I get public holidays, doesn't cover ${countryName(cc)} yet, so I can't list them. The government's own site will have them.`);
  return { cc, note: guessed ? ` (I'm going by your time zone; say "my country is ..." if that's wrong.)` : "" };
}
const unreachable = () => new Error("I couldn't reach the public holidays service just now. Try again in a few minutes.");

const next = defineAction({
  name: "holiday.next",
  tier: 1,
  description: "The next public holiday in the person's country (or a named one), with any long weekend it makes. Data from Nager.Date.",
  schema: z.object({ country: z.string().max(40).optional(), remember: z.boolean().optional() }),
  needs: askNeeded, fill: fillCountry,
  async run(a, ctx) {
    const { cc, note } = await prepare(ctx.db, ctx.user, a);
    const today = local(ctx.now, ctx.user.tz).startOf("day");
    const list = [...((await holidays(ctx.db, cc, today.year)) ?? []), ...(today.month >= 10 ? (await holidays(ctx.db, cc, today.year + 1)) ?? [] : [])];
    if (!list.length && !(await holidays(ctx.db, cc, today.year))) throw unreachable();
    const ahead = list.filter((h) => h.date >= today.toISODate()!);
    if (!ahead.length) return { reply: `No more public holidays listed for ${countryName(cc)} this year.${note}` };
    const h = ahead[0], d = DateTime.fromISO(h.date, { zone: ctx.user.tz });
    const days = Math.round(d.diff(today, "days").days);
    const br = longBreaks(list, cc, today).find((b) => b.holiday.date === h.date || (b.start <= DateTime.fromISO(h.date, { zone: "UTC" }) && b.end >= DateTime.fromISO(h.date, { zone: "UTC" })));
    const extra = br ? (br.take ? ` Taking ${takeWords(br.take)} off makes it ${br.joined!.days} days in a row.` : br.days >= 3 ? ` That's ${br.days} days off, ${br.start.toFormat("ccc")} to ${br.end.toFormat("ccc")}.` : "") : "";
    const region = h.global ? "" : " (some regions only)";
    const after = ahead[1] ? ` After that: ${ahead[1].name}, ${dd(DateTime.fromISO(ahead[1].date))}.` : "";
    return { reply: `Next public holiday in ${countryName(cc)}: ${h.name}${h.localName && h.localName !== h.name ? ` (${h.localName})` : ""}${region}, ${dd(d)}, ${days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${plural(days, "day")}`}.${extra}${after}${note}` };
  },
});

const long = defineAction({
  name: "holiday.long",
  tier: 1,
  description: "Long weekends left this year (or a given year) in the person's country: breaks of three days or more, and where taking one or two days off joins a holiday to a weekend.",
  schema: z.object({ country: z.string().max(40).optional(), year: z.number().int().min(2000).max(2100).optional(), remember: z.boolean().optional() }),
  needs: askNeeded, fill: fillCountry,
  async run(a, ctx) {
    const { cc, note } = await prepare(ctx.db, ctx.user, a);
    const today = local(ctx.now, ctx.user.tz).startOf("day");
    const year = a.year ?? today.year;
    const list = await holidays(ctx.db, cc, year);
    if (!list) throw unreachable();
    const from = year === today.year ? today : DateTime.fromObject({ year, month: 1, day: 1 }, { zone: "UTC" });
    const brs = longBreaks([...list, ...((await holidays(ctx.db, cc, year + 1)) ?? []).filter((h) => h.date < `${year + 1}-01-08`)], cc, from).filter((b) => b.holiday.date.startsWith(String(year)));
    if (!brs.length) return { reply: `No long weekends left in ${countryName(cc)} for ${year}, even with a day or two off.${note}` };
    return { reply: [`Long weekends in ${countryName(cc)}${year === today.year ? " for the rest of the year" : ` in ${year}`}:`, ...brs.slice(0, 8).map((b) => `- ${breakLine(b)}`)].join("\n") + note };
  },
});

register(next, long);

const IN = "(?:\\s+(?:in|for)\\s+(?:the\\s+)?([a-z][a-z .'-]{1,38}?))?";
addRules(
  [new RegExp(`^(?:when'?s|when is|what'?s)?\\s*(?:the\\s+)?next\\s+(?:public\\s+|bank\\s+|national\\s+)?holiday${IN}\\??$|^(?:any\\s+)?(?:public|bank)\\s+holidays?\\s+(?:coming up|soon)${IN}$`, "i"), (m) => ({ action: "holiday.next", args: m[1] ?? m[2] ? { country: (m[1] ?? m[2]).trim() } : {} })],
  [new RegExp(`^(?:any\\s+|show\\s+|my\\s+)?long weekends?(?:\\s+(?:this year|left|coming up|in (\\d{4})))?${IN}$|^(?:public|bank)\\s+holidays\\s+(?:this year|in (\\d{4}))${IN}$|^when (?:can|should) i take (?:a )?(?:day|days) off$`, "i"), (m) => ({ action: "holiday.long", args: { ...(m[1] ?? m[3] ? { year: Number(m[1] ?? m[3]) } : {}), ...(m[2] ?? m[4] ? { country: (m[2] ?? m[4]).trim() } : {}) } })],
);
addExamples("holiday.next", ["next public holiday", "when is the next holiday", "next bank holiday in the UK"]);
addExamples("holiday.long", ["long weekends this year", "long weekends", "public holidays this year in Kenya"]);
addCues("holiday", ["holiday", "holidays", "public holiday", "bank holiday", "long weekend", "day off", "days off", "my country"]);
addCapability({
  key: "holidays", name: "Holidays and long weekends",
  cues: ["public holiday", "bank holiday", "holidays", "long weekend", "day off", "days off"],
  what: "Your country's public holidays, and the long weekends in them, including where taking a day or two off makes a long break.",
  say: ["next public holiday", "long weekends this year", "my country is Kenya"],
  then: "A line in your morning note a week before a holiday and the day before. I use your country; say \"my country is ...\" if I have it wrong.",
  limits: "From Nager.Date, which covers about 120 countries. If yours isn't one of them I'll say so.",
}, "Your day");

addBriefSection({
  key: "home_holiday", order: 35,
  async lines(db, user, now) {
    if (!solid(user)) return [];
    const cc = countryFor(user).cc!;
    const today = local(now, user.tz).startOf("day");
    const list = [...((await cacheGet<Holiday[]>(db, `nager:${cc}:${today.year}`, 30 * 86_400_000, now)) ?? []), ...((await cacheGet<Holiday[]>(db, `nager:${cc}:${today.year + 1}`, 30 * 86_400_000, now)) ?? [])];
    for (const n of [1, 7]) {
      const h = list.find((x) => x.global && x.date === today.plus({ days: n }).toISODate());
      if (h) return [n === 1 ? `Tomorrow is ${h.name}, a public holiday.` : `${h.name} is a week today, ${dd(DateTime.fromISO(h.date))}, a public holiday.`];
    }
    return [];
  },
});

/** Once a day, keep each member country's holidays fresh in the cache (one request a country a week), so the brief never waits on the network. */
addSystemJob("home_holidays", "37 3 * * *");
onJob("home_holidays", async (_job, deps) => {
  const now = new Date();
  const users = await deps.db.query<User>(`SELECT * FROM users`);
  const ccs = [...new Set(users.filter(solid).map((u) => countryFor(u).cc!))];
  for (const cc of ccs.slice(0, 40)) {
    if ((await covered(deps.db, cc)) === false) continue;
    const y = local(now, "UTC").year;
    await holidays(deps.db, cc, y);
    if (local(now, "UTC").month >= 11) await holidays(deps.db, cc, y + 1);
  }
});
