/**
 * Copy-trading, shadow mode only.
 *
 * What exists here: follow a wallet (Tier 2 — the standing rule and its caps
 * are echoed and confirmed once), watchers that log what copying would have
 * done, and a report. What does not exist, on purpose: execution. The research
 * is clear that execution belongs behind a TEE/MPC signer with caps enforced
 * in the signer, and every real loss in the ledger came from skipping that.
 * Promote a wallet from shadow to live only after a signer integration lands,
 * and only for your own dedicated wallet.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { onJob } from "../core/scheduler.js";
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import type { Db } from "../core/db.js";

// Polymarket blocks order placement from these; the watcher is read-only but we
// refuse to even shadow-follow for users whose stated country is blocked, so the
// product never grows an execution path for them. Keep in sync with docs.polymarket.com.
export const POLYMARKET_BLOCKED = new Set(["AU", "BE", "BY", "BI", "CF", "CD", "CU", "DE", "ET", "FR", "GB", "IR", "IQ", "IT", "KP", "LB", "LY", "MM", "NI", "PL", "RU", "SG", "SO", "SS", "SD", "SY", "TH", "TW", "UM", "US", "ES", "CA"]);

const follow = defineAction({
  name: "trading.follow_wallet",
  tier: 2,
  description: "Shadow-follow a trader's wallet on 'polymarket' or 'pumpfun': logs what copying would have returned, executes nothing. Caps are per-trade and per-day in USD (polymarket) or SOL (pumpfun). Confirmed once as a standing rule.",
  schema: z.object({
    venue: z.enum(["polymarket", "pumpfun"]),
    address: z.string().min(20),
    label: z.string().optional(),
    max_per_trade: z.number().positive(),
    max_per_day: z.number().positive(),
  }),
  echo: (a) => `Shadow-follow ${a.label ?? a.address.slice(0, 8)} on ${a.venue}: max ${a.max_per_trade}/trade, ${a.max_per_day}/day. Nothing executes.`,
  async run(args, ctx) {
    const country = String(ctx.user.prefs?.country ?? "").toUpperCase();
    if (args.venue === "polymarket" && country && POLYMARKET_BLOCKED.has(country)) {
      return { reply: `Polymarket blocks order placement from ${country}, so I won't set up a follow that could ever execute there.` };
    }
    if (args.max_per_day < args.max_per_trade) throw new Error("max_per_day must be ≥ max_per_trade");
    await ctx.db.query(
      `INSERT INTO followed_wallets (user_id, venue, address, label, max_per_trade, max_per_day, mode)
       VALUES ($1,$2,$3,$4,$5,$6,'shadow') ON CONFLICT (user_id, venue, address) DO UPDATE SET label=EXCLUDED.label, max_per_trade=EXCLUDED.max_per_trade, max_per_day=EXCLUDED.max_per_day, active=true`,
      [ctx.user.id, args.venue, args.address, args.label ?? null, args.max_per_trade, args.max_per_day],
    );
    const flag = args.venue === "polymarket" ? config.enablePolymarketShadow : config.enablePumpfunShadow;
    return { reply: `Following in shadow mode.${flag ? "" : ` (The ${args.venue} watcher is off on this server — set ENABLE_${args.venue.toUpperCase()}_SHADOW=true.)`} I'll report what copying would have done after two weeks; promote nothing before that.` };
  },
});

const unfollow = defineAction({
  name: "trading.unfollow",
  tier: 1,
  description: "Stop following a wallet by address or label.",
  schema: z.object({ match: z.string().min(1) }),
  async run(args, ctx) {
    const r = await ctx.db.query(`UPDATE followed_wallets SET active=false WHERE user_id=$1 AND active AND (address ILIKE $2 OR label ILIKE $2) RETURNING id`, [ctx.user.id, `%${args.match}%`]);
    return { reply: r.length ? "Unfollowed." : "No active follow matched." };
  },
});

const report = defineAction({
  name: "trading.shadow_report",
  tier: 1,
  description: "Show what the followed wallets did and the simulated copy result (counts, median latency, slippage proxy).",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<any>(
      `SELECT w.venue, COALESCE(w.label, left(w.address, 10)) AS who, w.mode, count(t.id)::int AS trades,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY t.latency_ms) AS p50_latency,
              avg(CASE WHEN t.our_price IS NOT NULL AND t.leader_price > 0 THEN (t.our_price - t.leader_price)/t.leader_price END) AS slip
       FROM followed_wallets w LEFT JOIN shadow_trades t ON t.wallet_id=w.id AND t.seen_at > now() - interval '14 days'
       WHERE w.user_id=$1 AND w.active GROUP BY w.id ORDER BY w.venue, who`,
      [ctx.user.id],
    );
    if (!rows.length) return { reply: "Not following any wallets." };
    return {
      reply: rows
        .map((r) => `${r.venue} ${r.who} [${r.mode}] — ${r.trades} trades/14d${r.p50_latency ? `, p50 latency ${Math.round(r.p50_latency)}ms` : ""}${r.slip != null ? `, slippage proxy ${(Number(r.slip) * 100).toFixed(2)}%` : ""}`)
        .join("\n") + "\n\nExecution isn't built; this is the evidence you'd use to decide whether it should be.",
    };
  },
});

const execute = defineAction({
  name: "trading.execute",
  tier: 3,
  description: "Place a trade chosen by the model. Never allowed: the bot does not pick trades, move funds, or hold keys.",
  schema: z.object({ anything: z.any().optional() }),
  async run() {
    return { reply: "" };
  },
});

register(follow, unfollow, report, execute);

/* ---------- watchers ---------- */

onJob("poll_polymarket", async (_job, deps) => {
  if (!config.enablePolymarketShadow) return;
  const wallets = await deps.db.query<{ id: number; address: string; max_per_trade: string }>(`SELECT id, address, max_per_trade FROM followed_wallets WHERE venue='polymarket' AND active`);
  for (const w of wallets) {
    try {
      const r = await fetch(`https://data-api.polymarket.com/activity?user=${w.address}&limit=25&type=TRADE`, { headers: { "user-agent": "lifeline-bot/0.1" } });
      if (!r.ok) throw new Error(String(r.status));
      const acts: any[] = await r.json();
      for (const a of acts) {
        const tx = a.transactionHash ?? a.id;
        const exists = await deps.db.one(`SELECT 1 FROM shadow_trades WHERE wallet_id=$1 AND leader_tx=$2`, [w.id, tx]);
        if (exists) continue;
        const ts = a.timestamp ? new Date(Number(a.timestamp) * 1000) : new Date();
        const size = Math.min(Number(w.max_per_trade), Number(a.usdcSize ?? a.size ?? 0));
        await deps.db.query(
          `INSERT INTO shadow_trades (wallet_id, venue, leader_tx, market, side, leader_price, our_price, size, latency_ms, seen_at, raw) VALUES ($1,'polymarket',$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [w.id, tx, a.title ?? a.slug ?? a.conditionId, `${a.side ?? ""} ${a.outcome ?? ""}`.trim(), a.price ?? null, a.price ?? null, size, Math.max(0, Date.now() - ts.getTime()), ts, JSON.stringify(a)],
        );
      }
    } catch (e: any) {
      log.warn({ wallet: w.address, err: e?.message }, "polymarket watcher failed");
    }
  }
});

/** pump.fun via PumpPortal websocket. One connection, resubscribed when the follow list changes. */
export function startPumpfunWatcher(db: Db) {
  if (!config.enablePumpfunShadow) return;
  let ws: any;
  let subscribed = new Set<string>();
  const connect = async () => {
    const { default: WebSocket } = await import("ws");
    const url = config.pumpportalKey ? `wss://pumpportal.fun/api/data?api-key=${config.pumpportalKey}` : "wss://pumpportal.fun/api/data";
    ws = new WebSocket(url);
    ws.on("open", () => { subscribed = new Set(); resync(); });
    ws.on("message", async (buf: Buffer) => {
      try {
        const m = JSON.parse(buf.toString());
        if (!m.traderPublicKey) return;
        const w = await db.one<{ id: number; max_per_trade: string }>(`SELECT id, max_per_trade FROM followed_wallets WHERE venue='pumpfun' AND active AND address=$1 LIMIT 1`, [m.traderPublicKey]);
        if (!w) return;
        const price = m.vSolInBondingCurve && m.vTokensInBondingCurve ? Number(m.vSolInBondingCurve) / Number(m.vTokensInBondingCurve) : null;
        await db.query(
          `INSERT INTO shadow_trades (wallet_id, venue, leader_tx, market, side, leader_price, our_price, size, latency_ms, raw) VALUES ($1,'pumpfun',$2,$3,$4,$5,$6,$7,$8,$9)`,
          [w.id, m.signature ?? null, m.mint ?? null, m.txType ?? null, price, price, Math.min(Number(w.max_per_trade), Number(m.solAmount ?? 0)), 0, JSON.stringify(m)],
        );
      } catch (e) { log.warn({ err: e }, "pumpfun message"); }
    });
    ws.on("close", () => setTimeout(connect, 5000));
    ws.on("error", (e: any) => log.warn({ err: e?.message }, "pumpfun ws"));
  };
  const resync = async () => {
    if (!ws || ws.readyState !== 1) return;
    const rows = await db.query<{ address: string }>(`SELECT address FROM followed_wallets WHERE venue='pumpfun' AND active`);
    const keys = rows.map((r) => r.address).filter((k) => !subscribed.has(k));
    if (keys.length) {
      ws.send(JSON.stringify({ method: "subscribeAccountTrade", keys }));
      keys.forEach((k) => subscribed.add(k));
    }
  };
  connect();
  setInterval(resync, 60_000);
}
