/**
 * Dates and markets: airdrop claim windows and token unlocks the person enters themselves,
 * perps funding (Hyperliquid, with Binance as a second opinion) and perp price-move alerts,
 * and Polymarket markets they want to keep an eye on. Read only throughout.
 */
import { DateTime } from "luxon";
import { z } from "zod";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema, addSystemJob } from "../../../core/plugins.js";
import { onJob, type SchedulerDeps } from "../../../core/scheduler.js";
import { parseWhen } from "../../../core/time.js";
import { flush, getJson, queue, sorry } from "./shared.js";
import { checkRotations } from "./devtools.js";

/* =====================================================================
 * 11. Claims, unlocks and other crypto deadlines
 * ===================================================================== */

addSchema(`CREATE TABLE IF NOT EXISTS tech_claims (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, title TEXT NOT NULL, due DATE NOT NULL, sent INT[] NOT NULL DEFAULT '{}', done BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ DEFAULT now())`);

const KIND_WORD: Record<string, string> = { claim: "Claim window for", unlock: "Token unlock for", deadline: "Deadline for" };
const verb = (k: string) => (k === "unlock" ? "is on" : "closes");
const isoOf = (d: any) => (typeof d === "string" ? d.slice(0, 10) : DateTime.fromJSDate(d).toUTC().toISODate()!);
const pretty = (iso: string) => DateTime.fromISO(iso).toFormat("ccc d LLL");
const daysLeft = (iso: string, tz: string, now: Date) => Math.round(DateTime.fromISO(iso, { zone: tz }).diff(DateTime.fromJSDate(now).setZone(tz).startOf("day"), "days").days);

const claimAdd = defineAction({
  name: "claim.add",
  tier: 1,
  description: "Keep a crypto date the person gives: an airdrop claim window closing (`kind` claim), a token unlock (`kind` unlock) or another deadline. Reminders 7 days before, the day before and on the day. Manual entries only.",
  schema: z.object({ kind: z.enum(["claim", "unlock", "deadline"]), title: z.string().min(1).max(80), due: z.string().min(2) }),
  async run(args, ctx) {
    const d = parseWhen(args.due, ctx.user.tz, ctx.now);
    if (!d) throw new Error(`I couldn't read a date in "${args.due}". When is it, like "15 Dec"?`);
    const iso = DateTime.fromJSDate(d).setZone(ctx.user.tz).toISODate()!;
    const left = daysLeft(iso, ctx.user.tz, ctx.now);
    if (left < 0) throw new Error(`${pretty(iso)} has already passed. Did you mean next year?`);
    const title = args.title.trim().replace(/^the\s+/i, "");
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO tech_claims (user_id, kind, title, due, sent) VALUES ($1,$2,$3,$4,$5::int[]) RETURNING id`, [ctx.user.id, args.kind, title, iso, left < 7 ? [7] : []]);
    const plan = left >= 7 ? "I'll remind you 7 days before, the day before and on the day." : left >= 1 ? "That's soon, so I'll remind you the day before and on the day." : "That's today, so I'll remind you this morning if it's not too late.";
    return { reply: `${KIND_WORD[args.kind]} ${title} ${verb(args.kind)} ${pretty(iso)}. ${plan}`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM tech_claims WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Dropped that date.";
  },
});

const claimDone = defineAction({
  name: "claim.done",
  tier: 1,
  description: "The person claimed an airdrop or dealt with an unlock or deadline: stop its reminders. `match` is part of its name.",
  schema: z.object({ match: z.string().min(1) }),
  async run(args, ctx) {
    const r = await ctx.db.query<{ id: number; title: string }>(`UPDATE tech_claims SET done=true WHERE user_id=$1 AND NOT done AND title ILIKE $2 RETURNING id, title`, [ctx.user.id, `%${args.match.trim().replace(/^(?:the|my)\s+/i, "").replace(/\s+(?:airdrop|claim|tokens?)$/i, "")}%`]);
    if (!r.length) return { reply: `I don't have a claim or unlock matching "${args.match}". Say "my claims" to see them.` };
    return { reply: `Nice. ${r.map((x) => x.title).join(", ")} is done, no more reminders.`, undo: { payload: { ids: r.map((x) => x.id) } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE tech_claims SET done=false WHERE id = ANY($1::int[]) AND user_id=$2`, [p.ids, ctx.user.id]);
    return "Back on the list.";
  },
});

/** Hourly from 09:00 local: 7 days before (one gentle ping), the day before and the day itself (reminders). */
export async function checkClaims(deps: SchedulerDeps, now: Date): Promise<number[]> {
  const rows = await deps.db.query<any>(`SELECT c.*, u.tz FROM tech_claims c JOIN users u ON u.id=c.user_id WHERE NOT c.done AND c.due >= current_date - 1`);
  const touched: number[] = [];
  for (const c of rows) {
    const local = DateTime.fromJSDate(now).setZone(c.tz);
    if (local.hour < 9) continue;
    const iso = isoOf(c.due), left = daysLeft(iso, c.tz, now);
    const sent: number[] = (c.sent ?? []).map(Number);
    const stage = [0, 1, 7].find((s) => left <= s && left >= 0 && !sent.includes(s));
    if (stage === undefined) continue;
    const what = `${KIND_WORD[c.kind]} ${c.title}`;
    const text = stage === 0 ? `${what} ${c.kind === "unlock" ? "is today" : "closes today"}.` : stage === 1 ? `${what} ${c.kind === "unlock" ? "is tomorrow" : "closes tomorrow"}, ${pretty(iso)}.` : `${what} ${verb(c.kind)} ${pretty(iso)}, in ${left} days.`;
    await queue(deps.db, c.user_id, "claims", stage === 7 ? "daily" : "urgent", text, now, c.kind === "unlock" ? undefined : { label: "Done", data: `tc:claim:${c.id}` });
    // Passing a stage covers the earlier ones too, so a late entry never sends two at once.
    await deps.db.query(`UPDATE tech_claims SET sent=$2::int[] WHERE id=$1`, [c.id, [...new Set([...sent, ...[0, 1, 7].filter((s) => s >= stage)])]]);
    touched.push(c.user_id);
  }
  return touched;
}

onJob("tech_hourly", async (_job, deps) => {
  const now = new Date();
  const touched = [...(await checkClaims(deps, now)), ...(await checkRotations(deps, now))];
  if (touched.length) await flush(deps, now, [...new Set(touched)]);
});

/** Time-sensitive things near the top of the brief: claims and unlocks within a week, rotations due. */
addBriefSection({
  key: "tech_due", order: 12,
  async lines(db, user, now) {
    const claims = await db.query<any>(`SELECT kind, title, due FROM tech_claims WHERE user_id=$1 AND NOT done AND due >= $2::date AND due <= $2::date + 7 ORDER BY due LIMIT 3`, [user.id, DateTime.fromJSDate(now).setZone(user.tz).toISODate()]);
    const rot = await db.query<any>(`SELECT name, next_due FROM tech_rotations WHERE user_id=$1 AND active AND next_due <= $2::date + 3 ORDER BY next_due LIMIT 2`, [user.id, DateTime.fromJSDate(now).setZone(user.tz).toISODate()]);
    const bits = [
      ...claims.map((c) => { const l = daysLeft(isoOf(c.due), user.tz, now); return `${c.title} ${c.kind === "unlock" ? "unlocks" : "closes"} ${l === 0 ? "today" : l === 1 ? "tomorrow" : `in ${l} days`}`; }),
      ...rot.map((r) => { const l = daysLeft(isoOf(r.next_due), user.tz, now); return `rotate the ${r.name} ${l < 0 ? `(${-l} days overdue)` : l === 0 ? "today" : `in ${l} days`}`; }),
    ];
    return bits.length ? [`Coming up: ${bits.join("; ")}.`] : [];
  },
});

/* =====================================================================
 * 12. Perps funding and price moves
 * ===================================================================== */

addSchema(`CREATE TABLE IF NOT EXISTS tech_perp_alerts (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), coin TEXT NOT NULL, kind TEXT NOT NULL, op TEXT NOT NULL, threshold NUMERIC NOT NULL, ref NUMERIC, armed BOOLEAN NOT NULL DEFAULT true, fired_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now())`);

const COIN_ALIAS: Record<string, string> = { bitcoin: "BTC", ethereum: "ETH", ether: "ETH", solana: "SOL", hyperliquid: "HYPE", dogecoin: "DOGE", ripple: "XRP", pepe: "kPEPE", bonk: "kBONK" };
export const perpCoin = (s: string) => COIN_ALIAS[s.toLowerCase()] ?? (/^k[A-Z]+$/.test(s) ? s : s.toUpperCase());

export interface PerpCtx { coin: string; funding: number; mark: number; prevDay: number; oi: number }
/** Every Hyperliquid perp's context in one call: funding is the hourly rate as a fraction. */
export async function hyperliquid(): Promise<Map<string, PerpCtx>> {
  const [meta, ctxs] = await getJson<[any, any[]]>("https://api.hyperliquid.xyz/info", { body: { type: "metaAndAssetCtxs" } });
  const out = new Map<string, PerpCtx>();
  (meta?.universe ?? []).forEach((u: any, i: number) => {
    const c = ctxs?.[i];
    if (c && !u.isDelisted) out.set(String(u.name).toUpperCase(), { coin: u.name, funding: Number(c.funding), mark: Number(c.markPx), prevDay: Number(c.prevDayPx), oi: Number(c.openInterest) });
  });
  return out;
}
const p4 = (x: number) => `${(x * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`;
const usd = (n: number) => `$${n >= 100 ? Math.round(n).toLocaleString("en-US") : Number(n.toPrecision(4))}`;

const fundingCheck = defineAction({
  name: "funding.check",
  tier: 1,
  description: "Current perpetual futures funding rate for a coin (Hyperliquid, plus Binance when it answers), with mark price and which side pays.",
  schema: z.object({ coin: z.string().min(1).max(15) }),
  async run(args) {
    const coin = perpCoin(args.coin);
    let hl: Map<string, PerpCtx>;
    try { hl = await hyperliquid(); } catch (e) { throw sorry("Hyperliquid", e); }
    const c = hl.get(coin.toUpperCase());
    const binance = await getJson<any>(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${coin.replace(/^k/, "1000")}USDT`, { timeoutMs: 6000 }).catch(() => null);
    if (!c && !binance?.lastFundingRate) throw new Error(`I couldn't find a ${coin} perp on Hyperliquid or Binance. Check the ticker, like BTC or ETH?`);
    const lines: string[] = [];
    if (c) {
      const side = c.funding > 0 ? "longs pay shorts" : c.funding < 0 ? "shorts pay longs" : "nobody pays";
      lines.push(`${coin} funding on Hyperliquid is ${p4(c.funding)} an hour (${p4(c.funding * 8)} per 8 hours, about ${(c.funding * 24 * 365 * 100).toFixed(1)}% a year); ${side}. Mark ${usd(c.mark)}.`);
    }
    if (binance?.lastFundingRate !== undefined) lines.push(`Binance: ${p4(Number(binance.lastFundingRate))} per funding period, next ${DateTime.fromMillis(Number(binance.nextFundingTime)).toUTC().toFormat("HH:mm")} UTC.`);
    return { reply: lines.join("\n") };
  },
});

const fundingAlert = defineAction({
  name: "funding.alert",
  tier: 1,
  description: "Alert on perps: `kind` funding (funding rate goes above or below a percent, read per 8 hours like most exchanges quote it; Hyperliquid's hourly rate is converted) or move (the coin's Hyperliquid perp price moves by a percent from now). Keeps watching, at most one alert every 12 hours for funding and every hour for moves.",
  schema: z.object({ coin: z.string().min(1).max(15), kind: z.enum(["funding", "move"]), op: z.enum(["above", "below", "move"]).optional(), percent: z.number().min(-10).max(100) }),
  async run(args, ctx) {
    const coin = perpCoin(args.coin);
    let hl: Map<string, PerpCtx>;
    try { hl = await hyperliquid(); } catch (e) { throw sorry("Hyperliquid", e); }
    const c = hl.get(coin.toUpperCase());
    if (!c) throw new Error(`Hyperliquid doesn't list a ${coin} perp. Check the ticker, like BTC or ETH?`);
    if (args.kind === "move") {
      if (args.percent <= 0) throw new Error("Give me the size of the move as a percent, like 5.");
      const r = await ctx.db.one<{ id: number }>(`INSERT INTO tech_perp_alerts (user_id, coin, kind, op, threshold, ref) VALUES ($1,$2,'move','move',$3,$4) RETURNING id`, [ctx.user.id, coin, args.percent, c.mark]);
      return { reply: `I'll tell you when the ${coin} perp moves ${args.percent}% from ${usd(c.mark)}, then measure from there again. At most one of these an hour. Say "stop ${coin} perp alerts" to end it.`, undo: { payload: { id: r!.id } } };
    }
    const op = args.op === "below" ? "below" : "above";
    const thr = args.percent / 100;
    const now8 = c.funding * 8;
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO tech_perp_alerts (user_id, coin, kind, op, threshold, armed) VALUES ($1,$2,'funding',$3,$4,$5) RETURNING id`, [ctx.user.id, coin, op, thr, op === "above" ? now8 < thr : now8 > thr]);
    return { reply: `I'll tell you when ${coin} funding goes ${op} ${p4(thr)} per 8 hours (${p4(thr / 8)} an hour on Hyperliquid). It's ${p4(now8)} per 8 hours now. After it fires it waits until funding comes back before it can fire again, and never more than every 12 hours. Say "stop ${coin} funding alerts" to end it.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM tech_perp_alerts WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Perp alert dropped.";
  },
});

onJob("tech_perps", async (_job, deps) => { await checkPerps(deps, new Date()); });
export async function checkPerps(deps: SchedulerDeps, now: Date): Promise<void> {
  const alerts = await deps.db.query<any>(`SELECT * FROM tech_perp_alerts WHERE active ORDER BY id LIMIT 500`);
  if (!alerts.length) return;
  let hl: Map<string, PerpCtx>;
  try { hl = await hyperliquid(); } catch { return; }
  const touched = new Set<number>();
  for (const a of alerts) {
    const c = hl.get(String(a.coin).toUpperCase());
    if (!c) continue;
    const since = a.fired_at ? now.getTime() - new Date(a.fired_at).getTime() : Infinity;
    if (a.kind === "funding") {
      const f8 = c.funding * 8, thr = Number(a.threshold);
      const hit = a.op === "above" ? f8 >= thr : f8 <= thr;
      if (hit && a.armed && since >= 12 * 3_600_000) {
        await queue(deps.db, a.user_id, "perps", "urgent", `${a.coin} funding is ${p4(f8)} per 8 hours on Hyperliquid, ${a.op} your ${p4(thr)}. ${c.funding > 0 ? "Longs are paying shorts" : "Shorts are paying longs"}.`, now);
        await deps.db.query(`UPDATE tech_perp_alerts SET armed=false, fired_at=$2 WHERE id=$1`, [a.id, now]);
        touched.add(a.user_id);
      } else if (!hit && !a.armed) {
        // Re-arm only once it has clearly come back (a tenth of the way past the line), so it can't flap.
        const back = a.op === "above" ? f8 < thr - Math.abs(thr) * 0.1 : f8 > thr + Math.abs(thr) * 0.1;
        if (back) await deps.db.query(`UPDATE tech_perp_alerts SET armed=true WHERE id=$1`, [a.id]);
      }
    } else {
      const ref = Number(a.ref), move = ref ? (c.mark / ref - 1) * 100 : 0;
      if (Math.abs(move) >= Number(a.threshold) && since >= 3_600_000) {
        await queue(deps.db, a.user_id, "perps", "urgent", `The ${a.coin} perp is ${move > 0 ? "up" : "down"} ${Math.abs(move).toFixed(1)}% to ${usd(c.mark)} (from ${usd(ref)}).`, now);
        await deps.db.query(`UPDATE tech_perp_alerts SET ref=$2, fired_at=$3 WHERE id=$1`, [a.id, c.mark, now]);
        touched.add(a.user_id);
      }
    }
  }
  if (touched.size) await flush(deps, now, [...touched]);
}

/* =====================================================================
 * 13. Polymarket
 * ===================================================================== */

addSchema(`CREATE TABLE IF NOT EXISTS tech_markets (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), market_id TEXT NOT NULL, slug TEXT, question TEXT NOT NULL, ref NUMERIC, last NUMERIC, move_pts NUMERIC NOT NULL DEFAULT 10, fired_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, market_id))`);

const GAMMA = "https://gamma-api.polymarket.com";
const jsonList = (v: unknown): any[] => { if (Array.isArray(v)) return v; try { return JSON.parse(String(v ?? "[]")); } catch { return []; } };
/** The "Yes" price as a probability (0 to 1). Gamma sends outcomes and outcomePrices as JSON strings. */
export function yesPrice(m: any): number | null {
  const outcomes = jsonList(m?.outcomes).map(String), prices = jsonList(m?.outcomePrices).map(Number);
  if (!prices.length) return null;
  const i = outcomes.findIndex((o) => /^yes$/i.test(o));
  const p = prices[i >= 0 ? i : 0];
  return Number.isFinite(p) ? p : null;
}
const pts = (p: number) => `${Math.round(p * 100)}%`;

export async function findMarket(q: string): Promise<any | null> {
  const j = await getJson<any>(`${GAMMA}/public-search?q=${encodeURIComponent(q)}`);
  const markets = (j?.events ?? []).flatMap((e: any) => (e.markets ?? []).map((m: any) => ({ ...m, eventTitle: e.title }))).filter((m: any) => !m.closed && m.active !== false && yesPrice(m) !== null);
  const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const score = (m: any) => words.filter((w) => String(m.question ?? "").toLowerCase().includes(w)).length;
  return markets.sort((a: any, b: any) => score(b) - score(a) || Number(b.volume ?? 0) - Number(a.volume ?? 0))[0] ?? null;
}

const marketWatch = defineAction({
  name: "market.watch",
  tier: 1,
  description: "Watch a Polymarket prediction market found by search ('Will X happen'), read only: tells the person when the Yes price moves by `points` percentage points (default 10), and when it resolves.",
  schema: z.object({ query: z.string().min(3).max(200), points: z.number().min(1).max(90).optional() }),
  async run(args, ctx) {
    let m: any;
    try { m = await findMarket(args.query); } catch (e) { throw sorry("Polymarket", e); }
    if (!m) throw new Error(`I couldn't find an open Polymarket market for "${args.query}". Try a few words from its question?`);
    const p = yesPrice(m)!;
    const move = args.points ?? 10;
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO tech_markets (user_id, market_id, slug, question, ref, last, move_pts) VALUES ($1,$2,$3,$4,$5,$5,$6) ON CONFLICT (user_id, market_id) DO UPDATE SET active=true, ref=EXCLUDED.ref, last=EXCLUDED.last, move_pts=EXCLUDED.move_pts RETURNING id`, [ctx.user.id, String(m.id), m.slug ?? null, m.question, p, move]);
    return { reply: `Watching "${m.question}" on Polymarket, Yes at ${pts(p)} now. I'll tell you if it moves ${move} points, and when it resolves.${args.points ? "" : ` Say "alert me if it moves 5 points" to change that.`}`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM tech_markets WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Stopped watching that market.";
  },
});

const marketAlert = defineAction({
  name: "market.alert",
  tier: 1,
  description: "Change how big a move (in percentage points of the Yes price) triggers an alert on a watched Polymarket market. `match` picks the market by words in its question; without it, the most recently watched one.",
  schema: z.object({ points: z.number().min(1).max(90), match: z.string().optional() }),
  async run(args, ctx) {
    const row = await ctx.db.one<any>(`SELECT * FROM tech_markets WHERE user_id=$1 AND active AND ($2::text IS NULL OR question ILIKE '%' || $2 || '%') ORDER BY id DESC LIMIT 1`, [ctx.user.id, args.match ?? null]);
    if (!row) return { reply: `I'm not watching a Polymarket market${args.match ? ` matching "${args.match}"` : ""} for you yet. Say "watch the market 'Will X happen'" first.` };
    await ctx.db.query(`UPDATE tech_markets SET move_pts=$2, ref=COALESCE(last, ref) WHERE id=$1`, [row.id, args.points]);
    return { reply: `I'll tell you if "${row.question}" moves ${args.points} points from ${row.last != null ? pts(Number(row.last)) : "here"}.`, undo: { payload: { id: row.id, move: row.move_pts, ref: row.ref } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE tech_markets SET move_pts=$2, ref=$3 WHERE id=$1 AND user_id=$4`, [p.id, p.move, p.ref, ctx.user.id]);
    return "Put the old threshold back.";
  },
});

onJob("tech_markets", async (_job, deps) => { await checkMarkets(deps, new Date()); });
export async function checkMarkets(deps: SchedulerDeps, now: Date): Promise<void> {
  const rows = await deps.db.query<any>(`SELECT * FROM tech_markets WHERE active ORDER BY id LIMIT 300`);
  const cache = new Map<string, any>();
  const touched = new Set<number>();
  for (const w of rows) {
    if (!cache.has(w.market_id)) cache.set(w.market_id, await getJson<any>(`${GAMMA}/markets/${encodeURIComponent(w.market_id)}`).catch(() => null));
    const m = cache.get(w.market_id);
    if (!m) continue;
    const p = yesPrice(m);
    if (m.closed) {
      const outcome = p === null ? "" : p >= 0.99 ? ": Yes" : p <= 0.01 ? ": No" : "";
      await queue(deps.db, w.user_id, "markets", "daily", `"${w.question}" has closed on Polymarket${outcome}.`, now);
      await deps.db.query(`UPDATE tech_markets SET active=false, last=$2 WHERE id=$1`, [w.id, p]);
      touched.add(w.user_id);
      continue;
    }
    if (p === null) continue;
    const ref = Number(w.ref ?? p), moved = (p - ref) * 100;
    const recent = w.fired_at && now.getTime() - new Date(w.fired_at).getTime() < 3_600_000;
    if (Math.abs(moved) >= Number(w.move_pts) && !recent) {
      await queue(deps.db, w.user_id, "markets", "urgent", `"${w.question}" moved ${moved > 0 ? "up" : "down"} ${Math.round(Math.abs(moved))} points: Yes is ${pts(p)}, from ${pts(ref)}.${m.slug ? `\nhttps://polymarket.com/market/${m.slug}` : ""}`, now);
      await deps.db.query(`UPDATE tech_markets SET ref=$2, last=$2, fired_at=$3 WHERE id=$1`, [w.id, p, now]);
      touched.add(w.user_id);
    } else await deps.db.query(`UPDATE tech_markets SET last=$2 WHERE id=$1`, [w.id, p]);
  }
  if (touched.size) await flush(deps, now, [...touched]);
}

register(claimAdd, claimDone, fundingCheck, fundingAlert, marketWatch, marketAlert);

/* ---------- jobs, words, cards ---------- */

addSystemJob("tech_hourly", "37 * * * *");
addSystemJob("tech_perps", "3,13,23,33,43,53 * * * *");
addSystemJob("tech_markets", "8,23,38,53 * * * *");

const COIN = String.raw`([A-Za-z]{2,10})`;
const unq = (s: string) => s.trim().replace(/^["“'‘]|["”'’]$/g, "").trim();
addRules(
  [/^(?:the\s+)?(?:airdrop\s+)?claim(?:\s+window)?\s+(?:for|on)\s+(.+?)\s+(?:closes|ends|expires|is due|deadline is)\s+(?:on\s+)?(.+)$/i, (m) => ({ action: "claim.add", args: { kind: "claim", title: m[1], due: m[2] } })],
  [/^(?:the\s+)?(.+?)\s+(?:airdrop(?:\s+claim)?(?:\s+window)?|claim\s+window)\s+(?:closes|ends|expires)\s+(?:on\s+)?(.+)$/i, (m) => ({ action: "claim.add", args: { kind: "claim", title: m[1], due: m[2] } })],
  [/^(?:the\s+|a\s+)?(?:token\s+)?unlock\s+(?:for|of)\s+(.+?)\s+(?:on|is on|happens on|lands on|is)\s+(.+)$/i, (m) => ({ action: "claim.add", args: { kind: "unlock", title: m[1], due: m[2] } })],
  [/^(\$?[A-Z][A-Z0-9]{1,9}|[\w$ .-]{2,30}?\s+[Tt]oken)\s+[Uu]nlocks?\s+(?:on|is on)\s+(.+)$/, (m) => ({ action: "claim.add", args: { kind: "unlock", title: m[1], due: m[2] } })],
  [/^(?:i\s+)?(?:claimed|have claimed|already claimed)\s+(?:the\s+|my\s+)?(.+?)\s+(?:airdrop|tokens|allocation|drop|claim)$/i, (m) => ({ action: "claim.done", args: { match: m[1] } })],
  [/^(?:i\s+)?(?:claimed|have claimed|already claimed)\s+(?!(?:my|the|a|an|our|his|her|their|it|that|this)\b)([A-Z][\w$.-]{1,20}|\$[A-Za-z]{2,10})$/, (m) => ({ action: "claim.done", args: { match: m[1] } })],
  [new RegExp(String.raw`^(?:what(?:'s| is)\s+(?:the\s+)?)?funding(?:\s+rate)?\s+(?:on|for)\s+${COIN}(?:\s+(?:now|right now))?\??$`, "i"), (m) => ({ action: "funding.check", args: { coin: m[1] } })],
  [new RegExp(String.raw`^${COIN}\s+funding(?:\s+rate)?(?:\s+now)?\??$`, "i"), (m) => ({ action: "funding.check", args: { coin: m[1] } })],
  [new RegExp(String.raw`^(?:alert|tell|ping|notify)\s+me\s+(?:when|if)\s+${COIN}\s+funding(?:\s+rate)?\s+(?:goes|gets|is|rises|drops|falls|turns)?\s*(above|over|below|under)\s+(-?[\d.]+)\s*%?$`, "i"), (m) => ({ action: "funding.alert", args: { coin: m[1], kind: "funding", op: /above|over/i.test(m[2]) ? "above" : "below", percent: Number(m[3]) } })],
  [new RegExp(String.raw`^(?:alert|tell|ping|notify)\s+me\s+(?:when|if)\s+(?:funding\s+(?:on|for)\s+)${COIN}\s+(?:goes|gets|is|rises|drops|falls|turns)?\s*(above|over|below|under)\s+(-?[\d.]+)\s*%?$`, "i"), (m) => ({ action: "funding.alert", args: { coin: m[1], kind: "funding", op: /above|over/i.test(m[2]) ? "above" : "below", percent: Number(m[3]) } })],
  [new RegExp(String.raw`^(?:alert|tell|ping|notify)\s+me\s+(?:when|if)\s+(?:the\s+)?${COIN}\s+perps?\s+(?:moves?|swings?|changes?)\s+(?:by\s+)?([\d.]+)\s*%$`, "i"), (m) => ({ action: "funding.alert", args: { coin: m[1], kind: "move", percent: Number(m[2]) } })],
  [/^(?:watch|follow|track)\s+(?:the\s+)?(?:polymarket\s+)?(?:market|odds|prediction market)(?:\s+on\s+polymarket)?\s+(?:for\s+|on\s+)?(.+?)(?:,?\s+(?:and\s+)?(?:alert|tell|ping) me if it moves\s+(\d{1,2})\s*(?:points?|pts|percentage points))?$/i, (m) => ({ action: "market.watch", args: { query: unq(m[1]), points: m[2] ? Number(m[2]) : undefined } })],
  [/^(?:watch|follow|track)\s+(.+?)\s+on\s+polymarket$/i, (m) => ({ action: "market.watch", args: { query: unq(m[1]) } })],
  [/^(?:alert|tell|ping|notify)\s+me\s+(?:if|when)\s+(?:it|that(?: market)?|the market|the odds|the polymarket)\s+(?:moves?|swings?|changes?)\s+(?:by\s+)?(\d{1,2})\s*(?:points?|pts|percentage points)$/i, (m) => ({ action: "market.alert", args: { points: Number(m[1]) } })],
);
addExamples("claim.add", ["claim window for Jupiter closes 15 Dec", "token unlock for Arbitrum on 1 Feb", "the LayerZero airdrop claim closes on friday", "ZRO unlock on 20 June"]);
addExamples("claim.done", ["claimed the Jupiter airdrop", "I claimed the LayerZero airdrop"]);
addExamples("funding.check", ["funding on ETH", "BTC funding", "what's the funding rate on SOL"]);
addExamples("funding.alert", ["alert me when BTC funding goes above 0.05%", "tell me if ETH funding drops below -0.01%", "alert me if the SOL perp moves 5%"]);
addExamples("market.watch", ["watch the market 'Will X happen'", "watch the polymarket market \"Fed cuts rates in December\"", "watch the market Bitcoin above 150k and alert me if it moves 10 points"]);
addExamples("market.alert", ["alert me if it moves 10 points", "tell me if the market moves 5 points"]);
addCues("claim", ["airdrop", "claim", "claim window", "unlock", "token unlock", "vesting", "my claims"]);
addCues("funding", ["funding", "funding rate", "perp", "perps", "perpetual", "hyperliquid", "longs pay", "shorts pay"]);
addCues("market", ["polymarket", "prediction market", "odds", "will it happen", "market moves", "points"]);

addCapability({
  key: "cryptoalerts", name: "Crypto alerts and dates",
  cues: ["gas", "gwei", "wallet alerts", "incoming", "airdrop", "claim", "unlock", "funding", "perp", "polymarket", "prediction market", "odds"],
  what: "Alerts you set for crypto: gas under a level, activity on your wallets, perp funding above or below a rate, a perp moving a percent, a Polymarket market moving some points. And the dates you'd hate to miss: airdrop claim windows and token unlocks, with reminders a week before, the day before and on the day.",
  say: ["gas now", "tell me when ETH gas is under 5 gwei", "wallet alerts for 0x... on base", "alert me when BTC funding goes above 0.05%", "watch the market 'Will X happen'", "claim window for Jupiter closes 15 Dec", "my claims"],
  then: "Alerts you set come when they trigger, several in one message, and never in your quiet hours. Everything else waits for your morning note. Say \"stop gas alerts\" or \"stop watching ...\" to end any of them.",
  limits: "Read only: I never trade, sign or move funds. Claims and unlocks are the dates you give me; I don't scrape them.",
}, "Work, code and crypto");
