/**
 * Launch discovery on the free stack: Show HN, GitHub new repos by topic,
 * DexScreener boosted tokens gated by GoPlus. Novelty = first seen here;
 * risk = scanner flags (negative filter only — a clean scan is not an
 * endorsement). Founder contact lookup is drafted from self-published
 * sources (GitHub profile) and never from scraping.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { onJob } from "../core/scheduler.js";
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import type { Db } from "../core/db.js";

type Launch = { source: string; external_id: string; title: string; url: string; score?: number; risk?: string; tags?: string[]; raw?: unknown };

async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers: { "user-agent": "lifeline-bot/0.1", accept: "application/json", ...headers } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

export async function pollShowHN(): Promise<Launch[]> {
  const j: any = await getJson("https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&hitsPerPage=50");
  return (j.hits ?? []).map((h: any) => ({ source: "showhn", external_id: String(h.objectID), title: h.title.replace(/^Show HN:\s*/i, ""), url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`, score: h.points, tags: ["showhn"], raw: { hn: `https://news.ycombinator.com/item?id=${h.objectID}`, author: h.author } }));
}

export async function pollGitHub(topics: string[]): Promise<Launch[]> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  const out: Launch[] = [];
  for (const t of topics) {
    const j: any = await getJson(`https://api.github.com/search/repositories?q=topic:${encodeURIComponent(t)}+created:>${since}&sort=stars&order=desc&per_page=20`, config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {});
    for (const r of j.items ?? []) out.push({ source: "github", external_id: String(r.id), title: `${r.full_name}${r.description ? `: ${r.description.slice(0, 100)}` : ""}`, url: r.html_url, score: r.stargazers_count, tags: [t, ...(r.topics ?? [])], raw: { owner: r.owner?.login, owner_url: r.owner?.html_url, homepage: r.homepage } });
  }
  return out;
}

export async function pollDexBoosts(): Promise<Launch[]> {
  const j: any = await getJson("https://api.dexscreener.com/token-boosts/top/v1");
  const out: Launch[] = [];
  for (const t of (Array.isArray(j) ? j : []).slice(0, 30)) {
    let risk = "unscanned";
    try {
      if (t.chainId === "solana") {
        const g: any = await getJson(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${t.tokenAddress}`);
        const s = g.result?.[t.tokenAddress];
        risk = s ? (s.mintable?.status === "1" || s.freezable?.status === "1" ? "flagged" : "clean-scan") : "unscanned";
      } else {
        const chain = { ethereum: 1, bsc: 56, base: 8453, arbitrum: 42161, polygon: 137 }[t.chainId as string];
        if (chain) {
          const g: any = await getJson(`https://api.gopluslabs.io/api/v1/token_security/${chain}?contract_addresses=${t.tokenAddress}`);
          const s = g.result?.[t.tokenAddress.toLowerCase()];
          risk = s ? (s.is_honeypot === "1" || s.is_mintable === "1" || s.cannot_sell_all === "1" || Number(s.buy_tax ?? 0) > 0.1 ? "flagged" : "clean-scan") : "unscanned";
        }
      }
    } catch { /* leave unscanned */ }
    out.push({ source: "dexboost", external_id: `${t.chainId}:${t.tokenAddress}`, title: `${t.description?.slice(0, 80) ?? t.tokenAddress} on ${t.chainId}`, url: t.url, score: t.totalAmount, risk, tags: ["token", t.chainId], raw: t });
  }
  return out;
}

export async function upsertLaunches(db: Db, rows: Launch[]) {
  let n = 0;
  for (const r of rows) {
    const res = await db.query<{ inserted: boolean }>(`INSERT INTO launches (source, external_id, title, url, score, risk, tags, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (source, external_id) DO UPDATE SET score=EXCLUDED.score, risk=EXCLUDED.risk RETURNING (xmax=0) AS inserted`, [r.source, r.external_id, r.title, r.url, r.score ?? null, r.risk ?? null, r.tags ?? [], JSON.stringify(r.raw ?? {})]);
    if (res[0]?.inserted) n++;
  }
  return n;
}

onJob("poll_launches", async (_job, deps) => {
  const topics = (process.env.GITHUB_TOPICS ?? "ai-agents,defi,devtools,fintech,ethereum,solana").split(",");
  for (const [name, fn] of [["showhn", pollShowHN], ["github", () => pollGitHub(topics)], ["dexboost", pollDexBoosts]] as const) {
    try { log.info({ source: name, fresh: await upsertLaunches(deps.db, await fn()) }, "launch poll"); }
    catch (e: any) { log.warn({ source: name, err: e?.message }, "launch poll failed"); }
  }
});

const discover = defineAction({
  name: "launch.discover",
  tier: 1,
  description: "New product/repo/token launches not shown before. `source` optional: showhn | github | dexboost. Flagged tokens are never shown.",
  schema: z.object({ source: z.enum(["showhn", "github", "dexboost"]).optional(), limit: z.number().int().min(1).max(15).optional() }),
  async run(args, ctx) {
    const rows = await ctx.db.query<any>(
      `SELECT l.* FROM launches l WHERE ($2::text IS NULL OR l.source=$2) AND COALESCE(l.risk,'') <> 'flagged'
       AND NOT EXISTS (SELECT 1 FROM launch_seen s WHERE s.user_id=$1 AND s.launch_id=l.id) ORDER BY l.first_seen DESC, l.score DESC NULLS LAST LIMIT $3`,
      [ctx.user.id, args.source ?? null, args.limit ?? 8],
    );
    if (!rows.length) return { reply: "Nothing new since you last looked. I check Show HN, GitHub and the token boards every three hours." };
    for (const r of rows) await ctx.db.query(`INSERT INTO launch_seen (user_id, launch_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ctx.user.id, r.id]);
    const from: Record<string, string> = { showhn: "Show HN", github: "GitHub", dexboost: "token boards" };
    const tail = (r: any) => {
      const bits: string[] = [from[r.source] ?? r.source];
      if (r.source === "showhn" && r.score) bits.push(`${r.score} points`);
      if (r.source === "github" && r.score) bits.push(`${r.score} stars this week`);
      if (r.source === "dexboost") bits.push(r.risk === "clean-scan" ? "scan clean, not a recommendation" : "not scanned");
      return bits.join(", ");
    };
    const head = rows.length === 1 ? "One new launch." : `${rows.length} new launches, newest first.`;
    return { reply: [head, ...rows.map((r) => `${r.title}. ${tail(r)}.\n${r.url}`)].join("\n") };
  },
});

const contact = defineAction({
  name: "launch.contact",
  tier: 1,
  description: "Look up self-published contact info for a GitHub user or org (profile blog/website, public email, Twitter handle) and draft a short reply/outreach the user can send. Never sends.",
  schema: z.object({ github_login: z.string().min(1), about: z.string().optional() }),
  async run(args) {
    const p: any = await getJson(`https://api.github.com/users/${encodeURIComponent(args.github_login)}`, config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {});
    const lines = [`${p.name ?? p.login}${p.bio ? `, ${p.bio}` : ""}.`];
    const ways: string[] = [];
    if (p.blog) ways.push(`site ${p.blog}`);
    if (p.email) ways.push(`public email ${p.email}`);
    if (p.twitter_username) ways.push(`@${p.twitter_username} on X`);
    ways.push(`GitHub ${p.html_url}`);
    lines.push(`Ways in: ${ways.join(", ")}.`);
    lines.push("", "A first message you could send, edit it first:", `Hi ${p.name?.split(" ")[0] ?? p.login}, saw ${args.about ?? "your project"} on GitHub. I build on similar ground and had one concrete question: [your question]. Happy to share what we've learned if useful. [you]`);
    lines.push("", "A public reply or the project's own inbox is the safe route in the UK, EU and Nigeria; a personal email needs their consent first.");
    return { reply: lines.join("\n") };
  },
});

register(discover, contact);
