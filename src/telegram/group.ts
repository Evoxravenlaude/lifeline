/**
 * lifeline in a Telegram group: things friends do together, and nothing personal.
 *   /split 120 dinner @ana @ben   split a bill; each person taps "I've paid" when they have
 *   /tab                          who still owes what in this group
 *   /list rice, eggs | /list      one shared list, ticked with a tap
 *   /when movie night             a poll of the next few evenings
 *   /trivia                       a quiz poll for everyone
 *   /birthday 12 March            lifeline says happy birthday here on the day
 * Personal things (reminders, health, money) never come out in a group: a group message never reaches
 * handleMessage. Help and mistakes are shown only to the person who asked, so the chat stays tidy.
 * Only someone in the lifeline circle can bring the bot into a group.
 */
import { DateTime } from "luxon";
import type { Db } from "../core/db.js";
import { addCapability, addSchema } from "../core/plugins.js";
import { money, userCurrency } from "../core/money.js";
import { parseMoney } from "../core/time.js";
import { TRIVIA } from "../modules/fun.js";
import type { User } from "../policy/types.js";
import { complete, providerName } from "../intent/providers.js";
import { overBudget, recordUsage } from "../core/budget.js";

addSchema(`CREATE TABLE IF NOT EXISTS group_chats (chat_id BIGINT PRIMARY KEY, title TEXT, added_by INT REFERENCES users(id), tz TEXT NOT NULL DEFAULT 'UTC', currency TEXT, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS group_bills (id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, title TEXT NOT NULL, amount NUMERIC NOT NULL, currency TEXT, payer_name TEXT NOT NULL, payer_tg BIGINT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS group_shares (id SERIAL PRIMARY KEY, bill_id INT NOT NULL REFERENCES group_bills(id) ON DELETE CASCADE, name TEXT NOT NULL, username TEXT, tg_id BIGINT, share NUMERIC NOT NULL, paid BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE IF NOT EXISTS group_items (id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, text TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT false, added_by TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS group_birthdays (chat_id BIGINT NOT NULL, tg_id BIGINT NOT NULL, name TEXT NOT NULL, month INT NOT NULL, day INT NOT NULL, last_sent DATE, PRIMARY KEY (chat_id, tg_id))`);
addSchema(`ALTER TABLE group_bills ADD COLUMN IF NOT EXISTS msg_id BIGINT;
CREATE TABLE IF NOT EXISTS group_polls (poll_id TEXT PRIMARY KEY, chat_id BIGINT NOT NULL, msg_id BIGINT, what TEXT NOT NULL, options JSONB NOT NULL, at_hour INT NOT NULL DEFAULT 19, at_minute INT NOT NULL DEFAULT 0, created_by BIGINT, closes_at TIMESTAMPTZ NOT NULL, closed BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS group_votes (poll_id TEXT NOT NULL, tg_id BIGINT NOT NULL, name TEXT NOT NULL, options INT[] NOT NULL, PRIMARY KEY (poll_id, tg_id));
CREATE TABLE IF NOT EXISTS group_cards (id SERIAL PRIMARY KEY, chat_id BIGINT NOT NULL, name TEXT NOT NULL, username TEXT, tg_id BIGINT, day DATE NOT NULL, prompt_msg BIGINT, created_by BIGINT, sent BOOLEAN NOT NULL DEFAULT false, cancelled BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS group_card_voices (card_id INT NOT NULL REFERENCES group_cards(id) ON DELETE CASCADE, tg_id BIGINT NOT NULL, name TEXT NOT NULL, file_id TEXT NOT NULL, seconds INT, created_at TIMESTAMPTZ DEFAULT now(), PRIMARY KEY (card_id, tg_id))`);

export interface Person { id?: number; name: string; username?: string }
export interface GroupMsg { chatId: number; title?: string; from: Person & { id: number }; cmd: string; args: string; mentions: Person[] }
export interface GroupBtn { label: string; data: string }
export interface Poll { question: string; options: string[]; correct?: number; explanation?: string; multiple?: boolean }
export interface GroupOut {
  text?: string; buttons?: GroupBtn[][]; ephemeral?: boolean; poll?: Poll; dm?: boolean;
  /** Messages shown to one person each, inside the group (their share of a bill). */
  privately?: { tgId: number; text: string; buttons?: GroupBtn[][] }[];
  /** After posting: what the posted message was for, so the bot can remember its id (a bill, a poll, a card). */
  remember?: { bill?: number; poll?: { what: string; options: { label: string; date: string | null }[]; hour: number; minute: number }; card?: number };
  /** A file to post with it (a calendar invite). */
  file?: { data: string; name: string; mime: string };
  /** Close this poll (its message id) before posting. */
  stopPoll?: number;
}

export const GROUP_HELP = [
  "**In a group I do things together.**",
  "- `/split 120 dinner @ana @ben` splits a bill",
  "- `/tab` shows who still owes what",
  "- `/list rice, eggs` adds to the group's list; `/list` shows it",
  "- `/when movie night` makes a poll of the next few evenings",
  "- `/trivia` starts a quiz",
  "- `/birthday 12 March` and I'll say happy birthday here",
  "- `/card @ada 12 March` records a birthday card: everyone replies with a short voice note, and it all lands together at midnight on the day",
  "Your own things stay between you and me: message me directly for those.",
].join("\n");

const first = (p: Person) => (p.username ? `@${p.username}` : p.name.split(" ")[0]);
const amt = (n: number, cur: string | null) => (cur ? money(n, cur) : Number.isInteger(n) ? String(n) : n.toFixed(2));

/** A Telegram id for an @handle, when that person is in the circle (lifeline keeps handles current). */
async function tgOfUsername(db: Db, username: string): Promise<number | null> {
  const r = await db.one<{ id: string }>(`SELECT COALESCE(i.external_id, u.telegram_id::text) AS id FROM users u LEFT JOIN identities i ON i.user_id=u.id AND i.channel='telegram' WHERE lower(u.prefs->>'username')=lower($1) LIMIT 1`, [username]);
  const n = Number(r?.id);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The member behind a Telegram id, without creating anyone. */
export async function memberOf(db: Db, tgId: number): Promise<User | null> {
  return (await db.one<User>(`SELECT u.* FROM users u LEFT JOIN identities i ON i.user_id=u.id AND i.channel='telegram' WHERE u.telegram_id=$1 OR i.external_id=$2 LIMIT 1`, [tgId, String(tgId)])) ?? null;
}

/** Is lifeline switched on in this chat? It is once a circle member added it, or spoke in it. */
export async function groupActive(db: Db, chatId: number, title: string | undefined, fromTg: number): Promise<boolean> {
  const g = await db.one<{ active: boolean }>(`SELECT active FROM group_chats WHERE chat_id=$1`, [chatId]);
  if (g) return g.active;
  const m = await memberOf(db, fromTg);
  if (!m) return false;
  await activateGroup(db, chatId, title, m);
  return true;
}
export async function activateGroup(db: Db, chatId: number, title: string | undefined, by: User): Promise<void> {
  await db.query(`INSERT INTO group_chats (chat_id, title, added_by, tz, currency) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (chat_id) DO UPDATE SET active=true, title=EXCLUDED.title`, [chatId, title ?? null, by.id, by.tz || "UTC", userCurrency(by)]);
}
export async function deactivateGroup(db: Db, chatId: number): Promise<void> {
  await db.query(`UPDATE group_chats SET active=false WHERE chat_id=$1`, [chatId]);
}
const groupOf = (db: Db, chatId: number) => db.one<{ tz: string; currency: string | null; title: string | null }>(`SELECT tz, currency, title FROM group_chats WHERE chat_id=$1`, [chatId]);

/* ---------------- split ---------------- */

async function billText(db: Db, billId: number): Promise<GroupOut | null> {
  const b = await db.one<{ id: number; title: string; amount: string; currency: string | null; payer_name: string }>(`SELECT id, title, amount, currency, payer_name FROM group_bills WHERE id=$1`, [billId]);
  if (!b) return null;
  const shares = await db.query<{ name: string; username: string | null; share: string; paid: boolean }>(`SELECT name, username, share, paid FROM group_shares WHERE bill_id=$1 ORDER BY id`, [billId]);
  const open = shares.filter((s) => !s.paid);
  const each = new Set(shares.map((s) => Number(s.share))).size === 1 && shares.length ? `${amt(Number(shares[0].share), b.currency)} each` : "";
  const lines = [
    `**${b.title}, ${amt(Number(b.amount), b.currency)}**`,
    `${b.payer_name} paid${each ? `. ${each}` : ""}.`,
    ...shares.map((s) => `- ${s.username ? `@${s.username}` : s.name}: ${s.paid ? "paid" : `owes ${amt(Number(s.share), b.currency)}`}`),
    open.length ? "" : "All square. Thanks, everyone.",
  ].filter((l, i, a) => l || i < a.length - 1);
  return { text: lines.join("\n").trim(), buttons: open.length ? [[{ label: "I've paid my share", data: `gr:pay:${b.id}` }], [{ label: "Mark all paid", data: `gr:all:${b.id}` }]] : undefined };
}

async function split(db: Db, m: GroupMsg): Promise<GroupOut> {
  const g = await groupOf(db, m.chatId);
  const words = m.args.replace(/@\w+/g, " ").replace(/\s+/g, " ").trim();
  const said = parseMoney(words);
  const num = said ?? (() => { const x = /(\d[\d,]*(?:\.\d+)?)\s*(k)?\b/i.exec(words); return x ? { amount: Number(x[1].replace(/,/g, "")) * (x[2] ? 1000 : 1), currency: "" } : null; })();
  if (!num || !(num.amount > 0) || num.amount > 1e10) return { text: "Tell me the amount and who's in, like `/split 120 dinner @ana @ben`. You're counted in unless you add \"not me\".", ephemeral: true };
  const between = /\bbetween (\d{1,2})\b|\b(\d{1,2}) ways\b/i.exec(words);
  const notMe = /\bnot me\b|\bwithout me\b/i.test(words);
  const title = (words.replace(/\b(?:between \d{1,2}|\d{1,2} ways|not me|without me|with|for|and|split)\b/gi, " ")
    .replace(/(?:US\$|R\$|A\$|C\$|[$€£₦¥₹₩₱₺₽₴₵₫฿₪])?\s*\d[\d,]*(?:\.\d+)?\s*(?:k\b)?\s*([A-Za-z]{2,7}\b)?/, (_all, word?: string) => (word && !parseMoney(`1 ${word}`) ? ` ${word} ` : " ")).replace(/\s+/g, " ").trim() || "The bill").slice(0, 60);
  const cur = num.currency || g?.currency || null;
  let people: Person[] = [...m.mentions];
  if (!notMe) people.unshift(m.from);
  people = people.filter((p, i, a) => a.findIndex((q) => (q.id && q.id === p.id) || (q.username && q.username.toLowerCase() === p.username?.toLowerCase())) === i);
  if (between) {
    const n = Number(between[1] ?? between[2]);
    if (n < 2) return { text: "A split needs at least two people.", ephemeral: true };
    while (people.length < n) people.push({ name: `Person ${people.length + 1}` });
    people = people.slice(0, n);
  }
  if (people.length < 2) return { text: "Who's in? Mention them, like `/split 60 pizza @ben @cy`, or say \"between 4\".", ephemeral: true };
  if (people.length > 30) return { text: "That's more people than I can split between in one go. Thirty at most.", ephemeral: true };
  const share = Math.round((num.amount / people.length) * 100) / 100;
  const bill = await db.one<{ id: number }>(`INSERT INTO group_bills (chat_id, title, amount, currency, payer_name, payer_tg) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [m.chatId, title.charAt(0).toUpperCase() + title.slice(1), num.amount, cur, first(m.from), m.from.id]);
  const privately: NonNullable<GroupOut["privately"]> = [];
  for (const p of people) {
    const isPayer = p.id === m.from.id;
    const tg = p.id ?? (p.username ? await tgOfUsername(db, p.username) : null);
    await db.query(`INSERT INTO group_shares (bill_id, name, username, tg_id, share, paid) VALUES ($1,$2,$3,$4,$5,$6)`, [bill!.id, p.name, p.username ?? null, tg, share, isPayer]);
    // Each person's own share, shown only to them (Telegram's one-person messages in groups).
    if (tg && !isPayer) privately.push({ tgId: tg, text: `Your share of ${title.toLowerCase()} is ${amt(share, cur)}, to ${first(m.from)}. Only you can see this.`, buttons: [[{ label: "I've paid my share", data: `gr:pay:${bill!.id}` }]] });
  }
  return { ...(await billText(db, bill!.id))!, privately, remember: { bill: bill!.id } };
}

async function tab(db: Db, m: GroupMsg): Promise<GroupOut> {
  const rows = await db.query<{ title: string; payer_name: string; name: string; username: string | null; share: string; currency: string | null }>(
    `SELECT b.title, b.payer_name, s.name, s.username, s.share, b.currency FROM group_shares s JOIN group_bills b ON b.id=s.bill_id WHERE b.chat_id=$1 AND NOT s.paid ORDER BY b.id, s.id LIMIT 40`, [m.chatId]);
  if (!rows.length) return { text: "Nobody owes anything here. All square." };
  return { text: ["**Still open**", ...rows.map((r) => `- ${r.username ? `@${r.username}` : r.name} owes ${r.payer_name} ${amt(Number(r.share), r.currency)} for ${r.title.toLowerCase()}`)].join("\n") };
}

/* ---------------- the group's list ---------------- */

async function listText(db: Db, chatId: number): Promise<GroupOut> {
  const items = await db.query<{ id: number; text: string; done: boolean }>(`SELECT id, text, done FROM group_items WHERE chat_id=$1 ORDER BY done, id LIMIT 30`, [chatId]);
  if (!items.length) return { text: "The group's list is empty. Add to it with `/list rice, eggs`." };
  const open = items.filter((i) => !i.done);
  const buttons: GroupBtn[][] = open.slice(0, 12).map((i) => [{ label: `Got ${i.text.slice(0, 30)}`, data: `gr:tick:${i.id}` }]);
  if (items.some((i) => i.done)) buttons.push([{ label: "Clear the ticked ones", data: "gr:clear" }]);
  return { text: ["**The group's list**", ...items.map((i) => `- ${i.text}${i.done ? " (got it)" : ""}`)].join("\n"), buttons };
}
async function list(db: Db, m: GroupMsg): Promise<GroupOut> {
  const add = m.args.replace(/^add\s+/i, "").trim();
  if (!add) return listText(db, m.chatId);
  const items = add.split(/\s*(?:,|;|\n| and )\s*/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
  for (const it of items) await db.query(`INSERT INTO group_items (chat_id, text, added_by) VALUES ($1,$2,$3)`, [m.chatId, it.slice(0, 80), first(m.from)]);
  const shown = await listText(db, m.chatId);
  return { ...shown, text: `Added ${items.length === 1 ? items[0] : `${items.length} things`}.\n\n${shown.text}` };
}

/* ---------------- polls ---------------- */

/** "/when movie night 8pm": the evenings as a poll; "/when done" closes the latest and sends the invite. */
async function when(db: Db, m: GroupMsg, now: Date): Promise<GroupOut> {
  if (/^(?:done|close|stop|end|decide|pick)$/i.test(m.args.trim())) {
    const p = await db.one<{ poll_id: string }>(`SELECT poll_id FROM group_polls WHERE chat_id=$1 AND NOT closed ORDER BY created_at DESC LIMIT 1`, [m.chatId]);
    if (!p) return { text: "There's no open time poll here. Start one with `/when movie night`.", ephemeral: true };
    return (await closePoll(db, p.poll_id, now)) ?? { text: "Nobody's voted yet, so there's nothing to pick. Give it a little while.", ephemeral: true };
  }
  const g = await groupOf(db, m.chatId);
  let raw = m.args.trim().replace(/[?.]+$/, "");
  // A time in the words ("at 8pm", "19:30") sets the invite's time; evenings default to 7pm.
  let hour = 19, minute = 0;
  const clock = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)\b/i.exec(raw);
  if (clock) {
    if (clock[3]) { hour = (Number(clock[1]) % 12) + (clock[3].toLowerCase() === "pm" ? 12 : 0); minute = Number(clock[2] ?? 0); }
    else { hour = Number(clock[4]); minute = Number(clock[5]); }
    raw = raw.replace(clock[0], " ").replace(/\s+/g, " ").trim();
  }
  const what = raw.slice(0, 120) || "we meet";
  const local = DateTime.fromJSDate(now).setZone(g?.tz ?? "UTC");
  const start = local.hour >= Math.min(hour, 17) ? 1 : 0;
  const days = Array.from({ length: 6 }, (_, i) => local.plus({ days: start + i }));
  const label = (d: DateTime, i: number) => (i === 0 && start === 0 ? (hour >= 17 ? "Tonight" : "Today") : i === 0 || (start === 0 && i === 1) ? `Tomorrow, ${d.toFormat("ccc d LLL")}` : d.toFormat("cccc d LLL"));
  const options = [...days.map((d, i) => ({ label: label(d, i), date: d.toISODate() })), { label: "None of these work", date: null }];
  return {
    poll: { question: `When works for ${what}?`, options: options.map((o) => o.label), multiple: true },
    remember: { poll: { what, options, hour, minute } },
  };
}

/** Telegram calls the poll by its own id: keep what each option means and when it closes (a day later). */
export async function rememberPoll(db: Db, chatId: number, pollId: string, msgId: number, by: number, p: NonNullable<NonNullable<GroupOut["remember"]>["poll"]>, now = new Date()): Promise<void> {
  await db.query(`INSERT INTO group_polls (poll_id, chat_id, msg_id, what, options, at_hour, at_minute, created_by, closes_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (poll_id) DO NOTHING`,
    [pollId, chatId, msgId, p.what, JSON.stringify(p.options), p.hour, p.minute, by, new Date(now.getTime() + 24 * 3_600_000)]);
}
/** A vote changed (Telegram sends the whole new choice; an empty one is a retraction). */
export async function recordVote(db: Db, pollId: string, voter: Person & { id: number }, optionIds: number[]): Promise<void> {
  const known = await db.one(`SELECT 1 AS x FROM group_polls WHERE poll_id=$1 AND NOT closed`, [pollId]);
  if (!known) return;
  if (!optionIds.length) await db.query(`DELETE FROM group_votes WHERE poll_id=$1 AND tg_id=$2`, [pollId, voter.id]);
  else await db.query(`INSERT INTO group_votes (poll_id, tg_id, name, options) VALUES ($1,$2,$3,$4) ON CONFLICT (poll_id, tg_id) DO UPDATE SET options=EXCLUDED.options, name=EXCLUDED.name`, [pollId, voter.id, first(voter), optionIds]);
}

/** A calendar invite (.ics) for the picked evening, in the group's time zone. */
export function inviteIcs(what: string, startIso: string, tz: string, minutes = 120): string {
  const s = DateTime.fromISO(startIso, { zone: tz });
  const f = (d: DateTime) => d.toUTC().toFormat("yyyyLLdd'T'HHmmss'Z'");
  const clean = (t: string) => t.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, " ");
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//lifeline//group//EN", "METHOD:PUBLISH", "BEGIN:VEVENT", `UID:${s.toMillis()}-${Math.abs(hash(what))}@lifeline`, `DTSTAMP:${f(DateTime.utc())}`, `DTSTART:${f(s)}`, `DTEND:${f(s.plus({ minutes }))}`, `SUMMARY:${clean(what.charAt(0).toUpperCase() + what.slice(1))}`, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}
const hash = (t: string) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7);

/** Close a time poll: the evening most people can do wins (ties go to the sooner one), with an invite to keep. */
export async function closePoll(db: Db, pollId: string, now = new Date()): Promise<GroupOut | null> {
  const p = await db.one<{ chat_id: string; msg_id: string | null; what: string; options: { label: string; date: string | null }[]; at_hour: number; at_minute: number; closed: boolean }>(
    `SELECT chat_id::text, msg_id::text, what, options, at_hour, at_minute, closed FROM group_polls WHERE poll_id=$1`, [pollId]);
  if (!p || p.closed) return null;
  const votes = await db.query<{ name: string; options: number[] }>(`SELECT name, options FROM group_votes WHERE poll_id=$1`, [pollId]);
  const counts = p.options.map((o, i) => ({ ...o, i, n: o.date ? votes.filter((v) => v.options.includes(i)).length : 0, who: votes.filter((v) => v.options.includes(i)).map((v) => v.name) }));
  const best = counts.filter((c) => c.date && c.n > 0).sort((a, b) => b.n - a.n || a.i - b.i)[0];
  await db.query(`UPDATE group_polls SET closed=true WHERE poll_id=$1`, [pollId]);
  const stop = p.msg_id ? Number(p.msg_id) : undefined;
  if (!best) return { text: `Nobody could make any of those for ${p.what}. Try \`/when ${p.what}\` again with other days?`, stopPoll: stop };
  const g = await groupOf(db, Number(p.chat_id));
  const tz = g?.tz ?? "UTC";
  const start = DateTime.fromISO(best.date!, { zone: tz }).set({ hour: p.at_hour, minute: p.at_minute });
  const nice = start.toFormat("cccc d LLLL 'at' HH:mm");
  const of = votes.length;
  void now;
  return {
    text: [`**${p.what.charAt(0).toUpperCase() + p.what.slice(1)}: ${nice}**`, `${best.n} of ${of} can make it${best.who.length <= 8 ? ` (${best.who.join(", ")})` : ""}. The invite is attached; tap below to put it in your lifeline calendar.`].join("\n"),
    buttons: [[{ label: "Add to my calendar", data: `gr:cal:${best.i}` }]],
    file: { data: Buffer.from(inviteIcs(p.what, start.toISO()!, tz)).toString("base64"), name: `${p.what.replace(/[^\w -]/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "invite"}.ics`, mime: "text/calendar" },
    stopPoll: stop,
  };
}
/** Polls past their day, to close on the quarter-hour timer. */
export async function duePolls(db: Db, now: Date): Promise<{ chatId: number; out: GroupOut }[]> {
  const rows = await db.query<{ poll_id: string; chat_id: string }>(`SELECT poll_id, chat_id::text FROM group_polls WHERE NOT closed AND closes_at <= $1`, [now]);
  const out: { chatId: number; out: GroupOut }[] = [];
  for (const r of rows) { const o = await closePoll(db, r.poll_id, now); if (o) out.push({ chatId: Number(r.chat_id), out: o }); }
  return out;
}
/** "Add to my calendar" under a closed poll: the latest closed poll in the chat, into the tapper's own calendar. */
export async function pollEvent(db: Db, chatId: number, option: number): Promise<{ title: string; startIso: string } | null> {
  const p = await db.one<{ what: string; options: { label: string; date: string | null }[]; at_hour: number; at_minute: number }>(`SELECT what, options, at_hour, at_minute FROM group_polls WHERE chat_id=$1 AND closed ORDER BY created_at DESC LIMIT 1`, [chatId]);
  const o = p?.options[option];
  if (!p || !o?.date) return null;
  const g = await groupOf(db, chatId);
  return { title: p.what.charAt(0).toUpperCase() + p.what.slice(1), startIso: DateTime.fromISO(o.date, { zone: g?.tz ?? "UTC" }).set({ hour: p.at_hour, minute: p.at_minute }).toISO()! };
}
function trivia(now: Date): GroupOut {
  const [q, opts, answer, note] = TRIVIA[Math.floor((now.getTime() / 1000) % TRIVIA.length)];
  return { poll: { question: q, options: opts, correct: answer, explanation: note.slice(0, 200) } };
}

/* ---------------- birthdays ---------------- */

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function parseDayMonth(text: string): { month: number; day: number } | null {
  const t = text.toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1").trim();
  let m = /^(\d{1,2})\s+([a-z]{3,9})\.?$/.exec(t), day = 0, month = 0;
  if (m) { day = Number(m[1]); month = MONTHS.indexOf(m[2].slice(0, 3)) + 1; }
  else if ((m = /^([a-z]{3,9})\.?\s+(\d{1,2})$/.exec(t))) { day = Number(m[2]); month = MONTHS.indexOf(m[1].slice(0, 3)) + 1; }
  else if ((m = /^(\d{1,2})[/.-](\d{1,2})$/.exec(t))) { day = Number(m[1]); month = Number(m[2]); }
  if (!month || month > 12 || !day) return null;
  return DateTime.fromObject({ year: 2024, month, day }).isValid ? { month, day } : null;
}
async function birthday(db: Db, m: GroupMsg): Promise<GroupOut> {
  const a = m.args.trim();
  if (/^(?:forget|remove|delete|off)$/i.test(a)) {
    await db.query(`DELETE FROM group_birthdays WHERE chat_id=$1 AND tg_id=$2`, [m.chatId, m.from.id]);
    return { text: "Done, I've forgotten your birthday in this group.", ephemeral: true };
  }
  const d = parseDayMonth(a);
  if (!d) return { text: "Which day? Like `/birthday 12 March`. Just the day and month; your age is your business.", ephemeral: true };
  await db.query(`INSERT INTO group_birthdays (chat_id, tg_id, name, month, day) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (chat_id, tg_id) DO UPDATE SET name=EXCLUDED.name, month=EXCLUDED.month, day=EXCLUDED.day`, [m.chatId, m.from.id, m.from.name.split(" ")[0], d.month, d.day]);
  return { text: `Noted, ${m.from.name.split(" ")[0]}: ${d.day} ${DateTime.fromObject({ year: 2024, month: d.month, day: 1 }).toFormat("LLLL")}. I'll say happy birthday here on the day. \`/birthday forget\` takes it back.` };
}

/** Birthdays due now: once a day per person, from 09:00 in the group's time zone. */
export async function dueBirthdays(db: Db, now: Date): Promise<{ chatId: number; text: string }[]> {
  const rows = await db.query<{ chat_id: string; tg_id: string; name: string; month: number; day: number; last_sent: string | null; tz: string }>(
    `SELECT b.chat_id::text, b.tg_id::text, b.name, b.month, b.day, to_char(b.last_sent, 'YYYY-MM-DD') AS last_sent, g.tz FROM group_birthdays b JOIN group_chats g ON g.chat_id=b.chat_id WHERE g.active`);
  const out: { chatId: number; text: string }[] = [];
  const byChat = new Map<string, string[]>();
  for (const r of rows) {
    const local = DateTime.fromJSDate(now).setZone(r.tz || "UTC");
    const today = local.toISODate()!;
    if (local.month !== r.month || local.day !== r.day || local.hour < 9 || r.last_sent === today) continue;
    await db.query(`UPDATE group_birthdays SET last_sent=$3 WHERE chat_id=$1 AND tg_id=$2`, [r.chat_id, r.tg_id, today]);
    byChat.set(r.chat_id, [...(byChat.get(r.chat_id) ?? []), r.name]);
  }
  for (const [chat, names] of byChat) {
    const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    out.push({ chatId: Number(chat), text: `Happy birthday, ${who}. Have a good one.` });
  }
  return out;
}

/* ---------------- a voice card for someone's birthday ---------------- */

/** "/card @ada 12 March" (or "tomorrow", "friday"): everyone replies with a voice note; it lands together at midnight. */
async function card(db: Db, m: GroupMsg, now: Date): Promise<GroupOut> {
  const a = m.args.trim().replace(/^(?:a\s+)?(?:birthday\s+)?(?:card\s+)?for\s+/i, "");
  const g = await groupOf(db, m.chatId);
  const tz = g?.tz ?? "UTC";
  const cancel = /^(?:cancel|stop|forget)\s+(?:the\s+)?(?:card\s+(?:for\s+)?)?@?(\w[\w ]{0,40})$/i.exec(a);
  if (cancel) {
    const r = await db.query(`UPDATE group_cards SET cancelled=true WHERE chat_id=$1 AND NOT sent AND NOT cancelled AND (lower(name)=lower($2) OR lower(username)=lower($2)) RETURNING id`, [m.chatId, cancel[1].trim()]);
    return { text: r.length ? `Cancelled the card for ${cancel[1].trim()}. The voice notes won't be sent.` : "I couldn't find a card for them here.", ephemeral: true };
  }
  const DAYWORD = /^(?:today|tomorrow|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|for|on|\d)/i;
  const who = m.mentions[0] ?? (() => { const x = /^([a-z][\w'-]{1,30})\b/i.exec(a); return x && !DAYWORD.test(x[1]) ? { name: x[1].charAt(0).toUpperCase() + x[1].slice(1) } as Person : null; })();
  if (!who) return { text: "Who's it for, and when? Like `/card @ada 12 March` or `/card Ada friday`.", ephemeral: true };
  const rest = a.replace(/@\w+/, " ").replace(new RegExp(`^${who.name.replace(/[^\w]/g, "")}\\b`, "i"), " ").replace(/\b(?:for|on|is|birthday|bday)\b/gi, " ").replace(/\s+/g, " ").trim();
  const local = DateTime.fromJSDate(now).setZone(tz).startOf("day");
  let day: DateTime | null = null;
  const dm = parseDayMonth(rest);
  if (dm) { day = local.set({ month: dm.month, day: dm.day }); if (day < local) day = day.plus({ years: 1 }); }
  else if (/^tomorrow$/i.test(rest)) day = local.plus({ days: 1 });
  else if (/^today$/i.test(rest)) return { text: "Today's already begun, so there's no midnight left to land on. Start the card a day or more before, so everyone has time to record.", ephemeral: true };
  else {
    const wd = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].findIndex((w) => rest.toLowerCase().startsWith(w.slice(0, 3)));
    if (wd >= 0) { let d = local.plus({ days: 1 }); while (d.weekday !== wd + 1) d = d.plus({ days: 1 }); day = d; }
  }
  if (!day) return { text: "Which day is the birthday? Like `/card @ada 12 March`, `/card Ada friday` or `/card Ada tomorrow`.", ephemeral: true };
  if (day.diff(local, "days").days > 60) return { text: "That's more than two months away. Start the card closer to the day, so the voice notes are fresh.", ephemeral: true };
  const name = who.username && who.name === who.username ? who.username : who.name.split(" ")[0];
  const tg = who.id ?? (who.username ? await tgOfUsername(db, who.username) : null);
  const row = await db.one<{ id: number }>(`INSERT INTO group_cards (chat_id, name, username, tg_id, day, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [m.chatId, name, who.username ?? null, tg, day.toISODate(), m.from.id]);
  return {
    text: [`**A birthday card for ${who.username ? `@${who.username}` : name}**`, `Reply to this message with a short voice note, ten seconds or so. Everyone's goes out together in one card at midnight on ${day.toFormat("cccc d LLLL")}.`, `For a surprise, start it in a group ${name} isn't in. \`/card cancel ${name}\` stops it.`].join("\n"),
    remember: { card: row!.id },
  };
}
/** The bot posted the card's prompt: replies to that message are the voice notes. */
export async function rememberCard(db: Db, cardId: number, msgId: number): Promise<void> {
  await db.query(`UPDATE group_cards SET prompt_msg=$2 WHERE id=$1`, [cardId, msgId]);
}
/** A voice note replying to a card's prompt. One per person; a second replaces the first. */
export async function cardVoice(db: Db, chatId: number, replyTo: number, from: Person & { id: number }, fileId: string, seconds: number): Promise<"kept" | "replaced" | "too long" | null> {
  const c = await db.one<{ id: number }>(`SELECT id FROM group_cards WHERE chat_id=$1 AND prompt_msg=$2 AND NOT sent AND NOT cancelled`, [chatId, replyTo]);
  if (!c) return null;
  if (seconds > 60) return "too long";
  const had = await db.one(`SELECT 1 AS x FROM group_card_voices WHERE card_id=$1 AND tg_id=$2`, [c.id, from.id]);
  await db.query(`INSERT INTO group_card_voices (card_id, tg_id, name, file_id, seconds) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (card_id, tg_id) DO UPDATE SET file_id=EXCLUDED.file_id, seconds=EXCLUDED.seconds, name=EXCLUDED.name, created_at=now()`, [c.id, from.id, first(from), fileId, seconds]);
  return had ? "replaced" : "kept";
}
export interface DueCard { chatId: number; title: string | null; name: string; tgId: number | null; voices: { name: string; fileId: string; seconds: number | null }[] }
/** Cards whose day has begun in the group's time zone (sent in the first quarter hour after midnight, or late if the server was down). */
export async function dueCards(db: Db, now: Date): Promise<DueCard[]> {
  const rows = await db.query<{ id: number; chat_id: string; name: string; tg_id: string | null; day: string; tz: string; title: string | null }>(
    `SELECT c.id, c.chat_id::text, c.name, c.tg_id::text, to_char(c.day, 'YYYY-MM-DD') AS day, g.tz, g.title FROM group_cards c JOIN group_chats g ON g.chat_id=c.chat_id WHERE NOT c.sent AND NOT c.cancelled AND g.active`);
  const out: DueCard[] = [];
  for (const r of rows) {
    const today = DateTime.fromJSDate(now).setZone(r.tz || "UTC").toISODate()!;
    if (today < r.day) continue;
    await db.query(`UPDATE group_cards SET sent=true WHERE id=$1`, [r.id]);
    if (today > r.day) continue; // the day passed while we were down: a late card is worse than none
    const voices = await db.query<{ name: string; file_id: string; seconds: number | null }>(`SELECT name, file_id, seconds FROM group_card_voices WHERE card_id=$1 ORDER BY created_at LIMIT 30`, [r.id]);
    out.push({ chatId: Number(r.chat_id), title: r.title, name: r.name, tgId: r.tg_id ? Number(r.tg_id) : null, voices: voices.map((v) => ({ name: v.name, fileId: v.file_id, seconds: v.seconds })) });
  }
  return out;
}
/** The card as a rich message: a heading, a line, then each voice note with who it's from. */
export function cardRich(c: DueCard): { blocks: any[] } {
  const from = c.voices.length === 1 ? `One voice note from ${c.voices[0].name}` : c.voices.length ? `${c.voices.length} voice notes from ${c.title ?? "your friends"}` : "";
  return {
    blocks: [
      { type: "heading", text: `Happy birthday, ${c.name}`, size: 1 },
      ...(from ? [{ type: "paragraph", text: `${from}. Press play.` }] : [{ type: "paragraph", text: "From everyone here." }]),
      ...c.voices.map((v) => ({ type: "voice_note", voice_note: { type: "voice_note", media: v.fileId, ...(v.seconds ? { duration: v.seconds } : {}) }, caption: { text: `From ${v.name}` } })),
    ],
  };
}

/* ---------------- entry points ---------------- */

export async function groupCommand(db: Db, m: GroupMsg, now = new Date()): Promise<GroupOut | null> {
  switch (m.cmd) {
    case "split": return split(db, m);
    case "tab": case "owe": case "owes": return tab(db, m);
    case "list": return list(db, m);
    case "when": case "plan": return when(db, m, now);
    case "trivia": case "quiz": return trivia(now);
    case "birthday": case "bday": return birthday(db, m);
    case "card": case "celebrate": case "voicecard": return card(db, m, now);
    case "help": case "start": case "menu": case "everything": return { text: GROUP_HELP, ephemeral: true };
    default: return null;
  }
}

/** "@lifeline split 60 pizza with @ben" said in words: the same as the command. */
export function wordsToCommand(text: string): { cmd: string; args: string } | null {
  const t = text.trim();
  const m = /^(split|tab|who owes|list|add|when|trivia|quiz|birthday|my birthday is|celebrate|voice card for|birthday card for|card for|help)\b[:,]?\s*(.*)$/is.exec(t);
  if (!m) return null;
  const w = m[1].toLowerCase();
  const cmd = w === "who owes" ? "tab" : w === "add" ? "list" : w === "my birthday is" ? "birthday" : /card for$|^celebrate$/.test(w) ? "card" : w;
  return { cmd, args: m[2] ?? "" };
}

/** A tap on a group button. Returns the new text for the message (or nothing), and a short toast. */
export async function rememberBill(db: Db, billId: number, msgId: number): Promise<void> {
  await db.query(`UPDATE group_bills SET msg_id=$2 WHERE id=$1`, [billId, msgId]);
}

export async function groupButton(db: Db, chatId: number, from: Person & { id: number }, data: string): Promise<{ toast: string; edit?: GroupOut; billMsg?: number; calendar?: { title: string; startIso: string } }> {
  const [, kind, raw] = /^gr:(\w+)(?::(\d+))?$/.exec(data) ?? [];
  const id = Number(raw);
  if (kind === "pay" || kind === "all") {
    const b = await db.one<{ id: number; payer_tg: string | null }>(`SELECT id, payer_tg::text FROM group_bills WHERE id=$1 AND chat_id=$2`, [id, chatId]);
    if (!b) return { toast: "I can't find that bill any more." };
    if (kind === "all") {
      if (String(from.id) !== b.payer_tg) return { toast: "Only whoever paid can mark everyone square." };
      await db.query(`UPDATE group_shares SET paid=true WHERE bill_id=$1`, [id]);
      return { toast: "Everyone's square.", edit: (await billText(db, id))! };
    }
    const mine = await db.one<{ id: number; paid: boolean }>(
      `SELECT id, paid FROM group_shares WHERE bill_id=$1 AND (tg_id=$2 OR (username IS NOT NULL AND lower(username)=lower($3))) ORDER BY paid LIMIT 1`, [id, from.id, from.username ?? ""]);
    if (!mine) return { toast: "You're not in this split. Whoever made it can add you with a new /split." };
    if (mine.paid) return { toast: "You're already marked as paid." };
    await db.query(`UPDATE group_shares SET paid=true, tg_id=$2 WHERE id=$1`, [mine.id, from.id]);
    const msg = await db.one<{ msg_id: string | null }>(`SELECT msg_id::text FROM group_bills WHERE id=$1`, [id]);
    return { toast: "Marked as paid. Thank you.", edit: (await billText(db, id))!, billMsg: msg?.msg_id ? Number(msg.msg_id) : undefined };
  }
  if (kind === "cal") {
    const ev = await pollEvent(db, chatId, id);
    return ev ? { toast: "Adding it to your calendar.", calendar: ev } : { toast: "That plan has moved on." };
  }
  if (kind === "tick") {
    const r = await db.one<{ text: string }>(`UPDATE group_items SET done=true WHERE id=$1 AND chat_id=$2 RETURNING text`, [id, chatId]);
    return { toast: r ? `Got ${r.text}.` : "That's gone from the list.", edit: await listText(db, chatId) };
  }
  if (kind === "clear") {
    await db.query(`DELETE FROM group_items WHERE chat_id=$1 AND done`, [chatId]);
    return { toast: "Cleared.", edit: await listText(db, chatId) };
  }
  return { toast: "That button has expired." };
}

/* ---------------- guest mode: summoned in a chat lifeline isn't in ---------------- */


/**
 * Someone typed @lifeline in another chat. The answer is posted into that chat, so it is for everyone there:
 * a split worked out, a quick general answer for circle members, or a line about what lifeline is.
 * Never anything from the caller's own records.
 */
export async function guestAnswer(db: Db, caller: Person & { id: number }, text: string, botUsername: string): Promise<string> {
  const t = text.replace(new RegExp(`@${botUsername}\\b`, "ig"), " ").replace(/\s+/g, " ").trim();
  const w = wordsToCommand(t);
  if (w?.cmd === "split") {
    const words = w.args.replace(/@\w+/g, " ");
    const said = parseMoney(words);
    const x = said ?? (() => { const y = /(\d[\d,]*(?:\.\d+)?)/.exec(words); return y ? { amount: Number(y[1].replace(/,/g, "")), currency: "" } : null; })();
    const n = Number(/\bbetween (\d{1,2})\b|\b(\d{1,2}) ways\b/i.exec(words)?.slice(1).find(Boolean) ?? (w.args.match(/@\w+/g)?.length ?? 0) + 1);
    if (x && x.amount > 0 && n >= 2) return `${amt(x.amount, x.currency || null)} between ${n} is ${amt(Math.round((x.amount / n) * 100) / 100, x.currency || null)} each.`;
  }
  const member = await memberOf(db, caller.id);
  const about = `I'm lifeline, a personal assistant you talk to in plain words: reminders, lists, money, health, trips and more. Message @${botUsername} to start.`;
  if (!t || /^(?:help|hi|hello|hey|what are you|who are you)\??$/i.test(t)) return about;
  if (!member || !providerName() || (await overBudget(db, member.id))) return member ? "I can't think that one through right now. Ask me again in a bit." : about;
  try {
    const r = await complete({
      system: "You are lifeline, answering in someone else's chat because they called you in. Everyone there can read your answer. Answer the question briefly and plainly (at most 80 words). You know nothing about the person's own life here; never claim to. No emoji, no em dashes.",
      messages: [{ role: "user", content: t.slice(0, 1500) }], maxTokens: 300,
    });
    if (!r?.text) return "I couldn't come up with a good answer to that.";
    await recordUsage(db, member.id, r.usage.input, r.usage.output);
    return r.text.trim().slice(0, 1500);
  } catch { return "I couldn't come up with a good answer to that."; }
}

addCapability({
  key: "groups", name: "In a group chat",
  cues: ["group", "split the bill", "split", "shared list", "find a time", "group chat", "friends"],
  what: "Add me to a group and I help with what you do together: split a bill (each person sees their own share privately) and see who's paid, keep one shared list, make a poll to find a time and send the invite when it closes, run trivia, say happy birthday on the day, and record a voice card where everyone leaves a short message that lands together at midnight. Nothing personal of anyone's ever shows up there.",
  say: ["/split 120 dinner @ana @ben", "/list rice, eggs", "/when movie night 8pm", "/card @ada 12 March"],
  then: "Help and mistakes are shown only to whoever asked, so the group's chat stays about the group.",
}, "People");
