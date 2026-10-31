/**
 * The dashboard: what matters right now, drawn as a picture that sits at the top of /menu and keeps itself current.
 * Only real things go on it: what's left today with times, doses, this week's money, what's coming (a trip, a
 * birthday, a renewal, a document running out), and anything waiting on a yes. Empty sections are left off, so a
 * quiet day looks quiet rather than padded.
 *
 * Each section of the menu (Today, Money, Health, Lists, Trips) has its own picture built the same way.
 */
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import type { Db } from "./db.js";
import type { User } from "../policy/types.js";
import { money } from "./money.js";
import { inQuietHours } from "./time.js";
import { C, PLATES, esc, latin, pipArt, plateCard, renderPng, type Plate } from "./cards.js";
import { carried, keptDays, nextThing, THINGS, thingsArt } from "./pipthings.js";

export interface Row { time?: string; text: string; plate?: Plate }
export interface Tile { label: string; value: string; note?: string; plate: Plate }
export interface Dash { greeting: string; date: string; updated: string; today: Row[]; later: Row[]; tiles: Tile[]; pose: string; quiet: boolean; /** What Pip carries (src/core/pipthings.ts). */ things?: string[] }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const first = (u: User) => (u.name ? u.name.split(" ")[0] : null);
const greet = (h: number) => (h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening");
/** A query that may touch a feature's table: if the table isn't there, it's simply empty. */
async function maybe<T>(p: Promise<T>, empty: T): Promise<T> { try { return await p; } catch { return empty; } }
const inDays = (n: number) => (n <= 0 ? "today" : n === 1 ? "tomorrow" : n < 14 ? `in ${n} days` : n < 60 ? `in ${Math.round(n / 7)} weeks` : `in ${Math.round(n / 30.4)} months`);

/** Everything the home dashboard shows, from live data. */
export async function dashboardFacts(db: Db, u: User, now: Date): Promise<Dash> {
  const local = DateTime.fromJSDate(now).setZone(u.tz);
  const dayStart = local.startOf("day").toJSDate(), dayEnd = local.endOf("day").toJSDate(), today = local.toISODate()!;
  const hhmm = (d: Date | string) => DateTime.fromJSDate(new Date(d)).setZone(u.tz).toFormat("HH:mm");
  const [events, rems, doses, classes, spend, trip, dates, subs, docs, pend, open] = await Promise.all([
    db.query<{ title: string; at: string }>(`SELECT title, starts_at AS at FROM events WHERE user_id=$1 AND NOT deleted AND starts_at > $2 AND starts_at <= $3 ORDER BY starts_at LIMIT 4`, [u.id, now, dayEnd]),
    db.query<{ title: string; at: string }>(`SELECT text AS title, due_at AS at FROM reminders WHERE user_id=$1 AND NOT done AND NOT deleted AND due_at > $2 AND due_at <= $3 ORDER BY due_at LIMIT 4`, [u.id, now, dayEnd]),
    db.query<{ name: string; times: string[]; taken: string }>(
      `SELECT m.name, m.times, (SELECT count(*) FROM medication_logs l WHERE l.medication_id=m.id AND l.status='taken' AND l.scheduled_for >= $2 AND l.scheduled_for < $3)::text AS taken FROM medications m WHERE m.user_id=$1 AND m.active`, [u.id, dayStart, dayEnd]),
    db.query<{ name: string; start_time: string }>(`SELECT name, start_time FROM classes WHERE user_id=$1 AND active AND weekday=$2 ORDER BY start_time`, [u.id, local.weekday % 7]),
    db.query<{ currency: string; category: string; total: string }>(`SELECT currency, category, sum(amount)::text AS total FROM spend WHERE user_id=$1 AND spent_at >= $2 GROUP BY currency, category ORDER BY sum(amount) DESC`, [u.id, local.startOf("week").toJSDate()]),
    db.one<{ destination: string; starts_on: string }>(`SELECT destination, to_char(starts_on,'YYYY-MM-DD') AS starts_on FROM trips WHERE user_id=$1 AND starts_on >= $2::date AND status <> 'cancelled' ORDER BY starts_on LIMIT 1`, [u.id, today]),
    db.query<{ label: string; kind: string; on_date: string; yearly: boolean }>(`SELECT label, kind, to_char(on_date,'YYYY-MM-DD') AS on_date, yearly FROM dates WHERE user_id=$1`, [u.id]),
    maybe(db.query<{ name: string; next_on: string; amount: string; currency: string }>(`SELECT name, to_char(next_on,'YYYY-MM-DD') AS next_on, amount::text, currency FROM money_subs WHERE user_id=$1 AND active AND next_on BETWEEN $2::date AND $2::date + 7 ORDER BY next_on LIMIT 2`, [u.id, today]), []),
    maybe(db.query<{ name: string; expires_on: string }>(`SELECT name, to_char(expires_on,'YYYY-MM-DD') AS expires_on FROM money_docs WHERE user_id=$1 AND active AND expires_on BETWEEN $2::date AND $2::date + 60 ORDER BY expires_on LIMIT 1`, [u.id, today]), []),
    db.one<{ n: string }>(`SELECT count(*)::text AS n FROM pending_actions WHERE user_id=$1 AND resolved IS NULL AND expires_at > $2`, [u.id, now]),
    db.one<{ n: string }>(`SELECT count(*)::text AS n FROM todos WHERE user_id=$1 AND NOT done`, [u.id]),
  ]);

  // Today, in order: what's booked, what's due, classes and doses still to come.
  const rows: (Row & { at: number })[] = [];
  for (const e of events) rows.push({ at: +new Date(e.at), time: hhmm(e.at), text: cap(e.title), plate: "event" });
  for (const r of rems) rows.push({ at: +new Date(r.at), time: hhmm(r.at), text: cap(r.title), plate: "rem" });
  for (const c of classes) { const t = DateTime.fromFormat(c.start_time, "HH:mm", { zone: u.tz }).set({ year: local.year, month: local.month, day: local.day }); if (t > local) rows.push({ at: t.toMillis(), time: c.start_time, text: cap(c.name), plate: "class" }); }
  for (const m of doses) for (const t of m.times) { const d = DateTime.fromFormat(t, "HH:mm", { zone: u.tz }).set({ year: local.year, month: local.month, day: local.day }); if (d.isValid && d > local) rows.push({ at: d.toMillis(), time: t, text: `${cap(m.name)}`, plate: "dose" }); }
  rows.sort((a, b) => a.at - b.at);
  // Room left on the card: the next few days, so a light day still shows what's ahead.
  const room = Math.max(0, 5 - rows.length);
  const later: Row[] = room ? (await db.query<{ title: string; at: string; kind: string }>(
    `(SELECT title, starts_at AS at, 'event' AS kind FROM events WHERE user_id=$1 AND NOT deleted AND starts_at > $2 AND starts_at <= $3)
     UNION ALL (SELECT text AS title, due_at AS at, 'rem' AS kind FROM reminders WHERE user_id=$1 AND NOT done AND NOT deleted AND due_at > $2 AND due_at <= $3)
     ORDER BY at LIMIT $4`, [u.id, dayEnd, local.plus({ days: 6 }).endOf("day").toJSDate(), Math.min(room, 3)])).map((r) => ({ time: DateTime.fromJSDate(new Date(r.at)).setZone(u.tz).toFormat("ccc HH:mm"), text: cap(r.title), plate: r.kind as Plate })) : [];

  const tiles: Tile[] = [];
  const dosesDue = doses.reduce((n, m) => n + m.times.length, 0), dosesTaken = doses.reduce((n, m) => n + Number(m.taken), 0);
  if (dosesDue) tiles.push({ label: "Doses today", value: `${dosesTaken} of ${dosesDue} taken`, plate: "dose" });
  if (spend.length) {
    const cur = spend[0].currency, total = spend.filter((s) => s.currency === cur).reduce((n, s) => n + Number(s.total), 0);
    tiles.push({ label: "This week", value: `${money(total, cur)} spent`, note: spend[0].category && spend[0].category !== "other" ? `Most on ${spend[0].category}` : undefined, plate: "money" });
  }
  const coming: { days: number; text: string; plate: Plate }[] = [];
  if (trip) { const n = Math.round(DateTime.fromISO(trip.starts_on, { zone: u.tz }).diff(local.startOf("day"), "days").days); coming.push({ days: n, text: `${cap(trip.destination)} ${inDays(n)}`, plate: "trip" }); }
  for (const d of dates) {
    let on = DateTime.fromISO(d.on_date, { zone: u.tz });
    if (d.yearly) { on = on.set({ year: local.year }); if (on < local.startOf("day")) on = on.plus({ years: 1 }); }
    const n = Math.round(on.diff(local.startOf("day"), "days").days);
    if (n >= 0 && n <= 30) coming.push({ days: n, text: `${cap(d.label)} ${inDays(n)}`, plate: "rem" });
  }
  for (const s of subs) { const n = Math.round(DateTime.fromISO(s.next_on, { zone: u.tz }).diff(local.startOf("day"), "days").days); coming.push({ days: n, text: `${cap(s.name)} renews ${inDays(n)}`, plate: "money" }); }
  for (const d of docs) { const n = Math.round(DateTime.fromISO(d.expires_on, { zone: u.tz }).diff(local.startOf("day"), "days").days); coming.push({ days: n, text: `${cap(d.name)} expires ${inDays(n)}`, plate: "hack" }); }
  coming.sort((a, b) => a.days - b.days);
  if (coming.length) tiles.push({ label: "Coming up", value: coming[0].text, note: coming[1]?.text, plate: coming[0].plate });
  const p = Number(pend?.n ?? 0), o = Number(open?.n ?? 0);
  if (p) tiles.push({ label: "Waiting on you", value: `${p} to answer`, note: o ? `${o} open on your lists` : undefined, plate: "rem" });
  else if (o) tiles.push({ label: "Your lists", value: `${o} open`, plate: "list" });

  const quiet = inQuietHours(now, u.tz, u.quiet_start, u.quiet_end);
  return {
    greeting: `${greet(local.hour)}${first(u) ? `, ${first(u)}` : ""}.`,
    date: local.toFormat("cccc d LLLL"),
    updated: local.toFormat("HH:mm"),
    today: rows.slice(0, 5).map(({ at: _at, ...r }) => r),
    later,
    tiles: tiles.slice(0, 3),
    pose: quiet ? "asleep" : p ? "waiting" : local.hour < 12 ? "hello" : local.hour < 18 ? "ontoit" : "later",
    quiet,
    things: carried(u.prefs).map((t) => t.key),
  };
}

/** A fingerprint of what the dashboard says (not the minute it was drawn): when it changes, the picture is redrawn. */
export const dashSignature = (d: Dash) => createHash("sha1").update(JSON.stringify({ ...d, updated: "", greeting: "" })).digest("hex").slice(0, 16);

const DW = 1200, DH = 760;

/** The home dashboard as SVG: a header, today's timeline on the left, up to three tiles on the right. */
export function dashboardSvg(d: Dash): string {
  const line = (r: Row, y: number, wide = false) => `<rect x="96" y="${y - 30}" width="10" height="40" rx="3" fill="${PLATES[r.plate ?? "event"]}" stroke="${C.ink}" stroke-width="2"/>
      <text x="124" y="${y}" font-size="${wide ? 26 : 30}" font-family="Libre Caslon Display">${esc(r.time ?? "")}</text>
      <text x="${wide ? 268 : 228}" y="${y}" font-size="31">${esc(latin(r.text, wide ? 23 : 26))}</text>`;
  let y = 330;
  const parts: string[] = [];
  if (d.today.length) for (const r of d.today) { parts.push(line(r, y)); y += 62; }
  else { parts.push(`<text x="96" y="${y + 6}" font-size="32" font-style="italic" fill="${C.ink2}">Nothing else booked today.</text>`); y += 70; }
  if (d.later.length) {
    parts.push(`<text x="96" y="${y + 4}" font-size="26" font-style="italic" fill="${C.ink2}">Later this week</text>`); y += 52;
    for (const r of d.later) { if (y > 690) break; parts.push(line(r, y, true)); y += 60; }
  }
  const rows = parts.join("\n");
  const tiles = d.tiles.map((t, i) => {
    const y = 236 + i * 168, x = 772, w = 372, h = 140;
    return `${plateCard(x, y, w, h, PLATES[t.plate], 16)}
    <text x="${x + 24}" y="${y + 40}" font-size="25" font-style="italic" fill="${C.ink2}">${esc(latin(t.label, 22))}</text>
    <text x="${x + 24}" y="${y + 86}" font-size="${latin(t.value, 30).length > 17 ? 30 : 38}" font-family="Libre Caslon Display">${esc(latin(t.value, 24))}</text>
    ${t.note ? `<text x="${x + 24}" y="${y + 120}" font-size="23" fill="${C.ink3}">${esc(latin(t.note, 30))}</text>` : ""}`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DW}" height="${DH}" viewBox="0 0 ${DW} ${DH}">
  <rect width="${DW}" height="${DH}" fill="${C.paper}"/>
  <g font-family="EB Garamond" fill="${C.ink}">
    <text x="56" y="62" font-size="30" font-family="Libre Caslon Display">lifeline</text>
    <text x="178" y="62" font-size="26" font-style="italic" fill="${C.ink3}">· dashboard</text>
    <text x="${DW - 56}" y="62" font-size="24" font-style="italic" fill="${C.ink3}" text-anchor="end">updated ${esc(d.updated)}</text>
    <line x1="56" y1="86" x2="${DW - 56}" y2="86" stroke="${C.line}" stroke-width="2"/>
    <text x="56" y="160" font-size="${latin(d.greeting, 40).length > 24 ? 54 : 64}" font-family="Libre Caslon Display">${esc(latin(d.greeting, 34))}</text>
    <text x="58" y="206" font-size="32" font-style="italic" fill="${C.ink2}">${esc(latin(d.date, 40))}</text>
    ${pipArt(d.pose, DW - 216, 100, 160)}
    ${thingsArt(THINGS.filter((t) => d.things?.includes(t.key)), DW - 216, 100, 160)}
    ${plateCard(56, 236, 680, 470, PLATES.event, 18)}
    <text x="96" y="282" font-size="26" font-style="italic" fill="${C.ink2}">Still to come today</text>
    ${rows}
    ${d.tiles.length ? tiles : `<text x="790" y="300" font-size="28" font-style="italic" fill="${C.ink3}">Tell me something to keep,</text><text x="790" y="340" font-size="28" font-style="italic" fill="${C.ink3}">and it shows up here.</text>`}
  </g>
</svg>`;
}

/** A section's picture: its title and a few real rows (label and value), with Pip. */
export interface Section { title: string; subtitle?: string; plate: Plate; pose: string; rows: [string, string][]; updated: string; things?: string[] }
export function sectionSvg(s: Section): string {
  const rows = s.rows.slice(0, 6);
  const body = rows.length
    ? rows.map(([k, v], i) => {
      const y = 326 + i * 64;
      return `<text x="96" y="${y}" font-size="30">${esc(latin(k, 30))}</text>
      <text x="704" y="${y}" font-size="30" font-family="Libre Caslon Display" text-anchor="end">${esc(latin(v, 22))}</text>
      ${i < rows.length - 1 ? `<line x1="96" y1="${y + 24}" x2="704" y2="${y + 24}" stroke="${C.line}" stroke-width="1.5"/>` : ""}`;
    }).join("\n")
    : `<text x="96" y="320" font-size="30" font-style="italic" fill="${C.ink2}">Nothing here yet.</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${DW}" height="${DH}" viewBox="0 0 ${DW} ${DH}">
  <rect width="${DW}" height="${DH}" fill="${C.paper}"/>
  <g font-family="EB Garamond" fill="${C.ink}">
    <text x="56" y="62" font-size="30" font-family="Libre Caslon Display">lifeline</text>
    <text x="178" y="62" font-size="26" font-style="italic" fill="${C.ink3}">· ${esc(latin(s.title.toLowerCase(), 24))}</text>
    <text x="${DW - 56}" y="62" font-size="24" font-style="italic" fill="${C.ink3}" text-anchor="end">updated ${esc(s.updated)}</text>
    <line x1="56" y1="86" x2="${DW - 56}" y2="86" stroke="${C.line}" stroke-width="2"/>
    ${plateCard(56, 130, 690, 576, PLATES[s.plate], 18)}
    <text x="96" y="206" font-size="58" font-family="Libre Caslon Display">${esc(latin(s.title, 22))}</text>
    ${s.subtitle ? `<text x="98" y="246" font-size="28" font-style="italic" fill="${C.ink2}">${esc(latin(s.subtitle, 40))}</text>` : ""}
    ${body}
    ${pipArt(s.pose, 800, 210, 340)}
    ${thingsArt(THINGS.filter((t) => s.things?.includes(t.key)), 800, 210, 340)}
  </g>
</svg>`;
}

/* Pictures are drawn once per what they say (to the minute): moving back and forth in the menu reuses them. */
const drawn = new Map<string, Promise<Buffer>>();
function memo(svg: string): Promise<Buffer> {
  const key = createHash("sha1").update(svg).digest("hex");
  const hit = drawn.get(key);
  if (hit) { drawn.delete(key); drawn.set(key, hit); return hit; }
  const p = renderPng(svg, DW).catch((e) => { drawn.delete(key); throw e; });
  drawn.set(key, p);
  if (drawn.size > 300) drawn.delete(drawn.keys().next().value!);
  return p;
}
export const renderDashboard = (d: Dash) => memo(dashboardSvg(d));
export const renderSection = (s: Section) => memo(sectionSvg(s));

/* ---------------- each section's picture ---------------- */

const SECTION: Record<string, { title: string; plate: Plate; pose: string }> = {
  today: { title: "Today", plate: "event", pose: "ontoit" },
  lists: { title: "Your lists", plate: "list", pose: "noted" },
  health: { title: "Body and mind", plate: "dose", pose: "noted" },
  money: { title: "Money", plate: "money", pose: "noted" },
  trips: { title: "Trips", plate: "trip", pose: "carrying" },
  play: { title: "Play", plate: "hack", pose: "cheers" },
  settings: { title: "Settings", plate: "scout", pose: "thinking" },
  safety: { title: "Safety", plate: "rem", pose: "noted" },
  you: { title: "You", plate: "hack", pose: "cheers" },
  everything: { title: "Everything", plate: "class", pose: "hello" },
};
export const SECTION_KINDS = Object.keys(SECTION);

/** The real rows for one section's picture. */
export async function sectionFacts(db: Db, u: User, kind: string, now: Date): Promise<Section | null> {
  const meta = SECTION[kind];
  if (!meta) return null;
  const local = DateTime.fromJSDate(now).setZone(u.tz);
  const updated = local.toFormat("HH:mm");
  const rows: [string, string][] = [];
  let subtitle: string | undefined;
  if (kind === "today") {
    const d = await dashboardFacts(db, u, now);
    subtitle = local.toFormat("cccc d LLLL");
    for (const r of [...d.today, ...d.later]) rows.push([r.text, r.time ?? ""]);
    if (!rows.length) subtitle = `${subtitle}. Nothing else booked`;
  } else if (kind === "lists") {
    const r = await db.query<{ list: string; n: string }>(`SELECT list, count(*)::text AS n FROM todos WHERE user_id=$1 AND NOT done GROUP BY list ORDER BY count(*) DESC LIMIT 6`, [u.id]);
    for (const x of r) rows.push([cap(x.list), `${x.n} open`]);
    subtitle = r.length ? "What's still open" : "Nothing open";
  } else if (kind === "health") {
    const day = local.startOf("day").toJSDate(), end = local.endOf("day").toJSDate(), week = local.minus({ days: 7 }).toJSDate();
    const [meds, sleep, habits] = await Promise.all([
      db.query<{ name: string; times: string[]; taken: string }>(`SELECT m.name, m.times, (SELECT count(*) FROM medication_logs l WHERE l.medication_id=m.id AND l.status='taken' AND l.scheduled_for >= $2 AND l.scheduled_for < $3)::text AS taken FROM medications m WHERE m.user_id=$1 AND m.active ORDER BY m.name LIMIT 3`, [u.id, day, end]),
      db.one<{ a: string | null }>(`SELECT AVG(value)::text AS a FROM measures WHERE user_id=$1 AND name='sleep' AND at >= $2`, [u.id, week]),
      db.query<{ name: string; n: string; target: number }>(`SELECT h.name, (SELECT count(*) FROM habit_checkins c WHERE c.habit_id=h.id AND c.day >= $2::date)::text AS n, h.target_per_week AS target FROM habits h WHERE h.user_id=$1 AND h.active ORDER BY h.name LIMIT 3`, [u.id, local.minus({ days: 6 }).toISODate()]),
    ]);
    for (const m of meds) rows.push([cap(m.name), `${m.taken} of ${m.times.length} today`]);
    if (sleep?.a) rows.push(["Sleep, this week", `${Math.round(Number(sleep.a) * 10) / 10} h a night`]);
    for (const h of habits) rows.push([cap(h.name), `${h.n} of ${h.target} this week`]);
    const kept = await keptDays(db, u.id);
    if (kept) { const next = nextThing(kept); rows.push(["Days kept, all time", next ? `${kept}, ${next.at - kept} to go` : String(kept)]); }
    subtitle = "Kept between us";
  } else if (kind === "money") {
    const spend = await db.query<{ currency: string; category: string; total: string }>(`SELECT currency, category, sum(amount)::text AS total FROM spend WHERE user_id=$1 AND spent_at >= $2 GROUP BY currency, category ORDER BY sum(amount) DESC LIMIT 4`, [u.id, local.startOf("week").toJSDate()]);
    for (const s of spend) rows.push([cap(s.category), money(Number(s.total), s.currency)]);
    const subs = await maybe(db.query<{ name: string; next_on: string }>(`SELECT name, to_char(next_on,'YYYY-MM-DD') AS next_on FROM money_subs WHERE user_id=$1 AND active AND next_on BETWEEN $2::date AND $2::date + 14 ORDER BY next_on LIMIT 2`, [u.id, local.toISODate()]), []);
    for (const s of subs) rows.push([`${cap(s.name)} renews`, inDays(Math.round(DateTime.fromISO(s.next_on, { zone: u.tz }).diff(local.startOf("day"), "days").days))]);
    subtitle = spend.length ? "This week, so far" : "Nothing spent this week";
  } else if (kind === "trips") {
    const t = await db.query<{ id: number; destination: string; starts_on: string | null; done: string; total: string }>(
      `SELECT t.id, t.destination, to_char(t.starts_on,'YYYY-MM-DD') AS starts_on, (SELECT count(*) FROM trip_items i WHERE i.trip_id=t.id AND i.done)::text AS done, (SELECT count(*) FROM trip_items i WHERE i.trip_id=t.id)::text AS total
       FROM trips t WHERE t.user_id=$1 AND (t.starts_on IS NULL OR t.starts_on >= $2::date) AND t.status <> 'cancelled' ORDER BY t.starts_on NULLS LAST LIMIT 3`, [u.id, local.toISODate()]);
    for (const x of t) {
      rows.push([cap(x.destination), x.starts_on ? inDays(Math.round(DateTime.fromISO(x.starts_on, { zone: u.tz }).diff(local.startOf("day"), "days").days)) : "no date yet"]);
      if (Number(x.total)) rows.push([`  Packing for ${cap(x.destination)}`, `${x.done} of ${x.total}`]);
    }
    subtitle = t.length ? "Where you're going" : "No trips planned";
  } else if (kind === "play") {
    const s = { played: 0, right: 0, streak: 0, best: 0, ...(u.prefs.gameScore as Record<string, number> | undefined) };
    if (s.played) { rows.push(["Played", String(s.played)], ["Right", `${s.right} of ${s.played}`], ["Best run", String(s.best)]); }
    subtitle = "A quick game";
  } else if (kind === "settings") {
    const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
    rows.push(["Morning brief", hh(u.digest_hour)], ["Quiet hours", `${hh(u.quiet_start)} to ${hh(u.quiet_end)}`], ["Calm mode", u.prefs.calm === true ? "on" : "off"], ["Voice replies", String(u.prefs.voiceReplies ?? "when you speak")]);
    subtitle = "Tap to change";
  } else if (kind === "safety") {
    const n = async (sql: string) => Number((await maybe(db.one<{ n: string }>(sql, [u.id]), undefined))?.n ?? 0);
    const ck = await maybe(db.one<{ due_at: string }>(`SELECT due_at FROM safety_checkins WHERE user_id=$1 AND status='active' ORDER BY due_at LIMIT 1`, [u.id]), undefined);
    const contacts = await n(`SELECT count(*)::text AS n FROM safety_contacts WHERE user_id=$1 AND status='confirmed'`);
    const card = await n(`SELECT count(*)::text AS n FROM safety_ice WHERE user_id=$1`);
    const inc = await n(`SELECT count(*)::text AS n FROM safety_incidents WHERE user_id=$1`);
    rows.push(["Check-in", ck ? `due ${DateTime.fromJSDate(new Date(ck.due_at)).setZone(u.tz).toFormat("HH:mm")}` : "none running"]);
    rows.push(["Safety contacts", String(contacts)], ["Emergency card", card ? "ready" : "not set up"], ["Incident log", inc ? `${inc} kept` : "empty"]);
    subtitle = ck ? "Someone's looking out" : "Here when you need it";
  } else if (kind === "you") {
    const days = await keptDays(db, u.id);
    const mem = Number((await maybe(db.one<{ n: string }>(`SELECT count(*)::text AS n FROM memories WHERE user_id=$1`, [u.id]), undefined))?.n ?? 0);
    const next = THINGS.find((t) => !carried(u.prefs).some((x) => x.key === t.key));
    rows.push(["Days kept", String(days)], ["Pip carries", String(carried(u.prefs).length)]);
    if (next) rows.push(["Next for Pip", `${next.name.replace(/^an? /, "")}, at ${next.at}`]);
    rows.push(["Things I remember", String(mem)], ["Chat history kept", "180 days"]);
    subtitle = "Yours to keep or delete";
  } else if (kind === "everything") {
    subtitle = "In drawers, not a wall";
  }
  return { ...meta, subtitle, rows, updated, things: carried(u.prefs).map((t) => t.key) };
}
