/**
 * Read-only crypto helpers: gas and fees, wallet activity alerts, a plain-words transaction explainer,
 * token and approval safety (GoPlus), and ENS / SNS name lookups.
 * Never trades, never signs, never asks for or keeps a seed phrase or private key.
 */
import { z } from "zod";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema, addSystemJob } from "../../../core/plugins.js";
import { onJob, type SchedulerDeps } from "../../../core/scheduler.js";
import { log } from "../../../core/log.js";
import type { Db } from "../../../core/db.js";
import { fetchPrices } from "../../prices.js";
import {
  amount, CHAIN_WORDS, chainName, chainOf, EVM, flush, getJson, HttpError, inBatches, isEvmAddress, isEvmHash, isSolAddress, isSolSignature,
  looksSecret, queue, rpc, SEED_REFUSAL, short, SOLANA_RPC, sorry, units,
} from "./shared.js";

const ADDR = String.raw`(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})`;
const CHAIN = String.raw`(${CHAIN_WORDS})`;

/* =====================================================================
 * 7. Gas and fees
 * ===================================================================== */

addSchema(`CREATE TABLE IF NOT EXISTS tech_gas_alerts (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), chain TEXT NOT NULL, below NUMERIC NOT NULL, active BOOLEAN NOT NULL DEFAULT true, fired_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`);

export const gwei = (n: number) => (n >= 10 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : Number(n.toPrecision(2)).toString());
export async function gasPrice(chain: string): Promise<number> {
  return Number(BigInt(await rpc<string>(EVM[chain].rpc, "eth_gasPrice"))) / 1e9;
}
/** Ethereum's next base fee and the median tip over the last five blocks, in gwei. */
async function ethFees(): Promise<{ base: number; tip: number } | null> {
  const h = await rpc<any>(EVM.ethereum.rpc, "eth_feeHistory", ["0x5", "latest", [50]]).catch(() => null);
  if (!h?.baseFeePerGas?.length) return null;
  const tips = (h.reward ?? []).map((r: string[]) => Number(BigInt(r[0])) / 1e9).sort((a: number, b: number) => a - b);
  return { base: Number(BigInt(h.baseFeePerGas.at(-1))) / 1e9, tip: tips.length ? tips[Math.floor(tips.length / 2)] : 0 };
}
/** Median priority fee (micro-lamports per compute unit) over recent slots. */
export async function solanaPriority(): Promise<number | null> {
  const r = await rpc<{ slot: number; prioritizationFee: number }[]>(SOLANA_RPC(), "getRecentPrioritizationFees", []).catch(() => null);
  if (!r?.length) return null;
  const fees = r.map((x) => x.prioritizationFee).filter((x) => x > 0).sort((a, b) => a - b);
  return fees.length ? fees[Math.floor(fees.length / 2)] : 0;
}

const GAS_CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon"];
const gasNow = defineAction({
  name: "gas.now",
  tier: 1,
  description: "Current gas and network fees: Ethereum, Base, Arbitrum, Optimism and Polygon (gwei, from public RPC) and Solana priority fees. `chain` optional to ask about one (ethereum, base, arbitrum, optimism, polygon, bsc, solana).",
  schema: z.object({ chain: z.string().optional() }),
  async run(args) {
    const one = chainOf(args.chain);
    if (args.chain && !one) throw new Error(`I read gas on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Solana. Which of those?`);
    const lines: string[] = [];
    if (one === "solana") {
      const p = await solanaPriority();
      if (p === null) throw sorry("Solana's public RPC", new Error("down"));
      return { reply: `Solana fees: the base fee is 0.000005 SOL a signature, and priority fees are around ${Math.round(p).toLocaleString("en-US")} micro-lamports per compute unit lately.` };
    }
    const chains = one ? [one] : GAS_CHAINS;
    const [prices, fees, sol, px] = await Promise.all([
      Promise.all(chains.map((c) => gasPrice(c).catch(() => null))),
      chains.includes("ethereum") ? ethFees() : Promise.resolve(null),
      one ? Promise.resolve(null) : solanaPriority(),
      fetchPrices(["ethereum"]).catch(() => ({} as Record<string, number>)),
    ]);
    if (prices.every((p) => p === null)) throw sorry("the public RPCs", new Error("down"));
    chains.forEach((c, i) => {
      const p = prices[i];
      if (p === null) { lines.push(`- ${chainName(c)}: couldn't reach it just now`); return; }
      const extra = c === "ethereum" && fees ? ` (base ${gwei(fees.base)}, tip ${gwei(fees.tip)})` : "";
      lines.push(`- ${chainName(c)} ${gwei(p)} gwei${extra}`);
    });
    if (sol !== null) lines.push(`- Solana priority fees around ${Math.round(sol).toLocaleString("en-US")} micro-lamports per compute unit`);
    const ethIdx = chains.indexOf("ethereum");
    const eth = (px as Record<string, number>).ethereum;
    const tail = ethIdx >= 0 && prices[ethIdx] !== null && eth ? `\nA plain ETH transfer on Ethereum costs about $${(21000 * prices[ethIdx]! * 1e-9 * eth).toFixed(2)} right now.` : "";
    return { reply: `Gas right now:\n${lines.join("\n")}${tail}` };
  },
});

const gasAlert = defineAction({
  name: "gas.alert",
  tier: 1,
  description: "Tell the person once when gas on an EVM chain drops under a level in gwei ('tell me when ETH gas is under 5 gwei'), then stop. `chain` defaults to ethereum.",
  schema: z.object({ chain: z.string().optional(), below: z.number().positive().max(100_000) }),
  async run(args, ctx) {
    const chain = chainOf(args.chain ?? "ethereum");
    if (!chain || chain === "solana") throw new Error("I can watch gas on Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain. Solana fees don't work in gwei, so I can't set a level there.");
    let now: number | null = null;
    try { now = await gasPrice(chain); } catch { /* still set it */ }
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO tech_gas_alerts (user_id, chain, below) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, chain, args.below]);
    const at = now !== null ? ` It's ${gwei(now)} gwei now.` : "";
    if (now !== null && now <= args.below) return { reply: `${chainName(chain)} gas is already under ${args.below} gwei: ${gwei(now)} right now. I'll still tell you next time it dips after rising, once.`, undo: { payload: { id: r!.id } } };
    return { reply: `I'll tell you once when ${chainName(chain)} gas drops under ${args.below} gwei, then stop.${at}`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM tech_gas_alerts WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Gas alert dropped.";
  },
});

onJob("tech_gas", async (_job, deps) => { await checkGas(deps, new Date()); });
export async function checkGas(deps: SchedulerDeps, now: Date): Promise<void> {
  const alerts = await deps.db.query<any>(`SELECT * FROM tech_gas_alerts WHERE active ORDER BY id LIMIT 500`);
  if (!alerts.length) return;
  const prices = new Map<string, number | null>();
  for (const c of new Set(alerts.map((a) => a.chain as string))) prices.set(c, await gasPrice(c).catch(() => null));
  const touched = new Set<number>();
  for (const a of alerts) {
    const p = prices.get(a.chain);
    if (p == null || p > Number(a.below)) continue;
    await queue(deps.db, a.user_id, "gas", "urgent", `${chainName(a.chain)} gas is down to ${gwei(p)} gwei, under your ${Number(a.below)}. That alert is done; set another any time.`, now);
    await deps.db.query(`UPDATE tech_gas_alerts SET active=false, fired_at=$2 WHERE id=$1`, [a.id, now]);
    touched.add(a.user_id);
  }
  if (touched.size) await flush(deps, now, [...touched]);
}

/* =====================================================================
 * 8. Wallet activity
 * ===================================================================== */

addSchema(`CREATE TABLE IF NOT EXISTS tech_wallets (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), chain TEXT NOT NULL, address TEXT NOT NULL, label TEXT, alerts BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, chain, address));
CREATE TABLE IF NOT EXISTS tech_wallet_state (user_id INT NOT NULL REFERENCES users(id), chain TEXT NOT NULL, address TEXT NOT NULL, last_block BIGINT, last_sig TEXT, last_error TEXT, checked_at TIMESTAMPTZ, PRIMARY KEY (user_id, chain, address))`);

const etherscanKey = () => process.env.ETHERSCAN_API_KEY ?? "";
const KNOWN_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC", Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT", DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: "BONK",
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: "JUP", So11111111111111111111111111111111111111112: "wrapped SOL",
};
const mintName = (m: string) => KNOWN_MINTS[m] ?? `of token ${short(m)}`;

/** Wallets to watch: the person's portfolio wallets (the core `wallets` table, read only) unless muted, plus their own activity watches. */
export async function watchedWallets(db: Db, userId?: number): Promise<{ user_id: number; chain: string; address: string; label: string | null; source: "portfolio" | "tech" }[]> {
  return db.query(
    `SELECT w.user_id, w.chain, w.address, w.label, 'portfolio' AS source FROM wallets w
       WHERE ($1::int IS NULL OR w.user_id=$1) AND NOT EXISTS (SELECT 1 FROM tech_wallets t WHERE t.user_id=w.user_id AND t.chain=w.chain AND lower(t.address)=lower(w.address))
     UNION ALL
     SELECT t.user_id, t.chain, t.address, t.label, 'tech' AS source FROM tech_wallets t WHERE t.alerts AND ($1::int IS NULL OR t.user_id=$1)`,
    [userId ?? null],
  );
}

const walletAlerts = defineAction({
  name: "walletwatch.add",
  tier: 1,
  description: "Tell the person about new incoming and outgoing transactions on a public wallet address (read only): Solana for free, EVM chains (ethereum, base, arbitrum, optimism, polygon, bsc) through Etherscan. Merged, at most every 15 minutes. Wallets already in their portfolio are covered automatically. Never take private keys or seed phrases.",
  schema: z.object({ address: z.string().min(20).max(200), chain: z.string().optional(), label: z.string().max(40).optional() }),
  async run(args, ctx) {
    const address = args.address.trim();
    if (looksSecret(address) && !isEvmAddress(address) && !isSolAddress(address)) throw new Error(SEED_REFUSAL);
    const sol = isSolAddress(address) && !isEvmAddress(address);
    if (!sol && !isEvmAddress(address)) throw new Error("That doesn't look like a wallet address. An EVM one starts with 0x and has 40 characters after it; a Solana one is 32 to 44 letters and numbers.");
    const chain = sol ? "solana" : chainOf(args.chain ?? "ethereum");
    if (!chain || (sol && args.chain && chainOf(args.chain) !== "solana")) throw new Error("Which chain is it on? Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain or Solana.");
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO tech_wallets (user_id, chain, address, label, alerts) VALUES ($1,$2,$3,$4,true) ON CONFLICT (user_id, chain, address) DO UPDATE SET alerts=true, label=COALESCE(EXCLUDED.label, tech_wallets.label) RETURNING id`, [ctx.user.id, chain, address, args.label ?? null]);
    const name = args.label ? `${args.label} (\`${address}\`)` : `\`${address}\``;
    const keyNote = chain !== "solana" && !etherscanKey() ? " EVM activity comes from Etherscan, and this server doesn't have an Etherscan key yet (ETHERSCAN_API_KEY), so I'll start as soon as it does." : "";
    return { reply: `I'll tell you when ${name} sends or receives on ${chainName(chain)}, a few transactions in one message, at most every 15 minutes, and never during your quiet hours.${keyNote} Say "stop watching ${args.label ?? short(address)}" to end it.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM tech_wallets WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Stopped those wallet alerts.";
  },
});

interface Move { key: string; block: number; text: string }

async function evmMoves(chain: string, address: string, fromBlock: number): Promise<{ moves: Move[]; maxBlock: number }> {
  const c = EVM[chain];
  const base = `https://api.etherscan.io/v2/api?chainid=${c.id}&module=account&address=${address}&startblock=${fromBlock}&endblock=99999999&page=1&offset=10&sort=desc&apikey=${etherscanKey()}`;
  const get = async (action: string) => {
    const j = await getJson<any>(`${base}&action=${action}`);
    if (j?.status === "1" && Array.isArray(j.result)) return j.result as any[];
    if (/no transactions found/i.test(String(j?.message)) || (Array.isArray(j?.result) && !j.result.length)) return [];
    throw new Error(`etherscan: ${typeof j?.result === "string" ? j.result : j?.message ?? "error"}`);
  };
  const me = address.toLowerCase();
  const [txs, toks] = await Promise.all([get("txlist"), get("tokentx")]);
  const out: Move[] = [];
  for (const t of txs) {
    const v = units(t.value ?? "0", 18);
    const failed = t.isError === "1";
    const fn = String(t.functionName ?? "").split("(")[0];
    const text = t.from?.toLowerCase() === me
      ? v > 0 ? `sent ${amount(v)} ${c.native} to ${short(t.to)}${failed ? " (it failed)" : ""}` : `made a transaction${fn ? ` (${fn})` : ""}${failed ? " that failed" : ""}`
      : `received ${amount(v)} ${c.native} from ${short(t.from)}`;
    if (t.from?.toLowerCase() !== me && v === 0) continue;
    out.push({ key: t.hash, block: Number(t.blockNumber), text });
  }
  for (const t of toks) {
    const v = units(t.value ?? "0", Number(t.tokenDecimal ?? 18));
    out.push({ key: `${t.hash}:${t.tokenSymbol}`, block: Number(t.blockNumber), text: t.from?.toLowerCase() === me ? `sent ${amount(v)} ${t.tokenSymbol} to ${short(t.to)}` : `received ${amount(v)} ${t.tokenSymbol} from ${short(t.from)}` });
  }
  const maxBlock = Math.max(0, ...[...txs, ...toks].map((t) => Number(t.blockNumber) || 0));
  return { moves: out.sort((a, b) => b.block - a.block), maxBlock };
}

/** What a Solana transaction did to `address`: SOL in or out (fee excluded) and token changes. */
export function solanaChanges(tx: any, address: string): string[] {
  const keys: string[] = (tx?.transaction?.message?.accountKeys ?? []).map((k: any) => (typeof k === "string" ? k : k.pubkey));
  const meta = tx?.meta ?? {};
  const i = keys.indexOf(address);
  const out: string[] = [];
  if (i >= 0) {
    let d = (Number(meta.postBalances?.[i] ?? 0) - Number(meta.preBalances?.[i] ?? 0)) / 1e9;
    if (i === 0) d += Number(meta.fee ?? 0) / 1e9;
    if (Math.abs(d) >= 0.000001) out.push(d > 0 ? `received ${amount(d)} SOL` : `sent ${amount(-d)} SOL`);
  }
  const bal = (list: any[]) => new Map((list ?? []).filter((b) => b.owner === address).map((b) => [b.mint, Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0)]));
  const pre = bal(meta.preTokenBalances), post = bal(meta.postTokenBalances);
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const d = (post.get(mint) ?? 0) - (pre.get(mint) ?? 0);
    if (Math.abs(d) > 0) out.push(d > 0 ? `received ${amount(d)} ${mintName(mint)}` : `sent ${amount(-d)} ${mintName(mint)}`);
  }
  return out;
}

onJob("tech_wallets", async (_job, deps) => { await checkWallets(deps, new Date()); });

export async function checkWallets(deps: SchedulerDeps, now: Date): Promise<void> {
  const wallets = await watchedWallets(deps.db);
  if (!wallets.length) return;
  const state = new Map((await deps.db.query<any>(`SELECT * FROM tech_wallet_state`)).map((s) => [`${s.user_id}|${s.chain}|${s.address}`, s]));
  const list = wallets.filter((w) => w.chain === "solana" || (EVM[w.chain] && etherscanKey()))
    .sort((a, b) => new Date(state.get(`${a.user_id}|${a.chain}|${a.address}`)?.checked_at ?? 0).getTime() - new Date(state.get(`${b.user_id}|${b.chain}|${b.address}`)?.checked_at ?? 0).getTime())
    .slice(0, 40);
  const touched = new Set<number>();
  // Etherscan's free plan allows 3 calls a second, so EVM wallets go one at a time.
  await inBatches(list, 1, async (w) => {
    const k = `${w.user_id}|${w.chain}|${w.address}`;
    const s = state.get(k);
    const who = w.label ? `${w.label}` : short(w.address);
    let lines: string[] = [], lastBlock = s?.last_block ?? null, lastSig = s?.last_sig ?? null, error: string | null = null, link = "";
    try {
      if (w.chain === "solana") {
        const sigs = (await rpc<any[]>(SOLANA_RPC(), "getSignaturesForAddress", [w.address, { limit: 10, ...(lastSig ? { until: lastSig } : {}) }])) ?? [];
        if (s) {
          for (const sg of sigs.slice(0, 3)) {
            const tx = await rpc<any>(SOLANA_RPC(), "getTransaction", [sg.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
            const ch = tx ? solanaChanges(tx, w.address) : [];
            lines.push(...(ch.length ? ch : [`made a transaction${sg.err ? " that failed" : ""}`]));
          }
          if (sigs.length > 3) lines.push(`${sigs.length - 3} more transaction${sigs.length - 3 === 1 ? "" : "s"}`);
        }
        if (sigs[0]?.signature) lastSig = sigs[0].signature;
        link = `https://solscan.io/account/${w.address}`;
      } else {
        const { moves, maxBlock } = await evmMoves(w.chain, w.address, lastBlock !== null && lastBlock !== undefined ? Number(lastBlock) + 1 : 0);
        if (s) {
          lines = moves.slice(0, 4).map((m) => m.text);
          if (moves.length > 4) lines.push(`${moves.length - 4} more`);
        }
        lastBlock = Math.max(Number(lastBlock ?? 0), maxBlock);
        link = `${EVM[w.chain].explorer}/address/${w.address}`;
      }
    } catch (e) {
      error = (e as Error).message.slice(0, 200);
      log.warn({ chain: w.chain, err: error }, "wallet activity check failed");
    }
    if (lines.length) {
      await queue(deps.db, w.user_id, "wallets", "live", `${who} on ${chainName(w.chain)}: ${lines.join(", ")}.\n${link}`, now);
      touched.add(w.user_id);
    }
    // A first look that failed sets no baseline, so the next good look doesn't replay old history as new.
    if (error && !s) return;
    if (error) { await deps.db.query(`UPDATE tech_wallet_state SET last_error=$4, checked_at=$5 WHERE user_id=$1 AND chain=$2 AND address=$3`, [w.user_id, w.chain, w.address, error, now]); return; }
    await deps.db.query(
      `INSERT INTO tech_wallet_state (user_id, chain, address, last_block, last_sig, last_error, checked_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, chain, address) DO UPDATE SET last_block=EXCLUDED.last_block, last_sig=EXCLUDED.last_sig, last_error=EXCLUDED.last_error, checked_at=EXCLUDED.checked_at`,
      [w.user_id, w.chain, w.address, lastBlock, lastSig, error, now],
    );
  });
  if (touched.size) await flush(deps, now, [...touched]);
}

/* =====================================================================
 * 9. Transaction explainer
 * ===================================================================== */

const KNOWN_SIGS: Record<string, string> = {
  "0xa9059cbb": "transfer(address,uint256)", "0x095ea7b3": "approve(address,uint256)", "0x23b872dd": "transferFrom(address,address,uint256)",
  "0xa22cb465": "setApprovalForAll(address,bool)", "0x3593564c": "execute(bytes,bytes[],uint256)", "0xac9650d8": "multicall(bytes[])", "0x5ae401dc": "multicall(uint256,bytes[])",
  "0xd0e30db0": "deposit()", "0x2e1a7d4d": "withdraw(uint256)", "0x38ed1739": "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  "0x7ff36ab5": "swapExactETHForTokens(uint256,address[],address,uint256)", "0x18cbafe5": "swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
  "0x1249c58b": "mint()", "0x40c10f19": "mint(address,uint256)", "0x4e71d92d": "claim()",
};
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_UINT_HALF = 2n ** 255n;

/** The function behind a 4-byte selector: a small built-in list, then 4byte.directory (cached). */
export async function signatureOf(db: Db, selector: string): Promise<string | null> {
  const sel = selector.toLowerCase();
  if (KNOWN_SIGS[sel]) return KNOWN_SIGS[sel];
  const c = await db.one<{ body: any }>(`SELECT body FROM tech_cache WHERE key=$1`, [`4byte:${sel}`]);
  if (c) return (typeof c.body === "string" ? JSON.parse(c.body) : c.body)?.sig ?? null;
  try {
    const j = await getJson<any>(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${sel}`);
    const sig = [...(j?.results ?? [])].sort((a: any, b: any) => Number(a.id) - Number(b.id))[0]?.text_signature ?? null;
    await db.query(`INSERT INTO tech_cache (key, body) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET body=EXCLUDED.body, at=now()`, [`4byte:${sel}`, JSON.stringify({ sig })]);
    return sig;
  } catch { return null; }
}

export function plainCall(sig: string | null): string {
  const n = (sig ?? "").split("(")[0];
  if (!n) return "called a contract";
  if (/^setApprovalForAll$/i.test(n)) return "gave a contract permission over a whole NFT collection";
  if (/^approve$|^permit$/i.test(n)) return "gave permission to spend tokens";
  if (/^transfer(?:From)?$/i.test(n)) return "sent tokens";
  if (/swap/i.test(n)) return "made a swap";
  if (/^execute$/i.test(n)) return "made a trade through a router";
  if (/multicall/i.test(n)) return "bundled several actions into one";
  if (/bridge|outboundTransfer|depositETH|sendToL2/i.test(n)) return "bridged funds";
  if (/stake/i.test(n)) return "staked";
  if (/^deposit/i.test(n)) return "made a deposit";
  if (/^withdraw/i.test(n)) return "made a withdrawal";
  if (/mint/i.test(n)) return "minted";
  if (/claim/i.test(n)) return "claimed something";
  return `called ${n}`;
}

function abiString(hex: string): string | null {
  const h = hex?.replace(/^0x/, "") ?? "";
  if (h.length >= 192) {
    const len = parseInt(h.slice(64, 128), 16);
    return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8") || null;
  }
  if (h.length === 64) return Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, "") || null;
  return null;
}
async function tokenMeta(db: Db, chain: string, token: string): Promise<{ symbol: string; decimals: number }> {
  const key = `tok:${chain}:${token.toLowerCase()}`;
  const c = await db.one<{ body: any }>(`SELECT body FROM tech_cache WHERE key=$1`, [key]);
  if (c) return typeof c.body === "string" ? JSON.parse(c.body) : c.body;
  const call = (data: string) => rpc<string>(EVM[chain].rpc, "eth_call", [{ to: token, data }, "latest"]).catch(() => "0x");
  const [d, s] = await Promise.all([call("0x313ce567"), call("0x95d89b41")]);
  const meta = { symbol: abiString(s) ?? short(token), decimals: d && d !== "0x" ? Number(BigInt(d)) : 18 };
  await db.query(`INSERT INTO tech_cache (key, body) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING`, [key, JSON.stringify(meta)]);
  return meta;
}
const word = (a: string) => `0x${a.slice(-40)}`;

async function explainEvm(db: Db, hash: string, only: string | null): Promise<string> {
  const order = only ? [only] : ["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc"];
  let chain: string | null = null, tx: any = null;
  for (const c of order) {
    tx = await rpc<any>(EVM[c].rpc, "eth_getTransactionByHash", [hash]).catch(() => null);
    if (tx) { chain = c; break; }
  }
  if (!tx || !chain) throw new Error(`I couldn't find that transaction on ${only ? chainName(only) : "Ethereum, Base, Arbitrum, Optimism, Polygon or BNB Chain"}. Check the hash, or tell me the chain, like "explain tx 0x... on base".`);
  const c = EVM[chain];
  const receipt = await rpc<any>(c.rpc, "eth_getTransactionReceipt", [hash]).catch(() => null);
  const value = units(tx.value ?? "0x0", 18);
  const input: string = tx.input ?? "0x";
  const lines: string[] = [];
  const status = !receipt ? "it's still pending" : receipt.status === "0x1" ? "it worked" : "it failed, so nothing moved apart from the fee";
  lines.push(`On ${c.name}, ${status}.`);
  if (input === "0x" || input.length < 10) {
    lines.push(`${short(tx.from)} sent ${amount(value)} ${c.native} to ${short(tx.to ?? "")}.`);
  } else if (!tx.to) {
    lines.push(`${short(tx.from)} deployed a new contract${receipt?.contractAddress ? ` at ${short(receipt.contractAddress)}` : ""}.`);
  } else {
    const sel = input.slice(0, 10);
    const sig = await signatureOf(db, sel);
    const name = (sig ?? "").split("(")[0];
    if (/^(?:transfer|approve)$/.test(name) && input.length >= 138) {
      const target = word(input.slice(10, 74)), raw = BigInt(`0x${input.slice(74, 138)}`);
      const meta = await tokenMeta(db, chain, tx.to);
      if (name === "transfer") lines.push(`${short(tx.from)} sent ${amount(units(raw, meta.decimals))} ${meta.symbol} to ${short(target)}.`);
      else {
        const unlimited = raw >= MAX_UINT_HALF;
        lines.push(`${short(tx.from)} gave ${short(target)} permission to spend ${unlimited ? "an unlimited amount of" : amount(units(raw, meta.decimals))} ${meta.symbol}.`);
        if (unlimited) lines.push("That's an unlimited approval. If you don't know that contract, revoke it at revoke.cash.");
      }
    } else {
      lines.push(`${short(tx.from)} ${plainCall(sig)} at ${short(tx.to)}${value > 0 ? `, sending ${amount(value)} ${c.native} with it` : ""}.${sig ? ` Function: \`${sig}\`.` : ""}`);
    }
  }
  const transfers = (receipt?.logs ?? []).filter((l: any) => l.topics?.[0] === TRANSFER_TOPIC && l.topics.length === 3);
  if (transfers.length && !(input.startsWith("0xa9059cbb"))) {
    const moved: string[] = [];
    for (const l of transfers.slice(0, 3)) {
      const meta = await tokenMeta(db, chain, l.address);
      moved.push(`${amount(units(l.data && l.data !== "0x" ? l.data : "0x0", meta.decimals))} ${meta.symbol} from ${short(word(l.topics[1]))} to ${short(word(l.topics[2]))}`);
    }
    lines.push(`Tokens moved: ${moved.join("; ")}${transfers.length > 3 ? `; and ${transfers.length - 3} more` : ""}.`);
  }
  if (receipt) {
    const fee = BigInt(receipt.gasUsed ?? "0x0") * BigInt(receipt.effectiveGasPrice ?? tx.gasPrice ?? "0x0") + (receipt.l1Fee ? BigInt(receipt.l1Fee) : 0n);
    lines.push(`Fee: ${amount(units(fee, 18))} ${c.native}.`);
  }
  lines.push(`${c.explorer}/tx/${hash}`);
  return lines.join("\n");
}

async function explainSolana(sig: string): Promise<string> {
  const tx = await rpc<any>(SOLANA_RPC(), "getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  if (!tx) throw new Error("I couldn't find that Solana transaction. It may be too old for the public RPC, or still settling. Check the signature?");
  const keys: any[] = tx.transaction?.message?.accountKeys ?? [];
  const signer = (keys.find((k) => k.signer)?.pubkey ?? keys[0]?.pubkey ?? keys[0]) as string;
  const meta = tx.meta ?? {};
  const lines = [`On Solana, ${meta.err ? "it failed, so nothing moved apart from the fee" : "it worked"}. Signed by ${short(signer)}.`];
  const pubkeys: string[] = keys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const sol: string[] = [];
  pubkeys.forEach((k, i) => {
    let d = (Number(meta.postBalances?.[i] ?? 0) - Number(meta.preBalances?.[i] ?? 0)) / 1e9;
    if (i === 0) d += Number(meta.fee ?? 0) / 1e9;
    if (Math.abs(d) >= 0.000001) sol.push(`${short(k)} ${d > 0 ? "+" : "-"}${amount(Math.abs(d))}`);
  });
  if (sol.length) lines.push(`SOL: ${sol.slice(0, 4).join(", ")}${sol.length > 4 ? ", and more" : ""}.`);
  const owners = new Set<string>([...(meta.preTokenBalances ?? []), ...(meta.postTokenBalances ?? [])].map((b: any) => b.owner).filter(Boolean));
  const toks: string[] = [];
  for (const o of owners) for (const ch of solanaChanges({ transaction: { message: { accountKeys: [] } }, meta: { ...meta, preBalances: [], postBalances: [] } }, o)) toks.push(`${short(o)} ${ch}`);
  if (toks.length) lines.push(`Tokens: ${toks.slice(0, 4).join("; ")}${toks.length > 4 ? "; and more" : ""}.`);
  lines.push(`Fee: ${amount(Number(meta.fee ?? 0) / 1e9)} SOL.`);
  lines.push(`https://solscan.io/tx/${sig}`);
  return lines.join("\n");
}

const txExplain = defineAction({
  name: "tx.explain",
  tier: 1,
  description: "Explain a blockchain transaction in plain words for a non-expert: who, what, how much, the fee and whether it worked. `hash` is an EVM transaction hash (0x + 64 hex) or a Solana signature. `chain` optional (otherwise Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain are tried).",
  schema: z.object({ hash: z.string().min(40).max(100), chain: z.string().optional() }),
  async run(args, ctx) {
    const h = args.hash.trim();
    try {
      if (isEvmHash(h)) return { reply: await explainEvm(ctx.db, h, chainOf(args.chain) === "solana" ? null : chainOf(args.chain)) };
      if (isSolSignature(h)) return { reply: await explainSolana(h) };
    } catch (e) {
      if (e instanceof HttpError || /rpc |fetch failed|timeout|abort/i.test((e as Error).message)) throw sorry("the public RPC", e);
      throw e;
    }
    throw new Error("That doesn't look like a transaction hash. An EVM one is 0x and 64 characters; a Solana one is a long string of letters and numbers.");
  },
});

/* =====================================================================
 * 10. Token and approval safety (GoPlus)
 * ===================================================================== */

const GOPLUS = "https://api.gopluslabs.io/api";
const pct = (x: unknown) => `${Math.round(Number(x) * 1000) / 10}%`;
export function tokenFlags(s: any, solana: boolean): string[] {
  const on = (k: string) => String(s?.[k] ?? "") === "1";
  const f: string[] = [];
  if (solana) {
    if (s?.mintable?.status === "1") f.push("someone can still mint more of it");
    if (s?.freezable?.status === "1") f.push("someone can freeze your tokens");
    if (s?.closable?.status === "1") f.push("the token account can be closed by its authority");
    if (s?.balance_mutable_authority?.status === "1") f.push("an authority can change balances");
    if (s?.non_transferable === "1") f.push("it can't be transferred");
    if (s?.transfer_fee && Object.keys(s.transfer_fee).length && Number(s.transfer_fee?.fee_rate ?? 0) > 0) f.push("it charges a fee on every transfer");
    if (s?.transfer_hook?.length) f.push("it runs extra code on every transfer");
    return f;
  }
  if (on("is_honeypot")) f.push("it looks like a honeypot: you may be able to buy but not sell");
  if (on("cannot_sell_all")) f.push("you can't sell all of it at once");
  if (on("is_mintable")) f.push("the owner can mint more");
  if (on("owner_change_balance")) f.push("the owner can change balances");
  if (on("hidden_owner")) f.push("it has a hidden owner");
  if (on("can_take_back_ownership")) f.push("ownership can be taken back after being given up");
  if (on("transfer_pausable")) f.push("transfers can be paused");
  if (on("is_blacklisted")) f.push("it has a blacklist that can block wallets");
  if (on("slippage_modifiable")) f.push("the owner can change the tax");
  if (on("selfdestruct")) f.push("the contract can self-destruct");
  if (on("is_proxy")) f.push("it's an upgradeable proxy, so its code can change");
  if (String(s?.is_open_source ?? "") === "0") f.push("its code isn't verified");
  if (on("trading_cooldown")) f.push("it has a trading cooldown");
  if (Number(s?.buy_tax ?? 0) >= 0.1) f.push(`buy tax is ${pct(s.buy_tax)}`);
  if (Number(s?.sell_tax ?? 0) >= 0.1) f.push(`sell tax is ${pct(s.sell_tax)}`);
  if (String(s?.is_in_dex ?? "") === "0") f.push("it isn't trading on a DEX yet");
  return f;
}

const CHAIN_QUESTION = "Which chain is it on? Ethereum, Base, BNB Chain, Arbitrum, Optimism, Polygon or Solana.";
const tokenCheck = defineAction({
  name: "token.check",
  tier: 1,
  description: "Scan a token contract for red flags with GoPlus: honeypot, owner can mint, high buy or sell tax, blacklist, pausable transfers, unverified code; Solana mint and freeze authority. Never says a token is safe, only whether red flags were found. `chain` needed for EVM addresses (ethereum, base, bsc, arbitrum, optimism, polygon); Solana addresses are detected.",
  schema: z.object({ address: z.string().min(32).max(60), chain: z.string().optional() }),
  needs(args) {
    if (isEvmAddress(args.address) && !chainOf(args.chain)) return { need: "chain", question: CHAIN_QUESTION };
    return null;
  },
  fill(need, answer) { const c = chainOf(answer.replace(/^(?:on|it'?s on)\s+/i, "")); return need === "chain" && c ? { chain: c } : null; },
  async run(args, ctx) {
    const addr = args.address.trim();
    const solana = !isEvmAddress(addr) && isSolAddress(addr);
    if (!solana && !isEvmAddress(addr)) throw new Error("That doesn't look like a token address. An EVM one is 0x and 40 characters; a Solana mint is 32 to 44 letters and numbers.");
    const chain = solana ? "solana" : chainOf(args.chain) ?? "ethereum";
    if (!solana && chain === "solana") throw new Error(CHAIN_QUESTION);
    let j: any;
    try { j = await getJson(solana ? `${GOPLUS}/v1/solana/token_security?contract_addresses=${addr}` : `${GOPLUS}/v1/token_security/${EVM[chain].id}?contract_addresses=${addr}`); }
    catch (e) { throw sorry("GoPlus", e); }
    const res = j?.result ?? {};
    const s = res[addr.toLowerCase()] ?? res[addr] ?? Object.values(res)[0];
    if (!s) return { reply: `GoPlus has no data on that token on ${chainName(chain)}. Check the address and chain; a brand-new token may not be scanned yet.` };
    const name = s.token_symbol ?? s.metadata?.symbol ?? s.token_name ?? short(addr);
    const flags = tokenFlags(s, solana);
    const holders = s.holder_count ? ` It has about ${Number(s.holder_count).toLocaleString("en-US")} holders.` : "";
    if (!flags.length) return { reply: `No red flags found by GoPlus for ${name} on ${chainName(chain)}.${holders} That isn't a guarantee: scanners miss things, so only put in what you could lose.` };
    return { reply: `GoPlus found ${flags.length === 1 ? "a red flag" : `${flags.length} red flags`} on ${name} on ${chainName(chain)}:\n${flags.slice(0, 8).map((f) => `- ${f}`).join("\n")}\nI'd stay away unless you know exactly why these are there.` };
  },
});

const approvalsCheck = defineAction({
  name: "approvals.check",
  tier: 1,
  description: "List risky token approvals on a public EVM wallet (unlimited allowances, flagged or unverified spenders) using GoPlus' approval security API, with a revoke.cash link so the person can revoke them themselves. `chain` optional, defaults to ethereum. Read only; never revokes or signs.",
  schema: z.object({ address: z.string().min(42).max(42), chain: z.string().optional() }),
  async run(args, ctx) {
    const addr = args.address.trim();
    if (!isEvmAddress(addr)) throw new Error("Approvals need an EVM wallet address: 0x and 40 characters.");
    const chain = chainOf(args.chain ?? "ethereum");
    if (!chain || chain === "solana") throw new Error("I can check approvals on Ethereum, Base, Arbitrum, Optimism, Polygon and BNB Chain.");
    const id = EVM[chain].id;
    let j: any;
    try { j = await getJson(`${GOPLUS}/v2/token_approval_security/${id}?addresses=${addr}`); } catch (e) { throw sorry("GoPlus", e); }
    const tokens: any[] = Array.isArray(j?.result) ? j.result : [];
    const revoke = `https://revoke.cash/address/${addr}?chainId=${id}`;
    const all: { token: string; spender: string; why: string[] }[] = [];
    for (const t of tokens) for (const a of t.approved_list ?? []) {
      const info = a.address_info ?? {};
      const why: string[] = [];
      const amt = String(a.approved_amount ?? "");
      if (/unlimited/i.test(amt) || Number(amt) > 1e30) why.push("unlimited");
      if ((info.malicious_behavior ?? []).length || String(info.doubt_list) === "1" || String(t.malicious_address) === "1") why.push("flagged as risky");
      if (String(info.is_open_source) === "0") why.push("unverified contract");
      all.push({ token: t.token_symbol ?? t.token_name ?? short(t.token_address ?? ""), spender: info.contract_name || info.tag || short(a.approved_contract ?? ""), why });
    }
    const risky = all.filter((a) => a.why.length).sort((a, b) => Number(b.why.includes("flagged as risky")) - Number(a.why.includes("flagged as risky")));
    if (!all.length) return { reply: `No open token approvals found for ${short(addr)} on ${chainName(chain)}. Good place to be.` };
    if (!risky.length) return { reply: `${all.length} approval${all.length === 1 ? "" : "s"} on ${chainName(chain)}, none unlimited or flagged. You can review them at ${revoke}` };
    return { reply: [
      `${risky.length} of ${all.length} approvals on ${chainName(chain)} are worth a look:`,
      ...risky.slice(0, 6).map((r) => `- ${r.token} to ${r.spender}: ${r.why.join(", ")}`),
      ...(risky.length > 6 ? [`- and ${risky.length - 6} more`] : []),
      `Revoke the ones you don't use at ${revoke} (connect that wallet there; I can't do it for you).`,
    ].join("\n") };
  },
});

/* =====================================================================
 * 14. Names: ENS and SNS
 * ===================================================================== */

const SNS = "https://sns-sdk-proxy.bonfida.workers.dev";
const ensLookup = defineAction({
  name: "ens.lookup",
  tier: 1,
  description: "Look up on-chain names: an ENS name (vitalik.eth) to its address, a Solana Name Service name (toly.sol) to its owner, or an address back to its primary .eth or .sol name.",
  schema: z.object({ query: z.string().min(3).max(100) }),
  async run(args) {
    const q = args.query.trim().replace(/\?$/, "");
    try {
      if (/\.eth$/i.test(q)) {
        const j = await getJson<any>(`https://ensdata.net/${encodeURIComponent(q.toLowerCase())}`).catch((e) => { if (e instanceof HttpError && e.status === 404) return null; throw e; });
        return { reply: j?.address ? `The address for ${q.toLowerCase()} is \`${j.address}\`.` : `${q} doesn't point to an address right now.` };
      }
      if (/\.sol$/i.test(q)) {
        const j = await getJson<any>(`${SNS}/resolve/${encodeURIComponent(q.toLowerCase().replace(/\.sol$/, ""))}`);
        return { reply: j?.s === "ok" && typeof j.result === "string" ? `The owner of ${q.toLowerCase()} is \`${j.result}\`.` : `${q} isn't registered, or doesn't point anywhere.` };
      }
      if (isEvmAddress(q)) {
        const j = await getJson<any>(`https://ensdata.net/${q}`).catch((e) => { if (e instanceof HttpError && e.status === 404) return null; throw e; });
        const name = j?.ens_primary ?? j?.ens;
        return { reply: name ? `\`${q}\` is ${name}.` : `\`${short(q)}\` has no primary ENS name set.` };
      }
      if (isSolAddress(q)) {
        const j = await getJson<any>(`${SNS}/favorite-domain/${q}`);
        const r = j?.result;
        const name = typeof r === "string" ? r : r?.reverse;
        return { reply: j?.s === "ok" && name ? `\`${short(q)}\` is ${String(name).replace(/\.sol$/, "")}.sol.` : `\`${short(q)}\` has no primary .sol name set.` };
      }
    } catch (e) { throw sorry(/\.sol$|^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q) ? "the Solana name service" : "the ENS lookup", e); }
    throw new Error("Give me a .eth or .sol name, or an address, like \"who is vitalik.eth\".");
  },
});

register(gasNow, gasAlert, walletAlerts, txExplain, tokenCheck, approvalsCheck, ensLookup);

/* ---------- jobs, words, cards ---------- */

addSystemJob("tech_gas", "1,6,11,16,21,26,31,36,41,46,51,56 * * * *");
addSystemJob("tech_wallets", "9,24,39,54 * * * *");

const SAFE = "(?:safe|legit|ok|okay|a scam|a rug|a rug ?pull|a honeypot|risky)";
addRules(
  [new RegExp(String.raw`^(?:gas now|gas fees?(?: now)?|network fees|current gas|gwei|gwei now|what'?s (?:the )?gas (?:now|at|right now)|(?:crypto|chain|onchain|on-chain) gas)\??$`, "i"), () => ({ action: "gas.now", args: {} })],
  [new RegExp(String.raw`^(?:what'?s\s+(?:the\s+)?)?(?:gas|fees|gas fees)(?:\s+now)?\s+(?:on|for)\s+${CHAIN}(?:\s+now)?\??$`, "i"), (m) => ({ action: "gas.now", args: { chain: m[1] } })],
  [new RegExp(String.raw`^${CHAIN}\s+(?:gas|fees)(?:\s+now)?\??$`, "i"), (m) => ({ action: "gas.now", args: { chain: m[1] } })],
  [new RegExp(String.raw`^(?:tell me|let me know|alert me|ping me|notify me)\s+(?:when|if|once)\s+(?:the\s+)?(?:${CHAIN}\s+)?gas\s+(?:on\s+${CHAIN}\s+)?(?:is|goes|drops|gets|falls|dips)?\s*(?:under|below|less than|<)\s*([\d.]+)\s*(?:gwei)?$`, "i"), (m) => ({ action: "gas.alert", args: { chain: m[1] ?? m[2], below: Number(m[3]) } })],
  [new RegExp(String.raw`^(?:wallet|activity|transaction|tx)\s+alerts?\s+(?:for|on)\s+${ADDR}(?:\s+on\s+${CHAIN})?(?:\s+(?:as|called)\s+(.+))?$`, "i"), (m) => ({ action: "walletwatch.add", args: { address: m[1], chain: m[2], label: m[3] } })],
  [new RegExp(String.raw`^(?:watch|track|follow)\s+(?:the\s+)?(?:activity|transactions|txs)\s+(?:on|of|for)\s+${ADDR}(?:\s+on\s+${CHAIN})?(?:\s+(?:as|called)\s+(.+))?$`, "i"), (m) => ({ action: "walletwatch.add", args: { address: m[1], chain: m[2], label: m[3] } })],
  [new RegExp(String.raw`^(?:tell me|let me know|alert me|notify me|ping me)\s+(?:when|if)\s+${ADDR}\s+(?:moves|sends|receives|gets|transacts|has activity|does anything)(?:\s+(?:anything|funds|money|tokens))?(?:\s+on\s+${CHAIN})?$`, "i"), (m) => ({ action: "walletwatch.add", args: { address: m[1], chain: m[2] } })],
  [new RegExp(String.raw`^(?:explain|decode|what (?:is|was|did)|what happened in|break down)\s+(?:this\s+|the\s+|my\s+)?(?:tx|txn|transaction)?\s*(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90})(?:\s+(?:on|from)\s+${CHAIN})?(?:\s+do)?\??$`, "i"), (m) => ({ action: "tx.explain", args: { hash: m[1], chain: m[2] } })],
  [new RegExp(String.raw`^is\s+(?:this\s+|the\s+)?(?:token|coin|contract|memecoin)\s+${SAFE}\??\s+${ADDR}(?:\s+on\s+${CHAIN})?\??$`, "i"), (m) => ({ action: "token.check", args: { address: m[1], chain: m[2] } })],
  [new RegExp(String.raw`^is\s+${ADDR}\s+(?:on\s+${CHAIN}\s+)?${SAFE}(?:\s+on\s+${CHAIN})?\??$`, "i"), (m) => ({ action: "token.check", args: { address: m[1], chain: m[2] ?? m[3] } })],
  [new RegExp(String.raw`^(?:check|scan|audit|vet)\s+(?:this\s+|the\s+)?(?:token|coin|contract|memecoin)\s+${ADDR}(?:\s+on\s+${CHAIN})?$`, "i"), (m) => ({ action: "token.check", args: { address: m[1], chain: m[2] } })],
  [new RegExp(String.raw`^(?:check|scan|show|audit|review)\s+(?:my\s+|the\s+)?(?:token\s+)?(?:approvals?|allowances?)\s+(?:for\s+|of\s+|on\s+)?(0x[0-9a-fA-F]{40})(?:\s+on\s+${CHAIN})?$`, "i"), (m) => ({ action: "approvals.check", args: { address: m[1], chain: m[2] } })],
  [/^(?:who\s+is|who'?s|whois|resolve|what(?:'s| is) the address (?:of|for))\s+([a-z0-9][a-z0-9_.-]*\.(?:eth|sol))\??$/i, (m) => ({ action: "ens.lookup", args: { query: m[1] } })],
  [new RegExp(String.raw`^(?:who\s+is|whois|who owns|reverse(?:\s+lookup)?|(?:ens|sns)\s+name\s+(?:of|for)|what(?:'s| is) the name (?:of|for))\s+${ADDR}\??$`, "i"), (m) => ({ action: "ens.lookup", args: { query: m[1] } })],
);
const A = "0x1234567890abcdef1234567890abcdef12345678";
const S = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
addExamples("gas.now", ["gas now", "gas fees", "gas on base", "what's gas on arbitrum", "solana fees", "eth gas"]);
addExamples("gas.alert", ["tell me when ETH gas is under 5 gwei", "alert me when gas on base drops below 0.01 gwei"]);
addExamples("walletwatch.add", [`wallet alerts for ${A} on base`, `watch activity on ${S}`, `tell me when ${A} moves`]);
addExamples("tx.explain", [`explain tx 0x${"ab".repeat(32)}`, `explain tx 0x${"cd".repeat(32)} on base`, "explain 5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"]);
addExamples("token.check", [`is this token safe ${A} on base`, `check token ${A} on bsc`, `is ${S} a scam`]);
addExamples("approvals.check", [`check my approvals ${A}`, `check approvals ${A} on arbitrum`]);
addExamples("ens.lookup", ["who is vitalik.eth", "resolve toly.sol", `who is ${A}`]);
addCues("gas", ["gas", "gwei", "fees", "network fee", "priority fee", "base fee"]);
addCues("walletwatch", ["wallet alert", "wallet activity", "incoming", "outgoing", "transactions on", "moves funds", "receives", "sends"]);
addCues("tx", ["tx", "txn", "transaction", "hash", "explain tx", "what happened in", "signature"]);
addCues("token", ["is this token safe", "honeypot", "rug", "scam token", "token safe", "contract safe", "red flags", "goplus"]);
addCues("approvals", ["approval", "approvals", "allowance", "revoke", "revoke.cash", "unlimited approval"]);
addCues("ens", [".eth", ".sol", "ens", "sns", "resolve", "who is 0x", "name service"]);

addCapability({
  key: "cryptosafety", name: "Transactions, tokens and names",
  cues: ["explain tx", "transaction", "honeypot", "rug", "is this token safe", "approvals", "revoke", "ens", ".eth", ".sol", "who is"],
  what: "Paste a transaction and I explain it in plain words: who sent what to whom, whether it worked and the fee, on Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain and Solana. I scan tokens for red flags like honeypots, minting and high taxes, list risky approvals on your wallet, and look up .eth and .sol names.",
  say: ["explain tx 0x...", "is this token safe 0x... on base", "check my approvals 0x...", "who is vitalik.eth", "resolve toly.sol"],
  then: "Token scans never say \"safe\", only what red flags were or weren't found. For approvals I give you a revoke.cash link to revoke them yourself.",
  limits: "Read only. I never trade, sign or revoke, and I never ask for a seed phrase or private key.",
}, "Work, code and crypto");
