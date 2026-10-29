/**
 * Money between people: IOUs, freelance invoices and savings circles (ajo, esusu, tontine, chama,
 * tanda, susu, hui). All three are ledgers for the person only. Nothing here moves money, and the
 * only thing that ever reaches someone else is an invoice reminder the person confirms with a yes.
 */
import { z } from "zod";
import { defineAction, type Ctx } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import { canEmail, sendEmail } from "../../../core/email.js";
import {
  AMT, NAME, addBrief, addMoneyButton, addPeriod, addPinger, amt, byName, cap, clean, daysUntil, dt, ensureDaily, firstName, fmt, hasCardNumber,
  listWords, normCur, parseDay, periodOf, plural, re, runFromButton, sayDate, todayOf, totals, PERIOD,
} from "./common.js";

addSchema(`CREATE TABLE IF NOT EXISTS money_ious (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), who TEXT NOT NULL, direction TEXT NOT NULL, amount NUMERIC NOT NULL, paid NUMERIC NOT NULL DEFAULT 0, currency TEXT NOT NULL, note TEXT, due DATE, settled_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS money_invoices (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), client TEXT NOT NULL, amount NUMERIC NOT NULL, currency TEXT NOT NULL, due_on DATE, email TEXT, paid_at TIMESTAMPTZ, chased INT NOT NULL DEFAULT 0, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS money_circles (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT NOT NULL, members JSONB NOT NULL, amount NUMERIC NOT NULL, currency TEXT NOT NULL, period TEXT NOT NULL, start_on DATE NOT NULL, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS money_circle_pay (id SERIAL PRIMARY KEY, circle_id INT NOT NULL REFERENCES money_circles(id), round INT NOT NULL, member TEXT NOT NULL, at TIMESTAMPTZ DEFAULT now(), UNIQUE (circle_id, round, member))`);

interface Iou { id: number; who: string; direction: "they_owe" | "i_owe"; amount: string; paid: string; currency: string; note: string | null; due: string | null }
interface Invoice { id: number; client: string; amount: string; currency: string; due_on: string | null; email: string | null; chased: number; paid_at: string | null }
interface Circle { id: number; name: string; members: string[] | string; amount: string; currency: string; period: string; start_on: string }

const left = (r: Iou) => Number(r.amount) - Number(r.paid);
const dateIso = (d: string | Date | null) => (d ? (typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10)) : null);
const openIous = (ctx: Ctx) => ctx.db.query<Iou>(`SELECT id, who, direction, amount::text, paid::text, currency, note, due::text, settled_at FROM money_ious WHERE user_id=$1 AND settled_at IS NULL ORDER BY id`, [ctx.user.id]);
const openInvoices = (ctx: Pick<Ctx, "db" | "user">) => ctx.db.query<Invoice>(`SELECT id, client, amount::text, currency, due_on::text, email, chased, paid_at FROM money_invoices WHERE user_id=$1 AND paid_at IS NULL ORDER BY due_on NULLS LAST, id`, [ctx.user.id]);
const membersOf = (c: Circle): string[] => (typeof c.members === "string" ? JSON.parse(c.members) : c.members);
const circles = (ctx: Pick<Ctx, "db" | "user">) => ctx.db.query<Circle>(`SELECT id, name, members, amount::text, currency, period, start_on::text FROM money_circles WHERE user_id=$1 AND active ORDER BY id DESC`, [ctx.user.id]);

/* ================= IOUs ================= */

const iouAdd = defineAction({
  name: "iou.add",
  tier: 1,
  description: "Keep an IOU: someone owes the person money (direction they_owe, 'Ana owes me 40 for dinner') or the person owes someone (i_owe, 'I owe Tunde 15000'). 'due' is an optional date in their words. Currency as typed or an ISO code; leave it out to use theirs.",
  schema: z.object({ who: z.string().min(1).max(60), amount: z.number().positive(), currency: z.string().max(8).optional(), direction: z.enum(["they_owe", "i_owe"]), note: z.string().max(120).optional(), due: z.string().optional() }),
  async run(args, ctx) {
    const cur = normCur(args.currency, ctx.user);
    const who = clean(args.who).replace(/'s$/i, "");
    const note = args.note && !hasCardNumber(args.note) ? args.note.trim().replace(/[.!?,]+$/, "") : null;
    const due = args.due ? parseDay(args.due, ctx.user, ctx.now) : null;
    if (args.due && !due) throw new Error(`I couldn't read a date in "${args.due}". When should it be paid back?`);
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO money_ious (user_id, who, direction, amount, currency, note, due) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.user.id, cap(who), args.direction, args.amount, cur, note, due]);
    if (due) await ensureDaily(ctx.db, ctx.user);
    const all = (await openIous(ctx)).filter((x) => x.who.toLowerCase() === who.toLowerCase() && x.direction === args.direction && x.currency === cur);
    const sum = all.reduce((s, x) => s + left(x), 0);
    const more = all.length > 1 ? ` That's ${fmt(sum, cur)} in all.` : "";
    const when = due ? `, due ${sayDate(due, ctx.user, ctx.now)}` : "";
    const what = `${fmt(args.amount, cur)}${note ? ` for ${note}` : ""}${when}`;
    return args.direction === "they_owe"
      ? { reply: `${cap(who)} owes you ${what}.${more} Say "remind ${cap(who)}" for a friendly nudge to send, or "${cap(who)} paid me back" when it's sorted.`, undo: { payload: { id: r!.id } } }
      : { reply: `You owe ${cap(who)} ${what}.${more} Say "I paid ${cap(who)} back" when it's done.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM money_ious WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Taken off."; },
});

const iouList = defineAction({
  name: "iou.list",
  tier: 1,
  description: "Show open IOUs: who owes the person money and who they owe, with totals per currency.",
  schema: z.object({ direction: z.enum(["they_owe", "i_owe"]).optional() }),
  async run(args, ctx) {
    const rows = await openIous(ctx);
    if (!rows.length) return { reply: `Nobody owes you anything I know of, and you don't owe anyone. Say "Ana owes me 40 for dinner" to keep one.` };
    const line = (r: Iou) => `- ${r.who}: ${fmt(left(r), r.currency)}${r.note ? ` for ${r.note}` : ""}${r.due ? `, due ${sayDate(dateIso(r.due)!, ctx.user, ctx.now)}` : ""}`;
    const they = rows.filter((r) => r.direction === "they_owe"), me = rows.filter((r) => r.direction === "i_owe");
    const out: string[] = [];
    const sec = (head: string, rs: Iou[]) => { if (rs.length) out.push(head, ...rs.map(line)); };
    const theyHead = `Owed to you: ${totals(they.map((r) => ({ amount: left(r), currency: r.currency })))}.`;
    const meHead = `You owe: ${totals(me.map((r) => ({ amount: left(r), currency: r.currency })))}.`;
    if (args.direction === "i_owe") { sec(meHead, me); if (they.length) out.push("", theyHead.replace(/\.$/, " to you in all.").replace("Owed to you: ", "And ")); }
    else { sec(theyHead, they); if (me.length) { if (out.length) out.push(""); sec(meHead, me); } }
    if (!out.length) out.push(args.direction === "i_owe" ? "You don't owe anyone that I know of." : "Nobody owes you anything right now.");
    return { reply: out.join("\n") };
  },
});

/** Pay off IOUs with one person, oldest first. Returns what changed so it can be undone. */
async function settleIous(ctx: Ctx, rows: Iou[], amount?: number) {
  const changed: { id: number; paid: string }[] = [];
  let pool = amount ?? Infinity, applied = 0;
  for (const r of rows) {
    if (pool <= 0) break;
    const take = Math.min(left(r), pool);
    pool -= take; applied += take;
    changed.push({ id: r.id, paid: r.paid });
    const paid = Number(r.paid) + take;
    await ctx.db.query(`UPDATE money_ious SET paid=$2, settled_at=$3 WHERE id=$1`, [r.id, paid, paid >= Number(r.amount) - 1e-9 ? ctx.now : null]);
  }
  return { changed, applied };
}

const iouSettle = defineAction({
  name: "iou.settle",
  tier: 1,
  description: "Mark an IOU paid back, fully or by 'amount': 'Ana paid me back' (direction they_owe) or 'I paid Tunde back' (i_owe). Also settles a client's open invoice if that's what the name matches.",
  schema: z.object({ who: z.string().min(1), amount: z.number().positive().optional(), currency: z.string().max(8).optional(), direction: z.enum(["they_owe", "i_owe"]).optional() }),
  async run(args, ctx) {
    const all = await openIous(ctx);
    const pool = args.direction ? all.filter((r) => r.direction === args.direction) : all;
    const hit = byName(pool, "who", args.who);
    if (!hit) {
      if (args.direction !== "i_owe") {
        const inv = byName(await openInvoices(ctx), "client", args.who);
        if (inv) return payInvoice(ctx, inv);
      }
      return { reply: `I don't have anything open with ${cap(clean(args.who))}. Say "who owes me" to see what I'm keeping.` };
    }
    const rows = pool.filter((r) => r.who === hit.who && r.direction === hit.direction && (!args.currency || r.currency === normCur(args.currency, ctx.user)));
    const before = rows.reduce((s, r) => s + left(r), 0);
    const { changed, applied } = await settleIous(ctx, rows, args.amount);
    const rest = before - applied;
    const cur = rows[0].currency;
    const they = hit.direction === "they_owe";
    const reply = rest <= 1e-9
      ? (they ? `${hit.who}'s paid you back ${fmt(applied, cur)}. All square.` : `You've paid ${hit.who} back ${fmt(applied, cur)}. All square.`)
      : (they ? `${hit.who} paid ${fmt(applied, cur)}; ${fmt(rest, cur)} still to come.` : `You've paid ${hit.who} ${fmt(applied, cur)}; ${fmt(rest, cur)} still to go.`);
    return { reply, undo: { payload: { changed } } };
  },
  async undo(p, ctx) {
    for (const c of p.changed) await ctx.db.query(`UPDATE money_ious SET paid=$2, settled_at=NULL WHERE id=$1 AND user_id=$3`, [c.id, c.paid, ctx.user.id]);
    return "Back to owing.";
  },
});

const TONES = ["friendly", "normal", "direct"] as const;
function iouDraft(tone: (typeof TONES)[number], who: string, owed: string, note: string | null, due: string | null): string {
  const what = `${owed}${note ? ` for ${note}` : ""}`;
  if (tone === "friendly") return `Hey ${who}, hope you're well. Just a gentle nudge about the ${what} whenever you get a chance. No stress, thank you.`;
  if (tone === "normal") return `Hi ${who}, quick reminder about the ${what}. Could you send it over ${due ? `by ${due}` : "this week"}? Thanks.`;
  return `Hi ${who}, I still need the ${what} back. Can you pay it ${due ? `by ${due}` : "by the end of the week"}, please?`;
}

const iouRemind = defineAction({
  name: "iou.remind",
  tier: 1,
  description: "Draft a reminder the person sends themselves to someone who owes them money: tone friendly (default), normal or direct. Never sends anything.",
  schema: z.object({ who: z.string().min(1), tone: z.enum(TONES).optional() }),
  async run(args, ctx) {
    const all = await openIous(ctx);
    const hit = byName(all.filter((r) => r.direction === "they_owe"), "who", args.who);
    if (!hit) {
      const mine = byName(all.filter((r) => r.direction === "i_owe"), "who", args.who);
      if (mine) return { reply: `You owe ${mine.who} ${fmt(left(mine), mine.currency)}, so there's nothing to chase. Say "I paid ${mine.who} back" when it's sorted.` };
      const inv = byName(await openInvoices(ctx), "client", args.who);
      if (inv) return { reply: `${inv.client} has an open invoice. Say "chase ${inv.client}" and I'll draft a proper email for it.` };
      return { reply: `I don't have anything ${cap(clean(args.who))} owes you. Say "${cap(clean(args.who))} owes me 40 for dinner" first.` };
    }
    const rows = all.filter((r) => r.who === hit.who && r.direction === "they_owe" && r.currency === hit.currency);
    const owed = fmt(rows.reduce((s, r) => s + left(r), 0), hit.currency);
    const note = rows.length === 1 ? hit.note : null;
    const due = rows.find((r) => r.due)?.due;
    const tone = args.tone ?? "friendly";
    const text = iouDraft(tone, hit.who, owed, note, due ? sayDate(dateIso(due)!, ctx.user, ctx.now) : null);
    const label = tone === "normal" ? "A plain one" : tone === "direct" ? "A direct one" : "A friendly one";
    return {
      reply: `${label} to send ${hit.who} yourself:\n\n\`\`\`\n${text}\n\`\`\`\n\nI never send these for you.`,
      buttons: TONES.filter((t) => t !== tone).map((t) => ({ label: t === "direct" ? "More direct" : t === "normal" ? "Plainer" : "Friendlier", data: `mn:iou:${hit.id}:${t}` })),
    };
  },
});
addMoneyButton("iou", async (ctx, [id, tone]) => {
  const r = await ctx.db.one<{ who: string }>(`SELECT who FROM money_ious WHERE id=$1 AND user_id=$2`, [Number(id), ctx.user.id]);
  if (!r) return { text: "That one's been settled or taken off." };
  return runFromButton(ctx, "iou.remind", { who: r.who, tone });
});

/* ================= invoices ================= */

const invAdd = defineAction({
  name: "invoice.add",
  tier: 1,
  description: "Keep an invoice the person (a freelancer) sent a client: 'client', 'amount', optional 'due' date in their words and the client's 'email'. I watch it and help chase it if it runs late.",
  schema: z.object({ client: z.string().min(1).max(80), amount: z.number().positive(), currency: z.string().max(8).optional(), due: z.string().optional(), email: z.string().email().optional() }),
  async run(args, ctx) {
    const cur = normCur(args.currency, ctx.user);
    const client = cap(clean(args.client));
    const due = args.due ? parseDay(args.due, ctx.user, ctx.now) : null;
    if (args.due && !due) throw new Error(`I couldn't read a date in "${args.due}". When is the invoice due?`);
    const same = (await openInvoices(ctx)).find((i) => i.client.toLowerCase() === client.toLowerCase() && Number(i.amount) === args.amount && i.currency === cur);
    let id: number;
    if (same) { await ctx.db.query(`UPDATE money_invoices SET due_on=COALESCE($2,due_on), email=COALESCE($3,email) WHERE id=$1`, [same.id, due, args.email ?? null]); id = same.id; }
    else id = (await ctx.db.one<{ id: number }>(`INSERT INTO money_invoices (user_id, client, amount, currency, due_on, email) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.user.id, client, args.amount, cur, due, args.email ?? null]))!.id;
    await ensureDaily(ctx.db, ctx.user);
    const when = due ? `, due ${sayDate(due, ctx.user, ctx.now)}` : "";
    const tail = due ? `I'll tell you if it runs late, and "chase ${client}" drafts a polite reminder.` : `Tell me the due date ("invoice ${args.amount} to ${client} due 30 Nov") and I'll watch it.`;
    return { reply: `Invoice to ${client} for ${fmt(args.amount, cur)}${when}. ${tail} Say "${client} paid" when the money lands.`, undo: same ? undefined : { payload: { id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM money_invoices WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Invoice taken off."; },
});

async function payInvoice(ctx: Ctx, inv: Invoice) {
  await ctx.db.query(`UPDATE money_invoices SET paid_at=$2 WHERE id=$1`, [inv.id, ctx.now]);
  const year = String(dt(todayOf(ctx.user, ctx.now)).year);
  const paid = await ctx.db.query<{ amount: string; currency: string }>(`SELECT amount::text, currency FROM money_invoices WHERE user_id=$1 AND paid_at IS NOT NULL AND EXTRACT(YEAR FROM paid_at AT TIME ZONE $2)::text=$3`, [ctx.user.id, ctx.user.tz, year]);
  return { reply: `${inv.client} paid the ${fmt(inv.amount, inv.currency)}. That's ${totals(paid)} paid this year across ${plural(paid.length, "invoice")}.`, undo: { payload: { id: inv.id } } };
}

const invPaid = defineAction({
  name: "invoice.paid",
  tier: 1,
  description: "Mark a client's invoice paid ('Acme paid'). If the name isn't a client, it settles that person's IOU or marks them paid in a savings circle.",
  schema: z.object({ client: z.string().min(1) }),
  async run(args, ctx) {
    const inv = byName(await openInvoices(ctx), "client", args.client);
    if (inv) return payInvoice(ctx, inv);
    const iou = byName((await openIous(ctx)).filter((r) => r.direction === "they_owe"), "who", args.client);
    if (iou) return iouSettle.run({ who: iou.who, direction: "they_owe" }, ctx);
    const c = (await circles(ctx)).find((x) => byName(membersOf(x).map((m) => ({ m })), "m", args.client));
    if (c) return savingsPaid.run({ members: [args.client], circle: c.name }, ctx);
    return { reply: `I don't have an open invoice for ${cap(clean(args.client))}. Say "my invoices" to see them.` };
  },
  async undo(p, ctx) {
    if (p.id) await ctx.db.query(`UPDATE money_invoices SET paid_at=NULL WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    if (p.changed) await iouSettle.undo!(p, ctx);
    if (p.pays) await savingsPaid.undo!(p, ctx);
    return "Back to unpaid.";
  },
});

const invList = defineAction({
  name: "invoice.list",
  tier: 1,
  description: "Show the person's open invoices with due dates and anything overdue, plus what's been paid this year.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await openInvoices(ctx);
    if (!rows.length) return { reply: `No open invoices. Say "invoice 1500 to Acme due 30 Nov" when you send one.` };
    const lines = rows.map((i) => {
      const d = i.due_on ? daysUntil(i.due_on, ctx.user, ctx.now) : null;
      const when = d === null ? "no due date" : d < 0 ? `${plural(-d, "day")} overdue` : `due ${sayDate(i.due_on!, ctx.user, ctx.now)}`;
      return `- ${i.client}: ${fmt(i.amount, i.currency)}, ${when}`;
    });
    const late = rows.filter((i) => i.due_on && daysUntil(i.due_on, ctx.user, ctx.now) < 0);
    const head = `${plural(rows.length, "open invoice")}, ${totals(rows)} in all.`;
    return { reply: [head, ...lines, ...(late.length ? ["", `Say "chase ${late[0].client}" for a polite reminder to send.`] : [])].join("\n") };
  },
});

const TIERS = ["gentle", "firm", "final"] as const;
type Tier3 = (typeof TIERS)[number];
function tierFor(daysLate: number): Tier3 { return daysLate >= 21 ? "final" : daysLate >= 7 ? "firm" : "gentle"; }
function invoiceDraft(ctx: Ctx, inv: Invoice, tier: Tier3): { subject: string; body: string } {
  const sum = fmt(inv.amount, inv.currency);
  const due = inv.due_on ? sayDate(inv.due_on, ctx.user, ctx.now).replace(/^(today|tomorrow|yesterday)$/, (w) => w) : null;
  const late = inv.due_on ? -daysUntil(inv.due_on, ctx.user, ctx.now) : 0;
  const sign = firstName(ctx.user) || "Thanks";
  const hi = `Hi ${inv.client} team,`;
  if (tier === "gentle") {
    const line = late > 0 ? `A friendly reminder that my invoice for ${sum} was due ${due === "yesterday" ? "yesterday" : `on ${due}`}. If it's already on its way, thank you, and please ignore this.` : `A quick heads-up that my invoice for ${sum} is due ${due ? (/^(today|tomorrow)$/.test(due) ? due : `on ${due}`) : "soon"}.`;
    return { subject: `Invoice for ${sum}${due ? `, due ${due}` : ""}`, body: `${hi}\n\nI hope all's well. ${line}\n\nCould you let me know when to expect payment?\n\nBest,\n${sign}` };
  }
  if (tier === "firm") return { subject: `Overdue invoice: ${sum}`, body: `${hi}\n\nMy invoice for ${sum}${due ? `, due on ${due},` : ""} is now ${plural(late, "day")} overdue. Please arrange payment this week, or let me know if something is holding it up.\n\nThanks,\n${sign}` };
  const by = dt(todayOf(ctx.user, ctx.now)).plus({ days: 7 }).toFormat("d LLLL");
  return { subject: `Final reminder: invoice for ${sum}`, body: `${hi}\n\nThis is my final reminder about the invoice for ${sum}${due ? `, due on ${due}` : ""}, now ${late >= 14 ? `${Math.round(late / 7)} weeks` : plural(late, "day")} overdue. Please pay by ${by}, or reply to agree a date.\n\nRegards,\n${sign}` };
}
const verifiedEmail = async (ctx: Pick<Ctx, "db" | "user">): Promise<string | null> => {
  if (typeof ctx.user.prefs.emailVerified === "string") return ctx.user.prefs.emailVerified;
  const r = await ctx.db.one<{ external_id: string }>(`SELECT external_id FROM identities WHERE user_id=$1 AND channel='email' LIMIT 1`, [ctx.user.id]);
  return r?.external_id ?? null;
};
const block = (d: { subject: string; body: string }) => `\`\`\`\nSubject: ${d.subject}\n\n${d.body}\n\`\`\``;

const invChase = defineAction({
  name: "invoice.chase",
  tier: 1,
  description: "Draft a polite payment reminder email for a client's open invoice, escalating with how late it is: gentle, firm or final ('tier' to choose). The person sends it themselves, or says 'send it to <client>' for me to email it.",
  schema: z.object({ client: z.string().min(1), tier: z.enum(TIERS).optional() }),
  async run(args, ctx) {
    const inv = byName(await openInvoices(ctx), "client", args.client);
    if (!inv) {
      const iou = byName((await openIous(ctx)).filter((r) => r.direction === "they_owe"), "who", args.client);
      if (iou) return iouRemind.run({ who: iou.who }, ctx);
      return { reply: `I don't have an open invoice for ${cap(clean(args.client))}. Say "invoice 1500 to ${cap(clean(args.client))} due 30 Nov" first.` };
    }
    const late = inv.due_on ? -daysUntil(inv.due_on, ctx.user, ctx.now) : 0;
    const tier = args.tier ?? tierFor(late);
    const d = invoiceDraft(ctx, inv, tier);
    const head = late > 0 ? `A ${tier} reminder for ${inv.client}, ${plural(late, "day")} late, ready to send yourself:` : `${inv.client}'s invoice isn't late yet. Here's a ${tier} heads-up you can send yourself:`;
    const me = await verifiedEmail(ctx);
    const can = canEmail();
    const tail = can && me ? `\n\nOr say "send it to ${inv.client}" and I'll email it from lifeline, with replies going to ${me}.` : can ? `\n\nOnce your email is confirmed ("my email is ..."), I can send these for you.` : "";
    return { reply: `${head}\n\n${block(d)}${tail}`, buttons: can && me ? [{ label: "Send it for me", data: `mn:inv:send:${inv.id}:${tier}` }] : undefined };
  },
});

const invSend = defineAction({
  name: "invoice.send",
  tier: 2,
  description: "Email a payment reminder for a client's open invoice from lifeline, with the person's own verified address as reply-to. 'to' is the client's email if not already known; 'tier' gentle, firm or final. Always confirmed first.",
  schema: z.object({ client: z.string().min(1), to: z.string().email().optional(), tier: z.enum(TIERS).optional(), subject: z.string().optional(), body: z.string().optional() }),
  // Everything the echo shows is settled here, so the yes is to exactly this email.
  async needs(args, ctx) {
    const inv = byName(await openInvoices(ctx), "client", args.client);
    if (!inv) return { need: "client", question: `I don't have an open invoice for ${cap(clean(args.client))}. Which client is it?` };
    args.client = inv.client;
    const late = inv.due_on ? -daysUntil(inv.due_on, ctx.user, ctx.now) : 0;
    args.tier = args.tier ?? tierFor(late);
    const d = invoiceDraft(ctx, inv, args.tier);
    args.subject = args.subject ?? d.subject;
    args.body = args.body ?? d.body;
    const me = await verifiedEmail(ctx);
    if (!canEmail() || !me) return { need: "verified", question: `${!canEmail() ? "Email isn't switched on here yet" : "I only send these once your own email is confirmed, so the reply comes back to you. Say \"my email is ...\" to do that"}. Here's the draft to send yourself:\n\n${block({ subject: args.subject, body: args.body })}` };
    args.to = args.to ?? inv.email ?? undefined;
    if (!args.to) return { need: "to", question: `What's ${inv.client}'s email address?` };
    return null;
  },
  fill(need, answer) {
    if (need === "to") { const m = /[^\s<>]+@[^\s<>]+\.[a-z]{2,}/i.exec(answer); return m ? { to: m[0] } : null; }
    if (need === "client") return answer.length < 80 ? { client: answer } : null;
    return null;
  },
  echo: (a) => `This emails ${a.to} from lifeline, with replies going to you:\n\nSubject: ${a.subject}\n\n${a.body}`,
  async run(args, ctx) {
    const me = await verifiedEmail(ctx);
    if (!canEmail() || !me) return { reply: "Nothing was sent: email isn't set up for you yet. The draft from \"chase\" is yours to send." };
    const ok = await sendEmail(args.to!, args.subject!, args.body!, { replyTo: me });
    if (!ok) return { reply: "The email didn't go out. Nothing was sent; try again in a minute?" };
    await ctx.db.query(`UPDATE money_invoices SET chased=$3, email=COALESCE(email,$4) WHERE user_id=$1 AND client=$2 AND paid_at IS NULL`, [ctx.user.id, args.client, TIERS.indexOf(args.tier ?? "gentle") + 1, args.to]);
    return { reply: `Sent to ${args.to}. Replies come to ${me}.` };
  },
});
addMoneyButton("inv", async (ctx, [what, id, tier]) => {
  const r = await ctx.db.one<{ client: string }>(`SELECT client FROM money_invoices WHERE id=$1 AND user_id=$2 AND paid_at IS NULL`, [Number(id), ctx.user.id]);
  if (!r) return { text: "That invoice is paid or gone, so there's nothing to chase." };
  return what === "send" ? runFromButton(ctx, "invoice.send", { client: r.client, tier }) : runFromButton(ctx, "invoice.chase", { client: r.client });
});

/* ================= savings circles ================= */

const CIRCLE_WORDS = "savings circle|savings club|savings group|ajo|esusu|tontine|chama|tanda|susu|hui|rosca|stokvel|committee|pardner|paluwagan|arisan|njangi|cundina";

function roundsOf(c: Circle, todayIso: string): { round: number; start: string; next: string } {
  let start = c.start_on.slice(0, 10), round = 1;
  for (;;) {
    const next = addPeriod(start, c.period);
    if (next > todayIso) return { round, start, next };
    start = next; round++;
    if (round > 500) return { round, start, next };
  }
}
async function paidIn(ctx: Pick<Ctx, "db">, c: Circle, round: number): Promise<string[]> {
  return (await ctx.db.query<{ member: string }>(`SELECT member FROM money_circle_pay WHERE circle_id=$1 AND round=$2 ORDER BY id`, [c.id, round])).map((r) => r.member);
}
async function pickCircle(ctx: Ctx, name?: string): Promise<Circle | null> {
  const all = await circles(ctx);
  if (!all.length) return null;
  return (name ? byName(all, "name", name) : undefined) ?? all[0];
}
const NO_CIRCLE = `You don't have a savings circle with me yet. Say "start a savings circle: 6 people, 100 monthly, payout order Ana, Ben, Chi, Dayo, Efe, Femi".`;
const splitNames = (s: string) => s.split(/\s*(?:,|\band\b|&|\bthen\b)\s*/i).map((x) => clean(x)).filter(Boolean).map(cap);

const savingsStart = defineAction({
  name: "savings.start",
  tier: 1,
  description: "Start a savings circle ledger (ajo, esusu, tontine, chama, tanda, susu, hui, ROSCA): 'members' in payout order, 'amount' each person puts in per round, 'period' weekly, fortnightly or monthly, optional 'start' date and 'name'. A ledger only: it never holds or moves money.",
  schema: z.object({ members: z.array(z.string()).max(60), amount: z.number().positive().optional(), currency: z.string().max(8).optional(), period: z.enum(["weekly", "fortnightly", "monthly"]).optional(), size: z.number().int().positive().optional(), name: z.string().max(40).optional(), start: z.string().optional() }),
  needs(args) {
    if (args.members.length < 2) return { need: "members", question: "Who's in it, in payout order? Like \"Ana, Ben, Chi\"." };
    if (!args.amount) return { need: "amount", question: "How much does each person put in per round?" };
    return null;
  },
  fill(need, answer) {
    if (need === "members") { const m = splitNames(answer); return m.length >= 2 ? { members: m } : null; }
    if (need === "amount") { const m = new RegExp(AMT, "iu").exec(answer); return m ? amt(m[1]) : null; }
    return null;
  },
  async run(args, ctx) {
    const cur = normCur(args.currency, ctx.user);
    const period = args.period ?? "monthly";
    const start = (args.start ? parseDay(args.start, ctx.user, ctx.now) : null) ?? todayOf(ctx.user, ctx.now);
    const name = args.name ? clean(args.name) : "savings circle";
    const members = args.members.map((m) => cap(clean(m)));
    const each = args.amount ?? 0;
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO money_circles (user_id, name, members, amount, currency, period, start_on) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [ctx.user.id, name, JSON.stringify(members), each, cur, period, start]);
    await ensureDaily(ctx.db, ctx.user);
    const pot = fmt(each * members.length, cur);
    const second = addPeriod(start, period);
    const size = args.size && args.size !== members.length ? ` You said ${args.size} people and named ${members.length}, so I've gone with the ${members.length} names.` : "";
    return {
      reply: `Your ${name} is set: ${members.length} people, ${fmt(each, cur)} ${period}, so each payout is ${pot}. ${members[0]} collects first, ${sayDate(start, ctx.user, ctx.now)}; ${members[1]} next, ${sayDate(second, ctx.user, ctx.now)}.${size}\n\nSay "Ben paid this round" as people pay, and "whose turn is it" any time. I only keep the ledger; I never hold or move the money.`,
      undo: { payload: { id: r!.id } },
    };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE money_circles SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Savings circle taken off."; },
});

const savingsPaid = defineAction({
  name: "savings.paid",
  tier: 1,
  description: "Mark members of the person's savings circle as paid for the current round (or 'round'). 'members' are names; 'me' means the person themselves.",
  schema: z.object({ members: z.array(z.string().min(1)).min(1), round: z.number().int().positive().optional(), circle: z.string().optional() }),
  async run(args, ctx) {
    const c = await pickCircle(ctx, args.circle);
    if (!c) return { reply: NO_CIRCLE };
    const ms = membersOf(c);
    const today = todayOf(ctx.user, ctx.now);
    const round = args.round ?? roundsOf(c, today).round;
    if (round > ms.length) return { reply: `Every round of the ${c.name} is done: all ${ms.length} people have had their payout.` };
    const me = firstName(ctx.user);
    const found: string[] = [], unknown: string[] = [];
    for (const raw of args.members) {
      const typed = /^(?:me|i|myself)$/i.test(raw.trim()) && me ? me : raw;
      const hit = byName(ms.map((m) => ({ m })), "m", typed)?.m;
      if (hit) found.push(hit); else unknown.push(cap(clean(raw)));
    }
    if (!found.length) return { reply: `${listWords(unknown)} ${unknown.length === 1 ? "isn't" : "aren't"} in the ${c.name}. It's ${listWords(ms)}.` };
    const pays: number[] = [];
    for (const m of found) {
      const r = await ctx.db.one<{ id: number }>(`INSERT INTO money_circle_pay (circle_id, round, member) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`, [c.id, round, m]);
      if (r) pays.push(r.id);
    }
    const paid = await paidIn(ctx, c, round);
    const still = ms.filter((m) => !paid.includes(m));
    const who = ms[round - 1];
    const head = `${listWords(found)} marked paid for round ${round}.`;
    const tail = still.length ? ` ${paid.length} of ${ms.length} in; still to come: ${listWords(still)}.` : ` Everyone's in for round ${round}, so ${who} collects ${fmt(Number(c.amount) * ms.length, c.currency)}.`;
    return { reply: `${head}${tail}${unknown.length ? ` I couldn't find ${listWords(unknown)} in it.` : ""}`, undo: { payload: { pays } } };
  },
  async undo(p, ctx) {
    for (const id of p.pays) await ctx.db.query(`DELETE FROM money_circle_pay WHERE id=$1 AND circle_id IN (SELECT id FROM money_circles WHERE user_id=$2)`, [id, ctx.user.id]);
    return "Taken back.";
  },
});

const savingsTurn = defineAction({
  name: "savings.turn",
  tier: 1,
  description: "Whose turn it is in the person's savings circle: this round's collector, who has paid, who hasn't, and who's next.",
  schema: z.object({ circle: z.string().optional() }),
  async run(args, ctx) {
    const c = await pickCircle(ctx, args.circle);
    if (!c) return { reply: NO_CIRCLE };
    const ms = membersOf(c);
    const { round, start, next } = roundsOf(c, todayOf(ctx.user, ctx.now));
    if (round > ms.length) return { reply: `The ${c.name} has finished: all ${ms.length} people have collected. Start a new one whenever you're ready.` };
    const paid = await paidIn(ctx, c, round);
    const still = ms.filter((m) => !paid.includes(m));
    const pot = fmt(Number(c.amount) * ms.length, c.currency);
    const lines = [`Round ${round} of ${ms.length}: ${ms[round - 1]} collects ${pot}. It started ${sayDate(start, ctx.user, ctx.now)}.`];
    lines.push(paid.length ? `Paid so far: ${listWords(paid)}.` : "Nobody's marked paid yet.");
    if (still.length && paid.length) lines.push(`Still to mark: ${listWords(still)}.`);
    if (round < ms.length) lines.push(`Next up: ${ms[round]}, ${sayDate(next, ctx.user, ctx.now)}.`);
    return { reply: lines.join(" ") };
  },
});

const savingsStatus = defineAction({
  name: "savings.status",
  tier: 1,
  description: "The whole savings circle at a glance: every round, who collects when, and how this round's contributions stand.",
  schema: z.object({ circle: z.string().optional() }),
  async run(args, ctx) {
    const c = await pickCircle(ctx, args.circle);
    if (!c) return { reply: NO_CIRCLE };
    const ms = membersOf(c);
    const today = todayOf(ctx.user, ctx.now);
    const { round } = roundsOf(c, today);
    let d = c.start_on.slice(0, 10);
    const lines: string[] = [];
    for (let i = 0; i < ms.length; i++) {
      const state = i + 1 < round ? "done" : i + 1 === round ? `now, ${(await paidIn(ctx, c, round)).length} of ${ms.length} paid` : "";
      lines.push(`- Round ${i + 1}, ${ms[i]}, ${sayDate(d, ctx.user, ctx.now)}${state ? `: ${state}` : ""}`);
      d = addPeriod(d, c.period);
    }
    const head = `Your ${c.name}: ${fmt(c.amount, c.currency)} each, ${c.period}, payout ${fmt(Number(c.amount) * ms.length, c.currency)}.`;
    return { reply: [head, ...lines].join("\n") };
  },
});

register(iouAdd, iouList, iouSettle, iouRemind, invAdd, invPaid, invList, invChase, invSend, savingsStart, savingsPaid, savingsTurn, savingsStatus);

/* ---------------- words → actions ---------------- */

const DUE = "(?:,?\\s+(?:by|due|before|until)\\s+(.+?))?";
const FOR = "(?:\\s+for\\s+(.+?))?";
const PRON = "(?!(?:me|us|myself|him|her|them|everyone|everybody|all)\\b)";
const iouArgs = (who: string, a: string, direction: "they_owe" | "i_owe", note?: string, due?: string) => ({ who, ...amt(a), direction, ...(note ? { note } : {}), ...(due ? { due } : {}) });

addRules(
  [re(`(?:who owes me(?: money)?|(?:my |show my |list my )?ious|money owed to me|who still owes me)\\??`), () => ({ action: "iou.list", args: {} })],
  [re(`(?:who do i owe(?: money)?|what do i owe|how much do i owe)\\??`), () => ({ action: "iou.list", args: { direction: "i_owe" } })],
  // savings circle payments before generic "X paid"
  [re(`(?:mark\\s+)?(.+?)\\s+(?:as\\s+)?(?:has\\s+|have\\s+)?paid\\s+(?:in\\s+)?(?:for\\s+)?(?:this round|this turn|their share|(?:the |this )?(?:ajo|esusu|tontine|chama|tanda|susu|hui|savings circle)|round (\\d+))`), (m) => ({ action: "savings.paid", args: { members: splitNames(m[1]), ...(m[2] ? { round: Number(m[2]) } : {}) } })],
  [re(`${NAME}\\s+(?:has\\s+|have\\s+)?(?:paid me back|paid back|settled up|squared up|paid me)(?:\\s+${AMT})?`), (m) => ({ action: "iou.settle", args: { who: m[1], direction: "they_owe", ...(m[2] ? amt(m[2]) : {}) } })],
  [re(`i(?:'ve| have)?\\s+(?:paid|repaid)\\s+${NAME}\\s+back(?:\\s+${AMT})?|i(?:'ve| have)?\\s+paid back\\s+${NAME}(?:\\s+${AMT})?|i(?:'ve| have)?\\s+settled up with\\s+${NAME}`), (m) => ({ action: "iou.settle", args: { who: m[1] ?? m[3] ?? m[5], direction: "i_owe", ...(m[2] ?? m[4] ? amt((m[2] ?? m[4])!) : {}) } })],
  [re(`${NAME}\\s+owes\\s+me\\s+${AMT}${FOR}${DUE}`), (m) => ({ action: "iou.add", args: iouArgs(m[1], m[2], "they_owe", m[3], m[4]) })],
  [re(`i\\s+owe\\s+${NAME}\\s+${AMT}${FOR}${DUE}`), (m) => ({ action: "iou.add", args: iouArgs(m[1], m[2], "i_owe", m[3], m[4]) })],
  [re(`(?:i\\s+)?lent\\s+${NAME}\\s+${AMT}${FOR}${DUE}`), (m) => ({ action: "iou.add", args: iouArgs(m[1], m[2], "they_owe", m[3], m[4]) })],
  [re(`(?:i\\s+)?borrowed\\s+${AMT}\\s+from\\s+${NAME}${FOR}${DUE}`), (m) => ({ action: "iou.add", args: iouArgs(m[2], m[1], "i_owe", m[3], m[4]) })],
  [re(`(?:draft|write)\\s+(?:me\\s+)?(?:a\\s+)?(friendly|normal|plain|direct)\\s+(?:reminder|nudge|message)\\s+(?:to|for)\\s+${NAME}`), (m) => ({ action: "iou.remind", args: { who: m[2], tone: m[1].toLowerCase() === "plain" ? "normal" : m[1].toLowerCase() } })],
  [re(`(?:remind|nudge)\\s+${PRON}${NAME}(?:\\s+(?:about|of)\\s+(?:the\\s+|my\\s+|their\\s+|his\\s+|her\\s+)?(?:money|debt|loan|iou|cash|\\d.*))?`), (m) => ({ action: "iou.remind", args: { who: m[1] } })],

  // invoices
  [re(`(?:i\\s+)?(?:invoiced?|sent (?:an |the )?invoice(?: for| of)?|issued (?:an |the )?invoice(?: for| of)?)\\s+(?:for\\s+)?${AMT}\\s+(?:to|for)\\s+(.+?)(?:\\s+\\(?([^\\s()]+@[^\\s()]+)\\)?)?(?:,?\\s+due\\s+(?:on\\s+|by\\s+)?(.+))?`), (m) => ({ action: "invoice.add", args: { client: m[2], ...amt(m[1]), ...(m[3] ? { email: m[3] } : {}), ...(m[4] ? { due: m[4] } : {}) } })],
  [re(`(?:my |open |unpaid |show my |list my )?invoices|who hasn'?t paid (?:me|my invoices?)\\??|(?:any )?overdue invoices\\??`), () => ({ action: "invoice.list", args: {} })],
  [re(`chase\\s+(?:up\\s+)?(?:the\\s+)?(.+?)(?:'s)?(?:\\s+invoice)?(?:\\s+(gently|firmly|one last time))?`), (m) => ({ action: "invoice.chase", args: { client: m[1], ...(m[2] ? { tier: /gent/i.test(m[2]) ? "gentle" : /firm/i.test(m[2]) ? "firm" : "final" } : {}) } })],
  [re(`(?:draft|write)\\s+(?:a\\s+)?(gentle|polite|firm|final)\\s+(?:invoice\\s+)?(?:reminder|chaser|email)\\s+(?:to|for)\\s+(.+)`), (m) => ({ action: "invoice.chase", args: { client: m[2], tier: /firm/i.test(m[1]) ? "firm" : /final/i.test(m[1]) ? "final" : "gentle" } })],
  [re(`send\\s+(?:it|that|the (?:reminder|chaser|email))\\s+to\\s+(.+?)(?:\\s+at\\s+([^\\s]+@[^\\s]+))?`), (m) => ({ action: "invoice.send", args: { client: m[1], ...(m[2] ? { to: m[2] } : {}) } })],
  [re(`(?!(?:i|we|just|already|you|they|what|which|who|how|when|where|did|have|has|rent|mortgage|my|the rent|bills?|service charge)\\b)${NAME}\\s+(?:has\\s+|have\\s+|finally\\s+)?paid(?:\\s+(?:the|their|my|our|his|her)\\s+invoices?|\\s+up)?`), (m) => ({ action: "invoice.paid", args: { client: m[1] } })],

  // savings circles
  [re(`(?:start|set up|create|new)\\s+(?:a\\s+|an\\s+|our\\s+|my\\s+)?(${CIRCLE_WORDS})(?:\\s+called\\s+([^:,]+?))?\\s*[:,-]?\\s+(.+)`), (m) => ({ action: "savings.start", args: circleArgs(m[1], m[2], m[3]) })],
  [re(`(?:whose|who'?s)\\s+turn\\s+(?:is\\s+it|it\\s+is)(?:\\s+(?:in|for)\\s+(?:the\\s+|our\\s+|my\\s+)?(.+?))?\\??|who(?:'s| is)\\s+(?:collecting|getting the (?:pot|payout))(?:\\s+in\\s+(?:the\\s+|our\\s+|my\\s+)?(.+?))?\\??`), (m) => ({ action: "savings.turn", args: m[1] ?? m[2] ? { circle: m[1] ?? m[2] } : {} })],
  [re(`(?:my |our |the )?(${CIRCLE_WORDS})(?:\\s+(?:status|ledger|so far))?|how(?:'s| is) (?:the |our |my )?(${CIRCLE_WORDS})(?: going)?\\??`), () => ({ action: "savings.status", args: {} })],
);

/** "6 people, 100 monthly, payout order Ana, Ben, Chi": the parts of a savings circle from one sentence. */
function circleArgs(word: string, name: string | undefined, rest: string) {
  const size = /(\d{1,2})\s+(?:people|members|persons|of us|friends)/i.exec(rest)?.[1];
  const money = new RegExp(`${AMT}\\s*(?:a\\s+|per\\s+|each\\s+|every\\s+)?${PERIOD}`, "iu").exec(rest) ?? new RegExp(`${AMT}\\s+(?:each|per person)`, "iu").exec(rest);
  const order = /(?:payout order|in (?:this )?order|order|members|with|people are)[:\s]+(.+)$/i.exec(rest)?.[1];
  const a = money ? amt(money[1]) : { amount: 0 };
  const p = money?.[2] ? periodOf(money[2]) : undefined;
  return {
    members: order ? splitNames(order) : [],
    ...(a.amount ? { amount: a.amount } : {}),
    ...(a.currency ? { currency: a.currency } : {}),
    ...(p && p !== "yearly" ? { period: p } : {}),
    ...(size ? { size: Number(size) } : {}),
    name: name ?? (/^savings/i.test(word) ? undefined : word.toLowerCase()),
  };
}

addExamples("iou.add", ["Ana owes me 40 for dinner", "I owe Tunde 15000", "Kwame owes me ₵200 for the tickets by Friday", "lent Priya 50 euros", "borrowed 2000 from Sipho"]);
addExamples("iou.list", ["who owes me", "who do I owe", "my IOUs"]);
addExamples("iou.settle", ["Ana paid me back", "Ana paid me back 20", "I paid Tunde back"]);
addExamples("iou.remind", ["remind Ana", "nudge Kwame about the money", "draft a direct reminder to Ana"]);
addExamples("invoice.add", ["invoice 1500 to Acme due 30 Nov", "invoiced $800 to Studio Lima due next Friday", "sent an invoice for 2000 to Ndlovu Co (ap@ndlovu.co.za) due 15 December"]);
addExamples("invoice.list", ["my invoices", "who hasn't paid me?"]);
addExamples("invoice.chase", ["chase Acme", "chase the Acme invoice", "draft a firm reminder for Acme"]);
addExamples("invoice.send", ["send it to Acme", "send the reminder to Acme at ap@acme.com"]);
addExamples("invoice.paid", ["Acme paid", "Studio Lima paid the invoice"]);
addExamples("savings.start", ["start a savings circle: 6 people, 100 monthly, payout order Ana, Ben, Chi, Dayo, Efe, Femi", "start an ajo: 20000 monthly, order Bola, Chidi, Funke", "start a chama called Wamama: 1000 weekly with Achieng, Wanjiru, Njeri"]);
addExamples("savings.paid", ["Ben paid this round", "Chi and Dayo paid this round", "mark Efe paid for round 2"]);
addExamples("savings.turn", ["whose turn is it", "who's collecting?"]);
addExamples("savings.status", ["savings circle status", "how's the ajo going?", "my tontine"]);

addCues("iou", ["owes me", "owe", "lent", "borrowed", "pay me back", "paid me back", "who owes", "iou", "nudge"]);
addCues("invoice", ["invoice", "invoiced", "client", "chase", "overdue", "freelance", "paid the invoice", "payment reminder"]);
addCues("savings", ["savings circle", "ajo", "esusu", "tontine", "chama", "tanda", "susu", "hui", "rosca", "stokvel", "contribution", "payout", "whose turn", "this round"]);

addCapability({
  key: "ious", name: "Money people owe you",
  cues: ["owes me", "owe", "lent", "borrowed", "pay me back", "iou", "who owes"],
  what: "I keep track of who owes you and who you owe, in any currency, and draft a friendly, plain or direct reminder you send yourself.",
  say: ["Ana owes me 40 for dinner", "I owe Tunde 15000", "who owes me", "remind Ana", "Ana paid me back"],
  then: "Add a date (\"by Friday\") and your morning brief mentions it gently once it's due. I never message anyone for you.",
}, "Money");
addCapability({
  key: "invoices", name: "Invoices and getting paid",
  cues: ["invoice", "client", "freelance", "chase", "overdue", "get paid", "unpaid"],
  what: "For freelancers: I keep your invoices, tell you when one runs late, and draft a polite reminder that gets firmer with time (gentle, firm, final).",
  say: ["invoice 1500 to Acme due 30 Nov", "my invoices", "chase Acme", "Acme paid"],
  then: "You send the reminder yourself, or say \"send it to Acme\" and I email it from lifeline after your yes, with replies going to your own inbox once your email is confirmed.",
}, "Money");
addCapability({
  key: "savings_circles", name: "Savings circles",
  cues: ["savings circle", "ajo", "esusu", "tontine", "chama", "tanda", "susu", "hui", "rosca", "stokvel", "whose turn"],
  what: "A ledger for your ajo, esusu, tontine, chama, tanda, susu or hui: who's in, the payout order, who has paid this round and whose turn it is.",
  say: ["start a savings circle: 6 people, 100 monthly, payout order Ana, Ben, Chi, Dayo, Efe, Femi", "Ben paid this round", "whose turn is it", "savings circle status"],
  then: "If someone hasn't been marked paid a couple of days into a round, I tell you privately, once.",
  limits: "It's a ledger only. I never hold, collect or move the money.",
}, "Money");

/* ---------------- brief and pings ---------------- */

addBrief("money", async (db, user, today, now) => {
  const out: { p: number; text: string }[] = [];
  const ious = await db.query<Iou>(`SELECT id, who, direction, amount::text, paid::text, currency, note, due::text FROM money_ious WHERE user_id=$1 AND settled_at IS NULL AND due IS NOT NULL AND due <= $2::date AND due >= $2::date - 7 ORDER BY due`, [user.id, today]);
  const they = ious.filter((r) => r.direction === "they_owe"), me = ious.filter((r) => r.direction === "i_owe");
  if (they.length === 1) out.push({ p: 30, text: `${they[0].who}'s ${fmt(left(they[0]), they[0].currency)}${they[0].note ? ` for ${they[0].note}` : ""} was due back ${sayDate(dateIso(they[0].due)!, user, now)}. "remind ${they[0].who}" drafts a friendly nudge.` });
  else if (they.length > 1) out.push({ p: 30, text: `${listWords([...new Set(they.map((r) => r.who))])} have money due back to you. "who owes me" shows it all.` });
  if (me.length) out.push({ p: 31, text: `You'd planned to pay ${listWords([...new Set(me.map((r) => r.who))])} back by ${sayDate(dateIso(me[0].due)!, user, now)}.` });
  const invs = await openInvoices({ db, user });
  const late = invs.filter((i) => i.due_on && i.due_on <= today);
  if (late.length) {
    const i = late[0], d = -daysUntil(i.due_on!, user, now);
    out.push({ p: 32, text: `${i.client}'s ${fmt(i.amount, i.currency)} invoice ${d === 0 ? "is due today" : `is ${plural(d, "day")} overdue`}${late.length > 1 ? `, and ${plural(late.length - 1, "more")}` : ""}. "chase ${i.client}" drafts a reminder.` });
  }
  for (const c of await circles({ db, user })) {
    const ms = membersOf(c);
    const { round, start } = roundsOf(c, today);
    if (round > ms.length || daysUntil(start, user, now) < -7) continue;
    const paid = await paidIn({ db }, c, round);
    if (paid.length < ms.length) { out.push({ p: 40, text: `${cap(c.name)} round ${round} (${ms[round - 1]} collects): ${paid.length} of ${ms.length} marked paid.` }); break; }
  }
  return out;
});

addPinger("invoices", async (db, user, today, now) => {
  const out = [];
  for (const i of await openInvoices({ db, user })) {
    if (!i.due_on || i.due_on >= today) continue;
    const d = -daysUntil(i.due_on, user, now);
    const step = d >= 21 ? 21 : d >= 7 ? 7 : 1;
    const when = step === 21 ? `is ${Math.round(d / 7)} weeks overdue` : step === 7 ? `is ${d >= 14 ? `${Math.round(d / 7)} weeks` : plural(d, "day")} overdue` : d === 1 ? "was due yesterday" : `is ${plural(d, "day")} overdue`;
    out.push({ key: `inv:${i.id}:${step}`, text: `${i.client}'s invoice for ${fmt(i.amount, i.currency)} ${when}.`, button: { label: `Draft a reminder for ${i.client}`.slice(0, 40), data: `mn:inv:chase:${i.id}` } });
  }
  return out.slice(0, 2);
});

addPinger("circle", async (db, user, today, now) => {
  const out = [];
  for (const c of await circles({ db, user })) {
    const ms = membersOf(c);
    const { round, start } = roundsOf(c, today);
    if (round > ms.length || daysUntil(start, user, now) > -2) continue;
    const paid = await paidIn({ db }, c, round);
    const still = ms.filter((m) => !paid.includes(m));
    if (!still.length) continue;
    out.push({ key: `circ:${c.id}:${round}`, text: `${cap(c.name)} round ${round}: ${still.length > 4 ? `${still.slice(0, 4).join(", ")} and ${still.length - 4} more` : listWords(still)} ${still.length === 1 ? "hasn't" : "haven't"} been marked paid yet. Say "${still[0]} paid this round" when they do.` });
  }
  return out;
});
