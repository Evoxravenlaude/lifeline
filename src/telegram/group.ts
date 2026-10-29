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

export interface Person { id?: number; name: string; username?: string }
export interface GroupMsg { chatId: number; title?: string; from: Person & { id: number }; cmd: string; args: string; mentions: Person[] }
export interface GroupBtn { label: string; data: string }
export interface Poll { question: string; options: string[]; correct?: number; explanation?: string; multiple?: boolean }
export interface GroupOut { text?: string; buttons?: GroupBtn[][]; ephemeral?: boolean; poll?: Poll; dm?: boolean }

export const GROUP_HELP = [
  "**In a group I do things together.**",
  "- `/split 120 dinner @ana @ben` splits a bill",
  "- `/tab` shows who still owes what",
  "- `/list rice, eggs` adds to the group's list; `/list` shows it",
  "- `/when movie night` makes a poll of the next few evenings",
  "- `/trivia` starts a quiz",
  "- `/birthday 12 March` and I'll say happy birthday here",
  "Your own things stay between you and me: message me directly for those.",
].join("\n");

const first = (p: Person) => (p.username ? `@${p.username}` : p.name.split(" ")[0]);
const amt = (n: number, cur: string | null) => (cur ? money(n, cur) : Number.isInteger(n) ? String(n) : n.toFixed(2));

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
  for (const p of people) {
    const isPayer = p.id === m.from.id;
    await db.query(`INSERT INTO group_shares (bill_id, name, username, tg_id, share, paid) VALUES ($1,$2,$3,$4,$5,$6)`, [bill!.id, p.name, p.username ?? null, p.id ?? null, share, isPayer]);
  }
  return (await billText(db, bill!.id))!;
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

async function when(db: Db, m: GroupMsg, now: Date): Promise<GroupOut> {
  const g = await groupOf(db, m.chatId);
  const what = m.args.trim().replace(/[?.]+$/, "").slice(0, 120) || "we meet";
  const local = DateTime.fromJSDate(now).setZone(g?.tz ?? "UTC");
  const start = local.hour >= 17 ? 1 : 0;
  const options = Array.from({ length: 6 }, (_, i) => local.plus({ days: start + i })).map((d, i) => (i === 0 && start === 0 ? "Tonight" : i === 0 || (start === 0 && i === 1) ? `Tomorrow, ${d.toFormat("ccc d LLL")}` : d.toFormat("cccc d LLL")));
  options.push("None of these work");
  return { poll: { question: `When works for ${what}?`, options, multiple: true } };
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

/* ---------------- entry points ---------------- */

export async function groupCommand(db: Db, m: GroupMsg, now = new Date()): Promise<GroupOut | null> {
  switch (m.cmd) {
    case "split": return split(db, m);
    case "tab": case "owe": case "owes": return tab(db, m);
    case "list": return list(db, m);
    case "when": case "plan": return when(db, m, now);
    case "trivia": case "quiz": return trivia(now);
    case "birthday": case "bday": return birthday(db, m);
    case "help": case "start": case "menu": case "everything": return { text: GROUP_HELP, ephemeral: true };
    default: return null;
  }
}

/** "@lifeline split 60 pizza with @ben" said in words: the same as the command. */
export function wordsToCommand(text: string): { cmd: string; args: string } | null {
  const t = text.trim();
  const m = /^(split|tab|who owes|list|add|when|trivia|quiz|birthday|my birthday is|help)\b[:,]?\s*(.*)$/is.exec(t);
  if (!m) return null;
  const w = m[1].toLowerCase();
  const cmd = w === "who owes" ? "tab" : w === "add" ? "list" : w === "my birthday is" ? "birthday" : w;
  return { cmd, args: m[2] ?? "" };
}

/** A tap on a group button. Returns the new text for the message (or nothing), and a short toast. */
export async function groupButton(db: Db, chatId: number, from: Person & { id: number }, data: string): Promise<{ toast: string; edit?: GroupOut }> {
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
    return { toast: "Marked as paid. Thank you.", edit: (await billText(db, id))! };
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
  what: "Add me to a group and I help with what you do together: split a bill and see who's paid, keep one shared list, make a poll to find a time, run trivia, and say happy birthday on the day. Nothing personal of anyone's ever shows up there.",
  say: ["/split 120 dinner @ana @ben", "/list rice, eggs", "/when movie night", "/birthday 12 March"],
  then: "Help and mistakes are shown only to whoever asked, so the group's chat stays about the group.",
}, "People");
