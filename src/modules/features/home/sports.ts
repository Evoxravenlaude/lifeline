/**
 * Sports: fixtures and results for teams people follow, any sport, any country.
 * TheSportsDB (free key "3", non-commercial) finds teams and covers every sport; football-data.org
 * (FOOTBALL_DATA_KEY, free tier: 12 football competitions, 10 calls a minute) is used for football
 * teams it covers. One shared poll for everyone; a kickoff ping an hour before (one a day per person)
 * and the final score in the next morning note.
 */
import { z } from "zod";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import type { Db } from "../../../core/db.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema, addSystemJob } from "../../../core/plugins.js";
import { DateTime } from "luxon";
import { onJob } from "../../../core/scheduler.js";
import { localDay } from "../../../core/time.js";
import { andList, cacheGet, cachePut, dayWord, getJson, local, pingOnce, usersIn } from "./util.js";

addSchema(`CREATE TABLE IF NOT EXISTS home_teams (id SERIAL PRIMARY KEY, source TEXT NOT NULL, ext_id TEXT NOT NULL, name TEXT NOT NULL, sport TEXT, league TEXT, fd_id TEXT, refreshed_at TIMESTAMPTZ, UNIQUE (source, ext_id));
CREATE TABLE IF NOT EXISTS home_follows (user_id INT NOT NULL REFERENCES users(id), team_id INT NOT NULL REFERENCES home_teams(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (user_id, team_id));
CREATE TABLE IF NOT EXISTS home_matches (id SERIAL PRIMARY KEY, team_id INT NOT NULL REFERENCES home_teams(id), source TEXT NOT NULL, ext_id TEXT NOT NULL, home TEXT NOT NULL, away TEXT NOT NULL, starts_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL, home_score INT, away_score INT, competition TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (team_id, source, ext_id));
CREATE INDEX IF NOT EXISTS home_matches_time ON home_matches(starts_at);
CREATE TABLE IF NOT EXISTS home_match_sent (user_id INT NOT NULL REFERENCES users(id), day TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (user_id, day, kind))`);

const TSDB = () => `https://www.thesportsdb.com/api/v1/json/${process.env.THESPORTSDB_KEY || "3"}`;
const FD = "https://api.football-data.org/v4";
const fdKey = () => process.env.FOOTBALL_DATA_KEY ?? "";
/** The free football-data.org competitions: Premier League, Championship, La Liga, Serie A, Bundesliga, Ligue 1, Eredivisie, Primeira Liga, Brasileirão, Champions League, the Euros and the World Cup. */
export const FD_FREE = ["PL", "ELC", "PD", "SA", "BL1", "FL1", "DED", "PPL", "BSA", "CL", "EC", "WC"];

/** Nicknames people use for national sides. */
const ALIAS: Record<string, [string, string]> = {
  "super eagles": ["Nigeria", "Soccer"], "super falcons": ["Nigeria Women", "Soccer"], "black stars": ["Ghana", "Soccer"], "bafana bafana": ["South Africa", "Soccer"], "indomitable lions": ["Cameroon", "Soccer"],
  "pharaohs": ["Egypt", "Soccer"], "atlas lions": ["Morocco", "Soccer"], "harambee stars": ["Kenya", "Soccer"], "les pantheres": ["Gabon", "Soccer"], "the panthers": ["Gabon", "Soccer"], "teranga lions": ["Senegal", "Soccer"],
  "elephants": ["Ivory Coast", "Soccer"], "les bleus": ["France", "Soccer"], "three lions": ["England", "Soccer"], "selecao": ["Brazil", "Soccer"], "seleção": ["Brazil", "Soccer"], "albiceleste": ["Argentina", "Soccer"],
  "la roja": ["Spain", "Soccer"], "azzurri": ["Italy", "Soccer"], "die mannschaft": ["Germany", "Soccer"], "oranje": ["Netherlands", "Soccer"], "el tri": ["Mexico", "Soccer"], "socceroos": ["Australia", "Soccer"],
  "springboks": ["South Africa", "Rugby"], "all blacks": ["New Zealand", "Rugby"], "wallabies": ["Australia", "Rugby"],
};

interface Team { id: number; source: string; ext_id: string; name: string; sport: string | null; league: string | null; fd_id: string | null; refreshed_at: string | null }
interface Match { ext_id: string; source: string; home: string; away: string; starts_at: Date; status: "scheduled" | "live" | "finished" | "off"; home_score: number | null; away_score: number | null; competition: string | null }

/* ---------------- the two sources ---------------- */

const tsdbTime = (e: any): Date | null => {
  const s = typeof e.strTimestamp === "string" && e.strTimestamp ? (/(?:z|[+-]\d\d:?\d\d)$/i.test(e.strTimestamp) ? e.strTimestamp : `${e.strTimestamp}Z`)
    : e.dateEvent ? `${e.dateEvent}T${String(e.strTime || "12:00:00").slice(0, 8)}Z` : null;
  const d = s ? new Date(s) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

function tsdbMatch(e: any, now: Date): Match | null {
  const starts = tsdbTime(e);
  if (!starts || !e.idEvent || !e.strHomeTeam || !e.strAwayTeam) return null;
  const hs = num(e.intHomeScore), as = num(e.intAwayScore), st = String(e.strStatus ?? "");
  const status: Match["status"] = /postpon|cancel|abandon|suspend/i.test(st) ? "off"
    : /finish|^ft$|^aet$|^pen|ended|^aot$|final/i.test(st) || (hs !== null && as !== null && starts.getTime() < now.getTime() - 3 * 3_600_000) ? "finished"
    : /^(?:1h|2h|ht|et|bt|p|live|in ?play|q[1-4]|ot|\d+')$/i.test(st) ? "live" : "scheduled";
  return { ext_id: String(e.idEvent), source: "tsdb", home: e.strHomeTeam, away: e.strAwayTeam, starts_at: starts, status, home_score: hs, away_score: as, competition: e.strLeague ?? null };
}

function fdMatch(m: any): Match | null {
  if (!m?.id || !m.utcDate) return null;
  const s = String(m.status ?? "");
  const status: Match["status"] = s === "FINISHED" || s === "AWARDED" ? "finished" : s === "IN_PLAY" || s === "PAUSED" || s === "LIVE" ? "live" : /POSTPONED|CANCELLED|SUSPENDED/.test(s) ? "off" : "scheduled";
  return { ext_id: String(m.id), source: "fd", home: m.homeTeam?.shortName || m.homeTeam?.name || "?", away: m.awayTeam?.shortName || m.awayTeam?.name || "?", starts_at: new Date(m.utcDate), status, home_score: num(m.score?.fullTime?.home), away_score: num(m.score?.fullTime?.away), competition: m.competition?.name ?? null };
}

async function tsdbSearch(name: string): Promise<any[] | null> {
  const r = await getJson(`${TSDB()}/searchteams.php?t=${encodeURIComponent(name)}`);
  if (!r || r.status >= 400) return null;
  return Array.isArray(r.data?.teams) ? r.data.teams : [];
}

const fdNorm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/\b(?:fc|afc|cf|sc|ac|club|de|futbol|football)\b/g, "").replace(/[^a-z0-9]/g, "");
/** football-data.org's id for a team, from the cached lists of its free competitions. */
async function fdLookup(db: Db, name: string): Promise<{ id: string; name: string; league: string } | null> {
  const want = fdNorm(name);
  if (!want) return null;
  for (const code of FD_FREE) {
    const list = await cacheGet<any[]>(db, `fd:teams:${code}`, 60 * 86_400_000);
    const t = list?.find((x) => [x.name, x.shortName, x.tla].filter(Boolean).some((n: string) => fdNorm(n) === want));
    if (t) return { id: String(t.id), name: t.shortName || t.name, league: code };
  }
  return null;
}

/** Fresh fixtures and results for one team. False when no source answered. */
export async function refreshTeam(db: Db, team: Team, now = new Date()): Promise<boolean> {
  let got: Match[] | null = null;
  if (team.fd_id && fdKey()) {
    const from = local(now, "UTC").minus({ days: 3 }).toISODate(), to = local(now, "UTC").plus({ days: 10 }).toISODate();
    const r = await getJson(`${FD}/teams/${team.fd_id}/matches?dateFrom=${from}&dateTo=${to}`, { headers: { "X-Auth-Token": fdKey() } });
    if (r && r.status < 400 && Array.isArray(r.data?.matches)) got = r.data.matches.map(fdMatch).filter(Boolean) as Match[];
  }
  if (!got && team.source === "tsdb") {
    const [next, last] = await Promise.all([getJson(`${TSDB()}/eventsnext.php?id=${team.ext_id}`), getJson(`${TSDB()}/eventslast.php?id=${team.ext_id}`)]);
    if ((next && next.status < 400) || (last && last.status < 400)) {
      const evs = [...(next?.data?.events ?? next?.data?.results ?? []), ...(last?.data?.results ?? last?.data?.events ?? [])];
      got = evs.map((e: any) => tsdbMatch(e, now)).filter(Boolean) as Match[];
    }
  }
  if (!got) { await db.query(`UPDATE home_teams SET refreshed_at=$2 WHERE id=$1`, [team.id, new Date(now.getTime() - 5 * 3_600_000)]); return false; }
  for (const m of got) {
    await db.query(`INSERT INTO home_matches (team_id, source, ext_id, home, away, starts_at, status, home_score, away_score, competition, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (team_id, source, ext_id) DO UPDATE SET home=EXCLUDED.home, away=EXCLUDED.away, starts_at=EXCLUDED.starts_at, status=EXCLUDED.status, home_score=EXCLUDED.home_score, away_score=EXCLUDED.away_score, competition=EXCLUDED.competition, updated_at=EXCLUDED.updated_at`,
      [team.id, m.source, m.ext_id, m.home, m.away, m.starts_at, m.status, m.home_score, m.away_score, m.competition, now]);
  }
  await db.query(`UPDATE home_teams SET refreshed_at=$2 WHERE id=$1`, [team.id, now]);
  return true;
}

/** Find a team by what people call it: TheSportsDB first, then football-data.org's cached lists. */
async function findTeam(db: Db, said: string): Promise<{ team: Team | null; reachable: boolean }> {
  const q = said.trim().replace(/^the\s+/i, "").replace(/\s+(?:fc|football club)$/i, "");
  const alias = ALIAS[q.toLowerCase()];
  const name = alias?.[0] ?? q;
  const found = await tsdbSearch(name);
  if (found && found.length) {
    const lc = name.toLowerCase();
    const pick = found.find((t) => String(t.strTeam).toLowerCase() === lc && (!alias || t.strSport === alias[1]))
      ?? found.find((t) => !alias || t.strSport === alias[1]) ?? found[0];
    const fd = pick.strSport === "Soccer" ? await fdLookup(db, pick.strTeam) : null;
    const row = await db.one<Team>(`INSERT INTO home_teams (source, ext_id, name, sport, league, fd_id) VALUES ('tsdb',$1,$2,$3,$4,$5)
      ON CONFLICT (source, ext_id) DO UPDATE SET name=EXCLUDED.name, sport=EXCLUDED.sport, league=EXCLUDED.league, fd_id=COALESCE(EXCLUDED.fd_id, home_teams.fd_id) RETURNING *`,
      [String(pick.idTeam), pick.strTeam, pick.strSport ?? null, pick.strLeague ?? null, fd?.id ?? null]);
    return { team: row!, reachable: true };
  }
  if (fdKey()) {
    const fd = await fdLookup(db, name);
    if (fd) {
      const row = await db.one<Team>(`INSERT INTO home_teams (source, ext_id, name, sport, league, fd_id) VALUES ('fd',$1,$2,'Soccer',$3,$1) ON CONFLICT (source, ext_id) DO UPDATE SET name=EXCLUDED.name RETURNING *`, [fd.id, fd.name, fd.league]);
      return { team: row!, reachable: true };
    }
  }
  return { team: null, reachable: found !== null };
}

async function followed(db: Db, userId: number): Promise<Team[]> {
  return db.query<Team>(`SELECT t.* FROM home_teams t JOIN home_follows f ON f.team_id=t.id WHERE f.user_id=$1 ORDER BY f.created_at`, [userId]);
}
function pickFollowed(list: Team[], said: string): Team | null {
  const q = said.trim().replace(/^the\s+/i, "").toLowerCase();
  const alias = ALIAS[q]?.[0].toLowerCase();
  return list.find((t) => t.name.toLowerCase() === q || t.name.toLowerCase() === alias) ?? list.find((t) => t.name.toLowerCase().includes(q) || (alias && t.name.toLowerCase().includes(alias))) ?? null;
}

async function matchesOf(db: Db, teamId: number): Promise<{ next: any | null; last: any | null }> {
  const next = await db.one<any>(`SELECT * FROM home_matches WHERE team_id=$1 AND status IN ('scheduled','live') AND starts_at > now() - interval '3 hours' ORDER BY starts_at LIMIT 1`, [teamId]);
  const last = await db.one<any>(`SELECT * FROM home_matches WHERE team_id=$1 AND status='finished' ORDER BY starts_at DESC LIMIT 1`, [teamId]);
  return { next: next ?? null, last: last ?? null };
}
const score = (m: any) => `${m.home} ${m.home_score}, ${m.away} ${m.away_score}`;
function fixture(m: any, user: User, now: Date): string {
  const L = local(m.starts_at, user.tz);
  return `${m.home} v ${m.away}, ${m.status === "live" ? "on now" : `${dayWord(L, local(now, user.tz))} at ${L.toFormat("HH:mm")}`}${m.competition ? ` (${m.competition})` : ""}`;
}

/* ---------------- actions ---------------- */

const follow = defineAction({
  name: "sports.follow",
  tier: 1,
  description: "Follow a sports team (any sport, any country: 'Arsenal', 'the Lakers', 'Super Eagles'): a ping an hour before each game and the final score in the morning brief.",
  schema: z.object({ team: z.string().min(2).max(60) }),
  async run(a, ctx) {
    const { team, reachable } = await findTeam(ctx.db, a.team);
    if (!team) throw new Error(reachable ? `I couldn't find a team called "${a.team}". Try its full name, like "Manchester United" or "Los Angeles Lakers".` : "I couldn't reach the sports listings just now. Try again in a few minutes.");
    const mine = await followed(ctx.db, ctx.user.id);
    if (mine.some((t) => t.id === team.id)) return { reply: `You already follow ${team.name}.` };
    if (mine.length >= 10) return { reply: `You follow ten teams, which is as many as I keep. Say "stop following ..." to make room.` };
    await ctx.db.query(`INSERT INTO home_follows (user_id, team_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.user.id, team.id, ctx.now]);
    if (!team.refreshed_at || ctx.now.getTime() - new Date(team.refreshed_at).getTime() > 3 * 3_600_000) await refreshTeam(ctx.db, team, ctx.now);
    const { next } = await matchesOf(ctx.db, team.id);
    const league = team.league && !/^_/.test(team.league) ? ` (${team.league})` : "";
    return { reply: `Following ${team.name}${league}.${next ? ` Next: ${fixture(next, ctx.user, ctx.now)}.` : ""} I'll ping you an hour before each game, and the score comes in your morning note. Say "stop following ${team.name}" to stop.`, undo: { payload: { team: team.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM home_follows WHERE user_id=$1 AND team_id=$2`, [ctx.user.id, p.team]); return "Unfollowed."; },
});

const unfollow = defineAction({
  name: "sports.unfollow",
  tier: 1,
  description: "Stop following a sports team: no more kickoff pings or scores for it.",
  schema: z.object({ team: z.string().min(2).max(60) }),
  async run(a, ctx) {
    const t = pickFollowed(await followed(ctx.db, ctx.user.id), a.team);
    if (!t) return { reply: `You weren't following ${a.team}. Say "my teams" to see who you follow.` };
    await ctx.db.query(`DELETE FROM home_follows WHERE user_id=$1 AND team_id=$2`, [ctx.user.id, t.id]);
    return { reply: `Stopped following ${t.name}.`, undo: { payload: { team: t.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`INSERT INTO home_follows (user_id, team_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ctx.user.id, p.team]); return "Following again."; },
});

const next = defineAction({
  name: "sports.next",
  tier: 1,
  description: "When a team plays next and how its last game went ('when do Barcelona play'). With no team, the next game for each team the person follows.",
  schema: z.object({ team: z.string().max(60).optional() }),
  async run(a, ctx) {
    const mine = await followed(ctx.db, ctx.user.id);
    let teams: Team[];
    let notFollowed = false;
    if (a.team) {
      const t = pickFollowed(mine, a.team);
      if (t) teams = [t];
      else {
        const { team, reachable } = await findTeam(ctx.db, a.team);
        if (!team) throw new Error(reachable ? `I couldn't find a team called "${a.team}". Try its full name?` : "I couldn't reach the sports listings just now. Try again in a few minutes.");
        teams = [team]; notFollowed = true;
      }
    } else teams = mine;
    if (!teams.length) {
      // No teams yet: answer the question anyway ("what matches are on today"), then offer the follow.
      const { search, mediaAbilities } = await import("../../../core/media.js");
      const day = DateTime.fromJSDate(ctx.now).setZone(ctx.user.tz).toFormat("cccc d LLLL yyyy");
      const f = mediaAbilities().search ? await search(`Which major football matches are on ${day}? Kickoff times in ${ctx.user.tz}. Premier League, La Liga, Serie A, Bundesliga, Champions League and the Nigerian league first; then any big NBA or other games.`, ctx.user.tz).catch(() => null) : null;
      const tip = `Say "follow Arsenal" (any team) and I'll ping you before their games.`;
      return { reply: f ? `${f.answer}\n\n${tip}` : `I couldn't get today's listings just now. ${tip}` };
    }
    const lines: string[] = [];
    for (const t of teams.slice(0, 6)) {
      if (!t.refreshed_at || ctx.now.getTime() - new Date(t.refreshed_at).getTime() > 3 * 3_600_000) await refreshTeam(ctx.db, t, ctx.now);
      const { next: n, last } = await matchesOf(ctx.db, t.id);
      if (teams.length === 1) {
        lines.push(n ? `${t.name}: ${fixture(n, ctx.user, ctx.now)}.` : `${t.name} have nothing scheduled in the listings yet.`);
        if (last) lines.push(`Last time: ${score(last)}.`);
      } else lines.push(`- ${t.name}: ${n ? fixture(n, ctx.user, ctx.now) : "nothing scheduled yet"}`);
    }
    if (notFollowed) lines.push(`Say "follow ${teams[0].name}" for a ping before kickoff.`);
    return { reply: lines.join(teams.length === 1 ? " " : "\n") };
  },
});

const list = defineAction({
  name: "sports.list",
  tier: 1,
  description: "The teams the person follows.",
  schema: z.object({}),
  async run(_a, ctx) {
    const mine = await followed(ctx.db, ctx.user.id);
    if (!mine.length) return { reply: `You don't follow any teams yet. Say "follow Arsenal" or "follow the Lakers".` };
    return { reply: `You follow ${andList(mine.map((t) => t.name))}. Say "when do ${mine[0].name} play" for the next game, or "stop following ${mine[0].name}" to drop one.` };
  },
});

register(follow, unfollow, next, list);

/* ---------------- words ---------------- */

const NOT_TEAM = "(?!.*\\b(?:status|statuses|status pages?|uptime|alerts?|feed|repo|releases?|prices?|news|blog|account|wallet)$)(?!(?:me|up|you|him|her|them|us|this|that|it|along|through|suit|instructions?|orders|outages?|the (?:plan|rules|news|money|steps|recipe|instructions|link|thread)|my (?:gut|heart|dreams?)|greenhouse|lever|ashby|remoteok|remotive|jobs?|wallet|trader)\\b)(?![@/])(?!\\S*\\d\\S*$)";
const TEAM = "([\\p{L}][\\p{L}\\p{N} .'&-]{1,40}?)";
addRules(
  [new RegExp(`^follow\\s+${NOT_TEAM}(?:the\\s+team\\s+)?${TEAM}(?:\\s+(?:fixtures|games|matches|results))?$`, "iu"), (m) => ({ action: "sports.follow", args: { team: m[1].trim() } })],
  [new RegExp(`^(?:stop following|unfollow the team)\\s+${NOT_TEAM}(?:the\\s+team\\s+)?${TEAM}(?:\\s+(?:fixtures|games|matches|results|pings))?$`, "iu"), (m) => ({ action: "sports.unfollow", args: { team: m[1].trim() } })],
  [new RegExp(`^when\\s+(?:do|does|are|is)\\s+(?:the\\s+)?${TEAM}\\s+(?:play|playing|play next|playing next|next playing)$|^(?:when'?s|when is)\\s+(?:the\\s+)?next\\s+${TEAM}\\s+(?:game|match|fixture)$|^next\\s+${TEAM}\\s+(?:game|match|fixture)$|^(?!my\\s)${TEAM}\\s+(?:fixtures|next game|next match)$`, "iu"), (m) => ({ action: "sports.next", args: { team: (m[1] ?? m[2] ?? m[3] ?? m[4]).trim() } })],
  [/^(?:what|which) (?:matches|games|fixtures) are (?:on|playing)(?: today| tonight)?\??$|^(?:any|are there(?: any)?) (?:big )?(?:matches|games)(?: on)? (?:today|tonight)\??$/i, () => ({ action: "sports.next", args: {} })],
  [/^(?:my\s+)?(?:teams|fixtures)$|^who do i follow$/i, (m) => (/fixtures/i.test(m[0]) ? { action: "sports.next", args: {} } : { action: "sports.list", args: {} })],
);
addExamples("sports.follow", ["follow Arsenal", "follow the Lakers", "follow Super Eagles", "follow Kaizer Chiefs"]);
addExamples("sports.unfollow", ["stop following Arsenal", "stop following the Lakers"]);
addExamples("sports.next", ["when do Barcelona play", "when is the next Arsenal game", "my fixtures"]);
addExamples("sports.list", ["my teams", "who do I follow"]);
addCues("sports", ["follow", "team", "match", "game", "fixture", "fixtures", "kickoff", "kick off", "score", "result", "football", "soccer", "basketball", "nba", "premier league", "league", "play next", "super eagles"]);
addCapability({
  key: "sports", name: "Your teams",
  cues: ["team", "teams", "fixtures", "kickoff", "football", "soccer", "basketball", "match", "results", "follow arsenal"],
  what: "Follow any team in any sport and I'll ping you an hour before they play and put the final score in your morning note.",
  say: ["follow Arsenal", "follow the Lakers", "when do Barcelona play", "stop following Arsenal"],
  then: "One kickoff ping a day at most, even if several of your teams play. Scores come in the morning.",
  limits: "Listings come from TheSportsDB and, for the big football leagues, football-data.org. Smaller leagues can be late or missing.",
}, "Your day");

/* ---------------- the shared poll, the ping and the brief ---------------- */

addSystemJob("home_sports", "4,19,34,49 * * * *");
onJob("home_sports", async (_job, deps) => {
  const now = new Date();
  // 1. Kickoffs in about an hour: one merged ping per person per day.
  const soon = await deps.db.query<any>(`SELECT m.*, t.name AS team, t.sport, f.user_id FROM home_matches m JOIN home_teams t ON t.id=m.team_id JOIN home_follows f ON f.team_id=m.team_id
    WHERE m.status='scheduled' AND m.starts_at > $1 AND m.starts_at <= $2 ORDER BY m.starts_at`, [new Date(now.getTime() + 45 * 60_000), new Date(now.getTime() + 75 * 60_000)]);
  const byUser = new Map<number, any[]>();
  for (const r of soon) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  for (const [uid, rows] of byUser) {
    const user = await deps.getUser(uid);
    if (!user) continue;
    const day = localDay(now, user.tz);
    if (await deps.db.one(`SELECT 1 FROM home_match_sent WHERE user_id=$1 AND day=$2 AND kind='kickoff'`, [uid, day])) continue;
    const seen = new Set<string>();
    const games = rows.filter((r) => (seen.has(r.ext_id) ? false : (seen.add(r.ext_id), true)));
    const verb = (r: any) => (r.sport === "Soccer" ? "kicks off" : "starts");
    const text = games.length === 1
      ? `${games[0].home} v ${games[0].away} ${verb(games[0])} at ${local(games[0].starts_at, user.tz).toFormat("HH:mm")}, in about an hour. Say "stop following ${games[0].team}" to stop these.`
      : `In about an hour: ${andList(games.map((g) => `${g.home} v ${g.away} at ${local(g.starts_at, user.tz).toFormat("HH:mm")}`))}. Say "stop following ..." to drop a team.`;
    if (await pingOnce(deps, user, "sports", text, { now })) await deps.db.query(`INSERT INTO home_match_sent (user_id, day, kind) VALUES ($1,$2,'kickoff') ON CONFLICT DO NOTHING`, [uid, day]);
  }
  // 2. Refresh a few teams: stale listings first, then games that should have finished by now.
  const stale = await deps.db.query<Team>(`SELECT DISTINCT t.* FROM home_teams t JOIN home_follows f ON f.team_id=t.id
    WHERE t.refreshed_at IS NULL OR t.refreshed_at < $1 OR EXISTS (SELECT 1 FROM home_matches m WHERE m.team_id=t.id AND m.status IN ('scheduled','live') AND m.starts_at < $2 AND m.starts_at > $3 AND m.updated_at < $4)
    ORDER BY t.refreshed_at NULLS FIRST LIMIT 4`, [new Date(now.getTime() - 6 * 3_600_000), new Date(now.getTime() - 110 * 60_000), new Date(now.getTime() - 2 * 86_400_000), new Date(now.getTime() - 20 * 60_000)]);
  for (const t of stale) await refreshTeam(deps.db, t, now);
  // 3. With a football-data.org key, learn its team lists slowly (two competitions a run, kept for weeks), then map teams to it.
  if (fdKey()) {
    let fetched = 0;
    for (const code of FD_FREE) {
      if (fetched >= 2) break;
      if (await cacheGet(deps.db, `fd:teams:${code}`, 30 * 86_400_000, now)) continue;
      const r = await getJson(`${FD}/competitions/${code}/teams`, { headers: { "X-Auth-Token": fdKey() } });
      fetched++;
      if (r && r.status < 400 && Array.isArray(r.data?.teams)) await cachePut(deps.db, `fd:teams:${code}`, r.data.teams.map((t: any) => ({ id: t.id, name: t.name, shortName: t.shortName, tla: t.tla })), now);
    }
    for (const t of await deps.db.query<Team>(`SELECT * FROM home_teams WHERE fd_id IS NULL AND sport='Soccer' LIMIT 20`)) {
      const fd = await fdLookup(deps.db, t.name);
      if (fd) await deps.db.query(`UPDATE home_teams SET fd_id=$2 WHERE id=$1`, [t.id, fd.id]);
    }
  }
});

addBriefSection({
  key: "home_sports", order: 60,
  async lines(db, user, now) {
    const rows = await db.query<any>(`SELECT DISTINCT ON (m.source, m.ext_id) m.* FROM home_matches m JOIN home_follows f ON f.team_id=m.team_id WHERE f.user_id=$1 AND m.starts_at > $2 AND m.starts_at < $3 ORDER BY m.source, m.ext_id, m.starts_at`,
      [user.id, new Date(now.getTime() - 30 * 3_600_000), local(now, user.tz).endOf("day").toJSDate()]);
    const done = rows.filter((r) => r.status === "finished" && r.home_score !== null).sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at));
    const today = rows.filter((r) => r.status === "scheduled" && new Date(r.starts_at) > now && local(r.starts_at, user.tz).hasSame(local(now, user.tz), "day"));
    const out: string[] = [];
    if (done.length) out.push(`${done.length === 1 ? "Result" : "Results"}: ${done.slice(0, 3).map(score).join("; ")}.`);
    if (today.length) out.push(`Today: ${andList(today.slice(0, 3).map((g) => `${g.home} v ${g.away} at ${local(g.starts_at, user.tz).toFormat("HH:mm")}`))}.`);
    return out;
  },
});

export async function teamButton(db: Db, user: User, parts: string[]): Promise<string | null> {
  if (parts[0] !== "team") return null;
  const t = await db.one<Team>(`DELETE FROM home_follows WHERE user_id=$1 AND team_id=$2 RETURNING team_id`, [user.id, Number(parts[1])]);
  return t ? "Stopped following them." : "You weren't following that team any more.";
}
