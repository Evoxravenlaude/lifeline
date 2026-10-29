/**
 * Client work for artists: commissions (deposit, balance, revisions, deadline reminders 3 days and
 * 1 day before, a polite balance nudge the person sends themselves), open calls and submissions
 * (grants, residencies, competitions, festivals, labels and publishers; reminders 7 days and 1 day
 * before they close; a web search for new ones with real links only), and clean copyable quotes.
 */
import { z } from "zod";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import { userCurrency } from "../../../core/money.js";
import { search, allow, mediaAbilities } from "../../../core/media.js";
import type { Db } from "../../../core/db.js";
import { AMT, amt, fmt, normCur } from "../money/common.js";
import {
  addBriefItems, addPinger, byName, cap, clean, countOf, daysTo, ensureDaily, parseDay, plural, refuseSecret, runOther, sayDay, sayIn, shortDay, todayOf,
} from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS crt_commissions (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), client TEXT, title TEXT NOT NULL, price NUMERIC, currency TEXT NOT NULL, paid NUMERIC NOT NULL DEFAULT 0, due DATE, revisions INT NOT NULL DEFAULT 0, revisions_included INT, status TEXT NOT NULL DEFAULT 'active', delivered_on DATE, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS crt_calls (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT NOT NULL, closes DATE, link TEXT, status TEXT NOT NULL DEFAULT 'open', submitted_on DATE, result_on DATE, created_at TIMESTAMPTZ DEFAULT now())`);

const calm = (u: User) => u.prefs?.calm === true;

/* =====================================================================
 * 5. Commissions
 * ===================================================================== */

interface Comm { id: number; client: string | null; title: string; price: string | null; currency: string; paid: string; due: string | null; revisions: number; revisions_included: number | null; status: string; delivered_on: string | null }
const commsOf = (db: Db, userId: number, all = false) =>
  db.query<Comm>(`SELECT id, client, title, price, currency, paid, to_char(due, 'YYYY-MM-DD') AS due, revisions, revisions_included, status, to_char(delivered_on, 'YYYY-MM-DD') AS delivered_on FROM crt_commissions WHERE user_id=$1 ${all ? "" : "AND status IN ('active','delivered')"} ORDER BY due NULLS LAST, id`, [userId]);
const whose = (c: Pick<Comm, "client" | "title">) => (c.client ? `${c.client}'s ${c.title}` : cap(c.title));
const balance = (c: Comm) => (c.price === null ? null : Math.max(0, Number(c.price) - Number(c.paid)));

/** "portrait for Tolu, 150, due 20 Nov, 50 deposit paid" → title, client, price, deposit, due. */
export function parseCommission(body: string, from?: string): { title: string; client?: string; price?: number; currency?: string; deposit?: number; due?: string; revisions_included?: number } {
  const parts = body.split(/\s*[,;]\s*/).map((p) => p.trim()).filter(Boolean);
  const head = parts.shift() ?? body;
  let title = head, client = from?.trim();
  const f = /^(.+?)\s+for\s+(.+)$/i.exec(head);
  const pos = /^(.+?)'s\s+(.+)$/.exec(head);
  if (f && !client) { title = f[1]; client = f[2]; } else if (pos && !client) { client = pos[1]; title = pos[2]; }
  const out: ReturnType<typeof parseCommission> = { title: clean(title) || head, ...(client ? { client: clean(client) } : {}) };
  for (const p of parts) {
    let x: RegExpExecArray | null;
    if ((x = /^(?:due|by|deadline|delivery|deliver by|for)\s+(?=.*(?:\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|day|tomorrow|next|week))(.+)$/i.exec(p))) { out.due = x[1]; continue; }
    if (/^no deposit(?: yet)?$/i.test(p)) { out.deposit = 0; continue; }
    if ((x = new RegExp(`^${AMT}\\s+(?:deposit|upfront|up front|down)(?:\\s+(?:paid|received|in))?$`, "i").exec(p)) || (x = new RegExp(`^(?:deposit|upfront)(?:\\s+(?:of|paid|received))?:?\\s+${AMT}(?:\\s+paid)?$`, "i").exec(p)) || (x = new RegExp(`^${AMT}\\s+(?:paid|received)$`, "i").exec(p))) {
      const v = amt(x[1]); out.deposit = v.amount; if (v.currency) out.currency ??= v.currency; continue;
    }
    if ((x = /^(\d+|one|two|three|four|five)\s+(?:rounds? of\s+)?revisions?(?:\s+included)?$/i.exec(p))) { out.revisions_included = countOf(x[1]); continue; }
    if (out.price === undefined && (x = new RegExp(`^(?:price|fee|total|at)?:?\\s*${AMT}(?:\\s+(?:total|fee|in total|all in))?$`, "i").exec(p))) { const v = amt(x[1]); out.price = v.amount; if (v.currency) out.currency = v.currency; continue; }
  }
  return out;
}

const commAdd = defineAction({
  name: "commission.add",
  tier: 1,
  description: "Keep a commission or piece of client work: what it is, who for, the price (in the person's currency unless they say), deposit paid so far, due date, and revisions included. Reminds them 3 days and 1 day before it's due.",
  schema: z.object({ title: z.string().min(1).max(120), client: z.string().max(60).optional(), price: z.number().min(0).optional(), currency: z.string().max(10).optional(), deposit: z.number().min(0).optional(), due: z.string().max(60).optional(), revisions_included: z.number().int().min(0).max(50).optional() }),
  async run(a, ctx) {
    const bad = refuseSecret(a.title, a.client);
    if (bad) throw new Error(bad);
    const cur = normCur(a.currency, ctx.user);
    const due = a.due ? parseDay(a.due, ctx.user, ctx.now) : null;
    if (a.due && !due) throw new Error(`I couldn't read a date in "${a.due}". When is it due?`);
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO crt_commissions (user_id, client, title, price, currency, paid, due, revisions_included) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [ctx.user.id, a.client ? cap(a.client) : null, a.title, a.price ?? null, cur, a.deposit ?? 0, due, a.revisions_included ?? null]);
    if (due) await ensureDaily(ctx.db, ctx.user);
    const c = { client: a.client ? cap(a.client) : null, title: a.title };
    const money: string[] = [];
    if (a.price !== undefined) money.push(fmt(a.price, cur));
    if (a.deposit) money.push(`${fmt(a.deposit, cur)} deposit paid`);
    if (a.price !== undefined && a.deposit) money.push(`${fmt(Math.max(0, a.price - a.deposit), cur)} to go`);
    const when = due ? `, due ${sayDay(due, ctx.user, ctx.now)}` : "";
    const remind = due ? " I'll remind you 3 days and 1 day before." : " Add a due date any time and I'll remind you before it.";
    return { reply: `${whose(c)}: ${money.length ? money.join(", ") : "no price yet"}${when}.${remind} Say "revision 2 sent for ${whose(c)}" or "delivered ${whose(c)}" as it goes.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM crt_commissions WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Commission taken out."; },
});

async function findComm(db: Db, user: User, match: string): Promise<Comm> {
  const rows = await commsOf(db, user.id);
  const hits = byName(rows, ["client", "title"], match);
  if (!hits.length) throw new Error(rows.length ? `I can't find a commission like "${clean(match)}". Say "my commissions" to see them.` : `You don't have any commissions with me yet. Say "commission: portrait for Tolu, 150, due 20 Nov" to start one.`);
  if (hits.length > 1 && new Set(hits.map(whose)).size > 1) throw new Error(`Which one: ${hits.slice(0, 4).map(whose).join(", ")}?`);
  return hits[0];
}

const commUpdate = defineAction({
  name: "commission.update",
  tier: 1,
  description: "Update a commission: a revision sent (`n` is its number), delivered, a deposit or part payment received (`amount`), the rest paid in full, or cancelled. `match` is the client and/or piece, like \"Tolu's portrait\".",
  schema: z.object({ match: z.string().min(1).max(120), event: z.enum(["revision", "delivered", "deposit", "payment", "paid_rest", "cancel"]), n: z.number().int().min(1).max(100).optional(), amount: z.number().min(0).optional(), currency: z.string().max(10).optional() }),
  async run(a, ctx) {
    const c = await findComm(ctx.db, ctx.user, a.match);
    const prev = { revisions: c.revisions, status: c.status, paid: c.paid, delivered_on: c.delivered_on };
    const undo = { payload: { id: c.id, prev } };
    const name = whose(c);
    if (a.event === "revision") {
      const n = a.n ?? c.revisions + 1;
      await ctx.db.query(`UPDATE crt_commissions SET revisions=$2 WHERE id=$1`, [c.id, n]);
      const over = c.revisions_included !== null && n > c.revisions_included ? ` That's past the ${plural(c.revisions_included, "revision")} included, so it's fair to quote extra from here.` : "";
      return { reply: `Revision ${n} sent for ${name}.${over}`, undo };
    }
    if (a.event === "cancel") {
      await ctx.db.query(`UPDATE crt_commissions SET status='cancelled' WHERE id=$1`, [c.id]);
      return { reply: `${name}, cancelled. No more reminders for it.`, undo };
    }
    if (a.event === "delivered") {
      const bal = balance(c);
      const status = bal === 0 ? "done" : "delivered";
      await ctx.db.query(`UPDATE crt_commissions SET status=$2, delivered_on=$3 WHERE id=$1`, [c.id, status, todayOf(ctx.user, ctx.now)]);
      if (bal === 0) return { reply: `${name}, delivered and paid in full.${calm(ctx.user) ? "" : " Nice work."}`, undo };
      if (bal === null) return { reply: `${name}, delivered.`, undo };
      const first = c.client ? c.client.split(" ")[0] : "them";
      return { reply: `${name}, delivered. ${fmt(bal, c.currency)} still to come; say "draft a balance reminder for ${first}" when you want a note to send.`, undo };
    }
    let paid = Number(c.paid);
    if (a.event === "paid_rest") paid = c.price !== null ? Number(c.price) : paid;
    else {
      if (a.amount === undefined) throw new Error("How much did they pay?");
      paid += a.amount;
    }
    const done = c.price !== null && paid >= Number(c.price) && (c.status === "delivered" || a.event === "paid_rest");
    await ctx.db.query(`UPDATE crt_commissions SET paid=$2, status=$3 WHERE id=$1`, [c.id, paid, done && c.status === "delivered" ? "done" : c.status]);
    const left = c.price !== null ? Math.max(0, Number(c.price) - paid) : null;
    const who = c.client ?? "They";
    if (a.event === "paid_rest") return { reply: `${who} paid the rest. ${name} is paid in full${c.price !== null ? `: ${fmt(Number(c.price), c.currency)}` : ""}.${c.status === "active" ? " I'll keep the deadline reminder until you say it's delivered." : ""}`, undo };
    return { reply: `${fmt(a.amount!, c.currency)} in for ${name}.${left !== null ? left > 0 ? ` ${fmt(left, c.currency)} to go.` : " That's everything." : ""}`, undo };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE crt_commissions SET revisions=$2, status=$3, paid=$4, delivered_on=$5 WHERE id=$1 AND user_id=$6`, [p.id, p.prev.revisions, p.prev.status, p.prev.paid, p.prev.delivered_on, ctx.user.id]);
    return "Back how it was.";
  },
});

const commList = defineAction({
  name: "commission.list",
  tier: 1,
  description: "Show the person's open commissions and client work: who, what, what's paid and still owed, the deadline, revisions so far and whether it's delivered.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await commsOf(ctx.db, ctx.user.id);
    if (!rows.length) return { reply: "No open commissions. Say \"commission: portrait for Tolu, 150, due 20 Nov, 50 deposit paid\" to keep one." };
    const owed = new Map<string, number>();
    const lines = rows.map((c) => {
      const bal = balance(c);
      if (bal) owed.set(c.currency, (owed.get(c.currency) ?? 0) + bal);
      const bits: string[] = [];
      if (c.price !== null) bits.push(bal ? `${fmt(bal, c.currency)} of ${fmt(Number(c.price), c.currency)} to come` : `paid in full`);
      if (c.status === "delivered") bits.push("delivered");
      else if (c.due) bits.push(`due ${shortDay(c.due)}${daysTo(c.due, ctx.user, ctx.now) < 0 ? ", past the date" : ""}`);
      if (c.revisions) bits.push(`revision ${c.revisions}`);
      return `- ${whose(c)}: ${bits.join(", ") || "no details yet"}`;
    });
    const total = [...owed].map(([cur, n]) => fmt(n, cur)).join(" and ");
    return { reply: [`${plural(rows.length, "open commission")}${total ? `, ${total} still to come` : ""}:`, ...lines].join("\n") };
  },
});

const commNudge = defineAction({
  name: "commission.nudge",
  tier: 1,
  description: "Draft a polite note asking a client for the balance on a commission, for the person to send themselves (lifeline never sends it). `match` is the client or piece.",
  schema: z.object({ match: z.string().min(1).max(120) }),
  async run(a, ctx) {
    const c = await findComm(ctx.db, ctx.user, a.match);
    const bal = balance(c);
    if (bal === 0) return { reply: `${whose(c)} is already paid in full. Nothing to chase.` };
    const hi = c.client ? `Hi ${c.client.split(" ")[0]},` : "Hi,";
    const amount = bal !== null ? `the balance of ${fmt(bal, c.currency)}` : "the balance";
    const body = c.status === "delivered"
      ? `${hi} I hope you're enjoying the ${c.title}. A gentle reminder that ${amount} is still open. Could you send it when you get a chance? Thank you so much for the commission.`
      : `${hi} a quick note on the ${c.title}: ${amount} is due on delivery${c.due ? `, which is planned for ${sayDay(c.due, ctx.user, ctx.now)}` : ""}. Thank you, I'm enjoying working on it.`;
    return { reply: `A gentle one to send ${c.client ?? "your client"} yourself:\n\n\`\`\`\n${body}\n\`\`\`\nAdd how they can pay. I never send these for you.` };
  },
});

addPinger("commissions", async (db, user, today, now) => {
  const out = [];
  for (const c of await commsOf(db, user.id)) {
    if (c.status !== "active" || !c.due) continue;
    const d = daysTo(c.due, user, now);
    if (d === 3 || d === 1) out.push({ key: `cm:${c.id}:${d}:${c.due}`, text: `${whose(c)} is due ${sayDay(c.due, user, now)}${d > 1 ? ` (${sayIn(d)})` : ""}.` });
  }
  return out;
});
addBriefItems(async (db, user, now) => {
  const out = [];
  for (const c of await commsOf(db, user.id)) {
    if (c.status !== "active" || !c.due) continue;
    const d = daysTo(c.due, user, now);
    if (d >= 0 && d <= 3) out.push({ p: 10 + d, text: `${whose(c)} is due ${sayDay(c.due, user, now)}` });
  }
  return out;
});

/* =====================================================================
 * 6. Open calls and submissions
 * ===================================================================== */

interface Call { id: number; name: string; closes: string | null; link: string | null; status: string; submitted_on: string | null }
const callsOf = (db: Db, userId: number) => db.query<Call>(`SELECT id, name, to_char(closes, 'YYYY-MM-DD') AS closes, link, status, to_char(submitted_on, 'YYYY-MM-DD') AS submitted_on FROM crt_calls WHERE user_id=$1 ORDER BY closes NULLS LAST, id`, [userId]);

const callAdd = defineAction({
  name: "opencall.add",
  tier: 1,
  description: "Keep an open call the person wants to enter: a grant, residency, competition, festival, prize, or a label or publisher's submission window, with its closing date and link. Reminds them 7 days and 1 day before it closes.",
  schema: z.object({ name: z.string().min(1).max(140), closes: z.string().max(60).optional(), link: z.string().max(300).optional() }),
  async run(a, ctx) {
    const bad = refuseSecret(a.name);
    if (bad) throw new Error(bad);
    const name = cap(clean(a.name));
    const closes = a.closes ? parseDay(a.closes, ctx.user, ctx.now) : null;
    if (a.closes && !closes) throw new Error(`I couldn't read a date in "${a.closes}". When does it close?`);
    const rows = await callsOf(ctx.db, ctx.user.id);
    const same = rows.find((r) => r.name.toLowerCase() === name.toLowerCase() && r.status === "open");
    let id: number;
    if (same) { await ctx.db.query(`UPDATE crt_calls SET closes=COALESCE($2, closes), link=COALESCE($3, link) WHERE id=$1`, [same.id, closes, a.link ?? null]); id = same.id; }
    else id = (await ctx.db.one<{ id: number }>(`INSERT INTO crt_calls (user_id, name, closes, link) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.user.id, name, closes, a.link ?? null]))!.id;
    if (closes) await ensureDaily(ctx.db, ctx.user);
    const when = closes ? `, closes ${sayDay(closes, ctx.user, ctx.now)} (${sayIn(daysTo(closes, ctx.user, ctx.now))}). I'll remind you 7 days and 1 day before.` : ". Tell me when it closes and I'll remind you before.";
    return { reply: `${name}${when} Say "submitted to ${name}" when it's in.`, undo: { payload: { id, created: !same } } };
  },
  async undo(p, ctx) { if (p.created) await ctx.db.query(`DELETE FROM crt_calls WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Taken out."; },
});

const callUpdate = defineAction({
  name: "opencall.update",
  tier: 1,
  description: "Record what happened with an open call or submission: submitted, shortlisted, accepted, rejected or withdrawn. Creates the entry if it isn't kept yet. A hackathon entry by the same name is updated instead.",
  schema: z.object({ match: z.string().min(1).max(140), status: z.enum(["submitted", "shortlisted", "accepted", "rejected", "withdrawn"]) }),
  async run(a, ctx) {
    const rows = await callsOf(ctx.db, ctx.user.id);
    let hit = byName(rows, ["name"], a.match)[0];
    if (!hit && a.status === "submitted") {
      const hack = await ctx.db.one<{ id: number; title: string }>(`SELECT id, title FROM hackathon_entries WHERE user_id=$1 AND title ILIKE $2 LIMIT 1`, [ctx.user.id, `%${clean(a.match)}%`]).catch(() => undefined);
      if (hack) return { reply: (await runOther(ctx, "hackathon.update", { id: hack.id, status: "submitted" })).text };
    }
    const today = todayOf(ctx.user, ctx.now);
    let created = false;
    if (!hit) {
      const id = (await ctx.db.one<{ id: number }>(`INSERT INTO crt_calls (user_id, name, status) VALUES ($1,$2,'open') RETURNING id`, [ctx.user.id, cap(clean(a.match))]))!.id;
      hit = { id, name: cap(clean(a.match)), closes: null, link: null, status: "open", submitted_on: null };
      created = true;
    }
    const prev = { status: hit.status, submitted_on: hit.submitted_on };
    await ctx.db.query(`UPDATE crt_calls SET status=$2, submitted_on=CASE WHEN $2='submitted' THEN $3::date ELSE submitted_on END, result_on=CASE WHEN $2 IN ('accepted','rejected','shortlisted') THEN $3::date ELSE result_on END WHERE id=$1`, [hit.id, a.status, today]);
    const n = hit.name;
    const reply = {
      submitted: `Submitted to ${n}. That's the hard part done. Tell me when you hear back, like "accepted into ${n}" or "rejected by ${n}".`,
      shortlisted: `Shortlisted for ${n}. That means the work landed with them.`,
      accepted: `Accepted into ${n}. Congratulations${calm(ctx.user) ? "." : ", that's a real one."}`,
      rejected: `Logged. Every working artist has a long list of these; it means you're putting work out. Say "find open calls" whenever you want the next one.`,
      withdrawn: `${n}, withdrawn. No more reminders for it.`,
    }[a.status];
    return { reply, undo: { payload: { id: hit.id, prev, created } } };
  },
  async undo(p, ctx) {
    if (p.created) await ctx.db.query(`DELETE FROM crt_calls WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    else await ctx.db.query(`UPDATE crt_calls SET status=$2, submitted_on=$3 WHERE id=$1 AND user_id=$4`, [p.id, p.prev.status, p.prev.submitted_on, ctx.user.id]);
    return "Back how it was.";
  },
});

const callList = defineAction({
  name: "opencall.list",
  tier: 1,
  description: "Show the open calls the person is keeping (closing dates first) and their submissions waiting for an answer, with this year's results.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await callsOf(ctx.db, ctx.user.id);
    if (!rows.length) return { reply: "No open calls kept yet. Say \"open call: Lagos Photo Festival closes 15 Dec\", or \"find open calls for illustrators\" to look for some." };
    const open = rows.filter((r) => r.status === "open" && (!r.closes || daysTo(r.closes, ctx.user, ctx.now) >= 0));
    const waiting = rows.filter((r) => r.status === "submitted" || r.status === "shortlisted");
    const year = todayOf(ctx.user, ctx.now).slice(0, 4);
    const acc = rows.filter((r) => r.status === "accepted" && (r.submitted_on ?? year).startsWith(year)).length;
    const lines: string[] = [];
    if (open.length) lines.push("**Open**", ...open.slice(0, 8).map((r) => `- ${r.name}${r.closes ? `: closes ${shortDay(r.closes)}` : ""}${r.link ? ` ${r.link}` : ""}`));
    if (waiting.length) lines.push("**Waiting to hear**", ...waiting.slice(0, 8).map((r) => `- ${r.name}${r.status === "shortlisted" ? ", shortlisted" : r.submitted_on ? `, sent ${shortDay(r.submitted_on)}` : ""}`));
    if (!lines.length) lines.push("Nothing open or waiting right now.");
    const sent = rows.filter((r) => r.submitted_on && r.submitted_on.startsWith(year)).length;
    if (sent) lines.push("", `${plural(sent, "submission")} this year${acc ? `, ${acc} accepted` : ""}. Every one counts.`);
    return { reply: lines.join("\n") };
  },
});

const PLACES = "Places worth checking yourself: CaFE (callforentry.org), ArtConnect (artconnect.com), TransArtists (transartists.org) and Res Artis (resartis.org) for residencies.";
const callFind = defineAction({
  name: "opencall.find",
  tier: 1,
  description: "Search the web for current open calls (grants, residencies, competitions, festivals, label or publisher submissions) for a kind of artist or a place, with real links from the search only.",
  schema: z.object({ query: z.string().max(140).optional() }),
  async run(a, ctx) {
    if (!mediaAbilities().search) return { reply: `Web search isn't set up on this server, so I can't look right now. ${PLACES}` };
    if (!allow("search", ctx.user.id)) return { reply: `That's a lot of searching for today. Try again tomorrow. ${PLACES}` };
    const q = (a.query ?? "").trim();
    const f = await search(`Current open calls for artists${q ? ` ${q}` : ""}: grants, residencies, competitions, festivals and submission windows that are still open, with deadlines after today. For each one: the name, who it's for, the deadline, any entry fee, and where to apply.`, ctx.user.tz);
    if (!f) return { reply: `I couldn't search just now. Try again in a minute. ${PLACES}` };
    const known = new Set(f.sources.map((s) => s.uri));
    // Only links that came back from the search itself, never one written out of thin air.
    const text = f.answer.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, t, u) => (known.has(u) ? `${t} ${u}` : t)).replace(/https?:\/\/[^\s)]+/g, (u) => (known.has(u) ? u : "")).replace(/[ \t]+\n/g, "\n").trim();
    const src = f.sources.length ? `\n\nSources:\n${f.sources.map((s) => `- ${s.title ? `${s.title}: ` : ""}${s.uri}`).join("\n")}` : "\n\nI couldn't get source links for these, so find each one on the organiser's own site before you apply.";
    return { reply: `${text}${src}\n\nBe wary of any call that charges a big fee to an organiser you can't verify. Say "open call: <name> closes <date>" to keep one.` };
  },
});

addPinger("calls", async (db, user, _today, now) => {
  const out = [];
  for (const c of await callsOf(db, user.id)) {
    if (c.status !== "open" || !c.closes) continue;
    const d = daysTo(c.closes, user, now);
    if (d === 7 || d === 1) out.push({ key: `oc:${c.id}:${d}:${c.closes}`, text: `${c.name} closes ${sayDay(c.closes, user, now)}${d > 1 ? ` (${sayIn(d)})` : ""}.` });
  }
  return out;
});
addBriefItems(async (db, user, now) => {
  const out = [];
  for (const c of await callsOf(db, user.id)) {
    if (c.status !== "open" || !c.closes) continue;
    const d = daysTo(c.closes, user, now);
    if (d >= 0 && d <= 7) out.push({ p: 14 + d, text: `${c.name} closes ${sayDay(c.closes, user, now)}` });
  }
  return out;
});

/* =====================================================================
 * 10. Quotes
 * ===================================================================== */

interface QuoteArgs { item: string; quantity?: number; unit?: string; rate?: number; flat?: number; revisions?: number; revision_price?: number; extras?: { label: string; amount: number }[]; deposit_pct?: number; currency?: string }
const UNITS = "hours?|hrs?|h|days?|weeks?|sessions?|pages?|illustrations?|pieces?|images?|photos?|songs?|tracks?|minutes?|mins?|words?|looks?|designs?|frames?|shots?|videos?|edits?";
const unitWord = (u: string) => { const w = u.toLowerCase(); return /^(?:h|hrs?|hours?)$/.test(w) ? "hour" : /^mins?$|^minutes?$/.test(w) ? "minute" : w.replace(/s$/, ""); };

/** "a logo, 12 hours at 40 an hour plus 2 revisions", "mural, 3000 flat plus 400 for materials, 50% deposit, in euros". */
export function parseQuote(text: string): QuoteArgs {
  let t = ` ${text.trim().replace(/[.!]+$/, "")} `;
  const take = (re: RegExp) => { const m = re.exec(t); if (m) t = t.replace(m[0], " "); return m; };
  const out: QuoteArgs = { item: "" };
  const cur = take(/\s(?:in|priced in)\s+(euros?|dollars?|pounds?|naira|cedis?|rand|reais|yen|won|rupees?|[a-z]{3})\s*$/i);
  if (cur) out.currency = cur[1];
  const time = take(new RegExp(`\\s(\\d+(?:\\.\\d+)?)\\s*(${UNITS})\\s+(?:at|@|x)\\s+${AMT}\\s*(?:\\/\\s*|an?\\s+|per\\s+|each)?\\s*(?:${UNITS})?(?=[\\s,])`, "i"));
  if (time) { out.quantity = Number(time[1]); out.unit = unitWord(time[2]); const v = amt(time[3]); out.rate = v.amount; if (v.currency) out.currency ??= v.currency; }
  const rev = take(new RegExp(`\\s(?:plus|with|and|\\+)?\\s*(\\d+|one|two|three|four|five)\\s+(?:rounds?\\s+of\\s+)?revisions?(?:\\s+(?:at|@)\\s+${AMT}\\s*(?:each|per|a)?(?:\\s+(?:revision|round))?)?(?:\\s+included)?(?=[\\s,])`, "i"));
  if (rev) { out.revisions = countOf(rev[1]); if (rev[2]) out.revision_price = amt(rev[2]).amount; }
  const dep = take(/\s(?:with\s+(?:a\s+)?)?(?:(\d{1,3})\s*%\s*(?:deposit|upfront|up front|down)|(?:deposit|upfront)\s+(?:of\s+)?(\d{1,3})\s*%)(?=[\s,])/i);
  if (dep) out.deposit_pct = Number(dep[1] ?? dep[2]);
  const flat = take(new RegExp(`\\s(?:flat(?:\\s+fee)?(?:\\s+of)?\\s+${AMT}|${AMT}\\s+flat(?:\\s+fee)?|(?:for|at)\\s+${AMT}(?:\\s+(?:total|all in))?)(?=[\\s,])`, "i"));
  if (flat) { const v = amt(flat[1] ?? flat[2] ?? flat[3]); out.flat = v.amount; if (v.currency) out.currency ??= v.currency; }
  const extras: { label: string; amount: number }[] = [];
  for (let i = 0; i < 4; i++) {
    const e = take(new RegExp(`\\s(?:plus|\\+|and)\\s+${AMT}\\s+(?:for\\s+)?(?:the\\s+)?([a-z][a-z ]{1,30}?)(?=\\s*(?:,|$|\\s+plus\\b|\\s+and\\b))`, "i"))
      ?? take(new RegExp(`\\s(?:plus|\\+|and)\\s+(?:the\\s+)?([a-z][a-z ]{1,30}?)\\s+(?:at\\s+|of\\s+)?${AMT}(?=[\\s,])`, "i"));
    if (!e) break;
    const [label, raw] = /^\d|^[^a-z]/i.test(e[1]) || /\d/.test(e[1]) ? [e[2], e[1]] : [e[1], e[2]];
    const v = amt(raw);
    extras.push({ label: label.trim(), amount: v.amount });
    if (v.currency) out.currency ??= v.currency;
  }
  if (extras.length) out.extras = extras;
  out.item = clean(t.split(",")[0].replace(/\s+(?:plus|with|and)\s*$/i, "").replace(/\s{2,}/g, " ")).replace(/^(?:for\s+)?(?:a|an|the)\s+/i, "") || "the work";
  return out;
}

const pad = (rows: [string, string][]) => { const w = Math.max(...rows.map(([l]) => l.length)) + 3; return rows.map(([l, r]) => (r ? `${l.padEnd(w)}${r}` : l)).join("\n"); };
const quoteMake = defineAction({
  name: "quote.make",
  tier: 1,
  description: "Make a clean, copyable price quote for creative work: hours or days at a rate, or a flat fee, plus revisions (included or priced), extras like materials or travel, and an optional deposit percentage. In the person's own currency unless they name another.",
  schema: z.object({ item: z.string().min(1).max(80), quantity: z.number().positive().optional(), unit: z.string().max(20).optional(), rate: z.number().min(0).optional(), flat: z.number().min(0).optional(), revisions: z.number().int().min(0).max(50).optional(), revision_price: z.number().min(0).optional(), extras: z.array(z.object({ label: z.string().max(40), amount: z.number().min(0) })).max(6).optional(), deposit_pct: z.number().min(1).max(100).optional(), currency: z.string().max(12).optional() }),
  async run(a, ctx) {
    const cur = a.currency ? normCur(a.currency, ctx.user) : userCurrency(ctx.user);
    const f = (n: number) => fmt(n, cur);
    const rows: [string, string][] = [];
    let total = 0;
    if (a.quantity && a.rate !== undefined) {
      const u = a.unit ?? "hour";
      const sub = a.quantity * a.rate;
      total += sub;
      const per = u === "hour" ? "an hour" : u === "day" || u === "week" ? `a ${u}` : `per ${u}`;
      rows.push([`${a.quantity} ${a.quantity === 1 ? u : `${u}s`} at ${f(a.rate)} ${per}`, f(sub)]);
    }
    if (a.flat !== undefined) { total += a.flat; rows.push([cap(a.item), f(a.flat)]); }
    if (!rows.length) throw new Error("What's the price? Say it like \"quote for a logo, 12 hours at 40 an hour\" or \"quote for a mural, 3000 flat\".");
    if (a.revisions) {
      const r = a.revision_price ? a.revisions * a.revision_price : 0;
      total += r;
      rows.push([`${plural(a.revisions, "round")} of revisions${a.revision_price ? ` at ${f(a.revision_price)}` : ""}`, r ? f(r) : "included"]);
    }
    for (const e of a.extras ?? []) { total += e.amount; rows.push([cap(e.label), f(e.amount)]); }
    rows.push(["Total", f(total)]);
    if (a.deposit_pct) rows.push([`Deposit to start (${a.deposit_pct}%)`, f(Math.round(total * a.deposit_pct) / 100)]);
    const block = [`Quote: ${cap(a.item)}`, "", pad(rows), "", "Valid for 30 days."].join("\n");
    return { reply: `${f(total)} for the ${a.item.toLowerCase()}. Here it is to copy:\n\n\`\`\`\n${block}\n\`\`\`\nSay it again with "in EUR" or "50% deposit" to change it.` };
  },
});

register(commAdd, commUpdate, commList, commNudge, callAdd, callUpdate, callList, callFind, quoteMake);

/* ---------------- words ---------------- */

const A = AMT;
const OWNER = "(?:the\\s+|their\\s+|her\\s+|his\\s+)?";
/** A rejection by a person or a life institution is not a submission: "my mum rejected me", "rejected by the bank", "didn't get into uni". */
const PERSONAL = "(?!(?:the\\s+)?(?:my|his|her|their|our|your|him|he|she|they|them|me|us|you|everyone|everybody|someone|somebody|nobody|people|mum|mom|mama|dad|papa|mother|father|parents?|boyfriend|girlfriend|husband|wife|partner|fianc[eé]e?|ex|crush|friends?|family|boss|landlord|landlady|employer|school|university|uni|college|bank|visa|embassy|job|team)\\b)";
const CALL_KIND = "open call|call for (?:entries|submissions|artists|work|proposals)|grant|residency|competition|contest|festival|submission window|submissions|fellowship|prize|award|label submission|publisher submission";
addRules(
  [/^(?:new\s+)?commission(?:\s+from\s+([^:]+?))?\s*:\s*(.+)$/i, (m) => ({ action: "commission.add", args: parseCommission(m[2], m[1]) })],
  [/^(?:sent\s+)?revision\s+(?:#|no\.?\s*)?(\d+|one|two|three|four|five|six)?\s*(?:sent|done|delivered|out)?\s+(?:for|to|on)\s+(.+)$/i, (m) => ({ action: "commission.update", args: { match: m[2], event: "revision", ...(countOf(m[1]) ? { n: countOf(m[1]) } : {}) } })],
  [/^(?:i\s+)?sent\s+(?:the\s+)?(?:revision|revisions|edits|changes)\s+(?:#?(\d+)\s+)?(?:for|to|on)\s+(.+)$/i, (m) => ({ action: "commission.update", args: { match: m[2], event: "revision", ...(m[1] ? { n: Number(m[1]) } : {}) } })],
  // Delivered a piece of work ("Tolu's portrait", "the logo for Acme"), not a pizza or the keys.
  [/^(?:i\s+)?(?:delivered|handed over|sent (?:off )?(?:the\s+)?final(?:\s+files)?(?:\s+(?:for|to))?)\s+(?:the\s+)?(.+)$/i, (m) => (/'s\s|\b(?:commission|portrait|piece|logo|illustration|mural|painting|artwork|design|cover|files|edit|mix|master|beat|video|photos|shoot|sketch|drawing|print|book|manuscript|website|brand)\b/i.test(m[1]) ? { action: "commission.update", args: { match: m[1], event: "delivered" } } : null)],
  [/^(?!(?:i|we|you)\b)(?!(?:my|the|our)\s+(?:landlord|landlady|tenant|boss|employer|bank|mum|mom|dad|mother|father|parents|brother|sister|friend|husband|wife|partner|uncle|aunt|cousin|insurance|company|office)\b)(.+?)\s+paid\s+(?:me\s+)?(?:the\s+)?(?:rest|balance|remainder|remaining balance|final payment|in full)(?:\s+(?:for|on)\s+(?:the\s+)?(.+))?$/i, (m) => ({ action: "commission.update", args: { match: m[2] ? `${m[1]} ${m[2]}` : m[1], event: "paid_rest" } })],
  [new RegExp(`^(?!(?:i|we|you)\\b)(.+?)\\s+paid\\s+(?:the|a|their|her|his)\\s+(?:${A}\\s+)?deposit(?:\\s+(?:for|on)\\s+(?:the\\s+)?(.+))?$`, "i"), (m) => ({ action: "commission.update", args: { match: m[3] ? `${m[1]} ${m[3]}` : m[1], event: "deposit", ...(m[2] ? { amount: amt(m[2]).amount } : {}) } })],
  [new RegExp(`^(?!(?:i|we|you)\\b)(.+?)\\s+paid\\s+(?:me\\s+)?(?:another\\s+)?${A}\\s+(?:more\\s+)?towards\\s+${OWNER}(.+)$`, "i"), (m) => ({ action: "commission.update", args: { match: `${m[1]} ${m[3]}`, event: "payment", amount: amt(m[2]).amount } })],
  [/^(?:cancel|drop|remove)\s+(?:the\s+)?(.+?)\s+commission$/i, (m) => ({ action: "commission.update", args: { match: m[1], event: "cancel" } })],
  [/^(?:my\s+|show\s+my\s+)?(?:commissions|open commissions|client work|client jobs)$/i, () => ({ action: "commission.list", args: {} })],
  [/^(?:draft|write)\s+(?:a\s+|me\s+a\s+)?(?:balance|payment|polite)\s+(?:reminder|nudge|note|message)\s+(?:for|to)\s+(.+)$|^(?:nudge|remind)\s+(.+?)\s+about\s+(?:the|their|her|his)\s+(?:balance|commission|final payment|rest)$/i, (m) => ({ action: "commission.nudge", args: { match: m[1] ?? m[2] } })],

  [new RegExp(`^(?:new\\s+)?(?:${CALL_KIND})\\s*:\\s*(.+?)(?:,?\\s+(?:closes|close|deadline(?: is)?|due|ends|by|until)\\s+(?:on\\s+)?([^,]+?))?(?:,?\\s+(https?:\\/\\/\\S+))?$`, "i"), (m) => ({ action: "opencall.add", args: { name: m[1], ...(m[2] ? { closes: m[2] } : {}), ...(m[3] ? { link: m[3] } : {}) } })],
  [new RegExp(`^(?:the\\s+)?(.+?\\s(?:open call|call for (?:entries|submissions|artists|work|proposals)|grant|residency|submission window|submissions|fellowship))\\s+(?:closes|deadline is|is due|ends|shuts)\\s+(?:on\\s+)?([^,]+?)(?:,?\\s+(https?:\\/\\/\\S+))?$`, "i"), (m) => ({ action: "opencall.add", args: { name: m[1], closes: m[2], ...(m[3] ? { link: m[3] } : {}) } })],
  [/^(?:i\s+)?(?:just\s+)?(?:submitted|applied(?=\s+(?:my\s+\w+\s+)?to\s+(?!.*\bjobs?\b)))\s+(?:my\s+(?:work|portfolio|demo|manuscript|application|pitch|proposal|film|photos|entry|piece|track|song|art|artwork|poems?|story|book|ep|album)\s+)?(?:to|for|into)\s+(?:the\s+)?(.+)$|^(?:i\s+)?(?:just\s+)?sent\s+my\s+(?:work|portfolio|demo|manuscript|application|pitch|proposal|film|photos|entry|track|song|artwork|poems?|story|book)\s+to\s+(?:the\s+)?(.+)$/i, (m) => ({ action: "opencall.update", args: { match: m[1] ?? m[2], status: "submitted" } })],
  [new RegExp(`^(?:i\\s+)?(?:was\\s+|got\\s+|have been\\s+|i'?ve been\\s+|i'?m\\s+|we\\s+were\\s+)?(?:(accepted|selected|shortlisted|longlisted|waitlisted)\\s+(?:into|to|for|by|at|in)|(rejected|turned down)\\s+(?:by|from))\\s+(?:the\\s+)?${PERSONAL}(.+)$`, "i"), (m) => { const s = (m[1] ?? m[2]).toLowerCase(); return { action: "opencall.update", args: { match: m[3], status: /^(?:accepted|selected)$/.test(s) ? "accepted" : /listed$/.test(s) ? "shortlisted" : s === "waitlisted" ? "shortlisted" : "rejected" } }; }],
  [/^(?:i\s+)?got into\s+(?:the\s+)?(.+?\s(?:residency|festival|show|exhibition|programme|program|biennale|biennial|fair|fellowship|open call|anthology|magazine|gallery|collective|art school|mfa))$/i, (m) => ({ action: "opencall.update", args: { match: m[1], status: "accepted" } })],
  [new RegExp(`^(?:i\\s+)?(?:didn'?t|did not)\\s+get\\s+into\\s+(?:the\\s+)?${PERSONAL}(.+)$|^(?:the\\s+)?${PERSONAL}(.+?)\\s+(?:rejected|turned down)\\s+me$`, "i"), (m) => (/\b(?:club|party|bar|school|university|uni|college|team|course|class|gym|restaurant|car|bus|train|flight|building|house)\b/i.test(m[1] ?? m[2] ?? "") ? null : { action: "opencall.update", args: { match: m[1] ?? m[2], status: "rejected" } })],
  [/^(?:i\s+)?(?:withdrew|withdrawn)\s+my\s+(?:entry|submission|application)\s+(?:from|for|to)\s+(?:the\s+)?(.+)$/i, (m) => ({ action: "opencall.update", args: { match: m[1], status: "withdrawn" } })],
  [/^(?:my\s+|show\s+my\s+)?(?:open calls|submissions|applications|grants|residencies)$/i, () => ({ action: "opencall.list", args: {} })],
  [/^(?:find|search(?:\s+for)?|look\s+for|any|show\s+me)\s+(?:me\s+)?(?:some\s+|new\s+|good\s+)?(?:open\s+calls?|calls?\s+for\s+(?:entries|artists|submissions)|art\s+grants?|grants?\s+for\s+artists|artist\s+residenc(?:y|ies)|residenc(?:y|ies)|art\s+competitions?|competitions?\s+for\s+artists|art\s+prizes?)(?:\s+(.+?))?\??$/i, (m) => ({ action: "opencall.find", args: m[1] ? { query: m[1] } : {} })],

  [/^(?:make\s+(?:me\s+)?|draft\s+|write\s+(?:me\s+)?|give\s+me\s+|create\s+|do\s+)?(?:a\s+)?quote(?:\s+me)?(?:\s+for|:)\s+(?=.*\d)(.+)$/i, (m) => ({ action: "quote.make", args: { ...parseQuote(m[1]) } })],
);

addExamples("commission.add", ["commission: portrait for Tolu, 150, due 20 Nov, 50 deposit paid", "new commission from Ji-woo: album cover, 300000 KRW, due 5 Dec", "commission: mural for Café Lisboa, €1,200, due Friday, deposit 400"]);
addExamples("commission.update", ["revision 2 sent for Tolu's portrait", "delivered Tolu's portrait", "Tolu paid the rest", "Ji-woo paid the deposit", "Marta paid 200 more towards the mural", "cancel the mural commission"]);
addExamples("commission.list", ["my commissions", "client work"]);
addExamples("commission.nudge", ["draft a balance reminder for Tolu", "nudge Tolu about the balance"]);
addExamples("opencall.add", ["open call: Lagos Photo Festival closes 15 Dec", "residency: Cité internationale des arts deadline 1 Feb https://www.citedesartsparis.fr", "the São Paulo Biennial open call closes 30 Jan"]);
addExamples("opencall.update", ["submitted to Lagos Photo Festival", "I sent my demo to Mavin Records", "accepted into the Berlin residency", "rejected by Lagos Photo Festival", "shortlisted for the Seoul illustration prize", "I got into the Gasworks residency"]);
addExamples("opencall.list", ["my open calls", "my submissions"]);
addExamples("opencall.find", ["find open calls for illustrators this month", "any residencies in Berlin", "find art grants for Nigerian artists"]);
addExamples("quote.make", ["quote for a logo, 12 hours at 40 an hour plus 2 revisions", "make a quote for a mural, 3000 flat plus 400 for materials, 50% deposit", "quote: wedding shoot, 8 hours at 150 an hour, in EUR"]);

addCues("commission", ["commission", "commissions", "client", "deposit", "balance", "revision", "delivered", "paid the rest", "client work"]);
addCues("opencall", ["open call", "grant", "residency", "competition", "festival", "submitted to", "submission", "accepted into", "rejected by", "shortlisted", "fellowship", "prize"]);
addCues("quote", ["quote", "estimate", "price for", "hourly rate", "how much should i charge", "flat fee"]);

addCapability({
  key: "creativework", name: "Commissions, quotes and open calls",
  cues: ["commission", "client", "deposit", "balance", "revision", "quote", "estimate", "open call", "grant", "residency", "competition", "submission", "festival"],
  what: "Keep your commissions: who, what, deposit and balance, revisions and the deadline, with reminders 3 days and 1 day before, and a polite balance note you send yourself. Make a clean quote to copy in your own currency. Keep open calls, grants, residencies and submissions with reminders 7 days and 1 day before they close, track what you sent and what came back, and search for new ones.",
  say: ["commission: portrait for Tolu, 150, due 20 Nov, 50 deposit paid", "revision 2 sent for Tolu's portrait", "Tolu paid the rest", "quote for a logo, 12 hours at 40 an hour plus 2 revisions", "open call: Lagos Photo Festival closes 15 Dec", "submitted to Lagos Photo Festival", "find open calls for illustrators this month"],
  then: "At most one creative ping a day, merged; everything else waits for your brief. Say \"stop creative pings\" to keep it all to the brief.",
  limits: "I never message your clients for you. Search links come from the search itself, never made up.",
}, "Creative and NFTs");
