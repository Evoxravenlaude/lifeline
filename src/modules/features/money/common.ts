/**
 * Money and paperwork: the shared parts. Amounts and currencies in anyone's words, dates in the
 * person's own time zone, one calm daily sweep that combines every time-sensitive money thing into
 * a single ping, and the brief lines that carry everything else.
 */
import { DateTime } from "luxon";
import { z } from "zod";
import type { Db } from "../../../core/db.js";
import type { Ctx, User } from "../../../policy/types.js";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addBriefSection, addButtons, addCues, addExamples, addRules, addSchema, type ButtonReply } from "../../../core/plugins.js";
import { money, userCurrency } from "../../../core/money.js";
import { localDay, parseWhen } from "../../../core/time.js";
import { onJob, push, schedule, type SchedulerDeps } from "../../../core/scheduler.js";
import { propose, type Decision } from "../../../policy/engine.js";
import { setThread } from "../../../intent/thread.js";
import { complete, providerName } from "../../../intent/providers.js";
import { overBudget, recordUsage } from "../../../core/budget.js";
import { log } from "../../../core/log.js";

addSchema(`CREATE TABLE IF NOT EXISTS money_pings (user_id INT NOT NULL REFERENCES users(id), key TEXT NOT NULL, at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (user_id, key))`);

/* ---------------- amounts ---------------- */

const ISO = "usd|eur|gbp|ngn|ghs|kes|ugx|tzs|rwf|etb|zar|egp|mad|xaf|xof|cad|mxn|brl|ars|clp|cop|pen|chf|sek|nok|dkk|pln|czk|huf|ron|uah|aed|sar|qar|ils|inr|pkr|bdt|lkr|npr|cny|hkd|twd|jpy|krw|sgd|myr|idr|php|thb|vnd|aud|nzd|zmw|aoa|dzd|tnd|usdt|usdc|btc|eth|sol";
const WORDS = "naira|cedis?|shillings?|rand|rupees?|pesos?|reais|real|yen|yuan|rmb|dirhams?|francs?|cfa|euros?|dollars?|bucks|pounds?|quid";
const SYM = "(?:R\\$|US\\$|KSh|[$€£₦¥₹₵₱₩₺₫₴]|R(?=\\d))";
/** An amount as people type it: "40", "€40", "15,000", "15k", "1.8m", "99 dollars", "USD 15.49", "0.5 ETH". */
export const AMT = `((?:${SYM}\\s?)?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:k|m|bn|million|billion|thousand)\\b)?(?:\\s?(?:${ISO}|${WORDS})\\b)?|(?:${ISO})\\s?\\d[\\d,]*(?:\\.\\d+)?(?:\\s?(?:k|m|bn|million|billion|thousand)\\b)?)`;
/** A person, company or thing: one to four words. */
export const NAME = "([\\p{L}@][\\p{L}\\p{N}_.'&+-]*(?:\\s[\\p{L}\\p{N}][\\p{L}\\p{N}_.'&+-]*){0,3})";
export const re = (s: string) => new RegExp(`^(?:${s})$`, "iu");

/** "€40" → { amount: 40, currency: "€" }. The currency stays as typed; `normCur` turns it into a code for the person. */
export function amt(text: string): { amount: number; currency?: string } {
  const t = text.trim();
  const sym = new RegExp(`^${SYM}`, "i").exec(t)?.[0];
  const isoFirst = new RegExp(`^(${ISO})\\s?(?=\\d)`, "i").exec(t)?.[1];
  const num = /\d[\d,]*(?:\.\d+)?/.exec(t)![0];
  let amount = Number(num.replace(/,/g, ""));
  const after = t.slice(t.indexOf(num) + num.length).trim().toLowerCase();
  const mult = /^(k|m|bn|million|billion|thousand)\b/.exec(after)?.[1];
  if (mult) amount *= mult === "k" || mult === "thousand" ? 1e3 : mult === "m" || mult === "million" ? 1e6 : 1e9;
  const word = new RegExp(`(${ISO}|${WORDS})$`, "i").exec(after.replace(/^(k|m|bn|million|billion|thousand)\b\s?/, ""))?.[1];
  return { amount: Math.round(amount * 1e8) / 1e8, currency: sym ?? isoFirst ?? word ?? undefined };
}

const DOLLARS = new Set(["USD", "CAD", "AUD", "NZD", "SGD", "HKD", "TWD", "JMD", "TTD", "LRD", "BSD", "BBD"]);
const RUPEES = new Set(["INR", "PKR", "LKR", "NPR"]);
const SHILLINGS = new Set(["KES", "UGX", "TZS"]);
const PESOS = new Set(["MXN", "ARS", "CLP", "COP", "PHP"]);
const FRANCS = new Set(["CHF", "XAF", "XOF", "RWF"]);

/** The currency code meant by what someone typed, read in their own context ("dollars" for a Canadian is CAD). */
export function normCur(raw: string | undefined | null, user: Pick<User, "tz" | "prefs">): string {
  const own = userCurrency(user);
  if (!raw) return own;
  const r = raw.trim(), l = r.toLowerCase();
  if (r === "US$") return "USD";
  if (r === "R$" || /^rea(l|is)$/.test(l)) return "BRL";
  if (r === "$" || /^(dollars?|bucks)$/.test(l)) return DOLLARS.has(own) ? own : "USD";
  if (r === "€" || /^euros?$/.test(l)) return "EUR";
  if (r === "£" || /^(pounds?|quid)$/.test(l)) return own === "EGP" ? "EGP" : "GBP";
  if (r === "₦" || l === "naira") return "NGN";
  if (r === "¥") return own === "CNY" ? "CNY" : "JPY";
  if (r === "₹" || /^rupees?$/.test(l)) return RUPEES.has(own) ? own : "INR";
  if (r === "₵" || /^cedis?$/.test(l)) return "GHS";
  if (r === "R" || l === "rand") return "ZAR";
  if (/^ksh$/i.test(r)) return "KES";
  if (/^shillings?$/.test(l)) return SHILLINGS.has(own) ? own : "KES";
  if (/^pesos?$/.test(l)) return PESOS.has(own) ? own : "MXN";
  if (l === "yen") return "JPY";
  if (l === "yuan" || l === "rmb") return "CNY";
  if (/^dirhams?$/.test(l)) return own === "MAD" ? "MAD" : "AED";
  if (/^francs?$/.test(l)) return FRANCS.has(own) ? own : "CHF";
  if (l === "cfa") return own === "XOF" ? "XOF" : "XAF";
  const syms: Record<string, string> = { "₱": "PHP", "₩": "KRW", "₺": "TRY", "₫": "VND", "₴": "UAH" };
  if (syms[r]) return syms[r];
  if (/^[a-z]{3,4}$/i.test(r)) return r.toUpperCase();
  return own;
}

const CRYPTO = new Set(["BTC", "ETH", "SOL", "USDT", "USDC"]);
export const isCrypto = (c: string) => CRYPTO.has(c.toUpperCase());
/** An amount in its currency, the way people read it. */
export function fmt(amount: number | string, currency: string): string {
  const n = Number(amount);
  if (isCrypto(currency)) return `${Number(n.toFixed(8))} ${currency.toUpperCase()}`;
  return money(Math.round(n * 100) / 100, currency.toUpperCase());
}
/** Totals per currency in one phrase: "€40 and ₦15,000". */
export function totals(rows: { amount: number | string; currency: string }[]): string {
  const by = new Map<string, number>();
  for (const r of rows) by.set(r.currency, (by.get(r.currency) ?? 0) + Number(r.amount));
  return [...by].map(([c, t]) => fmt(t, c)).join(" and ");
}

/** Never keep a card number. */
export function hasCardNumber(text: string): boolean {
  return /\b(?:\d[ -]?){13,19}\b/.test(text);
}

/* ---------------- dates, always in the person's own zone ---------------- */

export const todayOf = (user: User, now: Date) => localDay(now, user.tz);
export const dt = (iso: string) => DateTime.fromISO(iso.slice(0, 10));
export const isoOf = (d: string | Date) => (typeof d === "string" ? d.slice(0, 10) : DateTime.fromJSDate(d).toISODate()!);
export function daysUntil(iso: string, user: User, now: Date): number {
  return Math.round(dt(iso).diff(dt(todayOf(user, now)), "days").days);
}
/** "today", "tomorrow", "Sunday", "3 November", "3 March 2027". */
export function sayDate(iso: string, user: User, now: Date): string {
  const d = daysUntil(iso, user, now);
  const day = dt(iso);
  if (d === 0) return "today";
  if (d === 1) return "tomorrow";
  if (d === -1) return "yesterday";
  if (d > 1 && d < 7) return day.toFormat("cccc");
  return day.toFormat(day.year === dt(todayOf(user, now)).year ? "d LLLL" : "d LLLL yyyy");
}
/** "in 3 days", "in 5 weeks", "in 4 months". */
export function sayIn(days: number): string {
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days < 0) return days === -1 ? "yesterday" : `${-days} days ago`;
  if (days < 14) return `in ${days} days`;
  if (days < 60) return `in ${Math.round(days / 7)} weeks`;
  return `in ${Math.round(days / 30.4)} months`;
}

/** A date someone typed ("Friday", "30 Nov", "3 March 2027", "June 2028"), as a local ISO day. */
export function parseDay(text: string, user: User, now: Date): string | null {
  const t = text.trim().replace(/^(?:on|by|the|before|until)\s+/i, "").replace(/\bthe\s+(?=\d)/i, "");
  const d = parseWhen(t, user.tz, now);
  if (!d) return null;
  return DateTime.fromJSDate(d).setZone(user.tz).toISODate();
}
/** "the 1st", "3rd", "on the 15th of each month": a day of the month, or null. */
export function dayOfMonth(text: string): number | null {
  const m = /^(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?(?:\s+of\s+(?:each|every|the)\s+month)?(?:\s+(?:of\s+)?(?:each|every)\s+month)?$/i.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 31 ? n : null;
}
/** The next date on day `d` of a month, from `fromIso` on (today counts). */
export function nextMonthly(d: number, fromIso: string): string {
  let x = dt(fromIso).startOf("month");
  for (let i = 0; i < 3; i++) {
    const cand = x.set({ day: Math.min(d, x.daysInMonth!) });
    if (cand >= dt(fromIso)) return cand.toISODate()!;
    x = x.plus({ months: 1 });
  }
  return x.toISODate()!;
}
/** Move a date on by one period, keeping a monthly anchor day where there is one. */
export function addPeriod(iso: string, period: string, anchor?: number | null): string {
  const d = dt(iso);
  if (period === "weekly") return d.plus({ weeks: 1 }).toISODate()!;
  if (period === "fortnightly") return d.plus({ weeks: 2 }).toISODate()!;
  if (period === "yearly") return d.plus({ years: 1 }).toISODate()!;
  const n = d.plus({ months: 1 }).startOf("month");
  return n.set({ day: Math.min(anchor ?? d.day, n.daysInMonth!) }).toISODate()!;
}
export function periodOf(word: string | undefined): "weekly" | "fortnightly" | "monthly" | "yearly" | undefined {
  if (!word) return undefined;
  const w = word.toLowerCase();
  if (/^(?:a |per |every )?(?:week|weekly|wk)$/.test(w)) return "weekly";
  if (/fortnight|biweekly|two weeks|2 weeks/.test(w)) return "fortnightly";
  if (/year|annual|yr|p\.?a/.test(w)) return "yearly";
  if (/month|mo\b|^mo$|pm/.test(w)) return "monthly";
  return undefined;
}
/** A "when" that looks like a date: a number, a month, a weekday, next or tomorrow. Keeps "my patience expires soon" out. */
export const DATEISH = "((?=.*?(?:\\d|\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|next|tomorrow|today|tonight|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|end of)))\\S.*)";
export const PERIOD = "(week|weekly|wk|fortnight|fortnightly|biweekly|month|monthly|mo|year|yearly|annually|annual|yr)";

/* ---------------- people and things by name ---------------- */

export const clean = (s: string) => s.trim().replace(/^(?:the|my|our|a|an)\s+/i, "").replace(/[.?!,]+$/, "").trim();
/** The row whose name best matches what someone typed: exact, then starts-with, then contains. */
export function byName<T extends Record<string, any>>(rows: T[], field: keyof T, typed: string): T | undefined {
  const q = clean(typed).toLowerCase();
  if (!q) return undefined;
  const n = (r: T) => String(r[field]).toLowerCase();
  return rows.find((r) => n(r) === q) ?? rows.find((r) => n(r).startsWith(q) || q.startsWith(n(r))) ?? rows.find((r) => n(r).includes(q) || q.includes(n(r)));
}
export const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
export const firstName = (user: User) => (user.name ? user.name.split(" ")[0] : "");
export const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------------- the daily sweep: one combined ping, only when time matters ---------------- */

export type Feature = "ious" | "subs" | "docs" | "rent" | "warranty" | "cooloff" | "debt" | "invoices" | "tax" | "circle" | "move";
export interface PingItem { key: string; text: string; button?: { label: string; data: string } }
type Pinger = (db: Db, user: User, today: string, now: Date) => Promise<PingItem[]>;
const pingers: [Feature, Pinger][] = [];
export const addPinger = (f: Feature, fn: Pinger) => { pingers.push([f, fn]); };

export type BriefItem = { p: number; text: string };
type Collector = (db: Db, user: User, today: string, now: Date) => Promise<BriefItem[]>;
const collectors: Record<"money" | "paperwork", Collector[]> = { money: [], paperwork: [] };
export const addBrief = (section: "money" | "paperwork", fn: Collector) => { collectors[section].push(fn); };

export const STOP_LINE = `Say "stop money pings" to keep these to your morning brief.`;

/** Which features the person has quietened (pings only; the brief still carries them). */
export const muted = (user: User): string[] => (Array.isArray(user.prefs.moneyQuiet) ? (user.prefs.moneyQuiet as string[]) : []);

export async function wasPinged(db: Db, user: User, key: string): Promise<boolean> {
  return Boolean(await db.one(`SELECT 1 FROM money_pings WHERE user_id=$1 AND key=$2`, [user.id, key]));
}
export async function markPinged(db: Db, user: User, keys: string[]): Promise<void> {
  for (const k of keys) await db.query(`INSERT INTO money_pings (user_id, key) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [user.id, k]);
}

/** The person's own daily money check, created the first time they keep something with a date. */
export async function ensureDaily(db: Db, user: User): Promise<void> {
  const j = await db.one<{ id: number; tz: string | null }>(`SELECT id, tz FROM jobs WHERE user_id=$1 AND kind='money_daily' AND active LIMIT 1`, [user.id]);
  if (!j) { await schedule(db, { userId: user.id, kind: "money_daily", cron: "41 9 * * *", tz: user.tz }); return; }
  if (j.tz !== user.tz) await db.query(`UPDATE jobs SET tz=$2 WHERE id=$1`, [j.id, user.tz]);
}

/** Everything time-sensitive today, at most one line per feature, in one message. Returns what was sent, or null. */
export async function moneySweep(deps: SchedulerDeps, user: User, now = new Date()): Promise<string | null> {
  const today = todayOf(user, now);
  const off = muted(user);
  if (off.includes("all")) return null;
  const parts: { text: string; keys: string[]; button?: PingItem["button"] }[] = [];
  for (const [f, fn] of pingers) {
    if (off.includes(f)) continue;
    let items: PingItem[] = [];
    try { items = await fn(deps.db, user, today, now); } catch (e: any) { log.warn({ err: e?.message, f }, "money pinger failed"); }
    const fresh: PingItem[] = [];
    for (const it of items) if (!(await wasPinged(deps.db, user, it.key)) && !(await wasPinged(deps.db, user, `${f}:day:${today}`))) fresh.push(it);
    if (!fresh.length) continue;
    parts.push({ text: fresh.map((x) => x.text).join(" "), keys: [...fresh.map((x) => x.key), `${f}:day:${today}`], button: fresh.find((x) => x.button)?.button });
  }
  if (!parts.length) return null;
  const body = parts.length === 1 ? parts[0].text : `A few money things today:\n${parts.map((p) => `- ${p.text}`).join("\n")}`;
  const text = `${body}\n\n${STOP_LINE}`;
  const buttons = parts.map((p) => p.button).filter((b): b is NonNullable<typeof b> => Boolean(b)).slice(0, 3);
  const ok = await push(deps, user, "money", text, { buttons: buttons.length ? buttons : undefined, now });
  if (!ok) return null;
  await markPinged(deps.db, user, parts.flatMap((p) => p.keys));
  return text;
}

onJob("money_daily", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  if (job.tz !== user.tz) await deps.db.query(`UPDATE jobs SET tz=$2 WHERE id=$1`, [job.id, user.tz]);
  await moneySweep(deps, user, new Date());
});

async function sectionLines(section: "money" | "paperwork", db: Db, user: User, now: Date): Promise<string[]> {
  const today = todayOf(user, now);
  const all: BriefItem[] = [];
  for (const fn of collectors[section]) {
    try { all.push(...(await fn(db, user, today, now))); } catch (e: any) { log.warn({ err: e?.message, section }, "money brief failed"); }
  }
  return all.sort((a, b) => a.p - b.p).slice(0, 2).map((x) => x.text);
}
addBriefSection({ key: "money_paperwork", order: 15, lines: (db, user, now) => sectionLines("paperwork", db, user, now) });
addBriefSection({ key: "money_money", order: 25, lines: (db, user, now) => sectionLines("money", db, user, now) });

/* ---------------- buttons ---------------- */

type ButtonFn = (ctx: Ctx, parts: string[]) => Promise<ButtonReply>;
const buttonFns = new Map<string, ButtonFn>();
/** A button "mn:<name>:..." comes to `fn` with the parts after the name. */
export const addMoneyButton = (name: string, fn: ButtonFn) => { buttonFns.set(name, fn); };
addButtons("mn", async (db, user, data, now) => {
  const [, name, ...parts] = data.split(":");
  const fn = buttonFns.get(name);
  if (!fn) return { text: "That button doesn't do anything any more." };
  return fn({ db, user, now, sourceMessage: `[button ${data}]` }, parts);
});

/** Run an action from a button and say what happened, the same way a typed message would. */
export async function runFromButton(ctx: Ctx, action: string, args: unknown): Promise<ButtonReply> {
  return render(ctx, await propose(ctx, action, args));
}
export async function render(ctx: Ctx, d: Decision): Promise<ButtonReply> {
  switch (d.kind) {
    case "ran": return { text: d.reply, buttons: [...(d.extra?.buttons ?? []), ...(d.undoId ? [{ label: "Undo", data: `undo:${d.undoId}` }] : [])] };
    case "pending": return { text: `${d.echo}\n\nGo ahead? This waits ten minutes for a yes.`, buttons: [{ label: "Yes, go ahead", data: `confirm:${d.pendingId}` }, { label: "No", data: `cancel:${d.pendingId}` }] };
    case "ask": await setThread(ctx.db, ctx.user, d.thread); return { text: d.reply };
    default: return { text: d.reply };
  }
}

/* ---------------- a short model call, only where it earns its cost ---------------- */

export async function think(db: Db, user: User, instruction: string, max = 160): Promise<string | null> {
  if (!providerName() || (await overBudget(db, user.id))) return null;
  try {
    const r = await complete({ system: "You are lifeline, a calm personal assistant. Plain sentences, no emoji, no em dashes. Information only: never legal, tax or financial advice.", messages: [{ role: "user", content: instruction }], maxTokens: max });
    if (!r?.text) return null;
    await recordUsage(db, user.id, r.usage.input, r.usage.output);
    return r.text.trim();
  } catch (e: any) { log.warn({ err: e?.message }, "money model call failed"); return null; }
}

export async function setPrefs(ctx: Ctx, patch: Record<string, unknown>): Promise<void> {
  await ctx.db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [ctx.user.id, JSON.stringify(patch)]);
  Object.assign(ctx.user.prefs, patch);
}

/* ---------------- the off switch, in words ---------------- */

const FEATURE_WORDS: [RegExp, Feature | "all"][] = [
  [/^(?:money|paperwork|money and paperwork)$/, "all"],
  [/^(?:subscriptions?|renewals?|subs?)$/, "subs"],
  [/^(?:documents?|docs?|expiry|expiries|passport|visa|id)$/, "docs"],
  [/^(?:rent|mortgage|home payments?)$/, "rent"],
  [/^(?:warranty|warranties|returns?|return windows?)$/, "warranty"],
  [/^(?:invoices?|invoice chasing)$/, "invoices"],
  [/^(?:tax|taxes|tax deadline)$/, "tax"],
  [/^(?:savings circle|circle|ajo|esusu|tontine|chama|tanda|susu|hui|rosca)$/, "circle"],
  [/^(?:cool[- ]?off|wishlist|impulse)$/, "cooloff"],
  [/^(?:ious?|debts? owed)$/, "ious"],
];
const FEATURE_SAY: Record<string, string> = { all: "money and paperwork", subs: "subscription", docs: "document", rent: "rent", warranty: "warranty and return", invoices: "invoice", tax: "tax", circle: "savings circle", cooloff: "cool-off", ious: "IOU" };

const quiet = defineAction({
  name: "money.quiet",
  tier: 1,
  description: "Turn money and paperwork pings off or back on, for everything ('feature' all) or one of: subs, docs, rent, warranty, invoices, tax, circle, cooloff, ious. Off means it waits for the morning brief instead of pinging.",
  schema: z.object({ feature: z.string().optional(), on: z.boolean() }),
  async run(args, ctx) {
    const w = (args.feature ?? "money").toLowerCase().trim();
    const f = FEATURE_WORDS.find(([r]) => r.test(w))?.[1] ?? "all";
    const prev = muted(ctx.user);
    const next = args.on ? (f === "all" ? [] : prev.filter((x) => x !== f)) : [...new Set([...prev, f])];
    await setPrefs(ctx, { moneyQuiet: next });
    const label = FEATURE_SAY[f];
    return args.on
      ? { reply: `${cap(label)} pings are back on. I still only ping when a date is close, once a day at most.`, undo: { payload: { prev } } }
      : { reply: `No more ${label} pings. They'll wait for your morning brief instead. Say "${label === "money and paperwork" ? "money" : label} pings on" to bring them back.`, undo: { payload: { prev } } };
  },
  async undo(p, ctx) { await setPrefs(ctx, { moneyQuiet: p.prev }); return "Back how it was."; },
});
register(quiet);
const FW = "(money|paperwork|money and paperwork|subscriptions?|subscription|renewals?|documents?|document|docs?|expiry|passport|visa|rent|mortgage|warranty|warranties|returns?|invoices?|invoice|tax|taxes|savings circle|circle|ajo|esusu|tontine|chama|tanda|susu|cool[- ]?off|wishlist|ious?)";
addRules(
  [re(`(?:stop|no more|mute|pause|turn off|quiet)(?: the| my)? ${FW} (?:pings|reminders|nudges|alerts|check-?ins|notifications)`), (m) => ({ action: "money.quiet", args: { feature: m[1], on: false } })],
  [re(`(?:turn on|resume|unmute|start)(?: the| my)? ${FW} (?:pings|reminders|nudges|alerts|check-?ins|notifications)|${FW} (?:pings|reminders|nudges|alerts) (?:back )?on`), (m) => ({ action: "money.quiet", args: { feature: m[1] ?? m[2], on: true } })],
);
addExamples("money.quiet", ["stop money pings", "stop the subscription reminders", "no more rent reminders", "money pings on"]);
addCues("money", ["money pings", "stop money", "paperwork pings", "money reminders"]);
