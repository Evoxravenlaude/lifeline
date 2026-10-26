/**
 * Scout: new and upcoming projects in a niche (web3, crypto, AI, tech, web2)
 * with their official socials and their founders'/handlers' public handles.
 *
 * Sources, all self-published or open: GitHub (repos, org members, profile
 * socials), CoinGecko (coin links), DefiLlama (protocol twitter/url), Show HN,
 * and — when a Gemini key is set — Google-grounded search to fill official
 * X/Telegram/Discord and founder handles with citations. No LinkedIn, no
 * Telegram-group scraping, no wallet-to-person attribution. Outreach is
 * drafted; the user sends it.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { onJob } from "../core/scheduler.js";
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import { complete, providerName } from "../intent/providers.js";
import type { Db } from "../core/db.js";

export interface ScoutHit {
  name: string;
  url?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  discord?: string | null;
  github?: string | null;
  founders: { name?: string; handle?: string; role?: string; source: string }[];
  objective?: string | null;
  sources: string[];
  raw?: unknown;
}

const UA = { "user-agent": "lifeline-bot/0.1", accept: "application/json" };
async function getJson(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}
const gh = (): Record<string, string> => (config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {});
const handle = (s?: string | null) => (s ? s.replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "").replace(/^@/, "").split(/[/?]/)[0] : null);

/* ---------- structured sources ---------- */

export async function fromGitHub(niche: string, limit: number): Promise<ScoutHit[]> {
  const since = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
  const j: any = await getJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(niche)}+created:>${since}&sort=stars&order=desc&per_page=${limit}`, gh());
  const out: ScoutHit[] = [];
  for (const r of j.items ?? []) {
    const hit: ScoutHit = { name: r.name, url: r.homepage || r.html_url, github: r.html_url, founders: [], objective: r.description, sources: ["github"], raw: { stars: r.stargazers_count, topics: r.topics } };
    try {
      if (r.owner?.type === "Organization") {
        const members: any[] = await getJson(`https://api.github.com/orgs/${r.owner.login}/public_members?per_page=5`, gh());
        for (const m of members.slice(0, 5)) {
          const p: any = await getJson(`https://api.github.com/users/${m.login}`, gh());
          hit.founders.push({ name: p.name ?? p.login, handle: p.twitter_username ? `@${p.twitter_username}` : `gh:${p.login}`, source: "github-public-member" });
        }
        const org: any = await getJson(`https://api.github.com/orgs/${r.owner.login}`, gh());
        if (org.twitter_username) hit.twitter = `@${org.twitter_username}`;
        if (org.blog && !hit.url) hit.url = org.blog;
      } else {
        const p: any = await getJson(`https://api.github.com/users/${r.owner.login}`, gh());
        hit.founders.push({ name: p.name ?? p.login, handle: p.twitter_username ? `@${p.twitter_username}` : `gh:${p.login}`, source: "github-profile" });
        if (p.twitter_username && !hit.twitter) hit.twitter = `@${p.twitter_username}`;
      }
    } catch { /* partial is fine */ }
    out.push(hit);
  }
  return out;
}

export async function fromCoinGecko(niche: string, limit: number): Promise<ScoutHit[]> {
  const s: any = await getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(niche)}`);
  const out: ScoutHit[] = [];
  for (const c of (s.coins ?? []).slice(0, limit)) {
    try {
      const d: any = await getJson(`https://api.coingecko.com/api/v3/coins/${c.id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`);
      const l = d.links ?? {};
      out.push({
        name: d.name, url: l.homepage?.[0] || null, twitter: l.twitter_screen_name ? `@${l.twitter_screen_name}` : null,
        telegram: l.telegram_channel_identifier ? `t.me/${l.telegram_channel_identifier}` : null,
        discord: (l.chat_url ?? []).find((u: string) => /discord/.test(u)) ?? null,
        github: l.repos_url?.github?.[0] ?? null, founders: [], objective: d.description?.en?.slice(0, 200) ?? null, sources: ["coingecko"], raw: { rank: d.market_cap_rank, genesis: d.genesis_date },
      });
    } catch { /* rate limited; skip */ }
  }
  return out;
}

export async function fromDefiLlama(niche: string, limit: number): Promise<ScoutHit[]> {
  const j: any[] = await getJson("https://api.llama.fi/protocols");
  const q = niche.toLowerCase();
  return j
    .filter((p) => [p.name, p.category, p.description, ...(p.chains ?? [])].join(" ").toLowerCase().includes(q))
    .sort((a, b) => new Date(b.listedAt ? b.listedAt * 1000 : 0).getTime() - new Date(a.listedAt ? a.listedAt * 1000 : 0).getTime())
    .slice(0, limit)
    .map((p) => ({ name: p.name, url: p.url, twitter: p.twitter ? `@${p.twitter}` : null, github: p.github?.[0] ? `https://github.com/${p.github[0]}` : null, founders: [], objective: p.description?.slice(0, 200), sources: ["defillama"], raw: { tvl: p.tvl, category: p.category, chains: p.chains } }));
}

export async function fromShowHN(niche: string, limit: number): Promise<ScoutHit[]> {
  const j: any = await getJson(`https://hn.algolia.com/api/v1/search_by_date?tags=show_hn&query=${encodeURIComponent(niche)}&hitsPerPage=${limit}`);
  return (j.hits ?? []).map((h: any) => ({ name: h.title.replace(/^Show HN:\s*/i, "").slice(0, 80), url: h.url, founders: [{ handle: `hn:${h.author}`, source: "hn-author" }], objective: null, sources: ["showhn"], raw: { points: h.points, hn: `https://news.ycombinator.com/item?id=${h.objectID}` } }));
}

/* ---------- grounded enrichment (Gemini + Google Search) ---------- */

const EnrichSchema = z.object({
  projects: z.array(z.object({
    name: z.string(),
    url: z.string().nullable().optional(),
    twitter: z.string().nullable().optional(),
    telegram: z.string().nullable().optional(),
    discord: z.string().nullable().optional(),
    stage: z.string().nullable().optional(),
    founders: z.array(z.object({ name: z.string().optional(), handle: z.string().optional(), role: z.string().optional() })).default([]),
  })),
});

export async function enrichWithSearch(niche: string, objective: string | undefined, hits: ScoutHit[]): Promise<ScoutHit[]> {
  if (!config.geminiKey) return hits;
  const names = hits.slice(0, 10).map((h) => h.name);
  const prompt = `Niche: ${niche}${objective ? `. User objective: ${objective}` : ""}.
For each of these projects, and up to 5 more NEW or UPCOMING projects in this niche you find (launched or announced in the last 6 months, any of web3/crypto/AI/tech/web2 as the niche implies), return the OFFICIAL X/Twitter handle, Telegram, Discord, website, stage (pre-launch, testnet, beta, live, raising), and the founders or community handlers with their PUBLIC X handles and roles — only handles they publish themselves on the project site, X bio, GitHub, or press. Do not guess; use null when unsure.
Projects: ${names.join(", ")}
Return JSON: {"projects":[{"name","url","twitter","telegram","discord","stage","founders":[{"name","handle","role"}]}]}`;
  try {
    const res = await complete({ system: "You are a research assistant. Use web search. Output only JSON.", messages: [{ role: "user", content: prompt }], grounded: true, json: true, maxTokens: 2500 }, "gemini");
    if (!res?.text) return hits;
    const parsed = EnrichSchema.safeParse(JSON.parse(res.text.replace(/^```json|```$/g, "").trim()));
    if (!parsed.success) return hits;
    const cites = (res.grounding ?? []).map((g) => g.uri);
    const byName = new Map(hits.map((h) => [h.name.toLowerCase(), h]));
    for (const p of parsed.data.projects) {
      const h = byName.get(p.name.toLowerCase()) ?? { name: p.name, founders: [], sources: [], raw: {} };
      h.url ||= p.url ?? null; h.twitter ||= handle(p.twitter) ? `@${handle(p.twitter)}` : null; h.telegram ||= p.telegram ?? null; h.discord ||= p.discord ?? null;
      if (p.stage) h.objective = `${p.stage}${h.objective ? ` · ${h.objective}` : ""}`;
      for (const f of p.founders) if (f.handle || f.name) h.founders.push({ name: f.name, handle: f.handle ? `@${handle(f.handle)}` : undefined, role: f.role, source: "web-grounded" });
      h.sources = [...new Set([...h.sources, "gemini-search", ...cites.slice(0, 3)])];
      byName.set(h.name.toLowerCase(), h);
    }
    return [...byName.values()];
  } catch (e: any) {
    log.warn({ err: e?.message }, "scout enrichment failed");
    return hits;
  }
}

/* ---------- orchestration ---------- */

export async function scout(db: Db, niche: string, objective?: string, limit = 8): Promise<ScoutHit[]> {
  const results: ScoutHit[] = [];
  for (const [name, fn] of [["github", fromGitHub], ["coingecko", fromCoinGecko], ["defillama", fromDefiLlama], ["showhn", fromShowHN]] as const) {
    try { results.push(...(await fn(niche, Math.ceil(limit / 2)))); }
    catch (e: any) { log.warn({ source: name, err: e?.message }, "scout source failed"); }
  }
  // merge by name
  const merged = new Map<string, ScoutHit>();
  for (const h of results) {
    const k = h.name.toLowerCase();
    const cur = merged.get(k);
    if (!cur) { merged.set(k, h); continue; }
    cur.url ||= h.url; cur.twitter ||= h.twitter; cur.telegram ||= h.telegram; cur.discord ||= h.discord; cur.github ||= h.github; cur.objective ||= h.objective;
    cur.founders.push(...h.founders); cur.sources = [...new Set([...cur.sources, ...h.sources])];
  }
  const enriched = await enrichWithSearch(niche, objective, [...merged.values()]);
  for (const h of enriched) {
    await db.query(
      `INSERT INTO scout_results (niche, name, url, twitter, telegram, discord, github, founders, objective, sources, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (niche, name) DO UPDATE SET url=COALESCE(EXCLUDED.url, scout_results.url), twitter=COALESCE(EXCLUDED.twitter, scout_results.twitter), telegram=COALESCE(EXCLUDED.telegram, scout_results.telegram),
         discord=COALESCE(EXCLUDED.discord, scout_results.discord), github=COALESCE(EXCLUDED.github, scout_results.github), founders=EXCLUDED.founders, objective=COALESCE(EXCLUDED.objective, scout_results.objective), sources=EXCLUDED.sources`,
      [niche.toLowerCase(), h.name, h.url ?? null, h.twitter ?? null, h.telegram ?? null, h.discord ?? null, h.github ?? null, JSON.stringify(h.founders), h.objective ?? null, h.sources, JSON.stringify(h.raw ?? {})],
    );
  }
  return enriched;
}

export function fmtHit(h: any): string {
  const socials = [h.url, h.twitter, h.telegram, h.discord, h.github].filter(Boolean).join(" · ");
  const founders = (typeof h.founders === "string" ? JSON.parse(h.founders) : h.founders ?? [])
    .filter((f: any, i: number, a: any[]) => a.findIndex((x) => (x.handle ?? x.name) === (f.handle ?? f.name)) === i)
    .slice(0, 4)
    .map((f: any) => `${f.name ?? ""}${f.handle ? ` ${f.handle}` : ""}${f.role ? ` (${f.role})` : ""}`.trim())
    .join(", ");
  return `• ${h.name}${h.objective ? ` — ${String(h.objective).slice(0, 90)}` : ""}\n  ${socials || "no socials found"}${founders ? `\n  people: ${founders}` : ""}`;
}

const find = defineAction({
  name: "scout.find",
  tier: 1,
  description: "Find new/upcoming projects in a niche (e.g. 'solana perps', 'ai agents', 'fintech africa', 'devtools') with official socials and founders' public handles. `objective` tells the ranking what the user wants (partner, hire, invest, sponsor, apply, learn).",
  schema: z.object({ niche: z.string().min(2), objective: z.string().optional(), limit: z.number().int().min(1).max(15).optional() }),
  async run(args, ctx) {
    const hits = await scout(ctx.db, args.niche, args.objective, args.limit ?? 8);
    if (!hits.length) return { reply: `Nothing surfaced for "${args.niche}". Try a broader or different phrasing.` };
    const rows = await ctx.db.query<any>(`SELECT * FROM scout_results WHERE niche=$1 AND NOT EXISTS (SELECT 1 FROM scout_seen s WHERE s.user_id=$2 AND s.result_id=scout_results.id) ORDER BY first_seen DESC LIMIT $3`, [args.niche.toLowerCase(), ctx.user.id, args.limit ?? 8]);
    for (const r of rows) await ctx.db.query(`INSERT INTO scout_seen (user_id, result_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ctx.user.id, r.id]);
    const body = (rows.length ? rows : hits.slice(0, args.limit ?? 8)).map(fmtHit).join("\n");
    const note = config.geminiKey ? "" : "\n\n(Set GEMINI_API_KEY for web-grounded founder lookup; this run used GitHub, CoinGecko, DefiLlama and Show HN only.)";
    return { reply: `${args.niche} — ${rows.length || hits.length} projects${args.objective ? ` for: ${args.objective}` : ""}\n${body}${note}\n\nSay "contact <github user>" or "draft outreach to <project>" for a message you send yourself.` };
  },
});

const watch = defineAction({
  name: "scout.watch",
  tier: 1,
  description: "Keep scouting a niche every 12h and put new projects in the digest.",
  schema: z.object({ niche: z.string().min(2), objective: z.string().optional() }),
  async run(args, ctx) {
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO scout_watches (user_id, niche, objective) VALUES ($1,$2,$3) ON CONFLICT (user_id, niche) DO UPDATE SET objective=EXCLUDED.objective, active=true RETURNING id`, [ctx.user.id, args.niche.toLowerCase(), args.objective ?? null]);
    return { reply: `Scouting "${args.niche}" every 12h.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE scout_watches SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Scout watch removed.";
  },
});

const outreach = defineAction({
  name: "scout.draft_outreach",
  tier: 1,
  description: "Draft a short outreach message to a scouted project or person, for the user to send themselves. Give the project name and what the user wants.",
  schema: z.object({ project: z.string(), ask: z.string() }),
  async run(args, ctx) {
    const row = await ctx.db.one<any>(`SELECT * FROM scout_results WHERE name ILIKE $1 ORDER BY first_seen DESC LIMIT 1`, [`%${args.project}%`]);
    const { draftReply } = await import("../intent/model.js");
    const who = row ? `${row.name}${row.twitter ? ` (${row.twitter})` : ""}${row.objective ? ` — ${row.objective}` : ""}` : args.project;
    const draft = await draftReply(ctx.db, ctx.user, `Project: ${who}\nWhat I want: ${args.ask}`, "Write a 3–5 sentence first message: specific, one concrete ask, no flattery, signed with the user's first name. Output the message only.");
    const route = row?.twitter ? `Send it as a public reply or DM to ${row.twitter}.` : "Send it through their public channel or site contact.";
    return { reply: `${draft ?? `Hi — I'm ${ctx.user.name ?? "[name]"}. ${args.ask}. [add one specific line about their project]`}\n\n${route} For people in the UK/EU/Nigeria, a personal email needs their consent; a public reply doesn't.` };
  },
});

export async function unseenForWatches(db: Db, userId: number, limit = 5) {
  return db.query<any>(
    `SELECT r.* FROM scout_results r JOIN scout_watches w ON w.user_id=$1 AND w.active AND w.niche=r.niche
     WHERE NOT EXISTS (SELECT 1 FROM scout_seen s WHERE s.user_id=$1 AND s.result_id=r.id) ORDER BY r.first_seen DESC LIMIT $2`,
    [userId, limit],
  );
}

onJob("poll_scout", async (_job, deps) => {
  const niches = await deps.db.query<{ niche: string; objective: string | null }>(`SELECT DISTINCT niche, objective FROM scout_watches WHERE active`);
  for (const n of niches) {
    try { await scout(deps.db, n.niche, n.objective ?? undefined, 8); }
    catch (e: any) { log.warn({ niche: n.niche, err: e?.message }, "scout poll failed"); }
  }
});

register(find, watch, outreach);
