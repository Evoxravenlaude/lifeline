/**
 * Price / volatility alerts and a read-only portfolio. CoinGecko's public
 * endpoint needs no key at this volume; balances come from public RPCs.
 * Tier 1 throughout: information, no fund control.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { onJob, push } from "../core/scheduler.js";
import { log } from "../core/log.js";
import type { Db } from "../core/db.js";

const ALIAS: Record<string, string> = { btc: "bitcoin", eth: "ethereum", sol: "solana", bnb: "binancecoin", usdc: "usd-coin", usdt: "tether", matic: "polygon-ecosystem-token", pol: "polygon-ecosystem-token", arb: "arbitrum", op: "optimism", ton: "the-open-network", hype: "hyperliquid", bonk: "bonk", wif: "dogwifcoin", jup: "jupiter-exchange-solana" };
export const coinId = (s: string) => ALIAS[s.toLowerCase()] ?? s.toLowerCase();

const RPC: Record<string, { url: string; native: string; kind: "evm" | "sol" }> = {
  ethereum: { url: process.env.RPC_ETHEREUM ?? "https://ethereum-rpc.publicnode.com", native: "ethereum", kind: "evm" },
  base: { url: process.env.RPC_BASE ?? "https://base-rpc.publicnode.com", native: "ethereum", kind: "evm" },
  arbitrum: { url: process.env.RPC_ARBITRUM ?? "https://arbitrum-one-rpc.publicnode.com", native: "ethereum", kind: "evm" },
  polygon: { url: process.env.RPC_POLYGON ?? "https://polygon-bor-rpc.publicnode.com", native: "polygon-ecosystem-token", kind: "evm" },
  bsc: { url: process.env.RPC_BSC ?? "https://bsc-rpc.publicnode.com", native: "binancecoin", kind: "evm" },
  solana: { url: process.env.RPC_SOLANA ?? "https://api.mainnet-beta.solana.com", native: "solana", kind: "sol" },
};

export async function fetchPrices(ids: string[]): Promise<Record<string, number>> {
  if (!ids.length) return {};
  const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${[...new Set(ids)].join(",")}&vs_currencies=usd`, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  const j: any = await r.json();
  return Object.fromEntries(Object.entries(j).map(([k, v]: any) => [k, Number(v.usd)]));
}

async function nativeBalance(chain: string, address: string): Promise<number> {
  const c = RPC[chain];
  const body = c.kind === "evm"
    ? { jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [address, "latest"] }
    : { jsonrpc: "2.0", id: 1, method: "getBalance", params: [address] };
  const r = await fetch(c.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j: any = await r.json();
  if (j.error) throw new Error(j.error.message);
  return c.kind === "evm" ? Number(BigInt(j.result)) / 1e18 : Number(j.result.value) / 1e9;
}

const alert = defineAction({
  name: "price.alert",
  tier: 1,
  description: "Alert when a coin crosses a USD price ('eth above 4000', 'btc below 60000') or moves by a percent within a window ('eth moves 10% in 24h' is op 'move', target 10, pct_window 24). Leave target empty if the user gave no level; the bot will ask.",
  schema: z.object({ coin: z.string(), op: z.enum(["above", "below", "move"]), target: z.number().positive().optional(), pct_window: z.number().int().positive().max(168).optional() }),
  needs(args) {
    if (args.target === undefined) return { need: "target", question: args.op === "move" ? `How big a move in ${args.coin} should I watch for? A percent, like 10.` : `What level for ${args.coin}? A dollar price, like ${args.op === "above" ? "4000" : "3000"}.` };
    return null;
  },
  fill(need, answer) {
    if (need !== "target") return null;
    const m = /(\d[\d,]*(?:\.\d+)?)\s*(k|m)?/i.exec(answer);
    if (!m) return null;
    let n = Number(m[1].replace(/,/g, ""));
    if (m[2]?.toLowerCase() === "k") n *= 1000;
    if (m[2]?.toLowerCase() === "m") n *= 1_000_000;
    return n > 0 ? { target: n } : null;
  },
  async run(args, ctx) {
    const id = coinId(args.coin);
    const px = await fetchPrices([id]);
    if (px[id] === undefined) throw new Error(`I don't know a coin called "${args.coin}". Try its full name, or the CoinGecko id.`);
    const target = args.target!;
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO price_alerts (user_id, coin, op, target, pct_window) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.user.id, id, args.op, target, args.op === "move" ? args.pct_window ?? 24 : null]);
    const desc = args.op === "move" ? `moves ${target}% in ${args.pct_window ?? 24} hours` : `goes ${args.op} $${target.toLocaleString()}`;
    return { reply: `I'll tell you when ${id} ${desc}. It's $${px[id].toLocaleString()} right now.${args.op === "move" ? " This one keeps watching after it fires." : " It rings once, then it's done."}`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM price_alerts WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Alert dropped.";
  },
});

const price = defineAction({
  name: "price.check",
  tier: 1,
  description: "Current USD price of one or more coins.",
  schema: z.object({ coins: z.array(z.string()).min(1).max(10) }),
  async run(args) {
    const ids = args.coins.map(coinId);
    const px = await fetchPrices(ids);
    const lines = ids.map((i) => (px[i] !== undefined ? `${i} is $${px[i].toLocaleString()}` : `I don't know ${i}; try its full name`));
    return { reply: lines.length === 1 ? `${lines[0]}.` : lines.join("\n") };
  },
});

const walletAdd = defineAction({
  name: "wallet.add",
  tier: 1,
  description: `Add a public address to the read-only portfolio. Chains: ${Object.keys(RPC).join(", ")}. Never ask for private keys.`,
  schema: z.object({ chain: z.enum(Object.keys(RPC) as [string, ...string[]]), address: z.string().min(20), label: z.string().optional() }),
  async run(args, ctx) {
    if (/^[0-9a-f]{64}$/i.test(args.address) || args.address.split(" ").length >= 12) throw new Error("That looks like a private key or seed phrase, so I haven't kept it. I only take public addresses, and you should move whatever is on that one.");
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO wallets (user_id, chain, address, label) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, chain, address) DO UPDATE SET label=EXCLUDED.label RETURNING id`, [ctx.user.id, args.chain, args.address, args.label ?? null]);
    return { reply: `Watching ${args.label ?? args.address.slice(0, 8)} on ${args.chain}. Say "portfolio" any time for the balances.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM wallets WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Stopped watching that wallet.";
  },
});

const portfolio = defineAction({
  name: "portfolio",
  tier: 1,
  description: "Native-token balances and USD value across the user's watched wallets.",
  schema: z.object({}),
  async run(_a, ctx) {
    const ws = await ctx.db.query<{ chain: string; address: string; label: string | null }>(`SELECT chain, address, label FROM wallets WHERE user_id=$1 ORDER BY chain`, [ctx.user.id]);
    if (!ws.length) return { reply: "I'm not watching any wallets yet. Say \"watch wallet <address> on base\" (or ethereum, arbitrum, polygon, bsc, solana) and I'll keep an eye on it." };
    const px = await fetchPrices(ws.map((w) => RPC[w.chain].native));
    let total = 0;
    const lines: string[] = [];
    for (const w of ws) {
      try {
        const bal = await nativeBalance(w.chain, w.address);
        const usd = bal * (px[RPC[w.chain].native] ?? 0);
        total += usd;
        lines.push(`${w.label ?? w.address.slice(0, 8)} on ${w.chain}: ${bal.toFixed(4)}, about $${usd.toFixed(2)}`);
      } catch (e: any) {
        lines.push(`${w.label ?? w.address.slice(0, 8)} on ${w.chain}: couldn't reach the chain just now`);
      }
    }
    lines.push(`About $${total.toFixed(2)} in native coins all together. Tokens aren't counted yet.`);
    return { reply: lines.join("\n") };
  },
});

onJob("poll_prices", async (_job, deps) => {
  const alerts = await deps.db.query<any>(`SELECT a.*, u.telegram_id FROM price_alerts a JOIN users u ON u.id=a.user_id WHERE a.active`);
  if (!alerts.length) return;
  let px: Record<string, number>;
  try { px = await fetchPrices(alerts.map((a) => a.coin)); } catch (e: any) { log.warn({ err: e?.message }, "price poll"); return; }
  for (const [coin, usd] of Object.entries(px)) await deps.db.query(`INSERT INTO price_history (coin, usd) VALUES ($1,$2)`, [coin, usd]);
  await deps.db.query(`DELETE FROM price_history WHERE at < now() - interval '8 days'`);
  for (const a of alerts) {
    const now = px[a.coin];
    if (now === undefined) continue;
    let fire = false, msg = "";
    if (a.op === "above" && now >= Number(a.target)) { fire = true; msg = `${a.coin} just went above $${Number(a.target).toLocaleString()}. It's $${now.toLocaleString()} now.`; }
    if (a.op === "below" && now <= Number(a.target)) { fire = true; msg = `${a.coin} just dropped below $${Number(a.target).toLocaleString()}. It's $${now.toLocaleString()} now.`; }
    if (a.op === "move") {
      const past = await deps.db.one<{ usd: string }>(`SELECT usd FROM price_history WHERE coin=$1 AND at <= now() - ($2 || ' hours')::interval ORDER BY at DESC LIMIT 1`, [a.coin, String(a.pct_window)]);
      if (past) {
        const chg = ((now - Number(past.usd)) / Number(past.usd)) * 100;
        if (Math.abs(chg) >= Number(a.target)) { fire = true; msg = `${a.coin} is ${chg > 0 ? "up" : "down"} ${Math.abs(chg).toFixed(1)}% in the last ${a.pct_window} hours, now $${now.toLocaleString()}.`; }
      }
    }
    if (!fire) continue;
    const user = await deps.getUser(a.user_id);
    if (!user) continue;
    await push(deps, user, "reminder", msg, { exempt: true });
    // price-cross alerts fire once; move alerts re-arm after the window
    if (a.op === "move") await deps.db.query(`UPDATE price_alerts SET fired_at=now() WHERE id=$1`, [a.id]);
    else await deps.db.query(`UPDATE price_alerts SET active=false, fired_at=now() WHERE id=$1`, [a.id]);
  }
});

export async function ensurePriceJob(db: Db) {
  const exists = await db.one(`SELECT 1 FROM jobs WHERE kind='poll_prices' AND active`);
  if (!exists) await db.query(`INSERT INTO jobs (kind, run_at, cron, tz) VALUES ('poll_prices', now(), '*/5 * * * *', 'UTC')`);
}

register(alert, price, walletAdd, portfolio);
