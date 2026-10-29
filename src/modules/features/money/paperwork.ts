/**
 * Paperwork: document and ID expiry dates, warranties and return windows, and a relocation checklist.
 * Only names and dates are kept, never document numbers or scans: a long ID in a message is dropped
 * and the person is told so.
 */
import { z } from "zod";
import { defineAction, type Ctx, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addPhotoAction, addRules, addSchema } from "../../../core/plugins.js";
import { propose } from "../../../policy/engine.js";
import type { Db } from "../../../core/db.js";
import { DATEISH, addBrief, addPinger, byName, cap, clean, daysUntil, dt, ensureDaily, parseDay, plural, re, sayDate, sayIn, think, todayOf } from "./common.js";

addSchema(`CREATE TABLE IF NOT EXISTS money_docs (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'other', expires_on DATE NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS money_warranty (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), item TEXT NOT NULL, kind TEXT NOT NULL, ends_on DATE NOT NULL, done BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS money_moves (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), destination TEXT NOT NULL, move_on DATE, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS money_move_items (id SERIAL PRIMARY KEY, move_id INT NOT NULL REFERENCES money_moves(id), key TEXT NOT NULL, label TEXT NOT NULL, done BOOLEAN NOT NULL DEFAULT false)`);

/* ================= documents ================= */

/** Long ID-like tokens: passport, licence and card numbers. Dates and amounts are left alone. */
export function idsIn(text: string): string[] {
  return text.split(/\s+/).map((t) => t.replace(/^[#(:"']+|[)"',.:;!?]+$/g, "")).filter((t) => {
    if (!t || /[/.]/.test(t) || /^\d{4}-\d{2}-\d{2}$/.test(t) || /^\d{1,2}(?:st|nd|rd|th)$/i.test(t)) return false;
    if (!/^[\p{L}\p{N}-]+$/u.test(t)) return false;
    const digits = (t.match(/\d/g) ?? []).length, letters = (t.match(/\p{L}/gu) ?? []).length;
    return digits >= 6 || (digits >= 3 && letters >= 1 && t.length >= 7);
  });
}
const KIND: [RegExp, string][] = [[/passport/i, "passport"], [/visa|permit|residen|green card|brp\b/i, "visa"], [/licen[cs]e/i, "licence"], [/insurance|policy/i, "insurance"], [/\bid\b|identity|national id|ghana card|aadhaar|\bnin\b/i, "id"]];
const kindOf = (name: string) => KIND.find(([r]) => r.test(name))?.[1] ?? "other";
interface Doc { id: number; name: string; kind: string; expires_on: string }
const docs = (db: Db, user: User) => db.query<Doc>(`SELECT id, name, kind, expires_on::text FROM money_docs WHERE user_id=$1 AND active ORDER BY expires_on`, [user.id]);

/** Upcoming trips that would start with less than six months left on the passport. */
async function passportWarnings(db: Db, user: User, today: string): Promise<{ doc: Doc; dest: string; starts: string; tripId: number }[]> {
  const pass = (await docs(db, user)).filter((d) => d.kind === "passport");
  if (!pass.length) return [];
  const trips = await db.query<{ id: number; destination: string; starts_on: string }>(`SELECT id, destination, starts_on::text FROM trips WHERE user_id=$1 AND status<>'cancelled' AND starts_on >= $2::date ORDER BY starts_on LIMIT 5`, [user.id, today]);
  const out = [];
  for (const t of trips) for (const p of pass) if (dt(p.expires_on) < dt(t.starts_on).plus({ months: 6 })) out.push({ doc: p, dest: cap(t.destination), starts: t.starts_on, tripId: t.id });
  return out;
}
const warnLine = (w: { doc: Doc; dest: string; starts: string }, user: User, now: Date) =>
  `Your passport will have under six months left when you go to ${w.dest} ${sayDate(w.starts, user, now)}. Some countries refuse entry with less, so check the rules for ${w.dest} before you fly.`;

const docAdd = defineAction({
  name: "doc.add",
  tier: 1,
  description: "Keep a document's expiry or renewal date: passport, visa, driving licence, ID card, residence permit, car or home insurance, police certificate, language test. Only the document's name and the date; never its number or a scan.",
  schema: z.object({ name: z.string().min(2).max(80), when: z.string().min(2) }),
  async run(args, ctx) {
    const found = [...new Set([...idsIn(args.name), ...idsIn(ctx.sourceMessage ?? "")])];
    let name = args.name;
    for (const id of found) {
      name = name.replace(id, " ");
      // The number shouldn't sit in the conversation log either.
      await ctx.db.query(`UPDATE messages SET content = replace(content, $2, '[number removed]') WHERE user_id=$1 AND role='user' AND content LIKE '%' || $2 || '%'`, [ctx.user.id, id]);
    }
    name = cap(clean(name.replace(/\b(?:number|no\.?|num)\b/gi, " ").replace(/\s+/g, " ")));
    if (!name || name.length < 2) throw new Error("Which document is it? Tell me its name and date, like \"my passport expires 3 March 2027\", without the number.");
    const d = parseDay(args.when, ctx.user, ctx.now);
    if (!d) throw new Error(`I couldn't read a date in "${args.when}". When does your ${name.toLowerCase()} expire?`);
    const kind = kindOf(name);
    const all = await docs(ctx.db, ctx.user);
    const same = all.find((x) => x.name.toLowerCase() === name.toLowerCase()) ?? (kind === "passport" ? all.find((x) => x.kind === "passport") : undefined);
    let id: number;
    if (same) { await ctx.db.query(`UPDATE money_docs SET expires_on=$2, name=$3 WHERE id=$1`, [same.id, d, name]); id = same.id; }
    else id = (await ctx.db.one<{ id: number }>(`INSERT INTO money_docs (user_id, name, kind, expires_on) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.user.id, name, kind, d]))!.id;
    await ensureDaily(ctx.db, ctx.user);
    const left = daysUntil(d, ctx.user, ctx.now);
    const head = left < 0 ? `${name}, expired ${sayDate(d, ctx.user, ctx.now)}. That date's passed, so it may need renewing now.` : `${name}, ${/renew|insurance|policy|membership/i.test(`${name} ${ctx.sourceMessage ?? ""}`) ? "renews" : "expires"} ${sayDate(d, ctx.user, ctx.now)}, ${sayIn(left)}. I'll bring it up at 6 months, 90, 30 and 7 days before, with a ping at 30 and 7.`;
    const idNote = found.length ? ` I've left the number out: I only keep the name and the date, never document numbers or scans.` : "";
    const warn = kind === "passport" ? (await passportWarnings(ctx.db, ctx.user, todayOf(ctx.user, ctx.now))).find((w) => w.doc.id === id) : undefined;
    return { reply: `${head}${idNote}${warn ? `\n\n${warnLine(warn, ctx.user, ctx.now)}` : ""}`, undo: { payload: { id, prev: same ?? null } } };
  },
  async undo(p, ctx) {
    if (p.prev) await ctx.db.query(`UPDATE money_docs SET expires_on=$2, name=$3 WHERE id=$1 AND user_id=$4`, [p.id, p.prev.expires_on, p.prev.name, ctx.user.id]);
    else await ctx.db.query(`DELETE FROM money_docs WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Taken back.";
  },
});

const docList = defineAction({
  name: "doc.list",
  tier: 1,
  description: "Show the person's documents and their expiry dates, soonest first ('name' to ask about one, e.g. when does my passport expire), with any passport warning for an upcoming trip.",
  schema: z.object({ name: z.string().optional() }),
  async run(args, ctx) {
    let rows = await docs(ctx.db, ctx.user);
    if (args.name) { const hit = byName(rows, "name", args.name) ?? rows.find((r) => r.kind === kindOf(args.name!) && r.kind !== "other"); rows = hit ? [hit] : []; }
    if (!rows.length) return { reply: args.name ? `I don't have a date for your ${clean(args.name).toLowerCase()}. Say "my ${clean(args.name).toLowerCase()} expires 3 March 2027" and I'll watch it.` : `No documents kept yet. Say "my passport expires 3 March 2027" or "car insurance renews 1 Jan".` };
    const line = (r: Doc) => { const d = daysUntil(r.expires_on, ctx.user, ctx.now); return `${r.name}: ${sayDate(r.expires_on, ctx.user, ctx.now)}, ${d < 0 ? "already passed" : sayIn(d)}`; };
    const warns = (await passportWarnings(ctx.db, ctx.user, todayOf(ctx.user, ctx.now))).map((w) => warnLine(w, ctx.user, ctx.now));
    const body = rows.length === 1 ? `${line(rows[0])}.` : [`${plural(rows.length, "document")}, soonest first:`, ...rows.map((r) => `- ${line(r)}`)].join("\n");
    return { reply: [body, ...(warns.length ? ["", warns[0]] : [])].join("\n") };
  },
});

const docRemove = defineAction({
  name: "doc.remove",
  tier: 1,
  description: "Stop tracking one of the person's document dates (it was renewed elsewhere, or they no longer have it).",
  schema: z.object({ name: z.string().min(2) }),
  async run(args, ctx) {
    const d = byName(await docs(ctx.db, ctx.user), "name", args.name);
    if (!d) return { reply: `I'm not keeping a date for ${clean(args.name).toLowerCase()}.` };
    await ctx.db.query(`UPDATE money_docs SET active=false WHERE id=$1`, [d.id]);
    return { reply: `${d.name} is off your documents.`, undo: { payload: { id: d.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE money_docs SET active=true WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Back on your documents."; },
});

/* ================= warranties and returns ================= */

interface War { id: number; item: string; kind: "warranty" | "return"; ends_on: string }
const wars = (db: Db, user: User) => db.query<War>(`SELECT id, item, kind, ends_on::text FROM money_warranty WHERE user_id=$1 AND NOT done ORDER BY ends_on`, [user.id]);

const warAdd = defineAction({
  name: "warranty.add",
  tier: 1,
  description: "Keep when a warranty ends (kind warranty) or a return window closes (kind return) for something the person bought: 'item' and 'when'. I remind them before it runs out.",
  schema: z.object({ item: z.string().min(1).max(60), kind: z.enum(["warranty", "return"]), when: z.string().min(2) }),
  async run(args, ctx) {
    const d = parseDay(args.when, ctx.user, ctx.now);
    if (!d) throw new Error(`I couldn't read a date in "${args.when}". When does it ${args.kind === "return" ? "close" : "end"}?`);
    const item = clean(args.item).toLowerCase();
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO money_warranty (user_id, item, kind, ends_on) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.user.id, item, args.kind, d]);
    await ensureDaily(ctx.db, ctx.user);
    const when = sayDate(d, ctx.user, ctx.now), left = daysUntil(d, ctx.user, ctx.now);
    const reply = args.kind === "return"
      ? `${cap(item)}: the return window closes ${when}.${left <= 1 ? " That's very soon, so return it now if you're going to." : " I'll remind you a day or two before."} Say "returned the ${item}" or "I'm keeping the ${item}" to clear it.`
      : `${cap(item)} warranty, until ${when}, ${sayIn(left)}. I'll remind you a month before, in case anything needs fixing while it's covered.`;
    return { reply, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM money_warranty WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Taken off."; },
});

const warList = defineAction({
  name: "warranty.list",
  tier: 1,
  description: "Show the person's open return windows and warranties, soonest first.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await wars(ctx.db, ctx.user);
    if (!rows.length) return { reply: `No warranties or return windows kept. Say "warranty for the laptop ends 12 May 2027" or "return window for the shoes closes Friday".` };
    return { reply: rows.map((r) => `- ${cap(r.item)}: ${r.kind === "return" ? "return by" : "warranty until"} ${sayDate(r.ends_on, ctx.user, ctx.now)}`).join("\n") };
  },
});

const warDone = defineAction({
  name: "warranty.done",
  tier: 1,
  description: "Clear a return window or warranty: the person returned the item, decided to keep it, or no longer needs the warranty reminder.",
  schema: z.object({ item: z.string().min(1), kept: z.boolean().optional() }),
  async run(args, ctx) {
    const w = byName(await wars(ctx.db, ctx.user), "item", args.item);
    if (!w) return { reply: `I don't have a return or warranty for ${clean(args.item).toLowerCase()}.` };
    await ctx.db.query(`UPDATE money_warranty SET done=true WHERE id=$1`, [w.id]);
    return { reply: w.kind === "return" ? (args.kept ? `Keeping the ${w.item}. I've cleared the return reminder.` : `${cap(w.item)} returned; reminder cleared. Keep an eye out for the refund.`) : `${cap(w.item)} warranty cleared.`, undo: { payload: { id: w.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE money_warranty SET done=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Back on."; },
});

/* ================= relocation ================= */

const CHECKLIST: { key: string; label: string; match: RegExp; doc?: RegExp }[] = [
  { key: "passport", label: "Passport valid long enough (many countries want six months beyond your stay)", match: /passport/i, doc: /passport/i },
  { key: "visa", label: "Visa or permit type chosen and applied for", match: /visa|permit|residen/i, doc: /visa|permit|residen/i },
  { key: "police", label: "Police certificate", match: /police|criminal|background|good conduct|clearance/i, doc: /police|clearance|criminal/i },
  { key: "funds", label: "Proof of funds (bank statements)", match: /fund|bank statement|savings|money/i },
  { key: "language", label: "Language test still valid (IELTS, TOEFL, DELF, Goethe or similar)", match: /language|ielts|toefl|pte|celpip|delf|dalf|\btef\b|goethe|testdaf|jlpt|hsk|duolingo|english test|french test/i, doc: /language|ielts|toefl|pte|celpip|delf|dalf|\btef\b|goethe|testdaf|jlpt|hsk|duolingo/i },
  { key: "credentials", label: "Degree or credential evaluation", match: /credential|evaluation|\bwes\b|ecctis|naric|degree|transcript|qualification/i, doc: /credential|evaluation|\bwes\b|ecctis|naric/i },
  { key: "flights", label: "Flights", match: /flight|ticket|plane/i },
  { key: "home", label: "Somewhere to stay when you land", match: /accommodation|housing|stay|apartment|flat|airbnb|place to live|room|lease|home|hotel/i },
];
interface Move { id: number; destination: string; move_on: string | null }
const activeMove = (db: Db, user: User) => db.one<Move>(`SELECT id, destination, move_on::text FROM money_moves WHERE user_id=$1 AND active ORDER BY id DESC LIMIT 1`, [user.id]);

async function checklist(ctx: Ctx, m: Move): Promise<string[]> {
  const items = await ctx.db.query<{ key: string; label: string; done: boolean }>(`SELECT key, label, done FROM money_move_items WHERE move_id=$1 ORDER BY id`, [m.id]);
  const ds = await docs(ctx.db, ctx.user);
  return items.map((it) => {
    const spec = CHECKLIST.find((c) => c.key === it.key);
    const d = spec?.doc ? ds.find((x) => spec.doc!.test(x.name)) : undefined;
    let note = d ? ` (${d.name.toLowerCase()} ${daysUntil(d.expires_on, ctx.user, ctx.now) < 0 ? "expired" : "expires"} ${sayDate(d.expires_on, ctx.user, ctx.now)})` : "";
    if (d && it.key === "passport" && m.move_on && dt(d.expires_on) < dt(m.move_on).plus({ months: 6 })) note += ", under six months left at your move date";
    return `- ${it.label}${note}${it.done ? ": done" : ""}`;
  });
}

const moveStart = defineAction({
  name: "relocation.start",
  tier: 1,
  description: "Start a relocation checklist for moving to another country ('destination', optional 'when'): passport validity, visa type, police certificate, proof of funds, language test, credential evaluation, flights, accommodation. Expiry dates go in the documents vault.",
  schema: z.object({ destination: z.string().min(2).max(60), when: z.string().optional() }),
  async run(args, ctx) {
    const dest = cap(clean(args.destination));
    const on = args.when ? parseDay(args.when, ctx.user, ctx.now) : null;
    const prev = await activeMove(ctx.db, ctx.user);
    if (prev) await ctx.db.query(`UPDATE money_moves SET active=false WHERE id=$1`, [prev.id]);
    const m = (await ctx.db.one<Move>(`INSERT INTO money_moves (user_id, destination, move_on) VALUES ($1,$2,$3) RETURNING id, destination, move_on::text`, [ctx.user.id, dest, on]))!;
    for (const c of CHECKLIST) await ctx.db.query(`INSERT INTO money_move_items (move_id, key, label) VALUES ($1,$2,$3)`, [m.id, c.key, c.label]);
    await ensureDaily(ctx.db, ctx.user);
    const tip = await think(ctx.db, ctx.user, `Someone is moving to ${dest}. In one short sentence, name the single most useful official place to check visa and entry rules for ${dest} (the government's immigration authority by name). No advice on eligibility. Output the sentence only.`, 80);
    const lines = await checklist(ctx, m);
    return {
      reply: [`${dest}${on ? `, ${sayDate(on, ctx.user, ctx.now)}` : ""}. Your move checklist:`, ...lines, "", `Tick things off with "tick flights". Anything with an expiry, tell me like "my police certificate expires 3 May 2027" and I'll watch it.${tip ? ` ${tip}` : ""}`].join("\n"),
      undo: { payload: { id: m.id, prev: prev?.id ?? null } },
    };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE money_moves SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    if (p.prev) await ctx.db.query(`UPDATE money_moves SET active=true WHERE id=$1 AND user_id=$2`, [p.prev, ctx.user.id]);
    return "Move checklist taken back.";
  },
});

const moveShow = defineAction({
  name: "relocation.show",
  tier: 1,
  description: "Show the person's relocation checklist: what's done, what's left, and any expiry dates from their documents.",
  schema: z.object({}),
  async run(_a, ctx) {
    const m = await activeMove(ctx.db, ctx.user);
    if (!m) return { reply: `No move checklist yet. Say "I'm moving to Canada" (or wherever) and I'll set one up.` };
    const lines = await checklist(ctx, m);
    const done = lines.filter((l) => l.endsWith(": done")).length;
    return { reply: [`${m.destination}${m.move_on ? `, ${sayDate(m.move_on, ctx.user, ctx.now)}` : ""}: ${done} of ${lines.length} done.`, ...lines].join("\n") };
  },
});

const moveTick = defineAction({
  name: "relocation.tick",
  tier: 1,
  description: "Tick an item off the person's relocation checklist ('item' in their words: flights, police certificate, IELTS). If there's no move checklist, it ticks it off their to-do or shopping list instead.",
  schema: z.object({ item: z.string().min(1) }),
  async run(args, ctx) {
    const m = await activeMove(ctx.db, ctx.user);
    const spec = CHECKLIST.find((c) => c.match.test(args.item));
    if (!m || !spec) {
      const d = await propose(ctx, "list.done", { match: args.item });
      if (d.kind === "ran") return { reply: d.reply, buttons: d.undoId ? [{ label: "Undo", data: `undo:${d.undoId}` }] : undefined };
      return { reply: m ? `That's not on your move checklist. Say "my move checklist" to see what is.` : d.kind === "error" || d.kind === "refused" ? d.reply : `There's nothing to tick there.` };
    }
    const it = await ctx.db.one<{ id: number; label: string; done: boolean }>(`SELECT id, label, done FROM money_move_items WHERE move_id=$1 AND key=$2`, [m.id, spec.key]);
    if (!it) return { reply: `That's not on your move checklist.` };
    await ctx.db.query(`UPDATE money_move_items SET done=true WHERE id=$1`, [it.id]);
    const left = await ctx.db.query<{ label: string }>(`SELECT label FROM money_move_items WHERE move_id=$1 AND NOT done ORDER BY id`, [m.id]);
    const short = it.label.split(" (")[0];
    return { reply: left.length ? `${short}: done. ${plural(left.length, "thing")} left for ${m.destination}; next, ${left[0].label.split(" (")[0].toLowerCase()}.` : `${short}: done. That's everything on the list for ${m.destination}. Safe travels when the day comes.`, undo: { payload: { id: it.id, was: it.done } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE money_move_items SET done=$2 WHERE id=$1 AND move_id IN (SELECT id FROM money_moves WHERE user_id=$3)`, [p.id, p.was, ctx.user.id]); return "Unticked."; },
});

register(docAdd, docList, docRemove, warAdd, warList, warDone, moveStart, moveShow, moveTick);
addPhotoAction("warranty.add");

/* ---------------- words → actions ---------------- */

const DOCW = "passport|visa|e-?visa|permit|licen[cs]e|insurance|policy|registration|residence card|residency|id|id card|identity card|national id|ghana card|nin|aadhaar|green card|brp|mot|road ?tax|roadworthy|vignette|certificate|membership|lease|tenancy|contract|ielts|toefl|pte|celpip|delf|vaccination card|yellow card|eta|esta";
const W = "[\\p{L}'’-]+";

addRules(
  // warranties and returns come before documents, so "warranty for the laptop ends ..." isn't a document
  [re(`(?:the\\s+)?warranty\\s+(?:for|on)\\s+(?:the\\s+|my\\s+)?(.+?)\\s+(?:ends|expires|runs out|lasts until|is valid until|runs until|is until|until)\\s+(?:on\\s+)?${DATEISH}`), (m) => ({ action: "warranty.add", args: { item: m[1], kind: "warranty", when: m[2] } })],
  [re(`(?:the\\s+|my\\s+)?(.+?)(?:'s)?\\s+warranty\\s+(?:ends|expires|runs out|lasts until|is until|until)\\s+(?:on\\s+)?${DATEISH}`), (m) => ({ action: "warranty.add", args: { item: m[1], kind: "warranty", when: m[2] } })],
  [re(`(?:the\\s+)?(?:return window|returns? period|return deadline|returns? policy)\\s+(?:for|on)\\s+(?:the\\s+|my\\s+)?(.+?)\\s+(?:closes|ends|is|shuts|runs out|expires)\\s+(?:on\\s+)?${DATEISH}`), (m) => ({ action: "warranty.add", args: { item: m[1], kind: "return", when: m[2] } })],
  [re(`(?:i\\s+)?(?:can|have to|must|need to)\\s+return\\s+(?:the\\s+|my\\s+)?(.+?)\\s+(?:by|before|until)\\s+${DATEISH}`), (m) => ({ action: "warranty.add", args: { item: m[1], kind: "return", when: m[2] } })],
  [re(`(?:my\\s+|show my\\s+)?(?:warranties|returns|return windows|warranty list)`), () => ({ action: "warranty.list", args: {} })],
  [re(`(?:i(?:'ve| have)?\\s+)?(?:returned|sent back|took back)\\s+(?!(?:the\\s+)?(?:call|calls|favou?r|home|from|to|fire|serve|ball)\\b)(?:the\\s+|my\\s+)?(.+)`), (m) => ({ action: "warranty.done", args: { item: m[1] } })],
  [re(`i(?:'m| am)\\s+keeping\\s+(?:the\\s+|my\\s+)?(.+)`), (m) => ({ action: "warranty.done", args: { item: m[1], kept: true } })],

  // documents
  [re(`(?:my\\s+|our\\s+|the\\s+)?(.{2,60}?)\\s+(?:expires|expire|expiring|expired|is valid until|valid until|valid till|good until)\\s+(?:on\\s+|in\\s+)?${DATEISH}`), (m) => ({ action: "doc.add", args: { name: m[1], when: m[2] } })],
  [re(`(?:my\\s+|our\\s+|the\\s+)?((?:${W}\\s+){0,4}?(?:${DOCW})(?:\\s+${W}){0,2}?)\\s+(?:ends|runs out|renews|is due for renewal|due for renewal|needs renewing)\\s+(?:on\\s+|in\\s+)?${DATEISH}`), (m) => ({ action: "doc.add", args: { name: m[1], when: m[2] } })],
  [re(`(?:my\\s+|show my\\s+)?(?:documents|docs|papers|paperwork|document vault|expiry dates)`), () => ({ action: "doc.list", args: {} })],
  [re(`when\\s+(?:does|do|is)\\s+(?:my\\s+)?(.+?)\\s+(?:expire|run out|end|due for renewal)\\??`), (m) => ({ action: "doc.list", args: { name: m[1] } })],
  [re(`(?:remove|delete|drop)\\s+(?:my\\s+|the\\s+)?(.+?)\\s+from\\s+(?:my\\s+)?(?:documents|docs|paperwork)|(?:remove|delete|drop)\\s+(?:my\\s+|the\\s+)?((?:${W}\\s+){0,2}?(?:${DOCW}))(?:\\s+date)?`), (m) => ({ action: "doc.remove", args: { name: m[1] ?? m[2] } })],

  // relocation
  [re(`(?:i(?:'m| am)|we(?:'re| are))\\s+(?:moving|relocating|emigrating)\\s+(?:abroad\\s+)?to\\s+(?!(?:a|an|the|my|our|new|another|his|her)\\b)(.+?)(?:\\s+((?:in|on|by|around|next|this|early|late|end of)\\s+.+))?|(?:help me\\s+)?(?:relocate|emigrate)\\s+to\\s+(.+)|(?:start\\s+(?:a\\s+)?)?(?:move|relocation)\\s+checklist\\s+(?:for\\s+)?(.+)`), (m) => ({ action: "relocation.start", args: { destination: m[1] ?? m[3] ?? m[4], ...(m[2] ? { when: m[2] } : {}) } })],
  [re(`(?:my\\s+|show my\\s+)?(?:move|moving|relocation)\\s+(?:checklist|list|plan|tracker)`), () => ({ action: "relocation.show", args: {} })],
  [re(`tick\\s+(?:off\\s+)?(?:the\\s+|my\\s+)?(.+?)(?:\\s+(?:on|off)\\s+(?:my\\s+|the\\s+)?(?:move|moving|relocation)(?:\\s+(?:checklist|list))?)?`), (m) => ({ action: "relocation.tick", args: { item: m[1] } })],
);

addExamples("warranty.add", ["warranty for the laptop ends 12 May 2027", "return window for the shoes closes Friday", "the fridge warranty expires June 2028", "I can return the jacket by 15 November"]);
addExamples("warranty.list", ["my warranties", "my returns"]);
addExamples("warranty.done", ["returned the shoes", "I'm keeping the jacket"]);
addExamples("doc.add", ["my passport expires 3 March 2027", "driving licence expires June 2028", "visa ends 30 Nov", "car insurance renews 1 Jan", "my residence permit expires 14 August 2027"]);
addExamples("doc.list", ["my documents", "when does my passport expire?"]);
addExamples("doc.remove", ["remove my visa", "delete the car insurance from my documents"]);
addExamples("relocation.start", ["I'm moving to Canada", "I'm relocating to Germany in March", "we're moving to Dubai"]);
addExamples("relocation.show", ["my move checklist", "relocation checklist"]);
addExamples("relocation.tick", ["tick flights", "tick off the police certificate"]);

addCues("doc", ["passport", "visa", "licence", "license", "permit", "expires", "expiry", "insurance", "documents", "id card", "renewal"]);
addCues("warranty", ["warranty", "guarantee", "return window", "return by", "returned", "refund", "receipt"]);
addCues("relocation", ["moving to", "relocating", "relocation", "emigrate", "move abroad", "checklist", "police certificate", "ielts", "proof of funds"]);

addCapability({
  key: "documents", name: "Documents and ID expiry",
  cues: ["passport", "visa", "licence", "license", "permit", "expires", "expiry", "insurance", "documents", "id card"],
  what: "I keep the expiry dates of your passport, visa, licence, ID, permits and insurance, and bring each up well before it runs out. If your passport will have under six months left on a trip you've told me about, I say so.",
  say: ["my passport expires 3 March 2027", "driving licence expires June 2028", "visa ends 30 Nov", "car insurance renews 1 Jan", "my documents"],
  then: "Your morning brief mentions each one at 6 months, 90, 30 and 7 days before; at 30 and 7 days I ping you too.",
  limits: "I keep only the name and the date. Never send me document numbers or scans; I won't keep them.",
}, "Home and paperwork");
addCapability({
  key: "warranties", name: "Warranties and returns",
  cues: ["warranty", "guarantee", "return window", "return by", "refund", "receipt"],
  what: "I remember when a return window closes and when a warranty ends, and remind you before either runs out.",
  say: ["warranty for the laptop ends 12 May 2027", "return window for the shoes closes Friday", "returned the shoes", "my warranties"],
  then: "Returns get a reminder a day or two before; warranties a month before. A receipt photo can start one.",
}, "Home and paperwork");
addCapability({
  key: "relocation", name: "Moving abroad checklist",
  cues: ["moving to", "relocating", "relocation", "emigrate", "move abroad", "police certificate", "proof of funds"],
  what: "Tell me where you're moving and I set up a short checklist: passport validity, visa type, police certificate, proof of funds, language test, credential evaluation, flights and somewhere to stay.",
  say: ["I'm moving to Canada", "my move checklist", "tick flights", "my police certificate expires 3 May 2027"],
  then: "Anything with an expiry date goes in your documents, so I watch it for you.",
  limits: "General steps for any country. For the rules themselves, the destination's official immigration site decides.",
}, "Home and paperwork");

/* ---------------- brief and pings ---------------- */

const DOC_MARKS = [182, 90, 30];
const docDue = (d: number) => (d >= 0 && d <= 7) || DOC_MARKS.some((m) => d <= m && d >= m - 2);

addBrief("paperwork", async (db, user, today, now) => {
  const out: { p: number; text: string }[] = [];
  const due = (await docs(db, user)).filter((r) => docDue(daysUntil(r.expires_on, user, now)) || (daysUntil(r.expires_on, user, now) < 0 && daysUntil(r.expires_on, user, now) >= -3));
  if (due.length) {
    const say = (r: Doc) => { const d = daysUntil(r.expires_on, user, now); return d < 0 ? `your ${r.name.toLowerCase()} expired ${sayDate(r.expires_on, user, now)}` : `your ${r.name.toLowerCase()} ${r.kind === "insurance" ? "renews" : "expires"} ${sayDate(r.expires_on, user, now)}, ${sayIn(d)}`; };
    out.push({ p: 10, text: cap(`${due.slice(0, 2).map(say).join(", and ")}.`) });
  }
  for (const w of await passportWarnings(db, user, today)) {
    const d = daysUntil(w.starts, user, now);
    if ((d <= 60 && d >= 58) || (d <= 30 && d >= 28) || d <= 14) { out.push({ p: 9, text: warnLine(w, user, now) }); break; }
  }
  const ws = await wars(db, user);
  const ret = ws.filter((w) => w.kind === "return" && daysUntil(w.ends_on, user, now) >= 0 && daysUntil(w.ends_on, user, now) <= 3);
  if (ret.length) out.push({ p: 12, text: `Last days to return: ${ret.map((w) => `the ${w.item} (${sayDate(w.ends_on, user, now)})`).join(", ")}.` });
  const war = ws.filter((w) => { const d = daysUntil(w.ends_on, user, now); return w.kind === "warranty" && ((d <= 30 && d >= 28) || (d >= 0 && d <= 7)); });
  if (war.length) out.push({ p: 14, text: `The ${war[0].item} warranty ends ${sayDate(war[0].ends_on, user, now)}, ${sayIn(daysUntil(war[0].ends_on, user, now))}.` });
  return out;
});

addPinger("docs", async (db, user, today, now) => {
  const out = [];
  for (const r of await docs(db, user)) {
    const d = daysUntil(r.expires_on, user, now);
    const step = d >= 0 && d <= 7 ? 7 : d > 7 && d <= 30 ? 30 : 0;
    if (step) out.push({ key: `doc:${r.id}:${r.expires_on}:${step}`, text: `Your ${r.name.toLowerCase()} ${r.kind === "insurance" ? "renews" : "expires"} ${sayDate(r.expires_on, user, now)}, ${sayIn(d)}.` });
  }
  for (const w of await passportWarnings(db, user, today)) if (daysUntil(w.starts, user, now) <= 90) out.push({ key: `passtrip:${w.doc.id}:${w.tripId}:${w.doc.expires_on}`, text: warnLine(w, user, now) });
  return out.slice(0, 3);
});
addPinger("warranty", async (db, user, _today, now) => {
  const out = [];
  for (const w of await wars(db, user)) {
    const d = daysUntil(w.ends_on, user, now);
    if (w.kind === "return" && d >= 0 && d <= 2) out.push({ key: `ret:${w.id}:${d === 0 ? "today" : "soon"}`, text: `The return window for the ${w.item} closes ${sayDate(w.ends_on, user, now)}. Say "I'm keeping the ${w.item}" if you've decided.` });
    if (w.kind === "warranty" && d > 0 && d <= 30) out.push({ key: `war:${w.id}:30`, text: `The ${w.item} warranty ends ${sayDate(w.ends_on, user, now)}, ${sayIn(d)}. If anything's wrong with it, now's the time to claim.` });
  }
  return out.slice(0, 2);
});
