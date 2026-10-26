/**
 * Hackathon pollers. Each returns normalised rows; `upsertHacks` dedupes on
 * (source, external_id) and also on canonical URL across sources so the same
 * event seen on HackathonRadar and Devpost is one row.
 *
 * All three are best-effort against undocumented or semi-documented feeds:
 * a schema change breaks one source, not the bot. Failures are logged and
 * the next poll retries.
 */
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import { onJob } from "../core/scheduler.js";
import type { Db } from "../core/db.js";

export interface HackRow {
  source: string;
  external_id: string;
  title: string;
  url: string;
  deadline?: Date | null;
  starts_at?: Date | null;
  prize_usd?: number | null;
  registrations?: number | null;
  online?: boolean | null;
  tags?: string[];
  quality?: number | null;
  raw?: unknown;
}

const UA = "lifeline-bot/0.1 (personal hackathon tracker)";

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const r = await fetch(url, { headers: { "user-agent": UA, accept: "application/json", ...headers } });
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

function canon(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function num(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const m = String(v).replace(/[^0-9.]/g, "");
  return m ? Number(m) : null;
}

function date(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

/** HackathonRadar: 51 platforms, quality score, API + webhooks. Needs a key. */
export async function pollHackathonRadar(): Promise<HackRow[]> {
  if (!config.hackathonRadarKey) return [];
  const base = process.env.HACKATHONRADAR_API_URL ?? "https://www.hackathonradar.com/api/v1/hackathons";
  const data = await getJson(`${base}?status=open&limit=200`, { authorization: `Bearer ${config.hackathonRadarKey}`, "x-api-key": config.hackathonRadarKey });
  const items: any[] = Array.isArray(data) ? data : data.data ?? data.hackathons ?? data.items ?? [];
  return items.map((h) => ({
    source: "hackathonradar",
    external_id: String(h.id ?? h.slug ?? h.url),
    title: h.name ?? h.title,
    url: h.url ?? h.link ?? h.website,
    deadline: date(h.submission_deadline ?? h.deadline ?? h.ends_at ?? h.end_date),
    starts_at: date(h.starts_at ?? h.start_date),
    prize_usd: num(h.prize_total_usd ?? h.prize_usd ?? h.prize),
    registrations: num(h.participants ?? h.registrations),
    online: typeof h.online === "boolean" ? h.online : h.mode ? /online|virtual|remote/i.test(h.mode) : null,
    tags: [...(h.tags ?? []), ...(h.categories ?? []), h.platform].filter(Boolean).map(String),
    quality: num(h.quality_score ?? h.score),
    raw: h,
  }));
}

/** Devpost: public JSON behind the listing page. */
export async function pollDevpost(): Promise<HackRow[]> {
  if (!config.enableDevpost) return [];
  const out: HackRow[] = [];
  for (let page = 1; page <= 3; page++) {
    const data = await getJson(`https://devpost.com/api/hackathons?status[]=open&page=${page}`);
    const items: any[] = data.hackathons ?? [];
    if (!items.length) break;
    for (const h of items) {
      const dl = parseDevpostDate(h.submission_period_dates);
      out.push({
        source: "devpost",
        external_id: String(h.id ?? h.url),
        title: h.title,
        url: h.url,
        deadline: dl,
        prize_usd: num(h.prize_amount?.replace?.(/<[^>]+>/g, "") ?? h.prize_amount),
        registrations: num(h.registrations_count),
        online: h.displayed_location?.location ? /online/i.test(h.displayed_location.location) : null,
        tags: (h.themes ?? []).map((t: any) => t.name ?? t).filter(Boolean),
        raw: h,
      });
    }
  }
  return out;
}

/** "Oct 01 - Nov 30, 2026" → end date, best effort. */
export function parseDevpostDate(s?: string): Date | null {
  if (!s) return null;
  const m = /-\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/.exec(s) ?? /([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\s*$/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]} 23:59:00 UTC`);
  return isNaN(d.getTime()) ? null : d;
}

/** Superteam Earn: undocumented /api/listings with deadline, reward, token, agentAccess. */
export async function pollSuperteam(): Promise<HackRow[]> {
  if (!config.enableSuperteam) return [];
  const data = await getJson("https://earn.superteam.fun/api/listings?type=hackathon,bounty&status=open&take=100");
  const items: any[] = Array.isArray(data) ? data : data.data ?? data.listings ?? [];
  return items
    .filter((l) => !l.isWinnersAnnounced)
    .map((l) => ({
      source: "superteam",
      external_id: String(l.id ?? l.slug),
      title: `${l.title}${l.sponsor?.name ? ` — ${l.sponsor.name}` : ""}`,
      url: `https://earn.superteam.fun/listing/${l.slug}`,
      deadline: date(l.deadline),
      prize_usd: num(l.usdValue ?? l.rewardAmount),
      registrations: num(l._count?.Submission ?? l.submissionCount),
      online: true,
      tags: ["solana", l.type, l.agentAccess, ...(l.skills ?? []).map((s: any) => s.skills ?? s)].filter(Boolean).map(String),
      raw: l,
    }));
}

/** ETHGlobal: events page carries Next.js data with upcoming events. */
export async function pollEthGlobal(): Promise<HackRow[]> {
  if (!config.enableEthglobal) return [];
  const r = await fetch("https://ethglobal.com/events", { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`ethglobal ${r.status}`);
  const html = await r.text();
  const out: HackRow[] = [];
  // Prefer embedded JSON (__NEXT_DATA__ or RSC payload); fall back to anchors.
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (m) {
    const walk = (o: any) => {
      if (!o || typeof o !== "object") return;
      if (Array.isArray(o)) return o.forEach(walk);
      if (o.slug && o.name && (o.startTime || o.start_time || o.startsAt)) {
        out.push({ source: "ethglobal", external_id: String(o.slug), title: `ETHGlobal ${o.name}`, url: `https://ethglobal.com/events/${o.slug}`, starts_at: date(o.startTime ?? o.start_time ?? o.startsAt), deadline: date(o.endTime ?? o.end_time ?? o.endsAt), online: o.type ? /online|async/i.test(String(o.type)) : null, tags: ["ethereum", "ethglobal", String(o.type ?? "")].filter(Boolean), raw: o });
      }
      Object.values(o).forEach(walk);
    };
    try { walk(JSON.parse(m[1])); } catch { /* fall through */ }
  }
  if (!out.length) {
    const cheerio = await import("cheerio");
    const $ = cheerio.load(html);
    $("a[href^='/events/']").each((_i, a) => {
      const href = $(a).attr("href")!;
      const slug = href.split("/")[2];
      const title = $(a).text().replace(/\s+/g, " ").trim();
      if (slug && title && !out.some((o) => o.external_id === slug)) out.push({ source: "ethglobal", external_id: slug, title: `ETHGlobal ${title.slice(0, 80)}`, url: `https://ethglobal.com${href}`, tags: ["ethereum", "ethglobal"] });
    });
  }
  return out;
}

/** Colosseum: blog RSS; announcements name the window, winners posts close them. */
export async function pollColosseum(): Promise<HackRow[]> {
  if (!config.enableColosseum) return [];
  const r = await fetch("https://blog.colosseum.com/rss/", { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`colosseum ${r.status}`);
  const xml = await r.text();
  const out: HackRow[] = [];
  for (const item of xml.split("<item>").slice(1)) {
    const title = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/.exec(item)?.[1] ?? "";
    const link = /<link>(.*?)<\/link>/.exec(item)?.[1] ?? "";
    const pub = /<pubDate>(.*?)<\/pubDate>/.exec(item)?.[1];
    if (!/hackathon|sprint|eternal/i.test(title) || /winners/i.test(title)) continue;
    out.push({ source: "colosseum", external_id: link, title, url: link, starts_at: date(pub), online: true, tags: ["solana", "colosseum"] });
  }
  return out;
}

/** Hack Club: public JSON. Mostly high-school events; off by default. */
export async function pollHackClub(): Promise<HackRow[]> {
  if (!config.enableHackclub) return [];
  const data = await getJson("https://hackathons.hackclub.com/api/events/upcoming");
  return (Array.isArray(data) ? data : []).map((h: any) => ({ source: "hackclub", external_id: String(h.id ?? h.website), title: h.name, url: h.website, starts_at: date(h.start), deadline: date(h.end), online: h.virtual === true || h.hybrid === true, tags: ["student", h.virtual ? "online" : "in-person"], raw: h }));
}

export async function upsertHacks(db: Db, rows: HackRow[]): Promise<number> {
  let fresh = 0;
  for (const r of rows) {
    if (!r.title || !r.url) continue;
    const c = canon(r.url);
    const dupe = await db.one<{ id: number }>(`SELECT id FROM hackathons WHERE canonical_url=$1 AND source<>$2 LIMIT 1`, [c, r.source]);
    if (dupe) {
      // Same event already known from another source: enrich missing fields, don't create a second row.
      await db.query(
        `UPDATE hackathons SET last_seen=now(), prize_usd=COALESCE(prize_usd,$2), registrations=COALESCE(registrations,$3), quality=COALESCE(quality,$4), deadline=COALESCE(deadline,$5) WHERE id=$1`,
        [dupe.id, r.prize_usd ?? null, r.registrations ?? null, r.quality ?? null, r.deadline ?? null],
      );
      continue;
    }
    const res = await db.query<{ inserted: boolean }>(
      `INSERT INTO hackathons (source, external_id, title, url, canonical_url, deadline, starts_at, prize_usd, registrations, online, tags, quality, raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (source, external_id) DO UPDATE SET title=EXCLUDED.title, deadline=COALESCE(EXCLUDED.deadline, hackathons.deadline),
         prize_usd=COALESCE(EXCLUDED.prize_usd, hackathons.prize_usd), registrations=COALESCE(EXCLUDED.registrations, hackathons.registrations),
         quality=COALESCE(EXCLUDED.quality, hackathons.quality), tags=EXCLUDED.tags, last_seen=now()
       RETURNING (xmax = 0) AS inserted`,
      [r.source, r.external_id, r.title, r.url, c, r.deadline ?? null, r.starts_at ?? null, r.prize_usd ?? null, r.registrations ?? null, r.online ?? null, r.tags ?? [], r.quality ?? null, JSON.stringify(r.raw ?? {})],
    );
    if (res[0]?.inserted) fresh++;
  }
  return fresh;
}

export async function pollAll(db: Db): Promise<Record<string, number | string>> {
  const result: Record<string, number | string> = {};
  for (const [name, fn] of [["hackathonradar", pollHackathonRadar], ["devpost", pollDevpost], ["superteam", pollSuperteam], ["ethglobal", pollEthGlobal], ["colosseum", pollColosseum], ["hackclub", pollHackClub]] as const) {
    try {
      const rows = await fn();
      result[name] = await upsertHacks(db, rows);
    } catch (e: any) {
      result[name] = `error: ${e?.message ?? e}`;
      log.warn({ source: name, err: e?.message }, "poller failed");
    }
  }
  return result;
}

onJob("poll_hackathons", async (_job, deps) => {
  const r = await pollAll(deps.db);
  log.info(r, "hackathon poll");
});
