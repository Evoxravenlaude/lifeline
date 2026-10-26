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
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  if (ms < 0) return "past";
  if (d >= 1) return `${d}d ${h}h`;
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h >= 1 ? `${h}h ${m}m` : `${m}m`;
}
