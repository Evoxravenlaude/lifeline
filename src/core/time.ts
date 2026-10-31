import * as chrono from "chrono-node";
import { DateTime } from "luxon";

const RELATIVE = /\b(?:in\s+(?:a|an|a few|half an?|\d+(?:\.\d+)?)\s*(?:secs?|seconds?|mins?|minutes?|hrs?|hours?)|from now)\b/i;

/**
 * chrono reads the words against today's UTC offset, so "Tuesday at 9am" across a clock change came out an hour off.
 * Anything said as a clock time or a date is rebuilt from its wall-clock parts in the person's own zone; only
 * "in 20 minutes" keeps chrono's instant, since that's a span, not a time on the clock.
 */
export function settle(c: chrono.ParsedComponents, tz: string, text: string): Date {
  if (RELATIVE.test(text)) return c.date();
  const dt = DateTime.fromObject(
    { year: c.get("year")!, month: c.get("month")!, day: c.get("day")!, hour: c.get("hour") ?? 0, minute: c.get("minute") ?? 0, second: c.get("second") ?? 0 },
    { zone: tz },
  );
  return dt.isValid ? dt.toJSDate() : c.date();
}

/** Parse "tomorrow 9am", "next friday 14:00", "in 20 minutes" in the user's timezone. */
export function parseWhen(text: string, tz: string, now: Date): Date | null {
  const ref = DateTime.fromJSDate(now).setZone(tz);
  // chrono works in the host tz; we give it a reference instant and the user's offset, then settle() fixes the zone.
  const r = chrono.parse(text, { instant: now, timezone: ref.offset }, { forwardDate: true });
  if (!r.length) return null;
  return settle(r[0].start, tz, r[0].text);
}

/** Parse an "HH:MM" or "9am" style clock time into [hour, minute]. */
export function parseClock(text: string): [number, number] | null {
  if (/^\s*(?:noon|midday|12\s*noon)\s*$/i.test(text)) return [12, 0];
  if (/^\s*midnight\s*$/i.test(text)) return [0, 0];
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*$/i.exec(text);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return [h, min];
}

/** "today at 14:00", "tomorrow at 09:00", "Fri 30 Oct at 15:00": how a person says when. */
export function human(d: Date | string, tz: string, now = new Date()): string {
  const dt = DateTime.fromJSDate(typeof d === "string" ? new Date(d) : d).setZone(tz);
  const today = DateTime.fromJSDate(now).setZone(tz).startOf("day");
  const days = Math.round(dt.startOf("day").diff(today, "days").days);
  const t = dt.toFormat("HH:mm");
  if (days === 0) return `today at ${t}`;
  if (days === 1) return `tomorrow at ${t}`;
  if (days > 1 && days < 7) return `${dt.toFormat("cccc")} at ${t}`;
  return `${dt.toFormat("ccc d LLL")} at ${t}`;
}

/** Parse a time, and when only a day was given ("tomorrow", "friday"), settle on 09:00 rather than the current hour. */
export function parseWhenOrMorning(text: string, tz: string, now: Date): Date | null {
  const ref = DateTime.fromJSDate(now).setZone(tz);
  const r = chrono.parse(text, { instant: now, timezone: ref.offset }, { forwardDate: true })[0];
  if (!r) return null;
  const d = settle(r.start, tz, r.text);
  if (r.start.isCertain("hour") || /\b(?:in \d|hours?|minutes?|mins?)\b/i.test(text)) return d;
  return DateTime.fromJSDate(d).setZone(tz).set({ hour: 9, minute: 0, second: 0, millisecond: 0 }).toJSDate();
}

export function fmt(d: Date | string, tz: string, withDate = true): string {
  const dt = DateTime.fromJSDate(typeof d === "string" ? new Date(d) : d).setZone(tz);
  return withDate ? dt.toFormat("ccc d LLL, HH:mm") : dt.toFormat("HH:mm");
}

export function fmtDate(d: Date | string, tz: string): string {
  return DateTime.fromJSDate(typeof d === "string" ? new Date(d) : d).setZone(tz).toFormat("ccc d LLL");
}

export function localDay(now: Date, tz: string): string {
  return DateTime.fromJSDate(now).setZone(tz).toISODate()!;
}

/** Next occurrence of a local clock time after `now` in `tz`. */
export function nextClock(h: number, m: number, tz: string, now: Date): Date {
  let dt = DateTime.fromJSDate(now).setZone(tz).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (dt.toJSDate() <= now) dt = dt.plus({ days: 1 });
  return dt.toJSDate();
}

export function inQuietHours(now: Date, tz: string, start: number, end: number): boolean {
  const h = DateTime.fromJSDate(now).setZone(tz).hour;
  return start > end ? h >= start || h < end : h >= start && h < end;
}

export function humanDelta(from: Date, to: Date | string): string {
  const ms = new Date(to).getTime() - from.getTime();
  if (ms < 0) return "already past";
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  if (d >= 14) return `${Math.round(d / 7)} weeks`;
  if (d >= 2) return `${d} days`;
  if (d === 1) return h >= 12 ? "2 days" : "a day";
  if (h >= 2) return `${h} hours`;
  if (h === 1) return m >= 30 ? "2 hours" : "an hour";
  if (m >= 2) return `${m} minutes`;
  return "a minute";
}

/** "dec 20 to dec 27", "20 to 27 december", "from the 3rd until the 9th", "next weekend": a start and maybe an end. */
export function parseRange(text: string, tz: string, now: Date): { start: Date; end: Date | null } | null {
  const ref = DateTime.fromJSDate(now).setZone(tz);
  const cleaned = text.replace(/\b(?:from|between)\b/gi, " ").replace(/\bthe\s+(?=\d)/gi, "").replace(/\b(?:until|till|through|thru|to|and|-|–)\b/gi, " to ");
  const r = chrono.parse(cleaned, { instant: now, timezone: ref.offset }, { forwardDate: true });
  if (!r.length) return null;
  const start = settle(r[0].start, tz, r[0].text);
  let end: Date | null = r[0].end ? settle(r[0].end, tz, r[0].text) : r[1] ? settle(r[1].start, tz, r[1].text) : null;
  if (end && end < start) {
    // "20 to 27 dec" where chrono put the first number in the wrong month
    end = DateTime.fromJSDate(end).plus({ months: 1 }).toJSDate();
  }
  return { start, end };
}

/** "600 usd", "$600", "600 dollars", "80k naira" -> amount and ISO-ish currency. */
const SYMBOLS: Record<string, string> = { $: "USD", "US$": "USD", "€": "EUR", "£": "GBP", "₦": "NGN", "¥": "JPY", "₹": "INR", "₩": "KRW", "₱": "PHP", "₺": "TRY", "₽": "RUB", "₴": "UAH", "₵": "GHS", "R$": "BRL", "A$": "AUD", "C$": "CAD", "₫": "VND", "฿": "THB", "₪": "ILS", "zł": "PLN", "Kč": "CZK" };
const WORDS: [RegExp, string][] = [
  [/^(?:usd|dollars?|bucks)$/, "USD"], [/^(?:eur|euros?)$/, "EUR"], [/^(?:gbp|pounds?|quid)$/, "GBP"], [/^(?:ngn|naira)$/, "NGN"], [/^(?:ghs|cedis?)$/, "GHS"],
  [/^(?:xaf|xof|cfa)$/, "XAF"], [/^(?:kes|shillings?)$/, "KES"], [/^(?:zar|rand)$/, "ZAR"], [/^(?:inr|rupees?|rs)$/, "INR"], [/^(?:jpy|yen)$/, "JPY"], [/^(?:cny|rmb|yuan)$/, "CNY"],
  [/^(?:brl|reais|real)$/, "BRL"], [/^(?:mxn|pesos?)$/, "MXN"], [/^(?:aed|dirhams?)$/, "AED"], [/^(?:egp)$/, "EGP"], [/^(?:cad|aud|chf|sgd|hkd|nzd|sek|nok|dkk|pln|php|idr|myr|thb|krw|vnd|pkr|bdt|try|sar|qar|ils|uah|cop|clp|pen|ars|mad|tzs|ugx|rwf|etb)$/, ""],
  [/^(?:usdt|usdc|eth|btc|sol)$/, ""],
];
/** "€40", "1,200 dollars", "80k naira", "2500 INR", "R$ 90". Needs a currency sign or word; a bare number isn't money. */
export function parseMoney(text: string): { amount: number; currency: string } | null {
  const m = /(?:(US\$|R\$|A\$|C\$|zł|Kč|[$€£₦¥₹₩₱₺₽₴₵₫฿₪])\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b\s*([A-Za-z]{2,7})?/.exec(text);
  if (!m) return null;
  const word = (m[4] ?? "").toLowerCase();
  const hit = word ? WORDS.find(([re]) => re.test(word)) : undefined;
  if (!m[1] && !hit) return null;
  let amount = Number(m[2].replace(/,/g, ""));
  if (m[3]?.toLowerCase() === "k") amount *= 1000;
  if (m[3]?.toLowerCase() === "m") amount *= 1_000_000;
  const cur = m[1] ? SYMBOLS[m[1]] : hit![1] || word.toUpperCase();
  return { amount, currency: cur };
}
