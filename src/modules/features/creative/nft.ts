/**
 * NFT collectors: a mint log in plain words, sales and listings, floors and a rough P&L in the
 * token you paid in (never converted to money), mints spotted on wallets the person already
 * watches (offered, never added without a yes), and a mint-link check that hands off to the
 * safety area's scam check. Read only: nothing here signs, mints, lists or trades.
 *
 * Floors: OpenSea API v2 collection stats (OPENSEA_API_KEY) for EVM chains, Magic Eden's public
 * Solana collection stats. Cached for an hour, fetched a few at a time.
 */
import { z } from "zod";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema, addSystemJob } from "../../../core/plugins.js";
import { onJob, push, type SchedulerDeps } from "../../../core/scheduler.js";
import type { Db } from "../../../core/db.js";
import { log } from "../../../core/log.js";
import { EVM, isEvmHash, isSolSignature, rpc } from "../tech/shared.js";
import {
  addBriefItems, addCrButton, addDays, byName, daysTo, cacheGet, cachePut, cap, clean, COUNT, countOf, getJson, HttpError, inBatches, listWords, markPinged, num,
  parseDay, plural, refuseSecret, render, setPrefs, todayOf, wasPinged,
} from "./shared.js";
import { propose } from "../../../policy/engine.js";
import { CHAIN_FOR_TOKEN, NFT_CHAINS, NFT_CHAIN_WORDS, TOKEN_WORDS, chainLabel, ckeyOf, nftChain, tokenOf } from "./chains.js";
export { NFT_CHAINS, NFT_CHAIN_WORDS, TOKEN_WORDS, chainLabel, ckeyOf, nftChain, tokenOf };

addSchema(`CREATE TABLE IF NOT EXISTS crt_mints (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), collection TEXT NOT NULL, ckey TEXT NOT NULL, qty INT NOT NULL, sold INT NOT NULL DEFAULT 0, transferred INT NOT NULL DEFAULT 0, listed INT NOT NULL DEFAULT 0, list_price NUMERIC, list_token TEXT, price NUMERIC, token TEXT NOT NULL, chain TEXT NOT NULL, wallet TEXT, tx TEXT, token_ids TEXT, contract TEXT, proceeds NUMERIC NOT NULL DEFAULT 0, proceeds_token TEXT, minted_on DATE, created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS crt_mints_user ON crt_mints (user_id, ckey);
CREATE TABLE IF NOT EXISTS crt_slugs (user_id INT NOT NULL REFERENCES users(id), ckey TEXT NOT NULL, grp TEXT NOT NULL, slug TEXT, asked BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (user_id, ckey, grp));
CREATE TABLE IF NOT EXISTS crt_scan (user_id INT NOT NULL REFERENCES users(id), chain TEXT NOT NULL, address TEXT NOT NULL, last_block BIGINT, last_error TEXT, checked_at TIMESTAMPTZ, PRIMARY KEY (user_id, chain, address));
CREATE TABLE IF NOT EXISTS crt_offers (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), chain TEXT NOT NULL, address TEXT NOT NULL, wallet TEXT, contract TEXT NOT NULL, collection TEXT NOT NULL, qty INT NOT NULL, price NUMERIC, token TEXT NOT NULL, tx TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', pinged_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, chain, tx, contract))`);

/* ---------------- reading a mint sentence ---------------- */

export interface MintArgs { collection: string; quantity?: number; price?: number; total?: number; token?: string; chain?: string; wallet?: string; tx?: string; token_ids?: string[]; day?: string; free?: boolean }

/** "2 Pudgy Penguins at 0.05 ETH", "Chromie Squiggle #1234 on ethereum for 0.1", "3 Mad Lads on solana at 2 SOL each with wallet 2". */
export function parseMint(raw: string, free = false): MintArgs {
  let t = ` ${raw.trim().replace(/[.!]+$/, "")} `;
  const take = (re: RegExp) => { const m = re.exec(t); if (m) t = t.replace(m[0], " "); return m; };
  const tx = take(/\s(?:with\s+|in\s+)?(?:tx|txn|hash|transaction)?:?\s*(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})(?=\s)/i);
  const wallet = take(/\s(?:with|from|using|on|in|into|to)\s+(?:my\s+)?((?:wallet|vault)\s*[\w-]{1,20}|[\w-]{1,20}\s+(?:wallet|vault))(?=\s)/i);
  const price = take(new RegExp(`\\s(?:at|for|@|paid|price)\\s+(free|nothing|\\d*\\.?\\d+)\\s*(${TOKEN_WORDS})?\\b\\s*(each|apiece|a piece|per piece|per|total|in total|all in|altogether)?(?=\\s)`, "i"));
  const chain = take(new RegExp(`\\s(?:on|from|via)\\s+(?:the\\s+)?(${NFT_CHAIN_WORDS})(?:\\s+(?:chain|network|mainnet))?(?=\\s)`, "i"));
  const day = take(/\s(today|yesterday|last night|this morning|on\s+\d{1,2}\s+[a-z]{3,9}|on\s+[a-z]{3,9}\s+\d{1,2}|on\s+(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?)(?=\s)/i);
  const ids = [...t.matchAll(/#\s?(\d{1,9})/g)].map((m) => m[1]);
  t = t.replace(/#\s?\d{1,9}(?:\s*(?:,|and|&)\s*)?/g, " ");
  const q = new RegExp(`^\\s*${COUNT}\\s+(?:x\\s+)?(?:of\\s+)?`, "i").exec(t);
  if (q) t = t.slice(q[0].length);
  const name = t.replace(/\s+/g, " ").trim().replace(/^(?:of|from|the)\s+/i, "").replace(/\s+(?:nfts?|tokens?|pieces?|editions?)$/i, "").replace(/[,;]+$/, "").trim();
  const out: MintArgs = { collection: name || raw.trim() };
  const qty = countOf(q?.[1]);
  if (qty) out.quantity = qty;
  else if (ids.length > 1) out.quantity = ids.length;
  if (ids.length) out.token_ids = ids;
  if (price) {
    const v = /^(?:free|nothing)$/i.test(price[1]) ? 0 : Number(price[1]);
    const each = /each|apiece|piece|per/i.test(price[3] ?? "") || (!/total|all in|altogether/i.test(price[3] ?? "") && /^\s(?:at|@)/i.test(price[0]));
    if (each) out.price = v; else out.total = v;
    if (price[2]) out.token = price[2];
  }
  if (free) out.free = true;
  if (chain) out.chain = chain[1];
  if (wallet) out.wallet = wallet[1];
  if (tx) out.tx = tx[1];
  if (day) out.day = day[1].replace(/^on\s+/i, "");
  return out;
}

/** The day a mint happened: "yesterday", "on Monday" (the last one), "on 3 Oct"; never in the future. */
function pastDay(text: string | undefined, user: User, now: Date): string {
  const today = todayOf(user, now);
  if (!text || /^(?:today|this morning)$/i.test(text)) return today;
  if (/^(?:yesterday|last night)$/i.test(text)) return addDays(today, -1);
  const d = parseDay(text, user, now);
  if (!d || d <= today) return d ?? today;
  const back = addDays(d, -7);
  return daysTo(d, user, now) <= 7 && back <= today ? back : `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
}

/* ---------------- rows ---------------- */

interface MintRow { id: number; collection: string; ckey: string; qty: number; sold: number; transferred: number; listed: number; list_price: string | null; list_token: string | null; price: string | null; token: string; chain: string; wallet: string | null; tx: string | null; token_ids: string | null; contract: string | null; proceeds: string; proceeds_token: string | null; minted_on: string | null }
const held = (r: MintRow) => r.qty - r.sold - r.transferred;
const mintsOf = (db: Db, userId: number) => db.query<MintRow>(`SELECT *, to_char(minted_on, 'YYYY-MM-DD') AS minted_on FROM crt_mints WHERE user_id=$1 ORDER BY id`, [userId]);
/** The collections matching what someone typed, by key first, then by name. */
function matchRows(rows: MintRow[], typed: string): MintRow[] {
  const k = ckeyOf(typed);
  const exact = rows.filter((r) => r.ckey === k);
  if (exact.length) return exact;
  const loose = rows.filter((r) => r.ckey.endsWith(` ${k}`) || r.ckey.startsWith(`${k} `) || r.ckey.includes(k) || (k.includes(r.ckey) && r.ckey.length > 3));
  return loose.length ? loose : byName(rows, ["collection"], typed);
}
const distinctNames = (rows: MintRow[]) => [...new Set(rows.map((r) => r.collection))];

/* ---------------- 1. the mint log ---------------- */

const mintAdd = defineAction({
  name: "mint.add",
  tier: 1,
  description: "Log NFTs the person minted, for their own mint log: collection name, how many, price (each, or total), token (ETH, SOL...), chain, optional wallet label, tx hash and token ids. A free mint has price 0. Read only: never mints or signs anything.",
  schema: z.object({
    collection: z.string().min(1).max(120), quantity: z.number().int().min(1).max(100_000).optional(),
    price: z.number().min(0).optional(), total: z.number().min(0).optional(), token: z.string().max(10).optional(), chain: z.string().max(30).optional(),
    wallet: z.string().max(40).optional(), tx: z.string().max(100).optional(), token_ids: z.array(z.string().max(20)).max(50).optional(), day: z.string().max(40).optional(), free: z.boolean().optional(),
  }),
  async run(a, ctx) {
    const bad = refuseSecret(a.collection, a.wallet);
    if (bad) throw new Error(bad);
    const name = cap(clean(a.collection).replace(/\s+/g, " "));
    if (!name || name.length < 2) throw new Error("Which collection did you mint? Say it like \"minted 2 Pudgy Penguins at 0.05 ETH\".");
    const token = tokenOf(a.token);
    const chain = nftChain(a.chain) ?? (token ? CHAIN_FOR_TOKEN[token] : undefined) ?? "ethereum";
    const tok = token ?? NFT_CHAINS[chain]?.native ?? "ETH";
    const qty = a.quantity ?? (a.token_ids?.length || 1);
    const each = a.free ? 0 : a.price ?? (a.total !== undefined ? a.total / qty : null);
    const tx = a.tx && (isEvmHash(a.tx) || isSolSignature(a.tx)) ? a.tx : null;
    const mintedOn = pastDay(a.day, ctx.user, ctx.now);
    const r = await ctx.db.one<{ id: number }>(
      `INSERT INTO crt_mints (user_id, collection, ckey, qty, price, token, chain, wallet, tx, token_ids, minted_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [ctx.user.id, name, ckeyOf(name), qty, each, tok, chain, a.wallet ?? null, tx, a.token_ids?.length ? a.token_ids.join(",") : null, mintedOn],
    );
    const ids = a.token_ids?.length ? ` ${a.token_ids.map((i) => `#${i}`).join(", ")}` : "";
    const what = `${qty > 1 ? `${qty} ` : ""}${name}${ids}`;
    const cost = each === 0 ? "a free mint" : each === null ? "no price yet" : `${num(each)} ${tok}${qty > 1 ? " each" : ""}`;
    const from = a.wallet ? `, from ${a.wallet}` : "";
    const one = name.replace(/s$/, "");
    return {
      reply: `${what} on ${chainLabel(chain)}, ${cost}${from}. It's in your mints. Say "sold 1 ${one} for 0.2 ${tok}" when you sell, or "my mints" to see them all.`,
      undo: { payload: { id: r!.id } },
    };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM crt_mints WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Taken out of your mints.";
  },
});

const mintUpdate = defineAction({
  name: "mint.update",
  tier: 1,
  description: "Mark NFTs from the person's mint log as sold (with the price), listed (with the asking price), delisted, or transferred to another of their wallets. `price` is each, `total` is for all of them. Record only: never lists or sells anything.",
  schema: z.object({ collection: z.string().min(1).max(120), kind: z.enum(["sold", "listed", "delisted", "transferred"]), quantity: z.number().int().min(1).max(100_000).optional(), price: z.number().min(0).optional(), total: z.number().min(0).optional(), token: z.string().max(10).optional(), to: z.string().max(60).optional() }),
  async run(a, ctx) {
    const all = await mintsOf(ctx.db, ctx.user.id);
    const rows = matchRows(all.filter((r) => held(r) > 0), a.collection);
    if (!rows.length) {
      const gone = matchRows(all, a.collection);
      if (gone.length) throw new Error(`You don't hold any ${gone[0].collection} any more, by my log. Say "my mints" to check.`);
      throw new Error(`I don't have ${clean(a.collection)} in your mints. Log it first, like "minted 2 ${clean(a.collection)} at 0.05 ETH", or say "my mints" to see what's there.`);
    }
    const names = distinctNames(rows);
    if (names.length > 1) throw new Error(`Which one: ${listWords(names)}? Say it again with the full name.`);
    const before = rows.map((r) => ({ id: r.id, sold: r.sold, transferred: r.transferred, listed: r.listed, list_price: r.list_price, list_token: r.list_token, proceeds: r.proceeds, proceeds_token: r.proceeds_token }));
    const name = names[0];
    const have = rows.reduce((s, r) => s + held(r), 0);
    const n = Math.min(a.quantity ?? 1, have);
    const tok = tokenOf(a.token) ?? rows[0].token;
    const thing = (k: number) => (k === 1 ? name.replace(/s$/, "") : name);
    if (a.kind === "listed") {
      const each = a.price ?? (a.total !== undefined ? a.total / n : undefined);
      let left = n;
      for (const r of rows) { const k = Math.min(left, held(r)); left -= k; await ctx.db.query(`UPDATE crt_mints SET listed=$2, list_price=$3, list_token=$4 WHERE id=$1`, [r.id, k, each ?? null, tok]); }
      return { reply: `${n} ${thing(n)} listed${each !== undefined ? ` at ${num(each)} ${tok}${n > 1 ? " each" : ""}` : ""}. I only keep the note; the listing itself lives on the marketplace. Say "sold ${n === 1 ? "1" : n} ${thing(n)} for ..." when ${n === 1 ? "it goes" : "they go"}.`, undo: { payload: { before } } };
    }
    if (a.kind === "delisted") {
      for (const r of rows) await ctx.db.query(`UPDATE crt_mints SET listed=0, list_price=NULL, list_token=NULL WHERE id=$1`, [r.id]);
      return { reply: `${name}, no longer listed.`, undo: { payload: { before } } };
    }
    const each = a.kind === "sold" ? a.price ?? (a.total !== undefined ? a.total / n : 0) : 0;
    let left = n;
    let cost = 0, costKnown = true;
    for (const r of rows) {
      if (!left) break;
      const k = Math.min(left, held(r));
      if (!k) continue;
      left -= k;
      if (r.price === null) costKnown = false; else cost += k * Number(r.price);
      if (a.kind === "sold") await ctx.db.query(`UPDATE crt_mints SET sold=sold+$2, listed=GREATEST(0, listed-$2), proceeds=proceeds+$3, proceeds_token=COALESCE(proceeds_token,$4) WHERE id=$1`, [r.id, k, k * each, tok]);
      else await ctx.db.query(`UPDATE crt_mints SET transferred=transferred+$2, listed=GREATEST(0, listed-$2) WHERE id=$1`, [r.id, k]);
    }
    const still = have - n;
    const rest = still ? ` You still hold ${still}.` : ` That was your last ${name.replace(/s$/, "")}.`;
    if (a.kind === "transferred") return { reply: `${n} ${thing(n)} moved${a.to ? ` to ${a.to}` : " to another wallet"}. I count ${n === 1 ? "it" : "them"} as gone from this log, not sold.${rest}`, undo: { payload: { before } } };
    const got = each * n;
    const sameTok = tok === rows[0].token;
    const diff = got - cost;
    const pl = costKnown && sameTok && (a.price !== undefined || a.total !== undefined) ? ` That's ${diff >= 0 ? "about" : "a loss of about"} ${num(Math.abs(diff))} ${tok}${diff >= 0 ? " over what you paid" : " on what you paid"}, before fees.` : "";
    return { reply: `Sold ${n} ${thing(n)}${a.price !== undefined || a.total !== undefined ? ` for ${num(got)} ${tok}` : ""}.${pl}${rest}`, undo: { payload: { before } } };
  },
  async undo(p, ctx) {
    for (const b of p.before) await ctx.db.query(`UPDATE crt_mints SET sold=$2, transferred=$3, listed=$4, list_price=$5, list_token=$6, proceeds=$7, proceeds_token=$8 WHERE id=$1 AND user_id=$9`, [b.id, b.sold, b.transferred, b.listed, b.list_price, b.list_token, b.proceeds, b.proceeds_token, ctx.user.id]);
    return "Back how it was.";
  },
});

/* ---------------- floors ---------------- */

const HOUR = 3_600_000;
const OS = "https://api.opensea.io/api/v2";
const ME = "https://api-mainnet.magiceden.dev/v2";
const osKey = () => process.env.OPENSEA_API_KEY ?? "";
const meHeaders = (): Record<string, string> => (process.env.MAGICEDEN_API_KEY ? { authorization: `Bearer ${process.env.MAGICEDEN_API_KEY}` } : {});
interface Floor { floor: number | null; token: string }
type Got = Floor | null | "busy";

/** OpenSea collection stats: total.floor_price in total.floor_price_symbol. Null when there's no such collection. */
async function osStats(db: Db, slug: string, now: Date): Promise<Got> {
  const key = `os:stats:${slug}`;
  const c = await cacheGet(db, key, HOUR, now);
  if (c) return c.missing ? null : c;
  try {
    const j = await getJson<any>(`${OS}/collections/${encodeURIComponent(slug)}/stats`, { "x-api-key": osKey() });
    const f = Number(j?.total?.floor_price);
    const out: Floor = { floor: Number.isFinite(f) && f > 0 ? f : null, token: tokenOf(String(j?.total?.floor_price_symbol || "ETH")) ?? "ETH" };
    await cachePut(db, key, out, now);
    return out;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 400)) { await cachePut(db, key, { missing: true }, now); return null; }
    log.warn({ err: (e as Error).message }, "opensea stats failed");
    return "busy";
  }
}
/** Magic Eden's Solana collection stats: floorPrice in lamports. */
async function meStats(db: Db, symbol: string, now: Date): Promise<Got> {
  const key = `me:stats:${symbol}`;
  const c = await cacheGet(db, key, HOUR, now);
  if (c) return c.missing ? null : c;
  try {
    const j = await getJson<any>(`${ME}/collections/${encodeURIComponent(symbol)}/stats`, meHeaders());
    if (!j || (j.floorPrice === undefined && !j.symbol)) { await cachePut(db, key, { missing: true }, now); return null; }
    const f = Number(j.floorPrice) / 1e9;
    const out: Floor = { floor: Number.isFinite(f) && f > 0 ? f : null, token: "SOL" };
    await cachePut(db, key, out, now);
    return out;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 400)) { await cachePut(db, key, { missing: true }, now); return null; }
    log.warn({ err: (e as Error).message }, "magic eden stats failed");
    return "busy";
  }
}
/** The OpenSea collection slug behind a contract, when the mint came with one. */
async function osSlugForContract(db: Db, chain: string, address: string, now: Date): Promise<string | null> {
  const os = NFT_CHAINS[chain]?.os;
  if (!os) return null;
  const key = `os:contract:${os}:${address.toLowerCase()}`;
  const c = await cacheGet(db, key, 30 * 24 * HOUR, now);
  if (c) return c.slug ?? null;
  try {
    const j = await getJson<any>(`${OS}/chain/${os}/contract/${address}`, { "x-api-key": osKey() });
    const slug = typeof j?.collection === "string" ? j.collection : null;
    await cachePut(db, key, { slug }, now);
    return slug;
  } catch { return null; }
}
/** Likely slugs from a name: "pudgypenguins", "pudgy-penguins"; on Solana "mad_lads", "madlads". */
export function slugGuesses(name: string, solana: boolean): string[] {
  const w = name.toLowerCase().replace(/#\s?\d+/g, " ").replace(/[^a-z0-9\s-]/g, "").trim().split(/[\s-]+/).filter(Boolean);
  const out = solana ? [w.join("_"), w.join("")] : [w.join(""), w.join("-")];
  return [...new Set(out.filter((s) => s.length >= 2))];
}

type FloorState = { state: "ok"; floor: Floor } | { state: "nokey" } | { state: "unknown"; asked: boolean } | { state: "busy" } | { state: "none" };
interface Group { ckey: string; grp: "evm" | "solana"; name: string; chain: string; contract: string | null }

async function floorOf(db: Db, user: User, g: Group, now: Date): Promise<FloorState> {
  const ch = NFT_CHAINS[g.chain];
  if (!ch || (!ch.os && !ch.me)) return { state: "none" };
  if (g.grp === "evm" && !osKey()) return { state: "nokey" };
  const stats = (s: string) => (g.grp === "solana" ? meStats(db, s, now) : osStats(db, s, now));
  const saved = await db.one<{ slug: string | null; asked: boolean }>(`SELECT slug, asked FROM crt_slugs WHERE user_id=$1 AND ckey=$2 AND grp=$3`, [user.id, g.ckey, g.grp]);
  if (saved?.slug) {
    const f = await stats(saved.slug);
    if (f === "busy") return { state: "busy" };
    return f ? { state: "ok", floor: f } : { state: "unknown", asked: saved.asked };
  }
  if (saved) return { state: "unknown", asked: saved.asked };
  const tries: string[] = [];
  if (g.grp === "evm" && g.contract) { const s = await osSlugForContract(db, g.chain, g.contract, now); if (s) tries.push(s); }
  tries.push(...slugGuesses(g.name, g.grp === "solana"));
  for (const s of [...new Set(tries)].slice(0, 3)) {
    const f = await stats(s);
    if (f === "busy") return { state: "busy" };
    if (f) {
      await db.query(`INSERT INTO crt_slugs (user_id, ckey, grp, slug) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, ckey, grp) DO UPDATE SET slug=EXCLUDED.slug`, [user.id, g.ckey, g.grp, s]);
      return { state: "ok", floor: f };
    }
  }
  await db.query(`INSERT INTO crt_slugs (user_id, ckey, grp, slug) VALUES ($1,$2,$3,NULL) ON CONFLICT DO NOTHING`, [user.id, g.ckey, g.grp]);
  return { state: "unknown", asked: false };
}

/** Floors for the collections still held, a few at a time and at most `cap` of them per look. */
async function floorsFor(db: Db, user: User, rows: MintRow[], now: Date, max = 10): Promise<Map<string, FloorState>> {
  const groups = new Map<string, Group>();
  for (const r of rows) {
    if (held(r) <= 0) continue;
    const grp = r.chain === "solana" ? "solana" : "evm";
    const k = `${r.ckey}|${grp}`;
    if (!groups.has(k)) groups.set(k, { ckey: r.ckey, grp, name: r.collection, chain: r.chain, contract: r.contract });
  }
  const out = new Map<string, FloorState>();
  await inBatches([...groups.entries()].slice(0, max), 3, async ([k, g]) => { out.set(k, await floorOf(db, user, g, now)); });
  return out;
}
const gkey = (r: { ckey: string; chain: string }) => `${r.ckey}|${r.chain === "solana" ? "solana" : "evm"}`;

/* ---------------- my mints, my P&L ---------------- */

interface Agg { name: string; ckey: string; chain: string; qty: number; held: number; sold: number; transferred: number; listed: number; listPrice: number | null; listToken: string | null; prices: (number | null)[]; token: string; proceeds: number; proceedsToken: string | null; ids: string[] }
function aggregate(rows: MintRow[]): Agg[] {
  const m = new Map<string, Agg>();
  for (const r of rows) {
    const k = `${r.ckey}|${r.chain}|${r.token}`;
    const a = m.get(k) ?? { name: r.collection, ckey: r.ckey, chain: r.chain, qty: 0, held: 0, sold: 0, transferred: 0, listed: 0, listPrice: null, listToken: null, prices: [], token: r.token, proceeds: 0, proceedsToken: null, ids: [] };
    a.qty += r.qty; a.held += held(r); a.sold += r.sold; a.transferred += r.transferred; a.listed += r.listed;
    if (r.list_price !== null) { a.listPrice = Number(r.list_price); a.listToken = r.list_token; }
    for (let i = 0; i < r.qty; i++) a.prices.push(r.price === null ? null : Number(r.price));
    a.proceeds += Number(r.proceeds); a.proceedsToken ??= r.proceeds_token;
    if (r.token_ids) a.ids.push(...r.token_ids.split(","));
    m.set(k, a);
  }
  return [...m.values()];
}
const avg = (xs: (number | null)[]) => { const k = xs.filter((x): x is number => x !== null); return k.length === xs.length && k.length ? k.reduce((s, x) => s + x, 0) / k.length : null; };

/** The notes under the list: a missing key once, and one collection's slug, asked once and remembered. */
async function floorNotes(db: Db, user: User, aggs: Agg[], floors: Map<string, FloorState>): Promise<string[]> {
  const notes: string[] = [];
  if ([...floors.values()].some((f) => f.state === "nokey")) notes.push("Floors on Ethereum and the other EVM chains need an OpenSea key on this server, so those show what you paid only.");
  if ([...floors.values()].some((f) => f.state === "busy")) notes.push("The floor service was busy for some of them; ask again in a few minutes.");
  const ask = aggs.find((a) => { const f = floors.get(gkey(a)); return f?.state === "unknown" && !f.asked; });
  if (ask) {
    notes.push(`I couldn't find a floor for ${ask.name}. Send its OpenSea or Magic Eden link, like "${ask.name} is https://opensea.io/collection/...", and I'll remember it.`);
    await db.query(`UPDATE crt_slugs SET asked=true WHERE user_id=$1 AND ckey=$2 AND grp=$3`, [user.id, ask.ckey, ask.chain === "solana" ? "solana" : "evm"]);
  }
  return notes;
}

const mintList = defineAction({
  name: "mint.list",
  tier: 1,
  description: "Show the person's NFT mint log grouped by chain: each collection, how many are still held, what they cost, sales and listings, and the floor with a rough paper gain or loss when it's known.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await mintsOf(ctx.db, ctx.user.id);
    if (!rows.length) return { reply: "No mints logged yet. Say \"minted 2 Pudgy Penguins at 0.05 ETH\" or \"free mint of Base Day on base\" and I'll keep the tab." };
    const aggs = aggregate(rows);
    const floors = await floorsFor(ctx.db, ctx.user, rows, ctx.now);
    const chains = [...new Set(aggs.map((a) => a.chain))];
    const out: string[] = [];
    const heldTotal = aggs.reduce((s, a) => s + a.held, 0);
    out.push(`${plural(aggs.length, "collection")}, ${heldTotal} ${heldTotal === 1 ? "piece" : "pieces"} still held.`);
    for (const c of chains) {
      out.push("", `**${chainLabel(c)}**`);
      for (const a of aggs.filter((x) => x.chain === c)) {
        const ids = a.ids.length && a.ids.length <= 3 ? ` ${a.ids.map((i) => `#${i}`).join(", ")}` : "";
        const parts: string[] = [];
        parts.push(a.held === a.qty ? `${a.qty} held` : a.held === 0 ? `none held of ${a.qty}` : `${a.held} of ${a.qty} held`);
        const each = avg(a.prices);
        parts.push(a.prices.every((p) => p === 0) ? "free mint" : each === null ? "cost not logged" : `cost ${num(each)} ${a.token}${a.qty > 1 ? " each" : ""}`);
        if (a.sold) parts.push(`${a.sold} sold${a.proceeds ? ` for ${num(a.proceeds)} ${a.proceedsToken ?? a.token}` : ""}`);
        if (a.listed) parts.push(`${a.listed} listed${a.listPrice !== null ? ` at ${num(a.listPrice)} ${a.listToken ?? a.token}` : ""}`);
        if (a.transferred) parts.push(`${a.transferred} moved to another wallet`);
        const f = floors.get(gkey(a));
        if (a.held && f?.state === "ok" && f.floor.floor !== null) {
          parts.push(`floor ${num(f.floor.floor)} ${f.floor.token}`);
          if (each !== null && f.floor.token === a.token) {
            const d = a.held * (f.floor.floor - each);
            parts.push(`${d >= 0 ? "+" : "-"}${num(Math.abs(d))} ${a.token} on paper`);
          }
        } else if (a.held && f?.state === "ok") parts.push("no floor right now");
        out.push(`- ${a.name}${ids}: ${parts.join(", ")}`);
      }
    }
    const notes = await floorNotes(ctx.db, ctx.user, aggs, floors);
    if (notes.length) out.push("", ...notes);
    return { reply: out.join("\n") };
  },
});

const mintPnl = defineAction({
  name: "mint.pnl",
  tier: 1,
  description: "A rough NFT profit and loss from the person's mint log, totalled per token (ETH, SOL...): spent on mints, got back from sales, and what's still held at floor. Never converted to money.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await mintsOf(ctx.db, ctx.user.id);
    if (!rows.length) return { reply: "No mints logged yet, so nothing to total. Say \"minted 2 Pudgy Penguins at 0.05 ETH\" to start." };
    const floors = await floorsFor(ctx.db, ctx.user, rows, ctx.now);
    const by = new Map<string, { spent: number; back: number; heldVal: number; held: number; atCost: number; unknownCost: number }>();
    const bucket = (t: string) => { const b = by.get(t) ?? { spent: 0, back: 0, heldVal: 0, held: 0, atCost: 0, unknownCost: 0 }; by.set(t, b); return b; };
    for (const r of rows) {
      const b = bucket(r.token);
      if (r.price === null) b.unknownCost += r.qty; else b.spent += r.qty * Number(r.price);
      if (Number(r.proceeds)) bucket(r.proceeds_token ?? r.token).back += Number(r.proceeds);
      const h = held(r);
      if (!h) continue;
      b.held += h;
      const f = floors.get(gkey(r));
      if (f?.state === "ok" && f.floor.floor !== null && f.floor.token === r.token) b.heldVal += h * f.floor.floor;
      else if (r.price !== null) { b.heldVal += h * Number(r.price); b.atCost += h; }
    }
    const lines = [...by].map(([t, b]) => {
      const pl = b.back + b.heldVal - b.spent;
      const bits = [`spent ${num(b.spent)}`, ...(b.back ? [`sold for ${num(b.back)}`] : []), ...(b.held ? [`${b.held} held worth about ${num(b.heldVal)}`] : [])];
      return `- ${t}: ${bits.join(", ")}. Rough P&L ${pl >= 0 ? "+" : "-"}${num(Math.abs(pl))} ${t}.`;
    });
    const atCost = [...by.values()].some((b) => b.atCost), unknown = [...by.values()].some((b) => b.unknownCost);
    const tail = ["Gas and marketplace fees aren't counted, and a floor is a rough guide, not a sale price."];
    if (atCost) tail.push("Pieces with no floor are counted at what you paid.");
    if (unknown) tail.push("Mints with no price logged are left out of what you spent.");
    if ([...floors.values()].some((f) => f.state === "nokey")) tail.push("EVM floors need an OpenSea key on this server.");
    return { reply: [`Your NFT P&L, in the tokens you paid with:`, ...lines, "", tail.join(" ")].join("\n") };
  },
});

const mintSlug = defineAction({
  name: "mint.slug",
  tier: 1,
  description: "Tell lifeline which marketplace collection a logged mint is, so its floor can be read: an OpenSea collection link or slug (EVM chains) or a Magic Eden link or symbol (Solana). Remembered for next time.",
  schema: z.object({ collection: z.string().min(1).max(120), slug: z.string().min(2).max(200) }),
  async run(a, ctx) {
    const s = a.slug.trim();
    const os = /opensea\.io\/collection\/([\w-]+)/i.exec(s)?.[1];
    const me = /magiceden\.(?:io|us)\/(?:marketplace|collections\/\w+)\/([\w-]+)/i.exec(s)?.[1];
    const meChain = /magiceden\.(?:io|us)\/collections\/(\w+)\//i.exec(s)?.[1]?.toLowerCase();
    const slug = os ?? me ?? (/^[\w-]{2,100}$/.test(s) ? s : null);
    if (!slug) throw new Error("That doesn't look like a collection link. Send the OpenSea link (opensea.io/collection/...) or the Magic Eden one.");
    const rows = matchRows(await mintsOf(ctx.db, ctx.user.id), a.collection);
    const ck = rows[0]?.ckey ?? ckeyOf(a.collection);
    const grp = me && (!meChain || meChain === "solana") ? "solana" : os ? "evm" : rows[0]?.chain === "solana" ? "solana" : "evm";
    await ctx.db.query(`INSERT INTO crt_slugs (user_id, ckey, grp, slug, asked) VALUES ($1,$2,$3,$4,true) ON CONFLICT (user_id, ckey, grp) DO UPDATE SET slug=EXCLUDED.slug, asked=true`, [ctx.user.id, ck, grp, slug]);
    const name = rows[0]?.collection ?? cap(clean(a.collection));
    return { reply: `${name} is \`${slug}\` on ${grp === "solana" ? "Magic Eden" : "OpenSea"}. I'll read its floor from there.` };
  },
});

/* ---------------- 2. mints spotted on watched wallets ---------------- */

const ZERO = "0x0000000000000000000000000000000000000000";
const ethKey = () => process.env.ETHERSCAN_API_KEY ?? "";
interface Watched { user_id: number; chain: string; address: string; label: string | null }

/** Wallets the person already watches (the core `wallets` table and tech_wallets), read only. EVM chains Etherscan covers. */
async function watched(db: Db): Promise<Watched[]> {
  let rows: Watched[];
  try {
    rows = await db.query<Watched>(`SELECT user_id, chain, address, label FROM wallets UNION ALL SELECT user_id, chain, address, label FROM tech_wallets`);
  } catch {
    rows = await db.query<Watched>(`SELECT user_id, chain, address, label FROM wallets`);
  }
  const seen = new Set<string>();
  return rows.filter((w) => {
    const k = `${w.user_id}|${w.chain}|${w.address.toLowerCase()}`;
    if (seen.has(k) || !EVM[w.chain] || !/^0x[0-9a-fA-F]{40}$/.test(w.address)) return false;
    seen.add(k);
    return true;
  });
}

async function etherscan(chainId: number, action: string, address: string, start: number, sort: "asc" | "desc"): Promise<any[]> {
  const j = await getJson<any>(`https://api.etherscan.io/v2/api?chainid=${chainId}&module=account&action=${action}&address=${address}&startblock=${start}&endblock=99999999&page=1&offset=100&sort=${sort}&apikey=${ethKey()}`);
  if (j?.status === "1" && Array.isArray(j.result)) return j.result;
  if (/no transactions found/i.test(String(j?.message)) || (Array.isArray(j?.result) && !j.result.length)) return [];
  throw new Error(`etherscan: ${typeof j?.result === "string" ? j.result : j?.message ?? "error"}`);
}

/** One pass: new ERC-721 and ERC-1155 transfers from the zero address to each watched wallet become offers. */
export async function scanMints(deps: SchedulerDeps, now = new Date()): Promise<void> {
  if (!ethKey()) return;
  const off = new Set((await deps.db.query<{ id: number }>(`SELECT id FROM users WHERE prefs->>'crtDetect' = 'false'`)).map((u) => u.id));
  const list = (await watched(deps.db)).filter((w) => !off.has(w.user_id));
  if (!list.length) return;
  const state = new Map((await deps.db.query<any>(`SELECT * FROM crt_scan`)).map((s) => [`${s.user_id}|${s.chain}|${String(s.address).toLowerCase()}`, s]));
  const k = (w: Watched) => `${w.user_id}|${w.chain}|${w.address.toLowerCase()}`;
  const order = list.sort((a, b) => new Date(state.get(k(a))?.checked_at ?? 0).getTime() - new Date(state.get(k(b))?.checked_at ?? 0).getTime()).slice(0, 20);
  const touched = new Set<number>();
  // Etherscan's free plan allows a few calls a second, so wallets go one at a time.
  for (const w of order) {
    const s = state.get(k(w));
    const c = EVM[w.chain];
    const me = w.address.toLowerCase();
    try {
      const start = s?.last_block != null ? Number(s.last_block) + 1 : 0;
      const sort = s ? "asc" : "desc";
      const [a721, a1155] = [await etherscan(c.id, "tokennfttx", w.address, start, sort), await etherscan(c.id, "token1155tx", w.address, start, sort)];
      const all = [...a721.map((t) => ({ ...t, n: 1 })), ...a1155.map((t) => ({ ...t, n: Math.max(1, Number(t.tokenValue ?? 1)) }))];
      const maxBlock = Math.max(Number(s?.last_block ?? 0), ...all.map((t) => Number(t.blockNumber) || 0));
      if (s) {
        const groups = new Map<string, { tx: string; contract: string; name: string; qty: number }>();
        for (const t of all) {
          if (String(t.from).toLowerCase() !== ZERO || String(t.to).toLowerCase() !== me) continue;
          const g = `${t.hash}|${String(t.contractAddress).toLowerCase()}`;
          const cur = groups.get(g) ?? { tx: t.hash, contract: String(t.contractAddress).toLowerCase(), name: String(t.tokenName || t.tokenSymbol || "an NFT collection"), qty: 0 };
          cur.qty += t.n;
          groups.set(g, cur);
        }
        const perTx = new Map<string, number>();
        for (const g of groups.values()) perTx.set(g.tx, (perTx.get(g.tx) ?? 0) + g.qty);
        for (const g of groups.values()) {
          const known = await deps.db.one(`SELECT 1 FROM crt_mints WHERE user_id=$1 AND lower(tx)=lower($2) UNION ALL SELECT 1 FROM crt_offers WHERE user_id=$1 AND chain=$3 AND lower(tx)=lower($2) AND contract=$4 LIMIT 1`, [w.user_id, g.tx, w.chain, g.contract]);
          if (known) continue;
          let price: number | null = null;
          try {
            const tx = await rpc<any>(c.rpc, "eth_getTransactionByHash", [g.tx]);
            if (tx?.value !== undefined) price = Number(BigInt(tx.value)) / 1e18 / (perTx.get(g.tx) ?? g.qty);
          } catch { /* the price stays unknown */ }
          await deps.db.query(`INSERT INTO crt_offers (user_id, chain, address, wallet, contract, collection, qty, price, token, tx, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`, [w.user_id, w.chain, w.address, w.label, g.contract, g.name, g.qty, price, c.native, g.tx, now]);
          touched.add(w.user_id);
        }
      }
      await deps.db.query(`INSERT INTO crt_scan (user_id, chain, address, last_block, last_error, checked_at) VALUES ($1,$2,$3,$4,NULL,$5) ON CONFLICT (user_id, chain, address) DO UPDATE SET last_block=EXCLUDED.last_block, last_error=NULL, checked_at=EXCLUDED.checked_at`, [w.user_id, w.chain, w.address, maxBlock, now]);
    } catch (e) {
      const err = (e as Error).message.slice(0, 200);
      log.warn({ chain: w.chain, err }, "mint scan failed");
      // A first look that failed sets no baseline, so the next good look doesn't offer old history as new.
      if (s) await deps.db.query(`UPDATE crt_scan SET last_error=$4, checked_at=$5 WHERE user_id=$1 AND chain=$2 AND address=$3`, [w.user_id, w.chain, w.address, err, now]);
    }
  }
  for (const uid of touched) { const u = await deps.getUser(uid); if (u) await offerPing(deps, u, now); }
}

interface Offer { id: number; chain: string; collection: string; qty: number; price: string | null; token: string; wallet: string | null; tx: string; contract: string; pinged_at: string | null }
const openOffers = (db: Db, userId: number) => db.query<Offer>(`SELECT * FROM crt_offers WHERE user_id=$1 AND status='open' ORDER BY id LIMIT 6`, [userId]);
const offerWords = (o: Offer[]) => listWords(o.map((x) => `${x.qty} from ${x.collection} on ${chainLabel(x.chain)}`));
const DETECT_STOP = `Say "stop mint detection" to stop these.`;

/** One merged line, at most once a day; anything that can't go out waits in the brief. */
export async function offerPing(deps: SchedulerDeps, user: User, now: Date): Promise<boolean> {
  const fresh = (await openOffers(deps.db, user.id)).filter((o) => !o.pinged_at);
  if (!fresh.length) return false;
  const day = todayOf(user, now);
  if (await wasPinged(deps.db, user.id, `offers:${day}`)) return false;
  const ids = fresh.map((o) => o.id).join(".");
  const text = `Looks like you minted ${offerWords(fresh)}. ${fresh.length === 1 ? "Add to your mints?" : "Add them to your mints?"} ${DETECT_STOP}`;
  const ok = await push(deps, user, "creative", text, { buttons: [{ label: "Yes, add", data: `cr:of:y:${ids}` }, { label: "No", data: `cr:of:n:${ids}` }], now });
  if (!ok) return false;
  await deps.db.query(`UPDATE crt_offers SET pinged_at=$2 WHERE id = ANY($1::int[])`, [fresh.map((o) => o.id), now]);
  await markPinged(deps.db, user.id, [`offers:${day}`]);
  return true;
}

async function answerOffers(db: Db, user: User, yes: boolean, ids: number[] | null): Promise<string> {
  const rows = ids
    ? await db.query<Offer>(`SELECT * FROM crt_offers WHERE user_id=$1 AND status='open' AND id = ANY($2::int[]) ORDER BY id`, [user.id, ids])
    : await db.query<Offer>(`SELECT * FROM crt_offers WHERE user_id=$1 AND status='open' ORDER BY id`, [user.id]);
  if (!rows.length) return "Nothing waiting there any more. Say \"my mints\" to see your log.";
  if (!yes) {
    await db.query(`UPDATE crt_offers SET status='dismissed' WHERE id = ANY($1::int[])`, [rows.map((r) => r.id)]);
    return "Left out. I won't ask about those again.";
  }
  for (const o of rows) {
    await db.query(`INSERT INTO crt_mints (user_id, collection, ckey, qty, price, token, chain, wallet, tx, contract, minted_on) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [user.id, o.collection, ckeyOf(o.collection), o.qty, o.price, o.token, o.chain, o.wallet, o.tx, o.contract, todayOf(user, new Date())]);
  }
  await db.query(`UPDATE crt_offers SET status='added' WHERE id = ANY($1::int[])`, [rows.map((r) => r.id)]);
  const priced = rows.every((o) => o.price !== null);
  return `Added ${offerWords(rows)} to your mints.${priced ? "" : " I couldn't read what one of them cost; log it again with the price if you want it in your P&L."}`;
}

addCrButton("of", async (ctx, [yn, ids]) => ({ text: await answerOffers(ctx.db, ctx.user, yn === "y", (ids ?? "").split(".").map(Number).filter(Boolean)) }));

const mintDetected = defineAction({
  name: "mint.detected",
  tier: 1,
  description: "Answer the mints lifeline spotted on the person's watched wallets: add them all to the mint log (accept true) or ignore them (accept false).",
  schema: z.object({ accept: z.boolean() }),
  async run(a, ctx) { return { reply: await answerOffers(ctx.db, ctx.user, a.accept, null) }; },
});

const mintDetect = defineAction({
  name: "mint.detect",
  tier: 1,
  description: "Turn mint spotting on or off: lifeline watches the wallets the person already follows for new NFT mints (EVM chains, through Etherscan) and asks before adding any.",
  schema: z.object({ on: z.boolean() }),
  async run(a, ctx) {
    const prev = ctx.user.prefs.crtDetect;
    await setPrefs(ctx.db, ctx.user, { crtDetect: a.on });
    if (!a.on) return { reply: "Mint spotting is off. Your mint log stays as it is. Say \"turn on mint detection\" to bring it back.", undo: { payload: { prev } } };
    const n = (await watched(ctx.db)).filter((w) => w.user_id === ctx.user.id).length;
    const how = !ethKey() ? " It reads mints through Etherscan, and this server doesn't have an Etherscan key yet, so it starts once it does." : n ? "" : " You don't have a wallet I'm watching yet; say \"watch wallet 0x... on base\" first.";
    return { reply: `Mint spotting is on. When a wallet you watch receives a fresh mint, I'll ask once before adding it, at most once a day.${how} Say "stop mint detection" to end it.`, undo: { payload: { prev } } };
  },
  async undo(p, ctx) { await setPrefs(ctx.db, ctx.user, { crtDetect: p.prev ?? null }); return "Back how it was."; },
});

/* ---------------- 4. safe by design ---------------- */

const MINT_TIPS = "For any mint: use only the link from the project's own verified account, read the domain letter by letter, and never sign a \"setApprovalForAll\" or a message you don't understand. A real mint never needs your seed phrase. I can't mint or sign for you; that always happens in your own wallet.";

const mintCheck = defineAction({
  name: "mint.checklink",
  tier: 1,
  description: "Check a mint, claim or drop link before connecting a wallet: runs the safety scam check on the link and adds plain mint safety advice. Never connects, signs or mints.",
  schema: z.object({ url: z.string().min(4).max(500) }),
  async run(a, ctx) {
    const d = await propose(ctx, "scam.check", { text: a.url });
    const r = await render(ctx, d);
    return { reply: `${r.text}\n\n${MINT_TIPS}`, buttons: r.buttons?.filter((b) => !/^undo:/.test(b.data)) };
  },
});

const secret = defineAction({
  name: "nft.secret",
  tier: 1,
  description: "Someone sent or offered their seed phrase, recovery phrase or private key: refuse plainly, keep nothing, and tell them to move funds if it was real.",
  schema: z.object({}),
  async run() {
    return { reply: "Please don't send that. A seed phrase or private key is the whole wallet, so I never take or keep one, and nobody genuine will ever ask for it. If you've shared it anywhere, move everything to a fresh wallet now. For your mints I only need names, prices and public addresses." };
  },
});

register(mintAdd, mintUpdate, mintList, mintPnl, mintSlug, mintDetected, mintDetect, mintCheck, secret);

onJob("crt_mintscan", async (_job, deps) => { await scanMints(deps, new Date()); });
addSystemJob("crt_mintscan", "13,43 * * * *");

/** Mints waiting for a yes, in the brief. */
addBriefItems(async (db, user) => {
  const o = await openOffers(db, user.id);
  return o.length ? [{ p: 30, text: `Possible new mints: ${offerWords(o)}. Say "add the detected mints" or "ignore the detected mints"` }] : [];
});

/* ---------------- words ---------------- */

const PRICE = `((?:\\d*\\.\\d+)|(?:\\d+(?=\\s*(?:${TOKEN_WORDS})\\b)))\\s*(${TOKEN_WORDS})?\\s*(each|apiece|total|in total)?`;
const toUpd = (kind: string, m: RegExpMatchArray) => {
  const n = countOf(m[1]);
  const v = Number(m[3]);
  const each = /each|apiece/i.test(m[5] ?? "") || (!/total/i.test(m[5] ?? "") && kind === "listed");
  return { action: "mint.update", args: { collection: m[2], kind, ...(n ? { quantity: n } : {}), ...(each ? { price: v } : { total: v }), ...(m[4] ? { token: m[4] } : {}) } };
};
const WHO = `(?:(${COUNT.slice(1, -1)})\\s+(?:of\\s+)?(?:my\\s+)?|my\\s+)?`;
/** Everyday things people sell, list or send that are not NFTs. */
const NOT_NFT = /\b(?:laptop|phone|iphone|car|house|flat|apartment|land|shares?|stocks?|bike|motorbike|tv|clothes|shoes|sneakers|tickets?|money|cash|funds|savings|salary|rent|furniture|couch|sofa|gold|dollars|naira|euros|pounds|usdc|usdt|eth|sol|btc|crypto|tokens?|coins?)\b/i;
/** A sale or listing reads as an NFT when it names a crypto price or a token number, and isn't one of those everyday things. */
const nftSale = (m: RegExpMatchArray, kind: string) => {
  if (NOT_NFT.test(m[2] ?? "")) return null;
  // No token named: still an NFT when it has a token number, or the price reads like one (a small decimal, "0.5").
  if (!m[4] && !/#\s?\d/.test(m[2] ?? "") && !(/\./.test(m[3] ?? "") && Number(m[3]) < 50)) return null;
  return toUpd(kind, m);
};
addRules(
  [/^(?:here'?s\s+|this is\s+)?my\s+(?:wallet'?s?\s+)?(?:seed(?: phrase)?|recovery phrase|secret (?:recovery )?phrase|mnemonic|private key)\s*(?:is|are|:|=)\s*(?!(?:in|on|at|inside|under|with|kept|stored|written|saved|safe|somewhere|offline)\b)\S[\s\S]*$/i, () => ({ action: "nft.secret", args: {} })],
  [/^(?:i\s+)?(?:just\s+)?minted\s+(?!(?:it|that|this|one|them|something|nothing|anything)\b\s*$)(.{2,})$/i, (m) => ({ action: "mint.add", args: { ...parseMint(m[1]) } })],
  [/^(?:i\s+)?(?:just\s+)?(?:got\s+|did\s+|claimed\s+|grabbed\s+)?(?:a\s+|the\s+)?free\s+mint(?:ed)?\s+(?:of|for|from)?\s*(.{2,})$/i, (m) => ({ action: "mint.add", args: { ...parseMint(m[1], true) } })],
  [new RegExp(`^(?:i\\s+)?(?:just\\s+)?sold\\s+${WHO}(.+?)\\s+(?:for|at)\\s+${PRICE}$`, "i"), (m) => nftSale(m, "sold")],
  [new RegExp(`^(?:i\\s+)?(?:just\\s+)?listed\\s+${WHO}(.+?)\\s+(?:for|at)\\s+${PRICE}$`, "i"), (m) => nftSale(m, "listed")],
  [/^(?:i\s+)?(?:just\s+)?(?:delisted|unlisted|cancelled the listing for|took down the listing for)\s+(?:my\s+)?(.+)$/i, (m) => ({ action: "mint.update", args: { collection: m[1], kind: "delisted" } })],
  [new RegExp(`^(?:i\\s+)?(?:just\\s+)?(?:transferred|moved|sent)\\s+(?![$€£₦¥₹]?[\\d,.]+\\s*k?\\s*(?:[a-z]{2,8}\\s+)?to\\s)${WHO}(.+?)\\s+to\\s+(?:my\\s+|a\\s+|another\\s+|the\\s+)?((?:[\\w-]+\\s+)?(?:wallet|vault|ledger|trezor|cold storage|hardware wallet)(?:\\s*[\\w-]+)?)$`, "i"), (m) => { if (NOT_NFT.test(m[2] ?? "")) return null; const n = countOf(m[1]); return { action: "mint.update", args: { collection: m[2], kind: "transferred", ...(n ? { quantity: n } : {}), to: m[3] } }; }],
  [/^(?:my|show my|show me my|list my)\s+(?:nft\s+)?(?:mints|mint log|nfts|nft collection)$|^what (?:have i|did i) mint(?:ed)?$|^mints$/i, () => ({ action: "mint.list", args: {} })],
  [/^(?:my\s+)?(?:nft|nfts|mint|mints)\s+(?:p\s*&\s*l|pnl|p\/l|profits?(?: and loss)?|returns|gains)\??$|^how (?:are|is) my (?:nfts|mints) doing\??$/i, () => ({ action: "mint.pnl", args: {} })],
  [/^(.+?)\s+is\s+(https?:\/\/(?:www\.)?(?:opensea\.io\/collection\/[\w-]+|magiceden\.(?:io|us)\/(?:marketplace|collections\/\w+)\/[\w-]+)\S*)$/i, (m) => ({ action: "mint.slug", args: { collection: m[1], slug: m[2] } })],
  [/^(?:the\s+)?(?:opensea\s+|magic eden\s+|collection\s+)?(?:slug|symbol)\s+(?:for|of)\s+(.+?)\s+is\s+([\w-]{2,80})$/i, (m) => ({ action: "mint.slug", args: { collection: m[1], slug: m[2] } })],
  [/^(?:yes,?\s+)?(?:add|keep|log)\s+(?:the|my|those|these)\s+(?:detected|found|new|spotted)\s+mints$/i, () => ({ action: "mint.detected", args: { accept: true } })],
  [/^(?:ignore|skip|dismiss|no to)\s+(?:the|my|those|these)\s+(?:detected|found|new|spotted)\s+mints$/i, () => ({ action: "mint.detected", args: { accept: false } })],
  [/^(?:stop|turn off|no more|pause)\s+(?:the\s+)?mint\s+(?:detection|detecting|offers|spotting)$/i, () => ({ action: "mint.detect", args: { on: false } })],
  [/^(?:turn on|start|resume)\s+(?:the\s+)?mint\s+(?:detection|spotting)$|^(?:detect|spot)\s+my\s+(?:new\s+)?mints$|^watch my wallets for (?:new )?mints$/i, () => ({ action: "mint.detect", args: { on: true } })],
  [/^(?:check|scan|is)\s+(?:this|the|my|that)\s+(?:mint|minting|drop|claim|allowlist|whitelist)\s+(?:link|site|page|url|website)(?:\s+(?:safe|legit|real))?[\s:,-]+(https?:\/\/\S+|\S+\.\S+?)\??$/i, (m) => ({ action: "mint.checklink", args: { url: m[1] } })],
  [/^is\s+(https?:\/\/\S+|\S+\.\S+)\s+(?:a\s+)?(?:legit|safe|real|the real|the official)\s+(?:mint|drop|claim)(?:\s+(?:link|site|page))?\??$/i, (m) => ({ action: "mint.checklink", args: { url: m[1] } })],
);

addExamples("mint.add", ["minted 2 Pudgy Penguins at 0.05 ETH", "minted Chromie Squiggle #1234 on ethereum for 0.1", "free mint of Base Day on base", "minted 3 Mad Lads on solana at 2 SOL", "I just minted 5 Lagos Nights Passes on base for 0.01 with wallet 2"]);
addExamples("mint.update", ["sold 1 Pudgy Penguin for 0.2 ETH", "listed 2 Squiggles at 0.5", "sold 2 Mad Lads at 45 SOL each", "transferred 1 Pudgy Penguin to my vault", "delisted my Squiggles"]);
addExamples("mint.list", ["my mints", "my nfts", "what have I minted"]);
addExamples("mint.pnl", ["my nft pnl", "nft p&l", "how are my mints doing"]);
addExamples("mint.slug", ["Chromie Squiggle is https://opensea.io/collection/chromie-squiggle-by-snowfro", "slug for Mad Lads is mad_lads"]);
addExamples("mint.detected", ["add the detected mints", "ignore the detected mints"]);
addExamples("mint.detect", ["stop mint detection", "turn on mint detection", "watch my wallets for mints"]);
addExamples("mint.checklink", ["check this mint link https://azuki-elementals-claim.xyz/mint", "is https://base-day-mint.app the real mint?"]);
addExamples("nft.secret", ["my seed phrase is apple river stone cloud house tiger lemon paper glass night ocean bread"]);

addCues("mint", ["minted", "mint", "mints", "nft", "nfts", "floor", "floor price", "collection", "opensea", "magic eden", "sold", "listed", "pnl", "p&l", "pudgy", "squiggle", "free mint"]);
addCues("nft", ["seed phrase", "private key", "recovery phrase", "mnemonic"]);

addCapability({
  key: "nftmints", name: "Your NFT mints",
  cues: ["mint", "minted", "nft", "nfts", "floor", "p&l", "pnl", "opensea", "magic eden", "my mints", "collection"],
  what: "Tell me what you mint and I keep the tab: how many, what you paid and on which chain, then sales, listings and transfers. \"My mints\" shows it by chain with floors where I can read them (OpenSea for EVM chains, Magic Eden for Solana), and \"my nft pnl\" totals it in ETH, SOL and the rest, never in money. If you watch a wallet, I spot fresh mints on it and ask before adding them.",
  say: ["minted 2 Pudgy Penguins at 0.05 ETH", "minted 3 Mad Lads on solana at 2 SOL", "free mint of Base Day on base", "sold 1 Pudgy Penguin for 0.2 ETH", "my mints", "my nft pnl", "check this mint link https://..."],
  then: "Floors are cached for an hour and are a rough guide, not a sale price. Gas isn't counted.",
  limits: "Read only. I never mint, sign, list or trade, and I never ask for or keep a seed phrase or private key.",
}, "Creative and NFTs");

/** For tests and the brief: everything a person holds, by collection. */
export async function heldBy(db: Db, user: User): Promise<{ name: string; held: number }[]> {
  return aggregate(await mintsOf(db, user.id)).map((a) => ({ name: a.name, held: a.held }));
}
