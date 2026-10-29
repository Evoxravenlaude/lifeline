/**
 * Circle outage alerts, crowdsourced and opt in. Someone says "power is out in Rumuola" (a neighbourhood
 * name, never an address); members who asked to hear about Rumuola get one quiet line, merged, at most
 * a couple a day. "light is back in Rumuola" closes it. No names are shared and no exact places are kept.
 */
import { z } from "zod";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import type { Db } from "../../../core/db.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import { onJob, schedule } from "../../../core/scheduler.js";
import { andList, cap, local, pingOnce } from "./util.js";

addSchema(`CREATE TABLE IF NOT EXISTS home_area_subs (user_id INT NOT NULL REFERENCES users(id), area_key TEXT NOT NULL, area TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, area_key));
CREATE TABLE IF NOT EXISTS home_area_reports (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), area_key TEXT NOT NULL, area TEXT NOT NULL, kind TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT now(), ended_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS home_area_reports_key ON home_area_reports(area_key, started_at);
CREATE TABLE IF NOT EXISTS home_area_sent (user_id INT NOT NULL REFERENCES users(id), report_id INT NOT NULL REFERENCES home_area_reports(id), sent_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, report_id))`);

const OPEN_HOURS = 12;
const KIND_WORD: Record<string, string> = { power: "power", water: "water", internet: "internet" };

/** A neighbourhood's key: lower case, plain letters, no "the". */
export const areaKey = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/^(?:the|my|our)\s+/, "").replace(/\s+(?:area|axis|estate|neighbourhood|neighborhood)$/, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
const titled = (s: string) => s.trim().replace(/\s+/g, " ").replace(/\b\p{Ll}/gu, (c) => c.toUpperCase()).slice(0, 40);

/** Neighbourhood names only. A house number, a street or a flat is an address, and we never keep those. */
function checkArea(area: string): string | null {
  const a = area.trim();
  if (a.length < 2 || a.length > 40) return "Which neighbourhood is it? Just the area's name, like Rumuola or Kilimani.";
  if (/\d/.test(a) && /\b(?:street|st|road|rd|avenue|ave|close|crescent|lane|ln|drive|dr|way|flat|apt|apartment|house|no|block|plot|floor|unit)\b/i.test(a) || /^\s*(?:no\.?\s*)?\d+[a-z]?\s+\w/i.test(a) || /\b(?:flat|apt|apartment|plot|block)\s*\d/i.test(a) || /\b\d{4,}\b/.test(a)) {
    return "I only share neighbourhood names, never addresses. Which area is it, like Rumuola or Kilimani?";
  }
  return null;
}

async function followers(db: Db, key: string): Promise<number> {
  return Number((await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM home_area_subs WHERE area_key=$1`, [key]))?.n ?? 0);
}

const report = defineAction({
  name: "outage.report",
  tier: 2,
  description: "Tell circle members who follow a neighbourhood that power, water or internet is out there. 'area' is a neighbourhood name only (never an address). Nobody is told who reported it.",
  schema: z.object({ area: z.string().min(2).max(60), kind: z.enum(["power", "water", "internet"]) }),
  echo: (a) => `This tells anyone in the circle who follows outages in ${titled(a.area)} that ${KIND_WORD[a.kind]} is out there. Your name isn't shared.`,
  needs(a) { const bad = checkArea(a.area); return bad ? { need: "area", question: bad } : null; },
  async run(a, ctx) {
    const bad = checkArea(a.area);
    if (bad) throw new Error(bad);
    const key = areaKey(a.area), area = titled(a.area);
    const since = new Date(ctx.now.getTime() - OPEN_HOURS * 3_600_000);
    const mine = await ctx.db.one(`SELECT id FROM home_area_reports WHERE user_id=$1 AND area_key=$2 AND kind=$3 AND ended_at IS NULL AND started_at > $4`, [ctx.user.id, key, a.kind, since]);
    if (mine) return { reply: `You've already reported ${KIND_WORD[a.kind]} out in ${area}. Say "${a.kind === "power" ? "light" : a.kind} is back in ${area}" when it returns.` };
    const row = await ctx.db.one<{ id: number }>(`INSERT INTO home_area_reports (user_id, area_key, area, kind, started_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ctx.user.id, key, area, a.kind, ctx.now]);
    // One alert job per neighbourhood at a time: reports that land together go out as one line.
    const pending = await ctx.db.one(`SELECT id FROM jobs WHERE kind='home_area_alert' AND active AND payload->>'key'=$1`, [key]);
    if (!pending) await schedule(ctx.db, { kind: "home_area_alert", runAt: new Date(ctx.now.getTime() + 3 * 60_000), payload: { key } });
    const n = await followers(ctx.db, key);
    const subbed = await ctx.db.one(`SELECT 1 FROM home_area_subs WHERE user_id=$1 AND area_key=$2`, [ctx.user.id, key]);
    const who = n - (subbed ? 1 : 0);
    const reach = who > 0 ? `Thanks. ${who === 1 ? "One person following" : `${who} people following`} ${area} will hear in a few minutes, without your name.` : `Thanks. Nobody else follows ${area} yet, so it waits in the log for anyone who does.`;
    return { reply: `${reach} Say "${a.kind === "power" ? "light" : a.kind} is back in ${area}" when it returns.${subbed ? "" : ` To hear when others report it, say "alert me about outages in ${area}".`}`, undo: { payload: { id: row!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM home_area_sent WHERE report_id=$1`, [p.id]);
    await ctx.db.query(`DELETE FROM home_area_reports WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Taken back. Anyone not told yet won't be.";
  },
});

const clear = defineAction({
  name: "outage.clear",
  tier: 1,
  description: "Say power, water or internet is back in a neighbourhood: closes the open reports there. Followers see it in their morning note; no ping.",
  schema: z.object({ area: z.string().min(2).max(60), kind: z.enum(["power", "water", "internet"]) }),
  async run(a, ctx) {
    const key = areaKey(a.area), area = titled(a.area);
    const rows = await ctx.db.query<{ id: number }>(`UPDATE home_area_reports SET ended_at=$3 WHERE area_key=$1 AND kind=$2 AND ended_at IS NULL RETURNING id`, [key, a.kind, ctx.now]);
    if (!rows.length) return { reply: `Good to hear. Nobody had ${KIND_WORD[a.kind]} down as out in ${area}.` };
    return { reply: `Good news. ${cap(KIND_WORD[a.kind])} back in ${area}; anyone following sees it in their morning note.`, undo: { payload: { ids: rows.map((r) => r.id) } } };
  },
  async undo(p, ctx) { await ctx.db.query(`UPDATE home_area_reports SET ended_at=NULL WHERE id = ANY($1)`, [p.ids]); return "Taken back. It's down as out again."; },
});

const follow = defineAction({
  name: "outage.follow",
  tier: 1,
  description: "Opt in to quiet alerts when circle members report a power, water or internet outage in a neighbourhood (a name, never an address).",
  schema: z.object({ area: z.string().min(2).max(60) }),
  needs(a) { const bad = checkArea(a.area); return bad ? { need: "area", question: bad } : null; },
  async run(a, ctx) {
    const bad = checkArea(a.area);
    if (bad) throw new Error(bad);
    const key = areaKey(a.area), area = titled(a.area);
    const n = Number((await ctx.db.one<{ n: string }>(`SELECT count(*)::text AS n FROM home_area_subs WHERE user_id=$1`, [ctx.user.id]))?.n ?? 0);
    if (n >= 5) return { reply: "You follow five neighbourhoods already, which is as many as I keep. Say \"stop outage alerts for ...\" to make room." };
    await ctx.db.query(`INSERT INTO home_area_subs (user_id, area_key, area) VALUES ($1,$2,$3) ON CONFLICT (user_id, area_key) DO NOTHING`, [ctx.user.id, key, area]);
    return { reply: `I'll tell you when someone in the circle reports power, water or internet out in ${area}: one quiet line, a couple a day at most, and nobody's name. Say "stop outage alerts for ${area}" to stop.`, undo: { payload: { key } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM home_area_subs WHERE user_id=$1 AND area_key=$2`, [ctx.user.id, p.key]); return "Unfollowed."; },
});

const unfollow = defineAction({
  name: "outage.unfollow",
  tier: 1,
  description: "Stop outage alerts for one neighbourhood, or all of them when no area is given.",
  schema: z.object({ area: z.string().max(60).optional() }),
  async run(a, ctx) {
    const rows = await ctx.db.query<{ area_key: string; area: string }>(a.area ? `DELETE FROM home_area_subs WHERE user_id=$1 AND area_key=$2 RETURNING area_key, area` : `DELETE FROM home_area_subs WHERE user_id=$1 RETURNING area_key, area`, a.area ? [ctx.user.id, areaKey(a.area)] : [ctx.user.id]);
    if (!rows.length) return { reply: a.area ? `You weren't following ${titled(a.area)}.` : "You weren't following any neighbourhoods." };
    return { reply: `No more outage alerts for ${andList(rows.map((r) => r.area))}.`, undo: { payload: { rows } } };
  },
  async undo(p, ctx) {
    for (const r of p.rows) await ctx.db.query(`INSERT INTO home_area_subs (user_id, area_key, area) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.user.id, r.area_key, r.area]);
    return "Following again.";
  },
});

register(report, clear, follow, unfollow);

const KIND = "(power|light|electricity|nepa|current|water|internet|wi-?fi|network|broadband)";
const kindOf = (w: string) => (/^water$/i.test(w) ? "water" : /^(?:internet|wi-?fi|network|broadband)$/i.test(w) ? "internet" : "power");
const AREA = "([\\p{L}\\p{N}][\\p{L}\\p{N} .,'-]{1,39})";

addRules(
  [new RegExp(`^(?:the\\s+)?${KIND}\\s+(?:is\\s+|has\\s+|just\\s+)*(?:out|off|gone|down|cut|gone off|went off|been cut)\\s+(?:in|at|around)\\s+${AREA}$|^no\\s+${KIND}\\s+in\\s+${AREA}$|^${KIND}\\s+(?:cut|outage|blackout)\\s+in\\s+${AREA}$`, "iu"),
    (m) => ({ action: "outage.report", args: { kind: kindOf(m[1] ?? m[3] ?? m[5]), area: (m[2] ?? m[4] ?? m[6]).trim() } })],
  [new RegExp(`^(?:the\\s+)?${KIND}\\s+(?:is\\s+|has\\s+|just\\s+)*(?:back|restored|came back|come back|returned)(?:\\s+on)?\\s+in\\s+${AREA}$`, "iu"), (m) => ({ action: "outage.clear", args: { kind: kindOf(m[1]), area: m[2].trim() } })],
  [new RegExp(`^(?:alert|tell|notify|warn|ping)\\s+me\\s+(?:about|of|when there are|if there(?:'s| is| are))\\s+(?:any\\s+)?(?:power\\s+|light\\s+|water\\s+|internet\\s+)?(?:outages?|cuts?|blackouts?)\\s+in\\s+${AREA}$|^follow\\s+(?:the\\s+)?outages\\s+in\\s+${AREA}$`, "iu"), (m) => ({ action: "outage.follow", args: { area: (m[1] ?? m[2]).trim() } })],
  [new RegExp(`^(?:stop|no more|turn off|mute|end)\\s+(?:the\\s+)?outage alerts(?:\\s+(?:for|in|about)\\s+${AREA})?$`, "iu"), (m) => ({ action: "outage.unfollow", args: m[1] ? { area: m[1].trim() } : {} })],
);
addExamples("outage.report", ["power is out in Rumuola", "water cut in Akanda", "internet down in Kilimani", "no light in Wuse"]);
addExamples("outage.clear", ["light is back in Rumuola", "water is back in Akanda"]);
addExamples("outage.follow", ["alert me about outages in Rumuola", "tell me about power cuts in Soweto"]);
addExamples("outage.unfollow", ["stop outage alerts for Rumuola", "stop outage alerts"]);
addCues("outage", ["outage", "outages", "blackout", "power is out in", "light is back in", "water cut in", "internet down in", "neighbourhood", "area", "alert me about outages"]);
addCapability({
  key: "area_outages", name: "Outages near you",
  cues: ["outage", "outages", "blackout", "neighbourhood", "power is out in", "light in", "water cut in", "internet down in"],
  what: "When someone in the circle says \"power is out in Rumuola\", people who asked to hear about Rumuola get one quiet line. Neighbourhood names only, never addresses, and never who reported it.",
  say: ["alert me about outages in Rumuola", "power is out in Rumuola", "light is back in Rumuola"],
  then: "A report waits for your yes before anyone is told. Alerts are merged, a couple a day at most, and the all-clear comes in the morning note. Say \"stop outage alerts\" any time.",
}, "Home and paperwork");

/* ---------------- the merged alert ---------------- */

onJob("home_area_alert", async (job, deps) => {
  const key = String(job.payload?.key ?? "");
  const now = new Date();
  const open = await deps.db.query<{ id: number; user_id: number; area: string; kind: string; started_at: string }>(`SELECT id, user_id, area, kind, started_at FROM home_area_reports WHERE area_key=$1 AND ended_at IS NULL AND started_at > $2 ORDER BY started_at`, [key, new Date(now.getTime() - OPEN_HOURS * 3_600_000)]);
  if (!open.length) return;
  const subs = await deps.db.query<{ user_id: number }>(`SELECT user_id FROM home_area_subs WHERE area_key=$1`, [key]);
  for (const s of subs) {
    const fresh = [];
    for (const r of open) {
      if (r.user_id === s.user_id) continue;
      if (!(await deps.db.one(`SELECT 1 FROM home_area_sent WHERE user_id=$1 AND report_id=$2`, [s.user_id, r.id]))) fresh.push(r);
    }
    if (!fresh.length) continue;
    const user = await deps.getUser(s.user_id);
    if (!user) continue;
    const text = alertLine(open.filter((r) => r.user_id !== s.user_id), user) + ` Say "stop outage alerts for ${open[0].area}" to stop these.`;
    if (await pingOnce(deps, user, "area", text, { max: 2, now, buttons: [{ label: "Stop these", data: `hm:area:${key}`.slice(0, 63) }] })) {
      for (const r of fresh) await deps.db.query(`INSERT INTO home_area_sent (user_id, report_id, sent_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [s.user_id, r.id, now]);
    }
  }
});

function alertLine(rows: { area: string; kind: string; started_at: string }[], user: User): string {
  const kinds = [...new Set(rows.map((r) => r.kind))];
  const first = rows.reduce((a, r) => (new Date(r.started_at) < new Date(a.started_at) ? r : a), rows[0]);
  const n = rows.length;
  return `${cap(andList(kinds.map((k) => KIND_WORD[k])))} reported out in ${rows[0].area} since ${local(first.started_at, user.tz).toFormat("HH:mm")}${n > 1 ? ` (${n} reports)` : ""}.`;
}

addBriefSection({
  key: "home_area", order: 20,
  async lines(db, user, now) {
    const subs = await db.query<{ area_key: string; area: string }>(`SELECT area_key, area FROM home_area_subs WHERE user_id=$1`, [user.id]);
    const out: string[] = [];
    for (const s of subs) {
      const open = await db.query<any>(`SELECT area, kind, started_at FROM home_area_reports WHERE area_key=$1 AND ended_at IS NULL AND started_at > $2 AND user_id<>$3`, [s.area_key, new Date(now.getTime() - OPEN_HOURS * 3_600_000), user.id]);
      if (open.length) { out.push(alertLine(open, user)); continue; }
      const back = await db.query<{ kind: string; ended_at: string }>(`SELECT kind, max(ended_at) AS ended_at FROM home_area_reports WHERE area_key=$1 AND ended_at > $2 GROUP BY kind`, [s.area_key, new Date(now.getTime() - 18 * 3_600_000)]);
      if (back.length) out.push(`${cap(andList(back.map((b) => KIND_WORD[b.kind])))} back in ${s.area} since ${local(back[0].ended_at, user.tz).toFormat("HH:mm")}.`);
    }
    return out.slice(0, 2);
  },
});

export async function areaButton(db: Db, user: User, parts: string[]): Promise<string | null> {
  if (parts[0] !== "area" || !parts[1]) return null;
  const rows = await db.query<{ area: string }>(`DELETE FROM home_area_subs WHERE user_id=$1 AND area_key=$2 RETURNING area`, [user.id, parts.slice(1).join(":")]);
  return rows.length ? `No more outage alerts for ${rows[0].area}.` : "You weren't following that neighbourhood any more.";
}
