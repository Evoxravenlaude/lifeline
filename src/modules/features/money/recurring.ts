/**
 * Money that comes round again: subscriptions with a renewal radar, rent and home payments, and the
 * tax year (your own deadline, your own income log). Information only, never legal or tax advice.
 */
import { z } from "zod";
import { defineAction, type Ctx, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addPhotoAction, addRules, addSchema } from "../../../core/plugins.js";
import { allow, mediaAbilities, search } from "../../../core/media.js";
import { countryOf, userCurrency } from "../../../core/money.js";
import type { Db } from "../../../core/db.js";
import {
  AMT, DATEISH, PERIOD, addBrief, addPeriod, addPinger, amt, byName, cap, clean, dayOfMonth, daysUntil, dt, ensureDaily, fmt, isCrypto, nextMonthly,
  normCur, parseDay, periodOf, plural, re, sayDate, sayIn, setPrefs, todayOf, totals,
} from "./common.js";

addSchema(`CREATE TABLE IF NOT EXISTS money_subs (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT NOT NULL, amount NUMERIC NOT NULL, currency TEXT NOT NULL, period TEXT NOT NULL DEFAULT 'monthly', day INT, next_on DATE, active BOOLEAN NOT NULL DEFAULT true, cancelled_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS money_rent (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), label TEXT NOT NULL DEFAULT 'rent', amount NUMERIC NOT NULL, currency TEXT NOT NULL, period TEXT NOT NULL, day INT, next_on DATE NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS money_rent_paid (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), rent_id INT NOT NULL REFERENCES money_rent(id), amount NUMERIC NOT NULL, currency TEXT NOT NULL, for_on DATE NOT NULL, paid_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS money_income (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), amount NUMERIC NOT NULL, currency TEXT NOT NULL, source TEXT, kind TEXT NOT NULL DEFAULT 'income', earned_on DATE NOT NULL, created_at TIMESTAMPTZ DEFAULT now())`);

const per = (p: string) => (p === "yearly" ? "a year" : p === "weekly" ? "a week" : p === "fortnightly" ? "every two weeks" : "a month");
const monthlyOf = (amount: number, p: string) => (p === "yearly" ? amount / 12 : p === "weekly" ? (amount * 52) / 12 : p === "fortnightly" ? (amount * 26) / 12 : amount);

/** The next renewal from what someone said: "the 3rd", "12 March", "Friday". Rolled forward past today. */
function nextFrom(when: string, period: string, user: User, now: Date): { next: string; day: number | null } | null {
  const today = todayOf(user, now);
  const dom = dayOfMonth(when);
  if (dom) return { next: nextMonthly(dom, today), day: dom };
  let d = parseDay(when, user, now);
  if (!d) return null;
  for (let i = 0; d < today && i < 600; i++) d = addPeriod(d, period);
  return { next: d, day: period === "monthly" ? dt(d).day : null };
}

/* ================= subscriptions ================= */

interface Sub { id: number; name: string; amount: string; currency: string; period: string; day: number | null; next_on: string | null }
async function subs(db: Db, user: User, now: Date): Promise<Sub[]> {
  const today = todayOf(user, now);
  const rows = await db.query<Sub>(`SELECT id, name, amount::text, currency, period, day, next_on::text FROM money_subs WHERE user_id=$1 AND active ORDER BY next_on NULLS LAST, name`, [user.id]);
  for (const r of rows) {
    if (!r.next_on || r.next_on >= today) continue;
    let d = r.next_on;
    for (let i = 0; d < today && i < 600; i++) d = addPeriod(d, r.period, r.day);
    await db.query(`UPDATE money_subs SET next_on=$2 WHERE id=$1`, [r.id, d]);
    r.next_on = d;
  }
  return rows.sort((a, b) => (a.next_on ?? "9999").localeCompare(b.next_on ?? "9999"));
}
function monthlyTotal(rows: Sub[]): string {
  return totals(rows.map((r) => ({ amount: Math.round(monthlyOf(Number(r.amount), r.period) * 100) / 100, currency: r.currency })));
}

const subAdd = defineAction({
  name: "sub.add",
  tier: 1,
  description: "Keep a subscription (Netflix, Spotify, a gym, an app) with its 'amount', 'period' monthly/yearly/weekly and when it renews ('when': 'the 3rd', '12 March'). Also updates one already kept, e.g. just its renewal date. I ping 3 days before each renewal.",
  schema: z.object({ name: z.string().min(1).max(50), amount: z.number().positive().optional(), currency: z.string().max(8).optional(), period: z.enum(["weekly", "fortnightly", "monthly", "yearly"]).optional(), when: z.string().optional() }),
  async run(args, ctx) {
    const name = cap(clean(args.name).replace(/\s+(?:subscription|membership|sub|plan)$/i, ""));
    const existing = byName(await subs(ctx.db, ctx.user, ctx.now), "name", name);
    const period = args.period ?? existing?.period ?? "monthly";
    const nx = args.when ? nextFrom(args.when, period, ctx.user, ctx.now) : null;
    if (args.when && !nx) throw new Error(`I couldn't read when ${name} renews from "${args.when}". Say it like "on the 3rd" or "12 March".`);
    let id: number, prev: Sub | null = null;
    if (existing && (!args.amount || existing.name.toLowerCase() === name.toLowerCase())) {
      prev = existing;
      id = existing.id;
      await ctx.db.query(`UPDATE money_subs SET amount=COALESCE($2,amount), currency=COALESCE($3,currency), period=$4, next_on=COALESCE($5,next_on), day=COALESCE($6,day) WHERE id=$1`,
        [id, args.amount ?? null, args.amount ? normCur(args.currency, ctx.user) : null, period, nx?.next ?? null, nx?.day ?? null]);
    } else {
      if (!args.amount) throw new Error(`How much is ${name}, and is it monthly or yearly? Like "${name} 15.49 monthly renews on the 3rd".`);
      id = (await ctx.db.one<{ id: number }>(`INSERT INTO money_subs (user_id, name, amount, currency, period, day, next_on) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [ctx.user.id, name, args.amount, normCur(args.currency, ctx.user), period, nx?.day ?? null, nx?.next ?? null]))!.id;
    }
    await ensureDaily(ctx.db, ctx.user);
    const all = await subs(ctx.db, ctx.user, ctx.now);
    const s = all.find((x) => x.id === id)!;
    const renew = s.next_on ? `, renews ${sayDate(s.next_on, ctx.user, ctx.now)}` : "";
    const ping = s.next_on ? "I'll ping you 3 days before each renewal." : `Tell me when it renews ("${s.name} renews on the 3rd") and I'll ping you 3 days before.`;
    const sum = all.length > 1 ? ` That's about ${monthlyTotal(all)} a month across ${all.length} subscriptions.` : "";
    return { reply: `${s.name}, ${fmt(s.amount, s.currency)} ${per(s.period)}${renew}. ${ping}${sum}`, undo: { payload: { id, prev } } };
  },
  async undo(p, ctx) {
    if (p.prev) await ctx.db.query(`UPDATE money_subs SET amount=$2, currency=$3, period=$4, day=$5, next_on=$6 WHERE id=$1 AND user_id=$7`, [p.id, p.prev.amount, p.prev.currency, p.prev.period, p.prev.day, p.prev.next_on, ctx.user.id]);
    else await ctx.db.query(`DELETE FROM money_subs WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Taken back.";
  },
});

const subList = defineAction({
  name: "sub.list",
  tier: 1,
  description: "Show the person's subscriptions, when each renews, and the monthly total in their currency (per currency when they differ).",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await subs(ctx.db, ctx.user, ctx.now);
    if (!rows.length) return { reply: `No subscriptions kept yet. Say "Netflix 15.49 monthly renews on the 3rd" and I'll warn you before each renewal.` };
    const lines = rows.map((r) => `- ${r.name}: ${fmt(r.amount, r.currency)} ${per(r.period)}${r.next_on ? `, renews ${sayDate(r.next_on, ctx.user, ctx.now)}` : ""}`);
    return { reply: [`About ${monthlyTotal(rows)} a month across ${plural(rows.length, "subscription")}.`, ...lines, "", `"cancel Netflix" gives the steps to get out of one.`].join("\n") };
  },
});

const GENERIC_CANCEL = (name: string) => [
  `Here's the usual way out of ${name}:`,
  `- Open ${name}'s app or website and sign in.`,
  "- Go to Account or Settings, then Subscription, Membership or Billing.",
  "- Choose Cancel and follow it to the end; there's often an offer to stay first.",
  "- Bought through the App Store or Google Play? Cancel there instead: Settings, your name, Subscriptions on iPhone; Play Store, Payments and subscriptions on Android.",
  "- Screenshot the confirmation, and check your next statement.",
].join("\n");

const subCancelHelp = defineAction({
  name: "sub.cancel_help",
  tier: 1,
  description: "How to cancel a subscription, in plain steps (looked up on the web when possible). I never cancel anything myself.",
  schema: z.object({ name: z.string().min(1).max(50) }),
  async run(args, ctx) {
    const kept = byName(await subs(ctx.db, ctx.user, ctx.now), "name", args.name);
    const name = kept?.name ?? cap(clean(args.name).replace(/\s+(?:subscription|membership|plan)$/i, ""));
    const after = `\n\nI can't cancel it for you. Once it's done, say "I cancelled ${name}" and I'll stop watching it.${kept?.next_on ? ` It next renews ${sayDate(kept.next_on, ctx.user, ctx.now)}.` : ""}`;
    if (mediaAbilities().search && allow("search", ctx.user.id)) {
      const country = countryOf(ctx.user);
      const f = await search(`How do I cancel a ${name} subscription${country ? ` (I'm in country code ${country})` : ""}? Give the official steps as a short numbered list, and say if it differs when billed through the App Store, Google Play or a mobile carrier.`, ctx.user.tz);
      if (f?.answer) {
        const src = f.sources.length ? `\n\nSources: ${f.sources.slice(0, 2).map((s) => `[${(s.title ?? new URL(s.uri).hostname).replace(/[[\]]/g, "")}](${s.uri})`).join(", ")}` : "";
        return { reply: `${f.answer.trim().slice(0, 1200)}${src}${after}` };
      }
    }
    return { reply: GENERIC_CANCEL(name) + after };
  },
});

const subCancelled = defineAction({
  name: "sub.cancelled",
  tier: 1,
  description: "The person has cancelled a subscription themselves: stop tracking it and its renewal pings.",
  schema: z.object({ name: z.string().min(1).max(50) }),
  async run(args, ctx) {
    const s = byName(await subs(ctx.db, ctx.user, ctx.now), "name", args.name.replace(/\s+(?:subscription|membership|plan)$/i, ""));
    if (!s) return { reply: `I wasn't keeping ${cap(clean(args.name))}, so there's nothing to stop. Say "my subscriptions" to see what I have.` };
    await ctx.db.query(`UPDATE money_subs SET active=false, cancelled_at=$2 WHERE id=$1`, [s.id, ctx.now]);
    return { reply: `${s.name} is off the list. That's ${fmt(Math.round(monthlyOf(Number(s.amount), s.period) * 100) / 100, s.currency)} a month back with you.`, undo: { payload: { id: s.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE money_subs SET active=true, cancelled_at=NULL WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Back on the list."; },
});

/* ================= rent and home payments ================= */

interface Rent { id: number; label: string; amount: string; currency: string; period: string; day: number | null; next_on: string }
const rentRows = (db: Db, user: User) => db.query<Rent>(`SELECT id, label, amount::text, currency, period, day, next_on::text FROM money_rent WHERE user_id=$1 AND active ORDER BY id`, [user.id]);
function savingTarget(r: Rent, user: User, now: Date): string | null {
  if (r.period !== "yearly") return null;
  const months = Math.max(1, Math.ceil(daysUntil(r.next_on, user, now) / 30.4));
  return `${months === 1 ? "That's about a month away, so" : `That's ${plural(months, "month")} away, so`} putting aside about ${fmt(Math.ceil(Number(r.amount) / months), r.currency)} a month gets you there.`;
}

const rentSet = defineAction({
  name: "rent.set",
  tier: 1,
  description: "Keep the person's rent or another home payment (mortgage, service charge): 'amount', 'period' monthly or yearly, and when it's due ('when': 'the 1st', '1 March'). I count down to it and, for yearly rent, work out a monthly saving target. Information only.",
  schema: z.object({ amount: z.number().positive(), currency: z.string().max(8).optional(), period: z.enum(["monthly", "yearly"]).optional(), when: z.string().optional(), label: z.string().max(40).optional() }),
  needs(args) { return args.when ? null : { need: "when", question: "When is it due? Like \"the 1st\" for monthly, or \"1 March\" for a yearly payment." }; },
  fill(need, answer) { return need === "when" && (dayOfMonth(answer) || /\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|next|end/i.test(answer)) ? { when: answer } : null; },
  async run(args, ctx) {
    const period = args.period ?? "monthly";
    const label = clean(args.label ?? "rent").toLowerCase();
    const nx = nextFrom(args.when!, period, ctx.user, ctx.now);
    if (!nx) throw new Error(`I couldn't read a date in "${args.when}". When is your ${label} due?`);
    const cur = normCur(args.currency, ctx.user);
    const old = (await rentRows(ctx.db, ctx.user)).filter((r) => r.label === label).map((r) => r.id);
    if (old.length) await ctx.db.query(`UPDATE money_rent SET active=false WHERE id = ANY($1::int[])`, [old]);
    const r = (await ctx.db.one<Rent>(`INSERT INTO money_rent (user_id, label, amount, currency, period, day, next_on) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, label, amount::text, currency, period, day, next_on::text`, [ctx.user.id, label, args.amount, cur, period, nx.day, nx.next]))!;
    await ensureDaily(ctx.db, ctx.user);
    const when = period === "monthly" && nx.day ? `due on the ${ordinal(nx.day)} of each month; next on ${sayDate(r.next_on, ctx.user, ctx.now)}` : `due ${sayDate(r.next_on, ctx.user, ctx.now)}`;
    const head = `${cap(label)}, ${fmt(args.amount, cur)} ${per(period)}, ${when}.`;
    const tail = period === "yearly" ? ` ${savingTarget(r, ctx.user, ctx.now)} I'll remind you 30 and 7 days before.` : ` I'll remind you 3 days before, and "paid ${label}" logs it.`;
    return { reply: head + tail, undo: { payload: { id: r.id, old } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM money_rent WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    if (p.old?.length) await ctx.db.query(`UPDATE money_rent SET active=true WHERE id = ANY($1::int[]) AND user_id=$2`, [p.old, ctx.user.id]);
    return "Taken back.";
  },
});
const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

const rentPaid = defineAction({
  name: "rent.paid",
  tier: 1,
  description: "Log that the person paid their rent (or mortgage, service charge), and move the countdown to the next due date.",
  schema: z.object({ amount: z.number().positive().optional(), currency: z.string().max(8).optional(), label: z.string().optional() }),
  async run(args, ctx) {
    const rows = await rentRows(ctx.db, ctx.user);
    const r = (args.label ? byName(rows, "label", args.label) : undefined) ?? rows[0];
    if (!r) return { reply: `I'm not keeping your rent yet. Say "rent 1200 due on the 1st monthly" and I'll count down to it.` };
    const amount = args.amount ?? Number(r.amount);
    const cur = args.amount ? normCur(args.currency ?? r.currency, ctx.user) : r.currency;
    const pay = await ctx.db.one<{ id: number }>(`INSERT INTO money_rent_paid (user_id, rent_id, amount, currency, for_on, paid_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.user.id, r.id, amount, cur, r.next_on, ctx.now]);
    const next = addPeriod(r.next_on, r.period, r.day);
    await ctx.db.query(`UPDATE money_rent SET next_on=$2 WHERE id=$1`, [r.id, next]);
    const short = amount < Number(r.amount) && cur === r.currency ? ` That's ${fmt(Number(r.amount) - amount, cur)} short of the usual; tell me if the rest is coming.` : "";
    return { reply: `${cap(r.label)} paid, ${fmt(amount, cur)}, logged. Next due ${sayDate(next, ctx.user, ctx.now)}.${short}`, undo: { payload: { id: r.id, pay: pay!.id, prev: r.next_on } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM money_rent_paid WHERE id=$1 AND user_id=$2`, [p.pay, ctx.user.id]);
    await ctx.db.query(`UPDATE money_rent SET next_on=$2 WHERE id=$1 AND user_id=$3`, [p.id, p.prev, ctx.user.id]);
    return "Payment taken off; the countdown is back.";
  },
});

const rentShow = defineAction({
  name: "rent.show",
  tier: 1,
  description: "When the person's rent (or other home payment) is next due, how long until then, the saving target for yearly rent, and when they last paid.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await rentRows(ctx.db, ctx.user);
    if (!rows.length) return { reply: `I'm not keeping your rent yet. Say "rent 1200 due on the 1st monthly", or "rent 1.8m due 1 March yearly".` };
    const out: string[] = [];
    for (const r of rows) {
      const d = daysUntil(r.next_on, ctx.user, ctx.now);
      const last = await ctx.db.one<{ paid_at: string; amount: string; currency: string }>(`SELECT paid_at, amount::text, currency FROM money_rent_paid WHERE rent_id=$1 ORDER BY id DESC LIMIT 1`, [r.id]);
      const lastLine = last ? ` Last paid ${sayDate(new Date(last.paid_at).toISOString().slice(0, 10), ctx.user, ctx.now)}.` : "";
      const due = d < 0 ? `was due ${sayDate(r.next_on, ctx.user, ctx.now)}; say "paid ${r.label}" once it's sorted` : `next due ${sayDate(r.next_on, ctx.user, ctx.now)}, ${sayIn(d)}`;
      out.push(`${cap(r.label)}: ${fmt(r.amount, r.currency)} ${per(r.period)}, ${due}.${lastLine}${savingTarget(r, ctx.user, ctx.now) && d >= 0 ? ` ${savingTarget(r, ctx.user, ctx.now)}` : ""}`);
    }
    return { reply: out.join("\n") };
  },
});

/* ================= tax year ================= */

const AUTHORITY: Record<string, string> = {
  NG: "the Federal Inland Revenue Service (FIRS), or your state's Internal Revenue Service", GH: "the Ghana Revenue Authority", KE: "the Kenya Revenue Authority on iTax", ZA: "SARS",
  UG: "the Uganda Revenue Authority", TZ: "the Tanzania Revenue Authority", RW: "the Rwanda Revenue Authority", EG: "the Egyptian Tax Authority", MA: "the Direction Générale des Impôts",
  SN: "the Direction Générale des Impôts et des Domaines", CI: "the Direction Générale des Impôts", CM: "the Direction Générale des Impôts", GA: "the Direction Générale des Impôts",
  GB: "HMRC on GOV.UK", IE: "Revenue (revenue.ie)", US: "the IRS, plus your state's tax department", CA: "the Canada Revenue Agency", AU: "the Australian Taxation Office", NZ: "Inland Revenue",
  IN: "the Income Tax Department's e-filing portal", PK: "the Federal Board of Revenue", BD: "the National Board of Revenue", DE: "your Finanzamt (ELSTER)", FR: "impots.gouv.fr",
  ES: "the Agencia Tributaria", IT: "the Agenzia delle Entrate", NL: "the Belastingdienst", BE: "SPF Finances (MyMinfin)", PT: "the Portal das Finanças", BR: "the Receita Federal", MX: "the SAT",
  AR: "AFIP", CO: "the DIAN", JP: "the National Tax Agency", KR: "the National Tax Service", SG: "IRAS", MY: "LHDN (Inland Revenue Board)", PH: "the BIR", ID: "the Direktorat Jenderal Pajak",
  AE: "the Federal Tax Authority", SA: "ZATCA", TR: "the Gelir İdaresi Başkanlığı", PL: "the Krajowa Administracja Skarbowa", SE: "Skatteverket", NO: "Skatteetaten", DK: "Skattestyrelsen", CH: "your canton's tax office",
};
const authorityFor = (c: string | null) => (c && AUTHORITY[c]) || "your country's official tax authority";
const ALIASES: Record<string, string> = { uk: "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB", usa: "US", us: "US", america: "US", "united states of america": "US", uae: "AE", emirates: "AE", "ivory coast": "CI", drc: "CD", "dr congo": "CD", holland: "NL", "south korea": "KR", korea: "KR", russia: "RU", "the netherlands": "NL", "czech republic": "CZ" };
let names: Map<string, string> | null = null;
/** Any country, by name or two-letter code, from the runtime's own list of regions. */
export function countryCode(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/^the\s+/, "").replace(/[.!]$/, "");
  if (ALIASES[t]) return ALIASES[t];
  if (!names) {
    names = new Map();
    const dn = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try { const n = dn.of(code)?.toLowerCase(); if (n && n !== code.toLowerCase() && !names.has(n)) names.set(n, code); } catch { /* not a region */ }
    }
  }
  if (/^[a-z]{2}$/.test(t)) { const up = t.toUpperCase(); return [...names.values()].includes(up) ? up : null; }
  return names.get(t) ?? [...names].find(([n]) => n.startsWith(t) && t.length >= 4)?.[1] ?? null;
}
const countryName = (c: string) => { try { return new Intl.DisplayNames(["en"], { type: "region" }).of(c) ?? c; } catch { return c; } };

interface TaxPrefs { deadline?: string; yearStart?: string; askedCountry?: boolean }
const taxPrefs = (user: User): TaxPrefs => ((user.prefs.moneyTax as TaxPrefs | undefined) ?? {});
function nextOfMonthDay(md: string, today: string): string {
  const y = dt(today).year;
  let d = dt(`${y}-${md}`);
  if (!d.isValid) d = dt(`${y}-${md.slice(0, 3)}28`);
  if (d.toISODate()! < today) d = d.plus({ years: 1 });
  return d.toISODate()!;
}
function taxYearStart(user: User, today: string): string {
  const md = taxPrefs(user).yearStart ?? "01-01";
  const y = dt(today).year;
  const d = `${y}-${md}`;
  return d <= today ? d : `${y - 1}-${md}`;
}
async function countryNote(ctx: Ctx): Promise<string> {
  const c = typeof ctx.user.prefs.country === "string" ? (ctx.user.prefs.country as string).toUpperCase() : null;
  if (c) return ` I don't give tax advice; ${authorityFor(c)} has the official rules.`;
  const tp = taxPrefs(ctx.user);
  if (tp.askedCountry) return ` I don't give tax advice; ${authorityFor(countryOf(ctx.user))} has the official rules.`;
  await setPrefs(ctx, { moneyTax: { ...tp, askedCountry: true } });
  return ` I don't give tax advice, but I can point you to the right official site: which country do you file in? Say "I file taxes in Kenya", for example.`;
}

const taxDeadline = defineAction({
  name: "tax.deadline",
  tier: 1,
  description: "Set the person's own tax filing deadline ('when', e.g. '31 January'); I remind them 30 and 7 days before, every year. Never tax advice.",
  schema: z.object({ when: z.string().min(2) }),
  async run(args, ctx) {
    const d = parseDay(args.when, ctx.user, ctx.now);
    if (!d) throw new Error(`I couldn't read a date in "${args.when}". When is your tax deadline?`);
    const tp = taxPrefs(ctx.user);
    await setPrefs(ctx, { moneyTax: { ...tp, deadline: d.slice(5) } });
    await ensureDaily(ctx.db, ctx.user);
    const next = nextOfMonthDay(d.slice(5), todayOf(ctx.user, ctx.now));
    return { reply: `Your tax deadline: ${dt(next).toFormat("d LLLL")}, ${sayIn(daysUntil(next, ctx.user, ctx.now))}. I'll remind you 30 and 7 days before.${await countryNote(ctx)}`, undo: { payload: { prev: tp } } };
  },
  async undo(p, ctx) { await setPrefs(ctx, { moneyTax: p.prev }); return "Tax deadline taken back."; },
});

const taxYear = defineAction({
  name: "tax.year",
  tier: 1,
  description: "Set when the person's tax year starts ('when', e.g. '6 April' or '1 July'), so 'my income this year' counts the right months.",
  schema: z.object({ when: z.string().min(2) }),
  async run(args, ctx) {
    const d = parseDay(args.when, ctx.user, ctx.now);
    if (!d) throw new Error(`I couldn't read a date in "${args.when}". When does your tax year start?`);
    const tp = taxPrefs(ctx.user);
    await setPrefs(ctx, { moneyTax: { ...tp, yearStart: d.slice(5) } });
    return { reply: `Your tax year starts ${dt(d).toFormat("d LLLL")}. "my income this year" counts from there.`, undo: { payload: { prev: tp } } };
  },
  async undo(p, ctx) { await setPrefs(ctx, { moneyTax: p.prev }); return "Taken back."; },
});

const taxCountry = defineAction({
  name: "tax.country",
  tier: 1,
  description: "Set the country the person files taxes in (any country, by name or two-letter code), so I can point to its official tax authority. Also sets their home country.",
  schema: z.object({ country: z.string().min(2).max(60) }),
  async run(args, ctx) {
    const c = countryCode(args.country);
    if (!c) throw new Error(`I don't know a country called "${args.country}". Try its full name, like "Kenya" or "United Kingdom".`);
    const prev = ctx.user.prefs.country ?? null;
    await setPrefs(ctx, { country: c });
    const cur = typeof ctx.user.prefs.currency === "string" ? "" : ` Amounts without a currency are in ${userCurrency(ctx.user)} now; say "my currency is ..." to change that.`;
    return { reply: `${countryName(c)}. For the rules themselves, ${authorityFor(c)} is the official source.${cur}`, undo: { payload: { prev } } };
  },
  async undo(p, ctx) {
    if (p.prev) await setPrefs(ctx, { country: p.prev });
    else { await ctx.db.query(`UPDATE users SET prefs = prefs - 'country' WHERE id=$1`, [ctx.user.id]); delete ctx.user.prefs.country; }
    return "Country taken back.";
  },
});

const CRYPTO_SOURCE = /stak|airdrop|mining|mined|defi|yield|validator|liquidity|lp\b|nft|trading/i;
const incomeLog = defineAction({
  name: "tax.income_log",
  tier: 1,
  description: "Log income for the person's own tax-year record (freelance work, crypto earnings, side jobs): 'amount', 'source' (client or where it came from), optional 'kind' freelance, crypto or other, optional 'when'.",
  schema: z.object({ amount: z.number().positive(), currency: z.string().max(8).optional(), source: z.string().max(80).optional(), kind: z.enum(["freelance", "crypto", "salary", "other"]).optional(), when: z.string().optional() }),
  async run(args, ctx) {
    const cur = normCur(args.currency, ctx.user);
    const on = (args.when ? parseDay(args.when, ctx.user, ctx.now) : null) ?? todayOf(ctx.user, ctx.now);
    const source = args.source ? cap(clean(args.source)) : null;
    const kind = args.kind ?? (isCrypto(cur) || (source && CRYPTO_SOURCE.test(source)) ? "crypto" : "freelance");
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO money_income (user_id, amount, currency, source, kind, earned_on) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.user.id, args.amount, cur, source, kind, on]);
    const since = taxYearStart(ctx.user, todayOf(ctx.user, ctx.now));
    const tot = await ctx.db.query<{ amount: string; currency: string }>(`SELECT sum(amount)::text AS amount, currency FROM money_income WHERE user_id=$1 AND earned_on >= $2 AND currency=$3 GROUP BY currency`, [ctx.user.id, since, cur]);
    return { reply: `${fmt(args.amount, cur)}${source ? ` from ${source}` : ""}, logged. ${totals(tot)} so far this tax year. "my income this year" shows it all.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM money_income WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Taken off the income log."; },
});

const incomeSummary = defineAction({
  name: "tax.income_summary",
  tier: 1,
  description: "The person's logged income this tax year: totals per currency, split freelance and crypto, and the biggest sources. Their own record, not tax advice.",
  schema: z.object({}),
  async run(_a, ctx) {
    const today = todayOf(ctx.user, ctx.now);
    const since = taxYearStart(ctx.user, today);
    const rows = await ctx.db.query<{ amount: string; currency: string; source: string | null; kind: string }>(`SELECT amount::text, currency, source, kind FROM money_income WHERE user_id=$1 AND earned_on >= $2 ORDER BY earned_on`, [ctx.user.id, since]);
    if (!rows.length) return { reply: `Nothing logged since ${dt(since).toFormat("d LLLL")}. Say "log income 2000 from Acme" whenever money comes in.` };
    const lines = [`Since ${dt(since).toFormat("d LLLL")}: ${totals(rows)}, across ${plural(rows.length, "payment")}.`];
    const kinds = [...new Set(rows.map((r) => r.kind))];
    if (kinds.length > 1) for (const k of kinds) lines.push(`- ${cap(k)}: ${totals(rows.filter((r) => r.kind === k))}`);
    const by = new Map<string, { amount: number; currency: string }>();
    for (const r of rows) if (r.source) { const k = `${r.source}|${r.currency}`; by.set(k, { amount: (by.get(k)?.amount ?? 0) + Number(r.amount), currency: r.currency }); }
    const top = [...by].sort((a, b) => b[1].amount - a[1].amount).slice(0, 3);
    if (top.length) lines.push(`Biggest: ${top.map(([k, v]) => `${k.split("|")[0]} (${fmt(v.amount, v.currency)})`).join(", ")}.`);
    const c = typeof ctx.user.prefs.country === "string" ? (ctx.user.prefs.country as string) : countryOf(ctx.user);
    lines.push(`It's your own record, not tax advice; ${authorityFor(c)} has the rules on what to declare.`);
    return { reply: lines.join("\n") };
  },
});

register(subAdd, subList, subCancelHelp, subCancelled, rentSet, rentPaid, rentShow, taxDeadline, taxYear, taxCountry, incomeLog, incomeSummary);
addPhotoAction("sub.add");

/* ---------------- words → actions ---------------- */

const NOT_SUB = "(?!(?:rent|my rent|house rent|mortgage|i|i'm|im|we|debt|loan|invoice|income|salary|log|add debt|new debt|debt:)\\b)";
const KNOWN = "netflix|spotify|apple music|apple tv\\+?|apple one|icloud\\+?|youtube premium|youtube music|youtube tv|disney\\+|disney plus|amazon prime|prime video|hbo max|hulu|paramount\\+|peacock|showmax|dstv|gotv|startimes|canal\\+|deezer|tidal|boomplay|audiomack|anghami|crunchyroll|chatgpt(?: plus)?|claude(?: pro)?|github copilot|google one|microsoft 365|office 365|xbox game pass|game pass|playstation plus|ps plus|nintendo switch online|duolingo(?: plus)?|headspace|strava|peloton|canva(?: pro)?|adobe(?: creative cloud)?|dropbox|notion|figma|zoom|linkedin premium|patreon|audible|kindle unlimited|starlink|nordvpn|nord vpn|expressvpn|surfshark|uber one|bolt plus|glovo prime|jumia prime|careem plus|deliveroo plus|gym membership|(?:the |my )?gym";
const subArgs = (name: string, a: string, p: string | undefined, when?: string) => ({ name, ...amt(a), ...(periodOf(p) ? { period: periodOf(p) } : {}), ...(when ? { when } : {}) });

addRules(
  // rent first, so "rent 1200 monthly" is never read as a subscription
  [re(`(?:my\\s+)?(rent|house rent|mortgage|service charge|home loan)(?:\\s+is)?\\s+${AMT}(?:\\s*(?:a\\s+|per\\s+|every\\s+|\\/\\s*)?${PERIOD})?,?(?:\\s+(?:and\\s+)?(?:it'?s\\s+)?(?:due|payable|paid))?(?:\\s+(?:on\\s+)?(?:the\\s+)?(.+?))?(?:,?\\s*(?:a\\s+|per\\s+|every\\s+)?${PERIOD})?`),
    (m) => { const p = periodOf(m[3] ?? m[5]); return { action: "rent.set", args: { label: m[1].toLowerCase(), ...amt(m[2]), ...(p === "yearly" || p === "monthly" ? { period: p } : {}), ...(m[4] ? { when: m[4] } : {}) } }; }],
  [re(`(?:i\\s+(?:just\\s+|have\\s+|'ve\\s+)?)?paid\\s+(?:the\\s+|my\\s+|this month'?s\\s+|this year'?s\\s+)?(rent|mortgage|service charge)(?:\\s+${AMT})?(?:\\s+(?:today|this month|for (?:this|the) month))?|(?:my\\s+|the\\s+)?(rent|mortgage)(?:'s| is)?\\s+paid`), (m) => ({ action: "rent.paid", args: { ...(m[2] ? amt(m[2]) : {}), label: (m[1] ?? m[3]).toLowerCase() } })],
  [re(`(?:my\\s+)?(?:rent|mortgage)(?:\\s+countdown)?|when(?:'s| is)\\s+(?:my\\s+|the\\s+)?(?:rent|mortgage)\\s+due\\??|how long (?:until|till) (?:my )?rent(?: is due)?\\??`), () => ({ action: "rent.show", args: {} })],

  // subscriptions with an amount
  [re(`${NOT_SUB}(?:my\\s+)?(.{1,40}?)\\s+(?:subscription\\s+|sub\\s+|plan\\s+|membership\\s+)?(?:is\\s+|costs?\\s+)?${AMT}\\s*(?:a\\s+|per\\s+|every\\s+|\\/\\s*)?${PERIOD}(?:,?\\s+(?:and\\s+)?(?:it\\s+)?(?:renews|renewing|billed|charged|due|bills|comes out|goes out|on)(?:\\s+(?:on|every))?\\s+(.+))?`),
    (m) => ({ action: "sub.add", args: subArgs(m[1], m[2], m[3], m[4]) })],
  [re(`${NOT_SUB}(?:my\\s+)?(.{1,40}?)\\s+(?:subscription\\s+)?${PERIOD}\\s+${AMT}(?:,?\\s+(?:renews\\s+|renewing\\s+|due\\s+|billed\\s+)?(?:on\\s+)?(.+))?`), (m) => ({ action: "sub.add", args: subArgs(m[1], m[3], m[2], m[4]) })],
  [re(`(?:my |list my |show my |all my )?(?:subscriptions|subs)|what am i subscribed to\\??|how much (?:do i spend|am i paying|do i pay) (?:on|for) subscriptions(?: a month)?\\??`), () => ({ action: "sub.list", args: {} })],
  [re(`(?:how (?:do i|to|can i)\\s+)?cancel\\s+(?:my\\s+)?(${KNOWN})(?:\\s+(?:subscription|membership|plan|account))?\\??|(?:how (?:do i|to|can i)\\s+)?cancel\\s+(?:my\\s+|the\\s+)?(.{1,40}?)\\s+(?:subscription|membership)\\??|(?:how (?:do i|to|can i)\\s+)?unsubscribe from\\s+(?:my\\s+)?(.{1,40}?)\\??`), (m) => ({ action: "sub.cancel_help", args: { name: m[1] ?? m[2] ?? m[3] } })],
  [re(`i(?:'ve| have| just)?\\s+(?:cancell?ed|stopped|ended|unsubscribed from|got rid of)\\s+(?:my\\s+)?(${KNOWN})(?:\\s+(?:subscription|membership|plan))?|i(?:'ve| have| just)?\\s+(?:cancell?ed|stopped|ended)\\s+(?:my\\s+|the\\s+)?(.{1,40}?)\\s+(?:subscription|membership)`), (m) => ({ action: "sub.cancelled", args: { name: m[1] ?? m[2] } })],

  // tax
  [re(`(?:my\\s+)?tax(?:es)?\\s+(?:return\\s+)?(?:deadline|filing deadline|due date|return is due|are due|is due)\\s+(?:is\\s+)?(?:on\\s+|by\\s+)?(.+)|i\\s+(?:have\\s+to|need\\s+to|must)\\s+file\\s+(?:my\\s+)?tax(?:es| return)?\\s+by\\s+(.+)`), (m) => ({ action: "tax.deadline", args: { when: m[1] ?? m[2] } })],
  [re(`(?:my\\s+)?tax\\s+year\\s+(?:starts|begins|runs from)\\s+(?:on\\s+)?(.+?)(?:\\s+to\\s+.+)?`), (m) => ({ action: "tax.year", args: { when: m[1] } })],
  [re(`(?:my\\s+)?tax\\s+country\\s+is\\s+(.{2,60})|i\\s+(?:file|pay)\\s+(?:my\\s+)?tax(?:es)?\\s+in\\s+(.{2,60})`), (m) => ({ action: "tax.country", args: { country: m[1] ?? m[2] } })],
  [re(`(?:log|add|record)\\s+(?:my\\s+)?(?:(freelance|crypto|side)\\s+)?income\\s+(?:of\\s+)?${AMT}(?:\\s+(?:from|for)\\s+(.+?))?`), (m) => ({ action: "tax.income_log", args: { ...amt(m[2]), ...(m[3] ? { source: m[3] } : {}), ...(m[1] && m[1].toLowerCase() !== "side" ? { kind: m[1].toLowerCase() } : {}) } })],
  [re(`(?:i\\s+)?(?:earned|got paid|received)\\s+${AMT}\\s+(?:from|for|by)\\s+(.+)`), (m) => ({ action: "tax.income_log", args: { ...amt(m[1]), source: m[2] } })],
  [re(`(?:my\\s+)?(?:income|earnings)(?:\\s+(?:this|so far this)\\s+(?:tax\\s+)?year|\\s+so far)?|how much (?:have i|did i) (?:earn|earned|make|made)(?:\\s+this (?:tax )?year)?\\??`), () => ({ action: "tax.income_summary", args: {} })],
);
/** Added after the documents rules (see index.ts): "Netflix renews on the 3rd" with no amount updates a kept subscription. */
export const subRenewRule = () => addRules([re(`${NOT_SUB}(?:my\\s+)?(.{1,40}?)\\s+(?:subscription\\s+)?(?:renews|renewal is|bills me|charges me)\\s+(?:on\\s+)?(?:every\\s+)?${DATEISH}`), (m) => ({ action: "sub.add", args: { name: m[1], when: m[2] } })]);

addExamples("sub.add", ["Netflix 15.49 monthly renews on the 3rd", "Spotify yearly 99 on 12 March", "Netflix subscription 15.49 monthly", "Showmax 2900 naira monthly renews on the 15th", "Netflix renews on the 5th"]);
addExamples("sub.list", ["my subscriptions", "what am I subscribed to?"]);
addExamples("sub.cancel_help", ["cancel Netflix", "cancel my gym membership", "cancel my Canal+ subscription", "unsubscribe from Showmax"]);
addExamples("sub.cancelled", ["I cancelled Spotify", "I've cancelled my Duolingo subscription"]);
addExamples("rent.set", ["rent 1200 due on the 1st monthly", "rent 1.8m due 1 March yearly", "my rent is 950 a month, due on the 5th"]);
addExamples("rent.paid", ["paid rent", "I paid the rent", "rent paid"]);
addExamples("rent.show", ["when is rent due?", "my rent"]);
addExamples("tax.deadline", ["my tax deadline is 31 January", "taxes are due 30 April"]);
addExamples("tax.year", ["my tax year starts 6 April"]);
addExamples("tax.country", ["I file taxes in Ghana", "my tax country is Canada"]);
addExamples("tax.income_log", ["log income 2000 from Acme", "log crypto income 0.5 ETH from staking", "received $600 from Studio Lima"]);
addExamples("tax.income_summary", ["my income this year", "how much have I earned this year?"]);

addCues("sub", ["subscription", "subscriptions", "subscribed", "renews", "renewal", "netflix", "spotify", "monthly", "yearly", "cancel", "membership"]);
addCues("rent", ["rent", "landlord", "mortgage", "service charge", "lease", "house"]);
addCues("tax", ["tax", "taxes", "tax return", "tax year", "income", "earned", "deadline", "filing", "country"]);

addCapability({
  key: "subscriptions", name: "Subscriptions and renewals",
  cues: ["subscription", "subscriptions", "renews", "renewal", "netflix", "spotify", "cancel", "membership"],
  what: "I keep your subscriptions and their renewal dates, add up what they cost you a month, and give you the plain steps to cancel one.",
  say: ["Netflix 15.49 monthly renews on the 3rd", "Spotify yearly 99 on 12 March", "my subscriptions", "cancel Netflix", "I cancelled Spotify"],
  then: "Three days before a renewal I ping you once, with any others due the same week in the same message. A receipt photo can become one too.",
  limits: "I never cancel anything for you; you do it, and tell me.",
}, "Money");
addCapability({
  key: "rent", name: "Rent and home payments",
  cues: ["rent", "landlord", "mortgage", "service charge", "paid rent"],
  what: "I count down to your rent, monthly or yearly, and for yearly rent work out how much to put aside each month to have it ready.",
  say: ["rent 1200 due on the 1st monthly", "rent 1.8m due 1 March yearly", "paid rent", "when is rent due?"],
  then: "Monthly rent gets a reminder 3 days before; yearly rent at 30 and 7 days. \"paid rent\" logs it and starts the next countdown.",
  limits: "Information only, never legal advice about tenancies.",
}, "Home and paperwork");
addCapability({
  key: "tax_year", name: "Tax year companion",
  cues: ["tax", "taxes", "tax return", "tax deadline", "tax year", "income", "freelance income", "crypto income"],
  what: "Set your own tax deadline and I remind you 30 and 7 days before. Freelancers and crypto earners can log income as it comes in and see the year's total any time.",
  say: ["my tax deadline is 31 January", "log income 2000 from Acme", "my income this year", "I file taxes in Ghana"],
  then: "Tell me your country once and I'll point you to its official tax authority whenever it matters.",
  limits: "Never tax advice. Your tax authority's official site has the rules.",
}, "Money");

/* ---------------- brief and pings ---------------- */

addBrief("money", async (db, user, today, now) => {
  const soon = (await subs(db, user, now)).filter((s) => s.next_on && daysUntil(s.next_on, user, now) >= 0 && daysUntil(s.next_on, user, now) <= 3);
  const out: { p: number; text: string }[] = [];
  if (soon.length) out.push({ p: 20, text: `Renewing soon: ${soon.map((s) => `${s.name} ${sayDate(s.next_on!, user, now)} (${fmt(s.amount, s.currency)})`).join(", ")}.` });
  const tp = taxPrefs(user);
  if (tp.deadline) {
    const next = nextOfMonthDay(tp.deadline, today);
    const d = daysUntil(next, user, now);
    if (d <= 7 || (d <= 30 && d >= 27)) out.push({ p: 22, text: `Your tax deadline is ${dt(next).toFormat("d LLLL")}, ${sayIn(d)}.` });
  }
  return out;
});
addBrief("paperwork", async (db, user, _today, now) => {
  const out: { p: number; text: string }[] = [];
  for (const r of await rentRows(db, user)) {
    const d = daysUntil(r.next_on, user, now);
    const label = cap(r.label);
    if (d < 0 && d >= -5) out.push({ p: 18, text: `${label} was due ${sayDate(r.next_on, user, now)}. Say "paid ${r.label}" once it's sorted.` });
    else if (d >= 0 && (r.period === "monthly" ? d <= 3 : d <= 30)) out.push({ p: 17, text: `${label} (${fmt(r.amount, r.currency)}) is due ${d === 0 ? "today" : `${sayDate(r.next_on, user, now)}, ${sayIn(d)}`}.` });
  }
  return out;
});

addPinger("subs", async (db, user, _today, now) => {
  const due = (await subs(db, user, now)).filter((s) => s.next_on && daysUntil(s.next_on, user, now) >= 1 && daysUntil(s.next_on, user, now) <= 3);
  return due.map((s) => ({ key: `sub:${s.id}:${s.next_on}`, text: `${s.name} renews ${sayDate(s.next_on!, user, now)} for ${fmt(s.amount, s.currency)}${due.length === 1 ? `; "cancel ${s.name}" gives the steps if you want out` : ""}.` }));
});
addPinger("rent", async (db, user, _today, now) => {
  const out = [];
  for (const r of await rentRows(db, user)) {
    const d = daysUntil(r.next_on, user, now);
    const step = r.period === "monthly" ? (d >= 0 && d <= 3 ? 3 : 0) : d >= 0 && d <= 7 ? 7 : d > 7 && d <= 30 ? 30 : 0;
    if (!step) continue;
    const target = r.period === "yearly" && step === 30 ? ` ${savingTarget(r, user, now)}` : "";
    out.push({ key: `rent:${r.id}:${r.next_on}:${step}`, text: `${cap(r.label)} of ${fmt(r.amount, r.currency)} is due ${d === 0 ? "today" : `${sayDate(r.next_on, user, now)}, ${sayIn(d)}`}.${target}` });
  }
  return out;
});
addPinger("tax", async (_db, user, today, now) => {
  const tp = taxPrefs(user);
  if (!tp.deadline) return [];
  const next = nextOfMonthDay(tp.deadline, today);
  const d = daysUntil(next, user, now);
  const step = d >= 0 && d <= 7 ? 7 : d > 7 && d <= 30 ? 30 : 0;
  if (!step) return [];
  return [{ key: `tax:${next}:${step}`, text: `Your tax deadline is ${dt(next).toFormat("d LLLL")}, ${sayIn(d)}. ${authorityFor(typeof user.prefs.country === "string" ? user.prefs.country : countryOf(user)).replace(/^./, (c) => c.toUpperCase())} has the official forms.` }];
});
