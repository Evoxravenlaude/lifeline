/**
 * Hackathon discovery + the participant's own ledger.
 * Discovery rows come from pollers (src/pollers). The ledger holds what no
 * platform exposes: submission, outcome, results date, payout chase.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { fmt, humanDelta, parseWhen } from "../core/time.js";
import { onJob, push, schedule } from "../core/scheduler.js";

export interface Hack {
  id: number;
  source: string;
  title: string;
  url: string;
  deadline: string | null;
  prize_usd: string | null;
  registrations: number | null;
  online: boolean | null;
  tags: string[];
  quality: number | null;
}

/** Odds-style score: prize per registrant, quality, remote eligibility, user tags. */
export function scoreHack(h: Hack, prefs: { tags?: string[]; remoteOnly?: boolean }, now: Date): number {
  let s = 0;
  const prize = Number(h.prize_usd ?? 0);
  const regs = h.registrations ?? 0;
  if (prize > 0) s += Math.min(40, Math.log10(prize + 1) * 10);
  if (prize > 0 && regs > 0) s += Math.min(25, (prize / regs) / 20); // $500/registrant → 25
  if (h.quality) s += h.quality / 5; // 0-20
  if (h.online) s += 10;
  else if (prefs.remoteOnly) s -= 100;
  const wanted = (prefs.tags ?? []).map((t) => t.toLowerCase());
  const hit = h.tags.filter((t) => wanted.some((w) => t.toLowerCase().includes(w))).length;
  s += Math.min(20, hit * 7);
  if (h.deadline) {
    const days = (new Date(h.deadline).getTime() - now.getTime()) / 86_400_000;
    if (days < 0) s -= 100;
    else if (days < 2) s -= 15; // too late to build well
    else if (days <= 21) s += 5;
  }
  return Math.round(s);
}

export async function rankedForUser(db: any, user: any, now: Date, limit = 8): Promise<(Hack & { score: number })[]> {
  const prefs = { tags: (user.prefs?.tags as string[]) ?? [], remoteOnly: user.prefs?.remoteOnly !== false };
  const rows = await db.query(
    `SELECT h.* FROM hackathons h
     WHERE (h.deadline IS NULL OR h.deadline > $2)
       AND NOT EXISTS (SELECT 1 FROM hackathon_seen s WHERE s.user_id=$1 AND s.hackathon_id=h.id)
     ORDER BY h.first_seen DESC LIMIT 300`,
    [user.id, now],
  );
  return rows
    .map((h: Hack) => ({ ...h, score: scoreHack(h, prefs, now) }))
    .filter((h: any) => h.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit);
}

export function hackLine(h: Hack & { score?: number }, tz: string, now: Date): string {
  const parts = [h.title];
  if (h.prize_usd) parts.push(`$${Number(h.prize_usd).toLocaleString()}`);
  if (h.registrations) parts.push(`${h.registrations} reg`);
  if (h.deadline) parts.push(`due ${fmt(h.deadline, tz)} (${humanDelta(now, h.deadline)})`);
  parts.push(h.online === false ? "in person" : "online");
  return `• ${parts.join(" · ")}\n  ${h.url}`;
}

const discover = defineAction({
  name: "hackathon.discover",
  tier: 1,
  description: "Show the top-ranked open hackathons for this user (prize/registrations, quality, tags, remote). Optional tag filter like 'solana' or 'ai'.",
  schema: z.object({ tag: z.string().optional(), limit: z.number().int().min(1).max(15).optional() }),
  async run(args, ctx) {
    const u = args.tag ? { ...ctx.user, prefs: { ...ctx.user.prefs, tags: [args.tag] } } : ctx.user;
    const list = await rankedForUser(ctx.db, u, ctx.now, args.limit ?? 8);
    if (!list.length) return { reply: "Nothing new in the feed. Pollers run every 6h; set HACKATHONRADAR_API_KEY for the wide net." };
    for (const h of list) await ctx.db.query(`INSERT INTO hackathon_seen (user_id, hackathon_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ctx.user.id, h.id]);
    return { reply: list.map((h) => `[${h.score}] ${hackLine(h, ctx.user.tz, ctx.now)}`).join("\n") };
  },
});

const setTags = defineAction({
  name: "hackathon.set_interests",
  tier: 1,
  description: "Set the tags used to rank hackathons for this user (e.g. ['solana','ai','defi']) and whether remote-only.",
  schema: z.object({ tags: z.array(z.string()).max(12), remote_only: z.boolean().optional() }),
  async run(args, ctx) {
    const prefs = { ...ctx.user.prefs, tags: args.tags, remoteOnly: args.remote_only ?? true };
    await ctx.db.query(`UPDATE users SET prefs=$2 WHERE id=$1`, [ctx.user.id, JSON.stringify(prefs)]);
    return { reply: `Ranking on: ${args.tags.join(", ") || "(no tags)"}; ${prefs.remoteOnly ? "remote only" : "any location"}.` };
  },
});

onJob("hack_deadline", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const e = await deps.db.one<{ title: string; deadline: string; status: string; url: string | null }>(`SELECT title, deadline, status, url FROM hackathon_entries WHERE id=$1`, [job.payload.entryId]);
  if (!e || ["submitted", "won", "lost", "withdrawn"].includes(e.status)) return;
  await push(deps, user, "reminder", `🏁 ${e.title} closes ${fmt(e.deadline, user.tz)} (${humanDelta(new Date(), e.deadline)}). Status: ${e.status}.${e.url ? `\n${e.url}` : ""}`, { exempt: true });
});

onJob("hack_payout", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const e = await deps.db.one<{ title: string; payout_received: string | null; prize: string | null }>(`SELECT title, payout_received, prize FROM hackathon_entries WHERE id=$1`, [job.payload.entryId]);
  if (!e || e.payout_received) return;
  await push(deps, user, "reminder", `💸 ${job.payload.days} days since results for ${e.title} and no payout logged${e.prize ? ` (${e.prize})` : ""}. Worth chasing the organiser.`, { exempt: true });
});

const track = defineAction({
  name: "hackathon.track",
  tier: 1,
  description: "Add a hackathon to the user's ledger by title (and url/deadline if known). Schedules alerts 3 days, 1 day and 6 hours before the deadline.",
  schema: z.object({ title: z.string().min(1), url: z.string().url().optional(), deadline: z.string().optional(), notes: z.string().optional() }),
  async run(args, ctx) {
    let deadline = args.deadline ? parseWhen(args.deadline, ctx.user.tz, ctx.now) : null;
    let hackId: number | null = null;
    const known = await ctx.db.one<{ id: number; deadline: string | null; url: string }>(`SELECT id, deadline, url FROM hackathons WHERE title ILIKE $1 OR url=$2 ORDER BY first_seen DESC LIMIT 1`, [`%${args.title}%`, args.url ?? ""]);
    if (known) { hackId = known.id; deadline ??= known.deadline ? new Date(known.deadline) : null; }
    const r = await ctx.db.one<{ id: number }>(
      `INSERT INTO hackathon_entries (user_id, hackathon_id, title, url, deadline, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [ctx.user.id, hackId, args.title, args.url ?? known?.url ?? null, deadline, args.notes ?? null],
    );
    const jobs: number[] = [];
    if (deadline) {
      for (const h of [72, 24, 6]) {
        const at = new Date(deadline.getTime() - h * 3_600_000);
        if (at > ctx.now) jobs.push(await schedule(ctx.db, { userId: ctx.user.id, kind: "hack_deadline", payload: { entryId: r!.id }, runAt: at }));
      }
    }
    return { reply: `Tracking "${args.title}"${deadline ? `, deadline ${fmt(deadline, ctx.user.tz)}` : " (no deadline yet — tell me when you know it)"}. Entry #${r!.id}.`, undo: { payload: { id: r!.id, jobs } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM hackathon_entries WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    for (const j of p.jobs) await ctx.db.query(`UPDATE jobs SET active=false WHERE id=$1`, [j]);
    return "Entry removed.";
  },
});

const update = defineAction({
  name: "hackathon.update",
  tier: 1,
  description: "Update a ledger entry: status (interested|registered|building|submitted|won|lost|withdrawn), submission_url, prize, results_expected (natural date), payout_received ('today'), notes. Match by id or title.",
  schema: z.object({
    id: z.number().int().optional(),
    match: z.string().optional(),
    status: z.enum(["interested", "registered", "building", "submitted", "won", "lost", "withdrawn"]).optional(),
    submission_url: z.string().optional(),
    prize: z.string().optional(),
    results_expected: z.string().optional(),
    payout_received: z.string().optional(),
    deadline: z.string().optional(),
    notes: z.string().optional(),
  }),
  async run(args, ctx) {
    const e = args.id
      ? await ctx.db.one<any>(`SELECT * FROM hackathon_entries WHERE id=$1 AND user_id=$2`, [args.id, ctx.user.id])
      : await ctx.db.one<any>(`SELECT * FROM hackathon_entries WHERE user_id=$1 AND title ILIKE $2 ORDER BY id DESC LIMIT 1`, [ctx.user.id, `%${args.match ?? ""}%`]);
    if (!e) return { reply: "No matching entry in your ledger." };
    const sets: string[] = [];
    const vals: unknown[] = [e.id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (args.status) set("status", args.status);
    if (args.submission_url) set("submission_url", args.submission_url);
    if (args.prize) set("prize", args.prize);
    if (args.notes) set("notes", args.notes);
    if (args.deadline) set("deadline", parseWhen(args.deadline, ctx.user.tz, ctx.now));
    if (args.results_expected) set("results_expected", parseWhen(args.results_expected, ctx.user.tz, ctx.now));
    if (args.payout_received) set("payout_received", parseWhen(args.payout_received, ctx.user.tz, ctx.now) ?? ctx.now);
    set("updated_at", ctx.now);
    await ctx.db.query(`UPDATE hackathon_entries SET ${sets.join(", ")} WHERE id=$1`, vals);
    let extra = "";
    if (args.status === "won") {
      for (const days of [30, 45]) await schedule(ctx.db, { userId: ctx.user.id, kind: "hack_payout", payload: { entryId: e.id, days }, runAt: new Date(ctx.now.getTime() + days * 86_400_000) });
      extra = " I'll nudge you at 30 and 45 days if no payout is logged.";
    }
    if (args.status === "submitted" && !e.results_expected && !args.results_expected) {
      extra = " When you know the results date, tell me and I'll track it (Colosseum-scale events lag ~7 weeks).";
    }
    return { reply: `Updated "${e.title}": ${sets.filter((s) => !s.startsWith("updated_at")).map((s) => s.split("=")[0]).join(", ")}.${extra}` };
  },
});

const ledger = defineAction({
  name: "hackathon.ledger",
  tier: 1,
  description: "Show the user's hackathon ledger: open entries by deadline, then outcomes and win rate.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<any>(`SELECT * FROM hackathon_entries WHERE user_id=$1 ORDER BY (status IN ('won','lost','withdrawn')), deadline NULLS LAST, id`, [ctx.user.id]);
    if (!rows.length) return { reply: "Ledger is empty. Say 'track <hackathon>' to add one." };
    const open = rows.filter((r: any) => !["won", "lost", "withdrawn"].includes(r.status));
    const closed = rows.filter((r: any) => ["won", "lost", "withdrawn"].includes(r.status));
    const lines = open.map((r: any) => `#${r.id} ${r.status.padEnd(10)} ${r.deadline ? `${fmt(r.deadline, ctx.user.tz)} (${humanDelta(ctx.now, r.deadline)})` : "no deadline"} — ${r.title}`);
    if (closed.length) {
      const won = closed.filter((r: any) => r.status === "won").length;
      const decided = closed.filter((r: any) => r.status !== "withdrawn").length;
      lines.push("", `Outcomes: ${won} won / ${decided} decided (${decided ? Math.round((won / decided) * 100) : 0}%)`);
      for (const r of closed) lines.push(`#${r.id} ${r.status} — ${r.title}${r.prize ? ` (${r.prize}${r.payout_received ? ", paid" : ", unpaid"})` : ""}`);
    }
    return { reply: lines.join("\n") };
  },
});

register(discover, setTags, track, update, ledger);
