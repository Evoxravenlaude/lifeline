import * as chrono from "chrono-node";
import { DateTime } from "luxon";

/** Parse "tomorrow 9am", "next friday 14:00", "in 20 minutes" in the user's timezone. */
export function parseWhen(text: string, tz: string, now: Date): Date | null {
  const ref = DateTime.fromJSDate(now).setZone(tz);
  // chrono works in the host tz; we give it a reference instant and the user's offset.
  const r = chrono.parse(text, { instant: now, timezone: ref.offset }, { forwardDate: true });
  if (!r.length) return null;
  return r[0].start.date();
}

/** Parse an "HH:MM" or "9am" style clock time into [hour, minute]. */
export function parseClock(text: string): [number, number] | null {
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
  const d = r.start.date();
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
  const start = r[0].start.date();
  let end: Date | null = r[0].end ? r[0].end.date() : r[1] ? r[1].start.date() : null;
  if (end && end < start) {
    // "20 to 27 dec" where chrono put the first number in the wrong month
    end = DateTime.fromJSDate(end).plus({ months: 1 }).toJSDate();
  }
  return { start, end };
}

/** "600 usd", "$600", "600 dollars", "80k naira" -> amount and ISO-ish currency. */
export function parseMoney(text: string): { amount: number; currency: string } | null {
  const m = /(?:([$€£₦])\s*)?(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\s*(usd|dollars?|bucks|eur|euros?|gbp|pounds?|ngn|naira|ghs|cedis?|xaf|cfa|kes|zar|usdt|usdc)?/i.exec(text);
  if (!m || (!m[1] && !m[4])) return null;
  let amount = Number(m[2].replace(/,/g, ""));
  if (m[3]?.toLowerCase() === "k") amount *= 1000;
  if (m[3]?.toLowerCase() === "m") amount *= 1_000_000;
  const sym: Record<string, string> = { $: "USD", "€": "EUR", "£": "GBP", "₦": "NGN" };
  const word = (m[4] ?? "").toLowerCase();
  const cur = m[1] ? sym[m[1]] : /^(usd|dollar|buck)/.test(word) ? "USD" : /^(eur)/.test(word) ? "EUR" : /^(gbp|pound)/.test(word) ? "GBP" : /^(ngn|naira)/.test(word) ? "NGN" : /^(ghs|cedi)/.test(word) ? "GHS" : /^(xaf|cfa)/.test(word) ? "XAF" : /^kes/.test(word) ? "KES" : /^zar/.test(word) ? "ZAR" : word.toUpperCase();
  return { amount, currency: cur };
}
