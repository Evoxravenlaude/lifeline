/**
 * Shared pieces for Work, code and crypto: HTTP and JSON-RPC helpers, the chains we read,
 * address and secret detection, and the outbox that merges every alert from this area into
 * one message (or one brief line) instead of a ping per event.
 *
 * Alert levels, from calmest to loudest:
 *   brief   only ever in the morning brief
 *   daily   may ping, at most once per feature per day; the rest waits for the brief
 *   live    pings through push() as usual (quiet hours, calm mode, quiet days and the daily cap all apply)
 *   urgent  something the person asked to hear about in real time (their site is down, their own
 *           reminder, a threshold they set). Quiet hours, quiet days and calm mode still hold it;
 *           only the daily cap is skipped.
 * Whatever can't go out waits and is retried, and lands in the brief if it's still waiting.
 */
import { DateTime } from "luxon";
import type { Db } from "../../../core/db.js";
import { push, type SchedulerDeps } from "../../../core/scheduler.js";
import { inQuietHours, localDay } from "../../../core/time.js";
import { addBriefSection, addSchema } from "../../../core/plugins.js";
import { log } from "../../../core/log.js";
import { publicFetch } from "../../../core/safefetch.js";
import type { User } from "../../../policy/types.js";

export const UA = "lifeline-bot/0.1 (personal assistant; read-only)";

addSchema(`CREATE TABLE IF NOT EXISTS tech_outbox (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), feature TEXT NOT NULL, level TEXT NOT NULL, text TEXT NOT NULL, button JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), sent_at TIMESTAMPTZ, briefed_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS tech_outbox_user ON tech_outbox (user_id, sent_at);
CREATE TABLE IF NOT EXISTS tech_pings (user_id INT NOT NULL REFERENCES users(id), feature TEXT NOT NULL, day TEXT NOT NULL, PRIMARY KEY (user_id, feature, day));
CREATE TABLE IF NOT EXISTS tech_cache (key TEXT PRIMARY KEY, etag TEXT, body JSONB, at TIMESTAMPTZ NOT NULL DEFAULT now())`);

/* ---------- HTTP ---------- */

export class HttpError extends Error {
  constructor(public status: number, public url: string, public body?: string) { super(`${new URL(url).hostname} answered ${status}`); }
}

/** `public`: the address came from the person, so only public hosts and checked redirects (see core/safefetch). */
export interface FetchOpts { method?: string; body?: unknown; headers?: Record<string, string>; timeoutMs?: number; public?: boolean }

export async function getJson<T = any>(url: string, o: FetchOpts = {}): Promise<T> {
  const r = await (o.public ? publicFetch : fetch)(url, {
    method: o.method ?? (o.body !== undefined ? "POST" : "GET"),
    headers: { "user-agent": UA, accept: "application/json", ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.headers ?? {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    signal: AbortSignal.timeout(o.timeoutMs ?? 15_000),
  });
  if (!r.ok) throw new HttpError(r.status, url, await r.text().catch(() => ""));
  return (await r.json()) as T;
}

/** JSON-RPC 2.0 call (EVM and Solana use the same envelope). */
export async function rpc<T = any>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const j = await getJson<any>(url, { body: { jsonrpc: "2.0", id: 1, method, params } });
  if (j?.error) throw new Error(`rpc ${method}: ${j.error.message ?? "error"}`);
  return j?.result as T;
}

/** A person-facing sentence for a failed call to `source`. */
export function sorry(source: string, e: unknown): Error {
  const err = e as any;
  const status = err instanceof HttpError ? err.status : Number(/\b([45]\d\d)\b/.exec(String(err?.message ?? ""))?.[1] ?? 0);
  if (status === 429) return new Error(`${source} is busy and asked me to slow down. Try again in a few minutes.`);
  if (status === 404) return new Error(`${source} doesn't have that. Check the name or address and try again?`);
  if (status === 401 || status === 403) return new Error(`${source} turned me away just now. Try again later.`);
  if (status >= 500) return new Error(`${source} is having trouble right now. Try again later.`);
  return new Error(`I couldn't reach ${source} just now. Try again in a minute.`);
}

/** Cached JSON with ETags (conditional requests): a 304 reuses the stored body. */
export async function cachedJson(db: Db, url: string, headers: Record<string, string> = {}): Promise<{ body: any; status: number; headers: Headers }> {
  const c = await db.one<{ etag: string | null; body: any }>(`SELECT etag, body FROM tech_cache WHERE key=$1`, [url]);
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers, ...(c?.etag ? { "if-none-match": c.etag } : {}) }, signal: AbortSignal.timeout(15_000) });
  if (r.status === 304 && c) return { body: typeof c.body === "string" ? JSON.parse(c.body) : c.body, status: 304, headers: r.headers };
  if (!r.ok) throw new HttpError(r.status, url, await r.text().catch(() => ""));
  const body = await r.json();
  const etag = r.headers.get("etag");
  await db.query(`INSERT INTO tech_cache (key, etag, body, at) VALUES ($1,$2,$3,now()) ON CONFLICT (key) DO UPDATE SET etag=EXCLUDED.etag, body=EXCLUDED.body, at=now()`, [url, etag, JSON.stringify(body)]);
  return { body, status: r.status, headers: r.headers };
}

/** Run `fn` over `items`, `n` at a time. */
export async function inBatches<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += n) await Promise.all(items.slice(i, i + n).map((x) => fn(x).catch((e) => log.warn({ err: (e as Error)?.message }, "tech batch item failed"))));
}

/* ---------- chains ---------- */

export interface EvmChain { key: string; id: number; name: string; rpc: string; native: string; explorer: string; coingecko: string }
const env = (k: string, d: string) => process.env[k] || d;
export const EVM: Record<string, EvmChain> = {
  ethereum: { key: "ethereum", id: 1, name: "Ethereum", rpc: env("RPC_ETHEREUM", "https://ethereum-rpc.publicnode.com"), native: "ETH", explorer: "https://etherscan.io", coingecko: "ethereum" },
  base: { key: "base", id: 8453, name: "Base", rpc: env("RPC_BASE", "https://base-rpc.publicnode.com"), native: "ETH", explorer: "https://basescan.org", coingecko: "ethereum" },
  arbitrum: { key: "arbitrum", id: 42161, name: "Arbitrum", rpc: env("RPC_ARBITRUM", "https://arbitrum-one-rpc.publicnode.com"), native: "ETH", explorer: "https://arbiscan.io", coingecko: "ethereum" },
  optimism: { key: "optimism", id: 10, name: "Optimism", rpc: env("RPC_OPTIMISM", "https://optimism-rpc.publicnode.com"), native: "ETH", explorer: "https://optimistic.etherscan.io", coingecko: "ethereum" },
  polygon: { key: "polygon", id: 137, name: "Polygon", rpc: env("RPC_POLYGON", "https://polygon-bor-rpc.publicnode.com"), native: "POL", explorer: "https://polygonscan.com", coingecko: "polygon-ecosystem-token" },
  bsc: { key: "bsc", id: 56, name: "BNB Chain", rpc: env("RPC_BSC", "https://bsc-rpc.publicnode.com"), native: "BNB", explorer: "https://bscscan.com", coingecko: "binancecoin" },
};
export const SOLANA_RPC = () => process.env.RPC_SOLANA || "https://api.mainnet-beta.solana.com";
export const CHAIN_WORDS = "eth|ethereum|mainnet|base|arb|arbitrum|op|optimism|polygon|matic|pol|bsc|bnb|bnb chain|binance|sol|solana";

/** "arb" → "arbitrum", "bnb chain" → "bsc", "sol" → "solana". */
export function chainOf(word?: string | null): string | null {
  const w = (word ?? "").toLowerCase().trim().replace(/^(?:the\s+)?/, "").replace(/\s+(?:chain|network|mainnet)$/, "");
  if (!w) return null;
  if (/^(?:eth|ethereum|mainnet|ethereum mainnet|l1)$/.test(w)) return "ethereum";
  if (/^base$/.test(w)) return "base";
  if (/^(?:arb|arbitrum|arbitrum one)$/.test(w)) return "arbitrum";
  if (/^(?:op|optimism)$/.test(w)) return "optimism";
  if (/^(?:polygon|matic|pol)$/.test(w)) return "polygon";
  if (/^(?:bsc|bnb|binance|bnb smart)$/.test(w)) return "bsc";
  if (/^(?:sol|solana)$/.test(w)) return "solana";
  return null;
}
export const chainName = (c: string) => (c === "solana" ? "Solana" : EVM[c]?.name ?? c);

export const isEvmAddress = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);
export const isSolAddress = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
export const isEvmHash = (s: string) => /^0x[0-9a-fA-F]{64}$/.test(s);
export const isSolSignature = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s);
export const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/** A plain amount: 1.5, 0.00042, 12,345.6. */
export function amount(n: number): string {
  if (!Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  if (a === 0) return "0";
  if (a >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a >= 1) return String(Number(n.toFixed(4)));
  return n.toLocaleString("en-US", { maximumSignificantDigits: 3, maximumFractionDigits: 18 });
}
export const units = (raw: bigint | string, decimals: number) => Number(BigInt(raw)) / 10 ** decimals;

/* ---------- secrets ---------- */

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[0-9a-zA-Z]{10,}/, "a Stripe key"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/\bAIza[0-9A-Za-z_-]{30,}/, "a Google key"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/, "a GitLab token"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/, "a login token"],
  [/\b(?:0x)?[0-9a-fA-F]{64}\b/, "a private key"],
  [/\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/, "a private key"],
];
/** If `s` looks like a key, token or seed phrase, a short description of what it looks like. */
export function looksSecret(s: string): string | null {
  for (const [re, what] of SECRET_PATTERNS) if (re.test(s)) return what;
  const words = s.trim().toLowerCase().split(/\s+/);
  if (words.length >= 12 && words.length <= 24 && words.every((w) => /^[a-z]{3,8}$/.test(w))) return "a seed phrase";
  // A long run of mixed letters and digits with no spaces reads as a token.
  if (s.split(/\s+/).some((w) => w.length >= 28 && /[a-z]/.test(w) && /[A-Z0-9]/.test(w) && /\d/.test(w) && !/^https?:/i.test(w))) return "a token";
  return null;
}
export const SECRET_REFUSAL = (what: string) => `That looks like ${what}, so I haven't kept it. I only ever keep a name, like "the Stripe key". If it's live, rotate it now, since it's been in a chat.`;
export const SEED_REFUSAL = "That looks like a private key or seed phrase, so I haven't kept it and I never will. I only take public addresses. If it's real, move the funds to a fresh wallet now.";

/* ---------- the outbox ---------- */

export type Level = "brief" | "daily" | "live" | "urgent";
export interface Button { label: string; data: string }

export async function queue(db: Db, userId: number, feature: string, level: Level, text: string, now: Date, button?: Button): Promise<void> {
  await db.query(`INSERT INTO tech_outbox (user_id, feature, level, text, button, created_at) VALUES ($1,$2,$3,$4,$5,$6)`, [userId, feature, level, text, button ? JSON.stringify(button) : null, now]);
}

/** Quiet hours, a quiet day or calm mode: nothing that isn't the person's own reminder goes out. */
export function holding(user: User, now: Date): boolean {
  if (inQuietHours(now, user.tz, user.quiet_start, user.quiet_end)) return true;
  if (Number(user.prefs?.quietUntil ?? 0) > now.getTime()) return true;
  return user.prefs?.calm === true;
}

const MAX_IN_ONE = 6;
/** One message per person with everything that may go out now. Returns how many people were reached. */
export async function flush(deps: SchedulerDeps, now = new Date(), only?: number[]): Promise<number> {
  const since = new Date(now.getTime() - 18 * 3_600_000);
  const rows = await deps.db.query<{ id: number; user_id: number; feature: string; level: Level; text: string; button: any }>(
    `SELECT id, user_id, feature, level, text, button FROM tech_outbox WHERE sent_at IS NULL AND briefed_at IS NULL AND level <> 'brief' AND created_at > $1 ${only ? "AND user_id = ANY($2::int[])" : ""} ORDER BY id`,
    only ? [since, only] : [since],
  );
  const byUser = new Map<number, typeof rows>();
  for (const r of rows) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  let reached = 0;
  for (const [uid, items] of byUser) {
    const user = await deps.getUser(uid);
    if (!user) continue;
    const day = localDay(now, user.tz);
    const pinged = new Set((await deps.db.query<{ feature: string }>(`SELECT feature FROM tech_pings WHERE user_id=$1 AND day=$2`, [uid, day])).map((p) => p.feature));
    const urgent = items.filter((i) => i.level === "urgent");
    const rest = items.filter((i) => i.level === "live" || (i.level === "daily" && !pinged.has(i.feature)));
    if (urgent.length && holding(user, now)) continue;
    const send = [...urgent, ...rest].slice(0, MAX_IN_ONE);
    if (!send.length) continue;
    const text = send.length === 1 ? send[0].text : ["From your watches:", ...send.map((i) => `- ${i.text}`)].join("\n");
    const buttons = send.map((i) => (typeof i.button === "string" ? JSON.parse(i.button) : i.button)).filter(Boolean).slice(0, 3) as Button[];
    const ok = await push(deps, user, "tech", text, { exempt: urgent.length > 0, buttons: buttons.length ? buttons : undefined, now });
    if (!ok) continue;
    reached++;
    await deps.db.query(`UPDATE tech_outbox SET sent_at=$2 WHERE id = ANY($1::int[])`, [send.map((i) => i.id), now]);
    for (const f of new Set(send.map((i) => i.feature))) await deps.db.query(`INSERT INTO tech_pings (user_id, feature, day) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [uid, f, day]);
  }
  await deps.db.query(`DELETE FROM tech_outbox WHERE created_at < $1`, [new Date(now.getTime() - 14 * 86_400_000)]);
  return reached;
}

/** Features that read as "work" in the brief; the rest are crypto. */
const DEV_FEATURES = new Set(["uptime", "expiry", "github", "packages", "status", "rotation"]);
const joinUp = (xs: string[], max = 3) => (xs.length <= max ? xs.join("; ") : `${xs.slice(0, max).join("; ")}; and ${xs.length - max} more`);
const sentence = (s: string) => (/[.?!]$/.test(s) ? s : `${s}.`);

/** Everything that didn't go out as a ping, as at most two lines: one for work, one for crypto. Shown for 12 hours, then gone. */
addBriefSection({
  key: "tech", order: 35,
  async lines(db, user, now, opts) {
    const rows = await db.query<{ id: number; feature: string; text: string; briefed_at: string | null }>(
      `SELECT id, feature, text, briefed_at FROM tech_outbox WHERE user_id=$1 AND sent_at IS NULL AND created_at > $2 AND (briefed_at IS NULL OR briefed_at > $3) ORDER BY id LIMIT 20`,
      [user.id, new Date(now.getTime() - 36 * 3_600_000), new Date(now.getTime() - 12 * 3_600_000)],
    );
    if (!rows.length) return [];
    if (!opts?.peek) await db.query(`UPDATE tech_outbox SET briefed_at=$2 WHERE id = ANY($1::int[]) AND briefed_at IS NULL`, [rows.map((r) => r.id), now]);
    const clean = (t: string) => t.replace(/\n+https?:\/\/\S+/g, "").replace(/\.$/, "").split("\n")[0];
    const dev = rows.filter((r) => DEV_FEATURES.has(r.feature)).map((r) => clean(r.text));
    const crypto = rows.filter((r) => !DEV_FEATURES.has(r.feature)).map((r) => clean(r.text));
    return [dev.length ? sentence(`Work: ${joinUp(dev)}`) : "", crypto.length ? sentence(`Crypto: ${joinUp(crypto)}`) : ""].filter(Boolean);
  },
});

/* ---------- dates ---------- */

export const dayLabel = (d: Date | string, tz: string) => DateTime.fromJSDate(typeof d === "string" ? new Date(d) : d).setZone(tz).toFormat("ccc d LLL");
export const daysUntil = (d: Date | string, now: Date) => Math.floor((new Date(d).getTime() - now.getTime()) / 86_400_000);
export function duration(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} minute${r === 1 ? "" : "s"}` : ""}`;
  return `${Math.round(h / 24)} days`;
}
