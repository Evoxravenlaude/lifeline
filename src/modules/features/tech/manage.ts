/**
 * One list and one off switch for everything in Work, code and crypto:
 * "my watches" shows it all, "stop watching mysite.com" or "stop gas alerts" ends any of it.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCues, addExamples, addRules } from "../../../core/plugins.js";
import type { Ctx } from "../../../policy/types.js";
import { chainName, short } from "./shared.js";
import { watchedWallets } from "./crypto.js";

const ONLY = ["sites", "github", "packages", "status", "wallets", "alerts", "rotations", "claims"] as const;
type Only = (typeof ONLY)[number];
const day = (d: any, tz = "UTC") => (d ? DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat("d LLL") : "");
const pct = (x: number) => `${(x * 100).toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}%`;

async function sections(ctx: Ctx, only?: Only): Promise<string[]> {
  const { db, user } = ctx;
  const q = (sql: string) => db.query<any>(sql, [user.id]);
  const out: string[] = [];
  const want = (k: Only) => !only || only === k;
  if (want("sites")) {
    for (const m of await q(`SELECT * FROM tech_monitors WHERE user_id=$1 AND active ORDER BY id`)) {
      const st = m.down_since ? `down since ${DateTime.fromJSDate(new Date(m.down_since)).setZone(user.tz).toFormat("HH:mm")}` : m.last_status?.startsWith("up") ? "up" : m.last_status ? "not answering" : "waiting for the first check";
      const extra = [m.cert_expires ? `certificate to ${day(m.cert_expires, user.tz)}` : "", m.domain_expires ? `domain to ${day(m.domain_expires, user.tz)}` : ""].filter(Boolean).join(", ");
      out.push(`- ${m.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}: ${st}${extra ? `; ${extra}` : ""}`);
    }
  }
  if (want("github")) for (const g of await q(`SELECT repo, kind FROM tech_gh WHERE user_id=$1 AND active ORDER BY repo`)) out.push(`- ${g.repo}: ${({ releases: "releases", ci: "failed CI runs", mentions: "mentions" } as any)[g.kind]}`);
  if (want("packages")) {
    const p = await q(`SELECT registry, name, last_version FROM tech_pkgs WHERE user_id=$1 AND active ORDER BY name`);
    if (p.length) out.push(`- Packages: ${p.map((x) => `${x.name} (${x.registry}, ${x.last_version})`).join(", ")}`);
  }
  if (want("status")) {
    const s = await q(`SELECT name FROM tech_status WHERE user_id=$1 AND active ORDER BY name`);
    if (s.length) out.push(`- Status pages: ${s.map((x) => x.name).join(", ")}`);
  }
  if (want("wallets")) {
    const state = new Map((await q(`SELECT * FROM tech_wallet_state WHERE user_id=$1`)).map((s) => [`${s.chain}|${s.address}`, s]));
    for (const w of await watchedWallets(db, user.id)) {
      const s = state.get(`${w.chain}|${w.address}`);
      const note = w.chain !== "solana" && !process.env.ETHERSCAN_API_KEY ? " (waiting for an Etherscan key on the server)" : s?.last_error ? (/^etherscan: /.test(s.last_error) ? ` (Etherscan said: ${s.last_error.replace(/^etherscan: /, "").replace(/\.$/, "")})` : " (the last check didn't go through)") : "";
      out.push(`- Wallet ${w.label ?? short(w.address)} on ${chainName(w.chain)}: activity alerts${note}`);
    }
  }
  if (want("alerts")) {
    for (const g of await q(`SELECT chain, below FROM tech_gas_alerts WHERE user_id=$1 AND active ORDER BY id`)) out.push(`- ${chainName(g.chain)} gas under ${Number(g.below)} gwei`);
    for (const a of await q(`SELECT coin, kind, op, threshold FROM tech_perp_alerts WHERE user_id=$1 AND active ORDER BY id`)) out.push(a.kind === "move" ? `- ${a.coin} perp moving ${Number(a.threshold)}%` : `- ${a.coin} funding ${a.op} ${pct(Number(a.threshold))} per 8 hours`);
    for (const a of await q(`SELECT coin, op, target, pct_window FROM price_alerts WHERE user_id=$1 AND active ORDER BY id`)) out.push(a.op === "move" ? `- ${a.coin} moving ${Number(a.target)}% in ${a.pct_window} hours` : `- ${a.coin} ${a.op} $${Number(a.target).toLocaleString("en-US")}`);
    for (const m of await q(`SELECT question, last, move_pts FROM tech_markets WHERE user_id=$1 AND active ORDER BY id`)) out.push(`- "${m.question}": Yes ${m.last != null ? `${Math.round(Number(m.last) * 100)}%` : "?"}, alert on ${Number(m.move_pts)} points`);
  }
  if (want("rotations")) for (const r of await q(`SELECT name, every_days, next_due FROM tech_rotations WHERE user_id=$1 AND active ORDER BY next_due`)) out.push(`- Rotate the ${r.name} every ${r.every_days} days, next ${day(r.next_due)}`);
  if (want("claims")) for (const c of await q(`SELECT kind, title, due FROM tech_claims WHERE user_id=$1 AND NOT done AND due >= current_date - 1 ORDER BY due`)) out.push(`- ${c.kind === "unlock" ? "Unlock" : c.kind === "claim" ? "Claim" : "Deadline"}: ${c.title}, ${day(c.due)}`);
  return out;
}

const EMPTY: Record<string, string> = {
  sites: "I'm not watching any sites yet. Say \"watch https://mysite.com\" to start.",
  claims: "No claims or unlocks coming up. Say \"claim window for Jupiter closes 15 Dec\" to add one.",
  rotations: "No rotation reminders yet. Say \"rotate the Stripe key every 90 days\" to set one.",
};

const watches = defineAction({
  name: "tech.watches",
  tier: 1,
  description: "List what the person has asked me to watch in Work, code and crypto: sites (uptime), GitHub repos, packages, status pages, wallets, gas / funding / Polymarket alerts, key rotations and claims. `only` narrows it to one of: sites, github, packages, status, wallets, alerts, rotations, claims.",
  schema: z.object({ only: z.enum(ONLY).optional() }),
  async run(args, ctx) {
    const lines = await sections(ctx, args.only);
    if (!lines.length) return { reply: EMPTY[args.only ?? ""] ?? "Nothing on watch yet. Try \"watch https://mysite.com\", \"watch npm react\", \"gas now\" or \"claim window for Jupiter closes 15 Dec\"." };
    const shown = lines.slice(0, 12);
    return { reply: [`${args.only === "claims" ? "Coming up" : "On watch"}:`, ...shown, ...(lines.length > 12 ? [`- and ${lines.length - 12} more`] : []), "Say \"stop watching\" and a name to end any of them."].join("\n") };
  },
});

/** Tables an off switch can reach, and how to find a match in each. */
const TARGETS: { table: string; col: string; label: string; where: string; cat: RegExp; off: string; on: string }[] = [
  { table: "tech_monitors", col: "url", label: "url", where: "url ILIKE $2", cat: /^(?:uptime|sites?|monitors?|websites?)$/i, off: "active=false", on: "active=true" },
  { table: "tech_gh", col: "repo", label: "repo || ' ' || kind", where: "repo ILIKE $2", cat: /^(?:github|ci|releases?|repos?|mentions?)$/i, off: "active=false", on: "active=true" },
  { table: "tech_pkgs", col: "name", label: "name", where: "(name ILIKE $2 OR registry || ' ' || name ILIKE $2)", cat: /^(?:packages?|npm|pypi|crates|releases?)$/i, off: "active=false", on: "active=true" },
  { table: "tech_status", col: "name", label: "name || ' status'", where: "(name ILIKE $2 OR service ILIKE $2 OR name || ' status' ILIKE $2)", cat: /^(?:status|status pages?|outages?|incidents?)$/i, off: "active=false", on: "active=true" },
  { table: "tech_wallets", col: "address", label: "COALESCE(label, address)", where: "(address ILIKE $2 OR label ILIKE $2)", cat: /^(?:wallets?|wallet activity|activity|transactions?)$/i, off: "alerts=false", on: "alerts=true" },
  { table: "tech_gas_alerts", col: "chain", label: "chain || ' gas'", where: "(chain ILIKE $2 OR chain || ' gas' ILIKE $2)", cat: /^(?:gas|gwei|fees?)$/i, off: "active=false", on: "active=true" },
  { table: "tech_perp_alerts", col: "coin", label: "coin || ' ' || kind", where: "(coin ILIKE $2 OR coin || ' ' || kind ILIKE $2 OR coin || ' perp' ILIKE $2)", cat: /^(?:funding|perps?|perp moves?)$/i, off: "active=false", on: "active=true" },
  { table: "tech_markets", col: "question", label: "question", where: "question ILIKE $2", cat: /^(?:markets?|polymarket|odds|prediction markets?)$/i, off: "active=false", on: "active=true" },
  { table: "tech_rotations", col: "name", label: "name", where: "name ILIKE $2", cat: /^(?:rotations?|rotation reminders?|keys?)$/i, off: "active=false", on: "active=true" },
  { table: "tech_claims", col: "title", label: "title", where: "title ILIKE $2", cat: /^(?:claims?|unlocks?|airdrops?)$/i, off: "done=true", on: "done=false" },
];
const ACTIVE: Record<string, string> = { tech_wallets: "alerts", tech_claims: "NOT done" };

const unwatch = defineAction({
  name: "tech.unwatch",
  tier: 1,
  description: "Stop watching something in Work, code and crypto: a site, repo, package, status page, wallet, market or rotation by name, or a whole kind ('gas', 'funding', 'wallet', 'status', 'claims', 'uptime', 'github', 'packages', 'markets', 'rotations'). Also mutes activity alerts for a portfolio wallet without removing it from the portfolio.",
  schema: z.object({ match: z.string().min(2).max(200) }),
  async run(args, ctx) {
    const raw = args.match.trim().replace(/^(?:the|my|all(?: my)?)\s+/i, "").replace(/\s+(?:alerts?|watch(?:es)?|reminders?|pings?|notifications?)$/i, "").replace(/^https?:\/\//i, "").replace(/\/$/, "");
    const like = `%${raw}%`;
    const stopped: { table: string; id: number; label: string }[] = [];
    const muted: number[] = [];
    const byCat = TARGETS.filter((t) => t.cat.test(raw));
    for (const t of byCat.length ? byCat : TARGETS) {
      const active = ACTIVE[t.table] ?? "active";
      const rows = await ctx.db.query<{ id: number; label: string }>(
        `UPDATE ${t.table} SET ${t.off} WHERE user_id=$1 AND ${active} AND ${byCat.length ? "true" : t.where} RETURNING id, ${t.label} AS label`,
        byCat.length ? [ctx.user.id] : [ctx.user.id, like],
      );
      stopped.push(...rows.map((r) => ({ table: t.table, id: r.id, label: r.label })));
    }
    // Portfolio wallets (the core table, read only): mute their activity alerts with a row of our own.
    const portfolio = (await watchedWallets(ctx.db, ctx.user.id)).filter((w) => w.source === "portfolio" && (/^(?:wallets?|wallet activity|activity|transactions?)$/i.test(raw) || (!byCat.length && (w.address.toLowerCase().includes(raw.toLowerCase()) || (w.label ?? "").toLowerCase().includes(raw.toLowerCase())))));
    for (const w of portfolio) {
      const r = await ctx.db.one<{ id: number }>(`INSERT INTO tech_wallets (user_id, chain, address, label, alerts) VALUES ($1,$2,$3,$4,false) ON CONFLICT (user_id, chain, address) DO UPDATE SET alerts=false RETURNING id`, [ctx.user.id, w.chain, w.address, w.label]);
      muted.push(r!.id);
      stopped.push({ table: "portfolio", id: r!.id, label: w.label ?? short(w.address) });
    }
    if (!stopped.length) return { reply: `I'm not watching anything matching "${args.match}". Say "my watches" to see the list.` };
    for (const s of stopped) if (s.table === "tech_gas_alerts") s.label = `${chainName(s.label.replace(/ gas$/, ""))} gas`;
    const names = [...new Set(stopped.map((s) => s.label.replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/ (releases|ci|mentions|funding|move)$/, (_m, k) => ({ releases: " releases", ci: " CI", mentions: " mentions", funding: " funding", move: " perp moves" } as any)[k])))];
    const list = names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
    const note = muted.length ? " Wallets stay in your portfolio; only their activity alerts stop." : "";
    return { reply: `Stopped ${stopped.length === 1 ? "watching" : `${stopped.length} watches:`} ${list}.${note}`, undo: { payload: { items: stopped.filter((s) => s.table !== "portfolio").map((s) => [s.table, s.id]), muted } } };
  },
  async undo(p, ctx) {
    for (const [table, id] of p.items as [string, number][]) {
      const t = TARGETS.find((x) => x.table === table);
      if (t) await ctx.db.query(`UPDATE ${t.table} SET ${t.on} WHERE id=$1 AND user_id=$2`, [id, ctx.user.id]);
    }
    if (p.muted?.length) await ctx.db.query(`DELETE FROM tech_wallets WHERE id = ANY($1::int[]) AND user_id=$2 AND NOT alerts`, [p.muted, ctx.user.id]);
    return "Back on watch.";
  },
});

register(watches, unwatch);

addRules(
  [/^(?:my|show(?: me)? my|list(?: my)?)\s+(?:tech\s+|dev\s+|crypto\s+)?watch(?:es|list)$|^what(?:'s| is| are) (?:you|u) watching(?: for me)?\??$|^what am i watching\??$/i, () => ({ action: "tech.watches", args: {} })],
  [/^(?:my|show(?: me)? my|list(?: my)?)\s+(?:uptime\s+)?(monitors|monitored sites|watched sites|sites)$/i, () => ({ action: "tech.watches", args: { only: "sites" } })],
  [/^(?:my|show(?: me)? my|list(?: my)?)\s+(claims|unlocks|airdrops|claims and unlocks|airdrop claims)$/i, () => ({ action: "tech.watches", args: { only: "claims" } })],
  [/^(?:my|show(?: me)? my|list(?: my)?)\s+(?:key\s+|secret\s+)?rotations?(?: reminders)?$/i, () => ({ action: "tech.watches", args: { only: "rotations" } })],
  [/^(?:my|show(?: me)? my|list(?: my)?)\s+(?:crypto\s+)?alerts$/i, () => ({ action: "tech.watches", args: { only: "alerts" } })],
  [/^(?:stop|quit)\s+(?:watching|monitoring)\s+(?!(?:my|the|our)\s+(?:mood|sleep|weight|spending|money|budget|habits?|health|cycle|period|diet|food|steps|water|stress|energy|kids?|children|house|home|family|friends?|phone|screen ?time|jobs?)\b)(?!(?:jobs?|job boards?|tv|telly|me|us|him|her|them|it|that|this|the (?:game|match|news|show|film|movie)|movies?|films?|netflix|youtube|porn|anime|series|shows?|football|soccer|sports?|the clock|my back)\b)(.{3,})$|^unwatch\s+(.{2,})$/i, (m) => ({ action: "tech.unwatch", args: { match: m[1] ?? m[2] } })],
  [/^(?:stop|cancel|turn off|no more|mute)\s+(?:the\s+|my\s+|all\s+(?:my\s+|the\s+)?)?((?:[A-Za-z0-9.]{2,12}\s+)?(?:gas|funding|wallet|wallet activity|status|status page|uptime|site|github|ci|release|package|market|polymarket|perp|rotation|claim|unlock|airdrop))\s+(?:alerts?|watch(?:es)?|reminders?|pings?|notifications?)$/i, (m) => ({ action: "tech.unwatch", args: { match: m[1] } })],
);
addExamples("tech.watches", ["my watches", "what are you watching for me", "my monitors", "my claims", "my rotations"]);
addExamples("tech.unwatch", ["stop watching mysite.com", "stop watching vercel/next.js", "unwatch react", "stop gas alerts", "stop the funding alerts", "stop wallet alerts"]);
addCues("tech", ["my watches", "watching", "stop watching", "unwatch", "stop alerts", "monitors"]);
