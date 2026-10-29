/**
 * Dev watches: uptime (with TLS certificate and domain expiry), GitHub releases / CI / mentions,
 * package releases on npm, PyPI and crates.io, and service status pages.
 * Polled by system jobs; everything they find goes through the outbox in shared.ts, merged.
 */
import tls from "node:tls";
import { z } from "zod";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema, addSystemJob } from "../../../core/plugins.js";
import { onJob, type SchedulerDeps } from "../../../core/scheduler.js";
import { config } from "../../../core/config.js";
import { log } from "../../../core/log.js";
import type { Db } from "../../../core/db.js";
import { BlockedAddress, checkPublic, publicFetch, safeLookup } from "../../../core/safefetch.js";
import { cachedJson, dayLabel, daysUntil, duration, flush, getJson, HttpError, inBatches, queue, sorry, UA } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS tech_monitors (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), url TEXT NOT NULL, host TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true, fails INT NOT NULL DEFAULT 0, first_fail_at TIMESTAMPTZ, down_since TIMESTAMPTZ, last_status TEXT, last_checked TIMESTAMPTZ, cert_expires TIMESTAMPTZ, cert_warned INT, domain_expires TIMESTAMPTZ, domain_warned INT, expiry_checked TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, url));
CREATE TABLE IF NOT EXISTS tech_gh (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), repo TEXT NOT NULL, kind TEXT NOT NULL, last_seen TEXT, login TEXT, checked_at TIMESTAMPTZ, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, repo, kind));
CREATE TABLE IF NOT EXISTS tech_pkgs (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), registry TEXT NOT NULL, name TEXT NOT NULL, last_version TEXT, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, registry, name));
CREATE TABLE IF NOT EXISTS tech_status (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), service TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, kind TEXT NOT NULL, seen JSONB NOT NULL DEFAULT '{}'::jsonb, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, service))`);

/* =====================================================================
 * 1. Uptime, certificates and domains
 * ===================================================================== */

export function normaliseUrl(raw: string): URL {
  const s = raw.trim().replace(/[),.;]+$/, "");
  const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) throw new Error("That doesn't look like a web address. Try something like https://mysite.com.");
  return u;
}
const prettyUrl = (u: string) => u.replace(/^https?:\/\//, "").replace(/\/$/, "");
/** The part of a host you register: example.co.uk, mysite.com.ng, mysite.com. */
export function registrable(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, "").split(".");
  if (parts.length > 2 && parts.at(-1)!.length === 2 && /^(?:co|com|net|org|gov|edu|ac|gob|or|ne|go|nic)$/.test(parts.at(-2)!)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

const isUp = (status: number) => status < 400 || status === 401 || status === 403 || status === 429;
const why = (e: any) => (/timeout|abort/i.test(String(e?.name ?? e?.message)) ? "no answer within 10 seconds" : /ENOTFOUND|EAI_AGAIN/.test(String(e?.cause?.code ?? e?.message)) ? "its name doesn't resolve" : /CERT|SSL|TLS/i.test(String(e?.cause?.code ?? e?.message)) ? "its certificate failed" : "the connection failed");

/** HEAD first, then GET if HEAD fails or isn't allowed. 10 seconds each. */
export async function probe(url: string): Promise<{ up: boolean; status?: number; ms: number; reason?: string }> {
  const t0 = Date.now();
  const go = async (method: string) => {
    const r = await publicFetch(url, { method, headers: { "user-agent": UA }, signal: AbortSignal.timeout(10_000) });
    await r.body?.cancel().catch(() => {});
    return r.status;
  };
  let status: number | undefined;
  try { status = await go("HEAD"); } catch { /* try GET */ }
  if (status === undefined || !isUp(status)) {
    try { status = await go("GET"); } catch (e) { return { up: false, ms: Date.now() - t0, reason: e instanceof BlockedAddress ? "it isn't on the public internet" : why(e) }; }
  }
  return { up: isUp(status), status, ms: Date.now() - t0, reason: isUp(status) ? undefined : `it answered ${status}` };
}

/** Swappable in tests: read a host's certificate expiry with a TLS handshake. */
export const probes = {
  tls: (host: string): Promise<Date | null> => new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 10_000, rejectUnauthorized: false, lookup: safeLookup }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c?.valid_to ? new Date(c.valid_to) : null);
    });
    s.on("error", () => resolve(null));
    s.on("timeout", () => { s.destroy(); resolve(null); });
  }),
};

/** Registration expiry from RDAP (rdap.org redirects to the registry). Null when the registry has no RDAP. */
export async function domainExpiry(domain: string): Promise<Date | null> {
  const j = await getJson<any>(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { accept: "application/rdap+json, application/json" } });
  const ev = (j?.events ?? []).find((e: any) => String(e?.eventAction).toLowerCase() === "expiration");
  return ev?.eventDate ? new Date(ev.eventDate) : null;
}

const monitorWatch = defineAction({
  name: "monitor.watch",
  tier: 1,
  description: "Watch a website for downtime (uptime monitor): checked every 5 minutes, alerts after two failures in a row and again when it's back, plus warnings before its TLS certificate (14 and 3 days) and domain registration (30 and 7 days) expire. `url` like https://mysite.com or mysite.com.",
  schema: z.object({ url: z.string().min(4) }),
  async run(args, ctx) {
    const u = normaliseUrl(args.url);
    const url = u.href;
    await checkPublic(u).catch((e) => { if (e instanceof BlockedAddress) throw e; }); // a name that doesn't resolve yet is still watchable
    const p = await probe(url);
    const r = await ctx.db.one<{ id: number }>(
      `INSERT INTO tech_monitors (user_id, url, host, last_status, last_checked, fails, first_fail_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id, url) DO UPDATE SET active=true, fails=EXCLUDED.fails, first_fail_at=EXCLUDED.first_fail_at, down_since=NULL, last_status=EXCLUDED.last_status, last_checked=EXCLUDED.last_checked RETURNING id`,
      [ctx.user.id, url, u.hostname, p.up ? `up ${p.status}` : `down ${p.reason}`, ctx.now, p.up ? 0 : 1, p.up ? null : ctx.now],
    );
    const now = p.up ? `It's up now (${p.status} in ${p.ms} ms).` : `It isn't answering right now (${p.reason}); I'll tell you if it's still down in five minutes.`;
    return { reply: `Watching ${prettyUrl(url)} every 5 minutes. ${now} I'll also warn you before its certificate or domain expires. Say "stop watching ${u.hostname}" to end it.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM tech_monitors WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Stopped watching that site.";
  },
});

onJob("tech_uptime", async (_job, deps) => {
  const rows = await deps.db.query<any>(`SELECT * FROM tech_monitors WHERE active ORDER BY last_checked NULLS FIRST LIMIT 300`);
  const now = new Date();
  await checkMonitors(deps, rows, now);
});

export async function checkMonitors(deps: SchedulerDeps, rows: any[], now: Date): Promise<void> {
  const touched = new Set<number>();
  // One probe per URL even when several people watch it.
  const results = new Map<string, Awaited<ReturnType<typeof probe>>>();
  await inBatches([...new Set(rows.map((r) => r.url as string))], 8, async (url) => { results.set(url, await probe(url)); });
  for (const m of rows) {
    const p = results.get(m.url);
    if (!p) continue;
    const label = prettyUrl(m.url);
    /* A site that keeps flapping: the first two downs (and their recoveries) ping; the rest of the day waits for the brief. */
    const today = now.toISOString().slice(0, 10);
    const n = m.alert_day === today ? Number(m.alert_n ?? 0) : 0;
    const how = (): "urgent" | "daily" => (n < 3 ? "urgent" : "daily");
    const counted = () => deps.db.query(`UPDATE tech_monitors SET alert_day=$2, alert_n=$3 WHERE id=$1`, [m.id, today, n + 1]);
    if (p.up) {
      if (m.down_since) {
        await queue(deps.db, m.user_id, "uptime", how(), `${label} is back up after ${duration(now.getTime() - new Date(m.first_fail_at ?? m.down_since).getTime())} down.`, now);
        await counted();
        touched.add(m.user_id);
      }
      await deps.db.query(`UPDATE tech_monitors SET fails=0, first_fail_at=NULL, down_since=NULL, last_status=$2, last_checked=$3 WHERE id=$1`, [m.id, `up ${p.status}`, now]);
      continue;
    }
    const fails = Number(m.fails) + 1;
    const first = m.first_fail_at ?? now;
    if (fails === 2 && !m.down_since) {
      await queue(deps.db, m.user_id, "uptime", how(), `${label} looks down: ${p.reason}, twice in a row. ${n === 2 ? "It keeps going up and down today, so any more changes go in your morning note." : "I'll tell you when it's back."}`, now, { label: "Stop watching", data: `tc:mon:off:${m.id}` });
      await counted();
      touched.add(m.user_id);
    }
    await deps.db.query(`UPDATE tech_monitors SET fails=$2, first_fail_at=$3, down_since=CASE WHEN $2 >= 2 THEN COALESCE(down_since, $3) ELSE down_since END, last_status=$4, last_checked=$5 WHERE id=$1`, [m.id, fails, first, `down ${p.reason}`, now]);
  }
  if (touched.size) await flush(deps, now, [...touched]);
}

onJob("tech_expiry", async (_job, deps) => { await checkExpiry(deps, new Date()); });

/** Once a day: certificate and domain expiry for every watched host. */
export async function checkExpiry(deps: SchedulerDeps, now: Date): Promise<void> {
  const rows = await deps.db.query<any>(`SELECT * FROM tech_monitors WHERE active AND (expiry_checked IS NULL OR expiry_checked < $1) ORDER BY expiry_checked NULLS FIRST LIMIT 100`, [new Date(now.getTime() - 20 * 3_600_000)]);
  const certs = new Map<string, Date | null>(), domains = new Map<string, Date | null>();
  for (const host of new Set(rows.filter((r) => r.url.startsWith("https:")).map((r) => r.host as string))) certs.set(host, await checkPublic(`https://${host}/`).then(() => probes.tls(host)).catch(() => null));
  for (const d of new Set(rows.map((r) => registrable(r.host)))) {
    try { domains.set(d, await domainExpiry(d)); } catch (e) { log.warn({ domain: d, err: (e as Error).message }, "rdap failed"); domains.set(d, null); }
  }
  const touched = new Set<number>();
  for (const m of rows) {
    const cert = certs.get(m.host) ?? null, dom = domains.get(registrable(m.host)) ?? null;
    let certWarned: number | null = m.cert_warned, domWarned: number | null = m.domain_warned;
    if (cert) {
      const left = daysUntil(cert, now);
      if (left > 14) certWarned = null; // renewed
      for (const stage of [3, 14]) {
        if (left <= stage && (certWarned === null || certWarned > stage)) {
          const when = left < 0 ? "has expired" : left === 0 ? "expires today" : `expires in ${left} day${left === 1 ? "" : "s"}, on ${dayLabel(cert, "UTC")}`;
          await queue(deps.db, m.user_id, "expiry", stage === 3 ? "urgent" : "daily", `The certificate for ${m.host} ${when}. Renew it before visitors see a warning.`, now);
          touched.add(m.user_id);
          certWarned = stage;
          break;
        }
      }
    }
    if (dom) {
      const left = daysUntil(dom, now);
      if (left > 30) domWarned = null;
      for (const stage of [7, 30]) {
        if (left <= stage && (domWarned === null || domWarned > stage)) {
          await queue(deps.db, m.user_id, "expiry", stage === 7 ? "urgent" : "daily", `The domain ${registrable(m.host)} ${left <= 0 ? "is due for renewal now" : `expires in ${left} days, on ${dayLabel(dom, "UTC")}`}. Check auto-renew with your registrar.`, now);
          touched.add(m.user_id);
          domWarned = stage;
          break;
        }
      }
    }
    await deps.db.query(`UPDATE tech_monitors SET cert_expires=$2, cert_warned=$3, domain_expires=$4, domain_warned=$5, expiry_checked=$6 WHERE id=$1`, [m.id, cert, certWarned, dom ?? m.domain_expires, domWarned, now]);
  }
  if (touched.size) await flush(deps, now, [...touched]);
}

/* =====================================================================
 * 2. GitHub
 * ===================================================================== */

const GH = "https://api.github.com";
let ghPausedUntil = 0;
const ghHeaders = () => ({ accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {}) });
/** Conditional GET (ETag) against the GitHub API, pausing when the rate limit runs low. */
export async function ghGet(db: Db, path: string): Promise<any> {
  if (Date.now() < ghPausedUntil) throw new Error("GitHub asked me to slow down. I'll try again shortly.");
  try {
    const r = await cachedJson(db, `${GH}${path}`, ghHeaders());
    const left = Number(r.headers.get("x-ratelimit-remaining") ?? 99), reset = Number(r.headers.get("x-ratelimit-reset") ?? 0);
    if (left < 5 && reset) ghPausedUntil = reset * 1000;
    return r.body;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 403 || e.status === 429) && /rate limit/i.test(e.body ?? "")) ghPausedUntil = Date.now() + 15 * 60_000;
    throw e;
  }
}
export const resetGithubPause = () => { ghPausedUntil = 0; };

/** The person who runs this lifeline (an ALLOWED_USER_IDS owner, or the first person in when none are set). */
async function runsTheCircle(db: Db, user: { id: number; telegram_id?: number | string | null }): Promise<boolean> {
  const first = await db.one<{ id: number }>(`SELECT min(id) AS id FROM users`);
  return config.allowedUserIds.length ? config.allowedUserIds.includes(Number(user.telegram_id ?? 0)) : user.id === first?.id;
}

export function repoOf(s: string): string | null {
  const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(s.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

const KIND_WORDS = { releases: "releases of", ci: "CI on", mentions: "mentions of you in" } as const;
const githubWatch = defineAction({
  name: "github.watch",
  tier: 1,
  description: "Watch a GitHub repo (owner/repo): `what` is 'releases' (new releases, merged into one message), 'ci' (tell me when GitHub Actions runs fail) or 'mentions' (issues and pull requests that mention the server's GitHub user; needs GITHUB_TOKEN). Public repos work without a token.",
  schema: z.object({ repo: z.string().min(3), what: z.enum(["releases", "ci", "mentions"]) }),
  async run(args, ctx) {
    const repo = repoOf(args.repo);
    if (!repo) throw new Error("I need the repo as owner/name, like vercel/next.js.");
    if (args.what === "mentions" && !config.githubToken) throw new Error("Mentions need a GitHub token on the server (GITHUB_TOKEN), because GitHub only tells a signed-in account who it mentions. Releases and CI on public repos work without one.");
    let info: any;
    try { info = await ghGet(ctx.db, `/repos/${repo}`); } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new Error(`I couldn't find ${repo} on GitHub. If it's private, the server's GITHUB_TOKEN needs access to it.`);
      throw sorry("GitHub", e);
    }
    /* The server's token belongs to whoever runs lifeline: private repos and mentions are theirs only. */
    const owner = await runsTheCircle(ctx.db, ctx.user);
    if (info?.private && !owner) throw new Error(`${repo} is private, and I can only watch public repos for you. The server's GitHub access belongs to whoever runs this lifeline.`);
    if (args.what === "mentions" && !owner) throw new Error("Mentions use the server's own GitHub account, so only the person who runs this lifeline can watch them. Releases and CI on public repos work for anyone.");
    const full = info?.full_name ?? repo;
    let lastSeen: string | null = null, login: string | null = null, tail = "";
    try {
      if (args.what === "releases") {
        const rel: any[] = await ghGet(ctx.db, `/repos/${full}/releases?per_page=5`);
        const top = (rel ?? []).filter((r) => !r.draft)[0];
        lastSeen = top ? String(top.id) : "0";
        tail = top ? ` The latest is ${top.name || top.tag_name}.` : " It has no releases yet.";
      } else if (args.what === "ci") {
        const runs: any = await ghGet(ctx.db, `/repos/${full}/actions/runs?status=failure&per_page=5`);
        lastSeen = String(Math.max(0, ...(runs?.workflow_runs ?? []).map((r: any) => Number(r.id))));
      } else {
        login = (await ghGet(ctx.db, "/user"))?.login ?? null;
        if (!login) throw new Error("The server's GitHub token didn't tell me whose mentions to watch. /doctor shows it.");
        lastSeen = ctx.now.toISOString();
      }
    } catch (e) { if (e instanceof HttpError) throw sorry("GitHub", e); throw e; }
    const r = await ctx.db.one<{ id: number }>(
      `INSERT INTO tech_gh (user_id, repo, kind, last_seen, login, checked_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, repo, kind) DO UPDATE SET active=true, last_seen=EXCLUDED.last_seen, login=EXCLUDED.login, checked_at=EXCLUDED.checked_at RETURNING id`,
      [ctx.user.id, full, args.what, lastSeen, login, ctx.now],
    );
    const how = args.what === "ci" ? `I'll tell you when CI fails on ${full}. I check every ${config.githubToken ? 10 : 30} minutes and put several failures in one message.`
      : args.what === "releases" ? `Watching releases of ${full}.${tail} New ones come in one message, at most once a day; the rest wait for your morning note.`
      : `Watching ${full} for issues and pull requests that mention ${login}. They come together, at most once a day.`;
    return { reply: `${how} Say "stop watching ${full}" to end it.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM tech_gh WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return `Stopped that GitHub watch.`;
  },
});

/** Minutes between checks, per kind. Unauthenticated calls get 60 an hour, so CI slows down without a token. */
const GH_EVERY = () => ({ releases: 120, ci: config.githubToken ? 10 : 30, mentions: 15 } as Record<string, number>);

onJob("tech_github", async (_job, deps) => { await checkGithub(deps, new Date()); });

export async function checkGithub(deps: SchedulerDeps, now: Date): Promise<void> {
  const rows = await deps.db.query<any>(`SELECT * FROM tech_gh WHERE active ORDER BY checked_at NULLS FIRST LIMIT 60`);
  const due = rows.filter((r) => !r.checked_at || now.getTime() - new Date(r.checked_at).getTime() >= GH_EVERY()[r.kind] * 60_000 - 30_000);
  const touched = new Set<number>();
  const fetched = new Map<string, any>();
  const get = async (path: string) => { if (!fetched.has(path)) fetched.set(path, await ghGet(deps.db, path)); return fetched.get(path); };
  for (const w of due) {
    try {
      if (w.kind === "releases") {
        const rel: any[] = (await get(`/repos/${w.repo}/releases?per_page=5`)) ?? [];
        const fresh = rel.filter((r) => !r.draft && Number(r.id) > Number(w.last_seen ?? 0)).sort((a, b) => Number(a.id) - Number(b.id));
        for (const r of fresh.slice(-3)) await queue(deps.db, w.user_id, "github", "daily", `${w.repo} released ${r.name || r.tag_name}${r.prerelease ? " (a pre-release)" : ""}.\n${r.html_url}`, now);
        if (fresh.length) { touched.add(w.user_id); w.last_seen = String(fresh.at(-1).id); }
      } else if (w.kind === "ci") {
        const runs: any[] = (await get(`/repos/${w.repo}/actions/runs?status=failure&per_page=10`))?.workflow_runs ?? [];
        const fresh = runs.filter((r) => Number(r.id) > Number(w.last_seen ?? 0)).sort((a, b) => Number(b.id) - Number(a.id));
        if (fresh.length) {
          const top = fresh[0];
          const what = `${top.name ?? "a workflow"} on ${top.head_branch ?? "a branch"}`;
          // The first CI failure of the day for a repo pings; later ones the same day join the morning note.
          const pinged = await deps.db.one(`SELECT 1 FROM tech_outbox WHERE user_id=$1 AND feature='github' AND level='urgent' AND text LIKE $2 AND created_at > $3 LIMIT 1`, [w.user_id, `%CI%failed on ${w.repo}%`, new Date(now.getTime() - 20 * 3_600_000)]);
          await queue(deps.db, w.user_id, "github", pinged ? "daily" : "urgent", fresh.length === 1 ? `CI failed on ${w.repo}: ${what}.\n${top.html_url}` : `${fresh.length} CI runs failed on ${w.repo}, the latest ${what}.\n${top.html_url}`, now);
          touched.add(w.user_id);
          w.last_seen = String(top.id);
        }
      } else if (w.kind === "mentions" && config.githubToken && w.login) {
        const items: any[] = (await get(`/repos/${w.repo}/issues?mentioned=${encodeURIComponent(w.login)}&state=all&sort=updated&since=${encodeURIComponent(w.last_seen ?? now.toISOString())}&per_page=10`)) ?? [];
        const fresh = items.filter((i) => new Date(i.updated_at) > new Date(w.last_seen ?? 0));
        if (fresh.length) {
          await queue(deps.db, w.user_id, "github", "daily", fresh.length === 1 ? `"${fresh[0].title}" in ${w.repo} mentions you.\n${fresh[0].html_url}` : `${fresh.length} issues or pull requests in ${w.repo} mention you, the latest "${fresh[0].title}".\n${fresh[0].html_url}`, now);
          touched.add(w.user_id);
          w.last_seen = fresh.map((i) => i.updated_at).sort().at(-1);
        }
      }
      await deps.db.query(`UPDATE tech_gh SET last_seen=$2, checked_at=$3 WHERE id=$1`, [w.id, w.last_seen, now]);
    } catch (e) {
      log.warn({ repo: w.repo, kind: w.kind, err: (e as Error).message }, "github watch failed");
      if (/slow down/.test((e as Error).message)) break;
    }
  }
  if (touched.size) await flush(deps, now, [...touched]);
}

/* =====================================================================
 * 3. Packages
 * ===================================================================== */

export const REGISTRY: Record<string, { name: string; latest: (pkg: string) => Promise<string | null>; url: (pkg: string) => string }> = {
  npm: { name: "npm", url: (p) => `https://www.npmjs.com/package/${p}`, latest: async (p) => (await getJson<any>(`https://registry.npmjs.org/${p.startsWith("@") ? `@${encodeURIComponent(p.slice(1))}` : encodeURIComponent(p)}/latest`))?.version ?? null },
  pypi: { name: "PyPI", url: (p) => `https://pypi.org/project/${p}/`, latest: async (p) => (await getJson<any>(`https://pypi.org/pypi/${encodeURIComponent(p)}/json`))?.info?.version ?? null },
  crates: { name: "crates.io", url: (p) => `https://crates.io/crates/${p}`, latest: async (p) => { const j = await getJson<any>(`https://crates.io/api/v1/crates/${encodeURIComponent(p)}`); return j?.crate?.max_stable_version || j?.crate?.newest_version || null; } },
};
export const registryOf = (w: string) => ({ npm: "npm", node: "npm", pypi: "pypi", pip: "pypi", python: "pypi", crates: "crates", crate: "crates", cargo: "crates", "crates.io": "crates", rust: "crates" } as Record<string, string>)[w.toLowerCase()] ?? null;
const major = (v: string) => Number(/^v?(\d+)/.exec(v)?.[1] ?? NaN);

const packageWatch = defineAction({
  name: "package.watch",
  tier: 1,
  description: "Watch a package for new versions: `registry` npm, pypi or crates (crates.io). Minor and patch releases go in the morning brief; a new major version may ping.",
  schema: z.object({ registry: z.enum(["npm", "pypi", "crates"]), name: z.string().min(1).max(214) }),
  async run(args, ctx) {
    const reg = REGISTRY[args.registry];
    const name = args.name.trim();
    let v: string | null;
    try { v = await reg.latest(name); } catch (e) {
      if (e instanceof HttpError && e.status === 404) throw new Error(`I couldn't find ${name} on ${reg.name}. Check the spelling?`);
      throw sorry(reg.name, e);
    }
    if (!v) throw new Error(`${reg.name} didn't give me a version for ${name}. Check the spelling?`);
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO tech_pkgs (user_id, registry, name, last_version) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, registry, name) DO UPDATE SET active=true, last_version=EXCLUDED.last_version RETURNING id`, [ctx.user.id, args.registry, name, v]);
    return { reply: `Watching ${name} on ${reg.name}, now at \`${v}\`. New versions go in your morning note; a new major version gets a ping. Say "stop watching ${name}" to end it.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM tech_pkgs WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Stopped watching that package.";
  },
});

onJob("tech_packages", async (_job, deps) => { await checkPackages(deps, new Date()); });

export async function checkPackages(deps: SchedulerDeps, now: Date): Promise<void> {
  const rows = await deps.db.query<any>(`SELECT * FROM tech_pkgs WHERE active ORDER BY id LIMIT 500`);
  const latest = new Map<string, string | null>();
  await inBatches([...new Set(rows.map((r) => `${r.registry}:${r.name}`))], 5, async (k) => {
    const [reg, ...rest] = k.split(":");
    latest.set(k, await REGISTRY[reg].latest(rest.join(":")).catch(() => null));
  });
  const touched = new Set<number>();
  for (const p of rows) {
    const v = latest.get(`${p.registry}:${p.name}`);
    if (!v || v === p.last_version) continue;
    const isMajor = p.last_version && major(v) > major(p.last_version);
    await queue(deps.db, p.user_id, "packages", isMajor ? "daily" : "brief", `${p.name} ${v} is out on ${REGISTRY[p.registry].name}${isMajor ? `, a new major version (was ${p.last_version})` : ""}.\n${REGISTRY[p.registry].url(p.name)}`, now);
    if (isMajor) touched.add(p.user_id);
    await deps.db.query(`UPDATE tech_pkgs SET last_version=$2 WHERE id=$1`, [p.id, v]);
  }
  if (touched.size) await flush(deps, now, [...touched]);
}

/* =====================================================================
 * 4. Service status
 * ===================================================================== */

type StatusKind = "statuspage" | "incidentio";
/** Public status pages. Atlassian Statuspage pages serve /api/v2/summary.json; OpenAI moved to incident.io (/api/v1/summary). */
export const SERVICES: Record<string, { name: string; base: string; kind: StatusKind }> = {
  github: { name: "GitHub", base: "https://www.githubstatus.com", kind: "statuspage" },
  vercel: { name: "Vercel", base: "https://www.vercel-status.com", kind: "statuspage" },
  cloudflare: { name: "Cloudflare", base: "https://www.cloudflarestatus.com", kind: "statuspage" },
  openai: { name: "OpenAI", base: "https://status.openai.com", kind: "incidentio" },
  anthropic: { name: "Anthropic", base: "https://status.claude.com", kind: "statuspage" },
  discord: { name: "Discord", base: "https://discordstatus.com", kind: "statuspage" },
  npm: { name: "npm", base: "https://status.npmjs.org", kind: "statuspage" },
  netlify: { name: "Netlify", base: "https://www.netlifystatus.com", kind: "statuspage" },
  digitalocean: { name: "DigitalOcean", base: "https://status.digitalocean.com", kind: "statuspage" },
  twilio: { name: "Twilio", base: "https://status.twilio.com", kind: "statuspage" },
  supabase: { name: "Supabase", base: "https://status.supabase.com", kind: "statuspage" },
  bitbucket: { name: "Bitbucket", base: "https://bitbucket.status.atlassian.com", kind: "statuspage" },
  circleci: { name: "CircleCI", base: "https://status.circleci.com", kind: "statuspage" },
  coinbase: { name: "Coinbase", base: "https://status.coinbase.com", kind: "statuspage" },
};
const SERVICE_ALIAS: Record<string, string> = { claude: "anthropic", "chatgpt": "openai", "open ai": "openai", do: "digitalocean", "digital ocean": "digitalocean", gh: "github", cf: "cloudflare", atlassian: "bitbucket" };

export function serviceOf(raw: string): { service: string; name: string; base: string; kind: StatusKind } | null {
  const w = raw.trim().toLowerCase().replace(/^the\s+/, "").replace(/\s+status$/, "");
  const key = SERVICE_ALIAS[w] ?? w.replace(/\s+/g, "");
  if (SERVICES[key]) return { service: key, ...SERVICES[key] };
  if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(w.replace(/^https?:\/\//, "").replace(/\/.*$/, ""))) {
    const host = w.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    return { service: host, name: host, base: `https://${host}`, kind: "statuspage" };
  }
  return null;
}

export interface Incident { id: string; name: string; status: string; impact: string; url?: string }
export async function fetchStatus(base: string, kind: StatusKind): Promise<{ indicator: string; description: string; incidents: Incident[] }> {
  const typed = !Object.values(SERVICES).some((s) => s.base === base);
  if (kind === "incidentio") {
    try {
      const j = await getJson<any>(`${base}/api/v1/summary`, { public: typed });
      const incidents: Incident[] = (j?.ongoing_incidents ?? []).map((i: any) => ({ id: String(i.id), name: i.name, status: i.status, impact: ({ full_outage: "critical", partial_outage: "major", degraded_performance: "minor" } as any)[i.current_worst_impact] ?? "minor", url: i.url }));
      return { indicator: incidents.length ? incidents.some((i) => i.impact !== "minor") ? "major" : "minor" : "none", description: incidents.length ? "Incident in progress" : "All Systems Operational", incidents };
    } catch (e) { if (!(e instanceof HttpError && e.status === 404)) throw e; }
  }
  const j = await getJson<any>(`${base}/api/v2/summary.json`, { public: typed });
  return {
    indicator: j?.status?.indicator ?? "none",
    description: j?.status?.description ?? "",
    incidents: (j?.incidents ?? []).filter((i: any) => !/resolved|postmortem/i.test(i.status)).map((i: any) => ({ id: String(i.id), name: i.name, status: i.status, impact: i.impact ?? "minor", url: i.shortlink })),
  };
}
const impactWords = (i: string) => ({ critical: "a major outage", major: "a partial outage", minor: "minor trouble", none: "a notice" } as Record<string, string>)[i] ?? "trouble";

const statusWatch = defineAction({
  name: "status.watch",
  tier: 1,
  description: `Follow public status pages and get told about incidents, merged: services like ${Object.values(SERVICES).map((s) => s.name).join(", ")}, or any Atlassian Statuspage address (status.example.com).`,
  schema: z.object({ services: z.array(z.string().min(2)).min(1).max(10) }),
  async run(args, ctx) {
    const found = args.services.map((s) => ({ s, svc: serviceOf(s) }));
    const unknown = found.filter((f) => !f.svc).map((f) => f.s);
    if (unknown.length === args.services.length) throw new Error(`I don't know a status page for ${unknown.join(", ")}. Give me its status page address, like status.example.com.`);
    const lines: string[] = [], names: string[] = [], ids: number[] = [];
    for (const { svc } of found) {
      if (!svc) continue;
      let st: Awaited<ReturnType<typeof fetchStatus>> | null = null;
      try { st = await fetchStatus(svc.base, svc.kind); } catch (e) {
        if (e instanceof BlockedAddress) throw e;
        if (!SERVICES[svc.service]) throw new Error(`${svc.base} doesn't look like a status page I can read. Most use Atlassian Statuspage; check the address?`);
      }
      const seen = Object.fromEntries((st?.incidents ?? []).map((i) => [i.id, i.name]));
      const r = await ctx.db.one<{ id: number }>(`INSERT INTO tech_status (user_id, service, name, url, kind, seen) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id, service) DO UPDATE SET active=true, seen=EXCLUDED.seen RETURNING id`, [ctx.user.id, svc.service, svc.name, svc.base, svc.kind, JSON.stringify(seen)]);
      ids.push(r!.id);
      names.push(svc.name);
      if (st?.incidents.length) lines.push(`${svc.name} has ${impactWords(st.incidents[0].impact)} right now: ${st.incidents[0].name}.`);
    }
    const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    const head = `Following ${list} status. ${lines.length ? lines.join(" ") : "All normal right now."} I'll tell you about new incidents, several in one message.`;
    return { reply: `${head}${unknown.length ? ` I don't know a status page for ${unknown.join(", ")}; send me its address to add it.` : ""} Say "stop watching ${names[0]} status" to end one.`, undo: { payload: { ids } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM tech_status WHERE id = ANY($1::int[]) AND user_id=$2`, [p.ids, ctx.user.id]);
    return "Stopped following those status pages.";
  },
});

const statusNow = defineAction({
  name: "status.now",
  tier: 1,
  description: "Is a service down right now? Reads its public status page (GitHub, Vercel, Cloudflare, OpenAI, Anthropic, Discord, npm and others).",
  schema: z.object({ service: z.string().min(2) }),
  async run(args) {
    const svc = serviceOf(args.service);
    if (!svc) throw new Error(`I don't know a status page for ${args.service}. Give me its status page address, like status.example.com.`);
    let st;
    try { st = await fetchStatus(svc.base, svc.kind); } catch (e) { throw e instanceof BlockedAddress ? e : sorry(`${svc.name}'s status page`, e); }
    if (!st.incidents.length && st.indicator === "none") return { reply: `${svc.name} looks fine right now: ${st.description || "no open incidents"}.` };
    const inc = st.incidents.slice(0, 2).map((i) => `${i.name} (${i.status})`).join("; ");
    return { reply: `${svc.name} reports ${st.description ? st.description.toLowerCase() : impactWords(st.indicator)}.${inc ? ` ${inc}.` : ""}${st.incidents[0]?.url ? `\n${st.incidents[0].url}` : ""}` };
  },
});

onJob("tech_status", async (_job, deps) => { await checkStatus(deps, new Date()); });

export async function checkStatus(deps: SchedulerDeps, now: Date): Promise<void> {
  const rows = await deps.db.query<any>(`SELECT * FROM tech_status WHERE active ORDER BY id LIMIT 500`);
  const pages = new Map<string, Awaited<ReturnType<typeof fetchStatus>> | null>();
  await inBatches([...new Set(rows.map((r) => `${r.kind}|${r.url}`))], 5, async (k) => {
    const [kind, url] = k.split("|");
    pages.set(k, await fetchStatus(url, kind as StatusKind).catch(() => null));
  });
  const touched = new Set<number>();
  for (const w of rows) {
    const st = pages.get(`${w.kind}|${w.url}`);
    if (!st) continue;
    const seen: Record<string, string> = typeof w.seen === "string" ? JSON.parse(w.seen) : w.seen ?? {};
    for (const i of st.incidents.filter((x) => !(x.id in seen))) {
      const loud = i.impact === "major" || i.impact === "critical";
      await queue(deps.db, w.user_id, "status", loud ? "urgent" : "daily", `${w.name} has ${impactWords(i.impact)}: ${i.name}.${i.url ? `\n${i.url}` : ""}`, now);
      touched.add(w.user_id);
    }
    const open = new Set(st.incidents.map((i) => i.id));
    for (const [id, name] of Object.entries(seen)) if (!open.has(id)) await queue(deps.db, w.user_id, "status", "brief", `${w.name}: ${name} is resolved`, now);
    await deps.db.query(`UPDATE tech_status SET seen=$2 WHERE id=$1`, [w.id, JSON.stringify(Object.fromEntries(st.incidents.map((i) => [i.id, i.name])))]);
  }
  if (touched.size) await flush(deps, now, [...touched]);
}

register(monitorWatch, githubWatch, packageWatch, statusWatch, statusNow);

/* ---------- jobs, words, cards ---------- */

addSystemJob("tech_uptime", "2,7,12,17,22,27,32,37,42,47,52,57 * * * *");
addSystemJob("tech_expiry", "19 5 * * *");
addSystemJob("tech_github", "6,16,26,36,46,56 * * * *");
addSystemJob("tech_packages", "29 */3 * * *");
addSystemJob("tech_status", "4,14,24,34,44,54 * * * *");

const REPO = String.raw`((?:https?:\/\/)?(?:github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)`;
const SVC_LIST = (s: string) => s.split(/\s*(?:,|\band\b|&)\s*/).map((x) => x.trim()).filter(Boolean);
addRules(
  [/^(?:watch|follow)\s+(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)\/?$/i, (m) => ({ action: "github.watch", args: { repo: m[1], what: "releases" } })],
  [/^watch\s+(?:the\s+)?(?:repo\s+)?(?!(?:tv|telly|netflix|youtube|movies?|films?|shows?|series|anime|football|games?)\/)([A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+)$/i, (m) => ({ action: "github.watch", args: { repo: m[1], what: "releases" } })],
  [/^(?:watch|monitor|keep an eye on|uptime(?: monitor)?(?: for)?)\s+(https?:\/\/\S+|(?!\S+\.(?:eth|sol)$)(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?)(?:\s+for (?:me|downtime|uptime))?$/i, (m) => ({ action: "monitor.watch", args: { url: m[1] } })],
  [/^(?:tell me|let me know|alert me|ping me)\s+(?:when|if)\s+(https?:\/\/\S+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})\s+(?:goes |is |gets )?down$/i, (m) => ({ action: "monitor.watch", args: { url: m[1] } })],
  [new RegExp(String.raw`^(?:watch|follow|track)\s+(?:the\s+)?(?:new\s+)?releases\s+(?:of|for|on|from)\s+${REPO}$`, "i"), (m) => ({ action: "github.watch", args: { repo: m[1], what: "releases" } })],
  [new RegExp(String.raw`^(?:watch|follow)\s+${REPO}\s+releases$`, "i"), (m) => ({ action: "github.watch", args: { repo: m[1], what: "releases" } })],
  [new RegExp(String.raw`^(?:tell me|let me know|alert me|ping me|notify me)\s+(?:when|if)\s+(?:the\s+)?(?:ci|build|builds|actions|github actions|checks|tests)\s+(?:fails?|breaks?|goes red|is red)\s+(?:on|in|for)\s+${REPO}$`, "i"), (m) => ({ action: "github.watch", args: { repo: m[1], what: "ci" } })],
  [new RegExp(String.raw`^(?:watch|monitor)\s+(?:the\s+)?(?:ci|builds|actions)\s+(?:on|of|for)\s+${REPO}$`, "i"), (m) => ({ action: "github.watch", args: { repo: m[1], what: "ci" } })],
  [new RegExp(String.raw`^(?:watch|tell me about)\s+(?:issues|prs|pull requests|issues and prs)?\s*(?:mentioning me|that mention me|mentions(?: of me)?)\s+(?:in|on)\s+${REPO}$`, "i"), (m) => ({ action: "github.watch", args: { repo: m[1], what: "mentions" } })],
  [/^(?:watch|follow|track)\s+(?:the\s+)?(npm|pypi|pip|crates?|cargo|crates\.io)\s+(?:package\s+|crate\s+)?(@?[\w.-]+(?:\/[\w.-]+)?)$/i, (m) => ({ action: "package.watch", args: { registry: registryOf(m[1]), name: m[2] } })],
  [/^(?:watch|follow|track)\s+(@?[\w.-]+(?:\/[\w.-]+)?)\s+on\s+(npm|pypi|crates(?:\.io)?|cargo)$/i, (m) => ({ action: "package.watch", args: { registry: registryOf(m[2]), name: m[1] } })],
  [/^(?:watch|follow|track)\s+(?:the\s+)?status\s+(?:page\s+)?(?:of|for)\s+(.+)$/i, (m) => ({ action: "status.watch", args: { services: SVC_LIST(m[1]) } })],
  [/^(?:watch|follow)\s+(.+?)\s+status(?: pages?)?$/i, (m) => ({ action: "status.watch", args: { services: SVC_LIST(m[1]) } })],
  [new RegExp(String.raw`^(?:is|are)\s+(${Object.keys(SERVICES).join("|")}|claude|chatgpt)\s+(?:down|up|having (?:issues|problems|an outage)|ok|okay)(?:\s+(?:right\s+)?now)?\??$`, "i"), (m) => ({ action: "status.now", args: { service: m[1] } })],
  [/^(?:status of|check status of|check the status of)\s+(\S+)\??$/i, (m) => ({ action: "status.now", args: { service: m[1] } })],
);
addExamples("monitor.watch", ["watch https://mysite.com", "monitor example.org", "uptime monitor for shop.example.co.uk", "tell me when mysite.com goes down"]);
addExamples("github.watch", ["watch releases of vercel/next.js", "tell me when CI fails on myorg/myrepo", "watch issues mentioning me in owner/repo", "watch denoland/deno releases", "watch the ci on myorg/api"]);
addExamples("package.watch", ["watch npm react", "watch pypi fastapi", "watch crates tokio", "watch @types/node on npm"]);
addExamples("status.watch", ["watch status of GitHub, Vercel, Cloudflare, OpenAI", "watch the status of supabase", "follow cloudflare and discord status"]);
addExamples("status.now", ["is github down", "is vercel down right now?", "status of openai"]);
addCues("monitor", ["uptime", "monitor", "website down", "site down", "is my site", "downtime", "certificate", "ssl", "domain expir"]);
addCues("github", ["github", "repo", "releases", "release", " ci ", "actions", "build fails", "pull request", "issues"]);
addCues("package", ["npm", "pypi", "crates", "cargo", "package", "new version", "release"]);
addCues("status", ["status page", "outage", "is github down", "is vercel down", "incident", "down right now", "status of"]);

addCapability({
  key: "devwatch", name: "Site, repo and package watch",
  cues: ["uptime", "website down", "monitor my site", "github releases", "ci fails", "npm", "pypi", "crates", "status page", "outage", "ssl certificate", "domain expiry"],
  what: "I watch your sites, repos and dependencies: an uptime check every 5 minutes with certificate and domain expiry warnings, GitHub releases and failed CI runs, new versions on npm, PyPI and crates.io, and status pages like GitHub, Vercel, Cloudflare and OpenAI.",
  say: ["watch https://mysite.com", "tell me when CI fails on myorg/myrepo", "watch npm react", "watch status of GitHub, Vercel, Cloudflare", "my watches"],
  then: "A site going down, a failed build or a big outage comes straight away, several in one message. Releases and new versions wait for your morning note. \"stop watching mysite.com\" ends any of them.",
  limits: "Public repos work without a token; mentions and private repos need a GitHub token on the server.",
}, "Work, code and crypto");

/* Flap counting, added after the table existed. */
addSchema(`ALTER TABLE tech_monitors ADD COLUMN IF NOT EXISTS alert_day TEXT;
ALTER TABLE tech_monitors ADD COLUMN IF NOT EXISTS alert_n INT NOT NULL DEFAULT 0`);
