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

/** Ranked open hackathons. The brief passes unseenOnly so it only mentions new ones; the web page shows everything open. */
export async function rankedForUser(db: any, user: any, now: Date, limit = 8, opts: { unseenOnly?: boolean } = { unseenOnly: true }): Promise<(Hack & { score: number })[]> {
  const prefs = { tags: (user.prefs?.tags as string[]) ?? [], remoteOnly: user.prefs?.remoteOnly !== false };
  const rows = await db.query(
    `SELECT h.* FROM hackathons h
     WHERE (h.deadline IS NULL OR h.deadline > $2)
       ${opts.unseenOnly ? "AND NOT EXISTS (SELECT 1 FROM hackathon_seen s WHERE s.user_id=$1 AND s.hackathon_id=h.id)" : "AND $1::int IS NOT NULL"}
     ORDER BY h.first_seen DESC LIMIT 300`,
    [user.id, now],
  );
  return rows
    .map((h: Hack) => ({ ...h, score: scoreHack(h, prefs, now) }))
    .filter((h: any) => h.score > 0)
    .sort((a: any, b: any) => b.score - a.score)
    .slice(0, limit);
}

/** Why this one fits, in a phrase: prize, crowd, how long is left, where. */
function whyFits(h: Hack, now: Date): string {
  const bits: string[] = [];
  if (h.prize_usd) bits.push(`$${Number(h.prize_usd).toLocaleString()} in prizes`);
  if (h.registrations) bits.push(`${h.registrations} signed up`);
  if (h.deadline) {
    const days = Math.floor((new Date(h.deadline).getTime() - now.getTime()) / 86_400_000);
    bits.push(days <= 0 ? "closes today" : days === 1 ? "closes tomorrow" : days <= 21 ? `${days} days to build` : `plenty of time, ${days} days`);
  }
  bits.push(h.online === false ? "in person" : "remote");
  return bits.join(", ");
}

export function hackLine(h: Hack & { score?: number }, tz: string, now: Date): string {
  const when = h.deadline ? `, closes ${fmt(h.deadline, tz)}` : "";
  return `${h.title}${when}. ${whyFits(h, now)}.\n${h.url}`;
}

const discover = defineAction({
  name: "hackathon.discover",
  tier: 1,
  description: "Show the top-ranked open hackathons for this user (prize/registrations, quality, tags, remote). Optional tag filter like 'ai', 'payments' or 'base'.",
  schema: z.object({ tag: z.string().optional(), limit: z.number().int().min(1).max(15).optional() }),
  async run(args, ctx) {
    const u = args.tag ? { ...ctx.user, prefs: { ...ctx.user.prefs, tags: [args.tag] } } : ctx.user;
    const list = await rankedForUser(ctx.db, u, ctx.now, args.limit ?? 8);
    if (!list.length) return { reply: args.tag ? `Nothing open for ${args.tag} right now. I check the sources every six hours; ask again later or drop the filter.` : "Nothing new that fits right now. I check the sources every six hours, and anything that fits lands in your morning brief." };
    for (const h of list) await ctx.db.query(`INSERT INTO hackathon_seen (user_id, hackathon_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [ctx.user.id, h.id]);
    const head = list.length === 1 ? "One worth a look." : `${list.length} worth a look, best fit first.`;
    return { reply: [head, "", ...list.map((h) => hackLine(h, ctx.user.tz, ctx.now))].join("\n") };
  },
});

const setTags = defineAction({
  name: "hackathon.set_interests",
  tier: 1,
  description: "Set the tags used to rank hackathons for this user (e.g. ['ai','payments','base','ethereum'], any chains or themes) and whether remote-only.",
  schema: z.object({ tags: z.array(z.string()).max(12), remote_only: z.boolean().optional() }),
  async run(args, ctx) {
    const prefs = { ...ctx.user.prefs, tags: args.tags, remoteOnly: args.remote_only ?? true };
    await ctx.db.query(`UPDATE users SET prefs=$2 WHERE id=$1`, [ctx.user.id, JSON.stringify(prefs)]);
    return { reply: args.tags.length ? `I'll rank hackathons and launches on ${args.tags.join(", ")}, ${prefs.remoteOnly ? "remote only" : "anywhere"}. The next brief uses it.` : `No interests set, so I'll rank on prize and quality alone, ${prefs.remoteOnly ? "remote only" : "anywhere"}.` };
  },
});

onJob("hack_deadline", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const e = await deps.db.one<{ title: string; deadline: string; status: string; url: string | null }>(`SELECT title, deadline, status, url FROM hackathon_entries WHERE id=$1`, [job.payload.entryId]);
  if (!e || ["submitted", "won", "lost", "withdrawn"].includes(e.status)) return;
  const left = humanDelta(new Date(), e.deadline);
  await push(deps, user, "reminder", `${e.title} closes ${fmt(e.deadline, user.tz)}, ${left} from now. You're marked as ${e.status}; say "submitted ${e.title}" once it's in.${e.url ? `\n${e.url}` : ""}`, { exempt: true });
});

onJob("hack_payout", async (job, deps) => {
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const e = await deps.db.one<{ title: string; payout_received: string | null; prize: string | null }>(`SELECT title, payout_received, prize FROM hackathon_entries WHERE id=$1`, [job.payload.entryId]);
  if (!e || e.payout_received) return;
  await push(deps, user, "reminder", `${job.payload.days} days since ${e.title} results and no payout logged${e.prize ? ` for the ${e.prize}` : ""}. Worth a message to the organiser. Say "paid for ${e.title}" when it lands.`, { exempt: true });
});

const track = defineAction({
  name: "hackathon.track",
  tier: 1,
  description: "Add a hackathon to the user's ledger by title (and url/deadline if known). Schedules alerts 3 days, 1 day and 6 hours before the deadline.",
  schema: z.object({ title: z.string().min(1).optional(), url: z.string().url().optional(), deadline: z.string().optional(), notes: z.string().optional() }),
  needs(args) {
    if (!args.title) return { need: "title", question: "Which hackathon? Give me the name and I'll track it." };
    return null;
  },
  async run(a, ctx) {
    const args = { ...a, title: a.title! };
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
    const when = deadline ? ` It closes ${fmt(deadline, ctx.user.tz)}; I'll nudge you three days, a day and six hours before.` : " No deadline yet; tell me when you know it and I'll set the nudges.";
    return { reply: `${args.title} is on your ledger.${when} Say "submitted ${args.title}" when it's in.`, undo: { payload: { id: r!.id, jobs } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM hackathon_entries WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    for (const j of p.jobs) await ctx.db.query(`UPDATE jobs SET active=false WHERE id=$1`, [j]);
    return "Taken off the ledger.";
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
    if (!e) return { reply: `Nothing on your ledger matches${args.match ? ` "${args.match}"` : " that"}. Say "ledger" to see what's there.` };
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
      extra = " If no payout is logged in 30 days I'll remind you to chase it, and again at 45.";
    }
    if (args.status === "submitted" && !e.results_expected && !args.results_expected) {
      extra = " When you know the results date, tell me and I'll watch for it. The big ones can take seven weeks.";
    }
    const changed = sets.filter((s) => !s.startsWith("updated_at")).map((s) => s.split("=")[0]);
    const said: Record<string, string> = { status: args.status === "won" ? "marked won, well done" : args.status === "submitted" ? "marked submitted" : `now ${args.status}`, submission_url: "submission link saved", prize: `prize ${args.prize}`, notes: "notes saved", deadline: args.deadline ? `deadline ${fmt(parseWhen(args.deadline, ctx.user.tz, ctx.now) ?? ctx.now, ctx.user.tz)}` : "", results_expected: "results date saved", payout_received: "payout logged" };
    const summary = changed.map((c) => said[c]).filter(Boolean).join(", ") || "nothing changed";
    return { reply: `${e.title}: ${summary}.${extra}` };
  },
});

const ledger = defineAction({
  name: "hackathon.ledger",
  tier: 1,
  description: "Show the user's hackathon ledger: open entries by deadline, then outcomes and win rate.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<any>(`SELECT * FROM hackathon_entries WHERE user_id=$1 ORDER BY (status IN ('won','lost','withdrawn')), deadline NULLS LAST, id`, [ctx.user.id]);
    if (!rows.length) return { reply: "Nothing on the ledger yet. Say \"I'm entering <hackathon>\" and I'll keep it." };
    const open = rows.filter((r: any) => !["won", "lost", "withdrawn"].includes(r.status));
    const closed = rows.filter((r: any) => ["won", "lost", "withdrawn"].includes(r.status));
    const lines: string[] = [];
    if (open.length) {
      lines.push(open.length === 1 ? "One in play." : `${open.length} in play.`);
      for (const r of open) lines.push(`${r.title}, ${r.status}${r.deadline ? `, closes ${fmt(r.deadline, ctx.user.tz)} (${humanDelta(ctx.now, r.deadline)} left)` : ", no deadline yet"}`);
    }
    if (closed.length) {
      const won = closed.filter((r: any) => r.status === "won").length;
      const decided = closed.filter((r: any) => r.status !== "withdrawn").length;
      if (lines.length) lines.push("");
      lines.push(`Decided so far: ${won} won out of ${decided}${decided ? `, ${Math.round((won / decided) * 100)}%` : ""}.`);
      for (const r of closed) lines.push(`${r.title}, ${r.status}${r.prize ? `, ${r.prize}${r.payout_received ? ", paid" : ", not paid yet"}` : ""}`);
    }
    return { reply: lines.join("\n") };
  },
});

register(discover, setTags, track, update, ledger);
