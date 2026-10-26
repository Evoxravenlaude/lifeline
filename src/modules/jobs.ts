/**
 * Jobs feed from keyless ATS boards (Greenhouse, Lever, Ashby) and remote
 * boards. Match-and-draft, never apply: the bot surfaces posts matching the
 * user's keywords and drafts outreach on request; the user sends it.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { onJob, push } from "../core/scheduler.js";
import { log } from "../core/log.js";

type Post = { external_id: string; title: string; url: string; location?: string };

const FETCHERS: Record<string, (slug: string) => Promise<Post[]>> = {
  greenhouse: async (slug) => {
    const j: any = await getJson(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`);
    return (j.jobs ?? []).map((x: any) => ({ external_id: String(x.id), title: x.title, url: x.absolute_url, location: x.location?.name }));
  },
  lever: async (slug) => {
    const j: any = await getJson(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return (j ?? []).map((x: any) => ({ external_id: x.id, title: x.text, url: x.hostedUrl, location: x.categories?.location }));
  },
  ashby: async (slug) => {
    const j: any = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    return (j.jobs ?? []).map((x: any) => ({ external_id: x.id, title: x.title, url: x.jobUrl, location: x.location }));
  },
  remoteok: async () => {
    const j: any = await getJson("https://remoteok.com/api");
    return (Array.isArray(j) ? j.slice(1) : []).map((x: any) => ({ external_id: String(x.id), title: `${x.position} — ${x.company}`, url: x.url, location: "remote" }));
  },
  remotive: async () => {
    const j: any = await getJson("https://remotive.com/api/remote-jobs?limit=200");
    return (j.jobs ?? []).map((x: any) => ({ external_id: String(x.id), title: `${x.title} — ${x.company_name}`, url: x.url, location: x.candidate_required_location }));
  },
};

async function getJson(url: string) {
  const r = await fetch(url, { headers: { "user-agent": "lifeline-bot/0.1", accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

const watch = defineAction({
  name: "jobs.watch",
  tier: 1,
  description: "Watch a job board. `ats` is greenhouse | lever | ashby | remoteok | remotive; `slug` is the company's board slug (e.g. 'dorahacks' on lever), ignored for remoteok/remotive. `keywords` filter titles (e.g. ['solana','growth','remote']).",
  schema: z.object({ ats: z.enum(["greenhouse", "lever", "ashby", "remoteok", "remotive"]), slug: z.string().optional(), keywords: z.array(z.string()).max(10).optional() }),
  async run(args, ctx) {
    const slug = args.slug ?? "-";
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO job_watches (user_id, ats, slug, keywords) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, ats, slug) DO UPDATE SET keywords=EXCLUDED.keywords, active=true RETURNING id`, [ctx.user.id, args.ats, slug, args.keywords ?? []]);
    return { reply: `Watching ${args.ats}${args.slug ? `/${args.slug}` : ""}${args.keywords?.length ? ` for ${args.keywords.join(", ")}` : ""}. New matches land in your digest.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE job_watches SET active=false WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Watch removed.";
  },
});

const list = defineAction({
  name: "jobs.list",
  tier: 1,
  description: "Show unseen job matches for the user's watches.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await matchesFor(ctx.db, ctx.user.id, 10);
    if (!rows.length) return { reply: "No new matches. Add watches with 'watch jobs lever dorahacks for growth'." };
    for (const r of rows) await ctx.db.query(`INSERT INTO job_seen (user_id, post_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ctx.user.id, r.id]);
    return { reply: rows.map((r: any) => `• ${r.title}${r.location ? ` (${r.location})` : ""}\n  ${r.url}`).join("\n") };
  },
});

export async function matchesFor(db: any, userId: number, limit: number) {
  return db.query(
    `SELECT DISTINCT p.id, p.title, p.url, p.location, p.first_seen FROM job_posts p
     JOIN job_watches w ON w.user_id=$1 AND w.active AND w.ats=p.ats AND (w.slug='-' OR w.slug=p.slug)
     WHERE NOT EXISTS (SELECT 1 FROM job_seen s WHERE s.user_id=$1 AND s.post_id=p.id)
       AND (cardinality(w.keywords)=0 OR EXISTS (SELECT 1 FROM unnest(w.keywords) k WHERE p.title ILIKE '%' || k || '%'))
     ORDER BY p.first_seen DESC LIMIT $2`,
    [userId, limit],
  );
}

onJob("poll_jobs", async (_job, deps) => {
  const watches = await deps.db.query<{ ats: string; slug: string }>(`SELECT DISTINCT ats, slug FROM job_watches WHERE active`);
  for (const w of watches) {
    try {
      const posts = await FETCHERS[w.ats](w.slug);
      for (const p of posts) {
        if (!p.url || !p.title) continue;
        await deps.db.query(`INSERT INTO job_posts (ats, slug, external_id, title, url, location) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [w.ats, w.slug, p.external_id, p.title, p.url, p.location ?? null]);
      }
    } catch (e: any) {
      log.warn({ ats: w.ats, slug: w.slug, err: e?.message }, "job poll failed");
    }
  }
});

register(watch, list);
