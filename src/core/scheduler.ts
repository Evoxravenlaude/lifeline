/**
 * Durable job queue on the jobs table. Telegram has no server-side scheduling
 * for bots, so this is the one scheduler for reminders, medication slots,
 * class alerts, digests, pollers and trading watchers.
 *
 * Jobs are either one-shot (run_at) or cron (recomputed after each run, in the
 * job's tz). Handlers are registered by kind. Every proactive message goes
 * through `push()` which enforces quiet hours and the per-day cap; reminders
 * and medication slots are exempt from the cap because the user asked for them.
 */
import { Cron } from "croner";
import type { Db } from "./db.js";
import { log } from "./log.js";
import { config } from "./config.js";
import { inQuietHours, localDay } from "./time.js";
import type { User } from "../policy/types.js";
import { TIMED, recordRun } from "./health.js";

export type JobHandler = (job: Job, deps: SchedulerDeps) => Promise<void>;

export interface Job {
  id: number;
  user_id: number | null;
  kind: string;
  payload: any;
  run_at: string;
  cron: string | null;
  tz: string | null;
  /** How late this run is, on the scheduler's clock (set when the job is claimed). */
  lateMs?: number;
}

export interface SchedulerDeps {
  db: Db;
  /** Deliver to the user's preferred channel with fallback (see core/dispatch). Returns false if no channel reached them. */
  send: (user: User, reply: { text: string; buttons?: { label: string; data: string }[]; kind?: string }) => Promise<boolean>;
  getUser: (id: number) => Promise<User | undefined>;
}

const handlers = new Map<string, JobHandler>();
export function onJob(kind: string, h: JobHandler) {
  handlers.set(kind, h);
}

export async function schedule(
  db: Db,
  j: { userId?: number | null; kind: string; payload?: unknown; runAt?: Date; cron?: string; tz?: string },
): Promise<number> {
  const runAt = j.runAt ?? (j.cron ? nextCron(j.cron, j.tz ?? config.defaultTz) : new Date());
  const row = await db.one<{ id: number }>(
    `INSERT INTO jobs (user_id, kind, payload, run_at, cron, tz) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [j.userId ?? null, j.kind, JSON.stringify(j.payload ?? {}), runAt, j.cron ?? null, j.tz ?? null],
  );
  return row!.id;
}

export async function cancelJob(db: Db, id: number) {
  await db.query(`UPDATE jobs SET active=false WHERE id=$1`, [id]);
}

/**
 * The person moved or changed their brief hour: every repeating job of theirs takes the new zone, and its next run is
 * worked out again now. Updating only the cron left the old run_at in place, so the next brief came at the old time.
 */
export async function rezone(db: Db, userId: number, tz: string, opts: { digestHour?: number; now?: Date } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const jobs = await db.query<{ id: number; kind: string; cron: string }>(`SELECT id, kind, cron FROM jobs WHERE user_id=$1 AND active AND cron IS NOT NULL`, [userId]);
  for (const j of jobs) {
    const cron = j.kind === "digest" && opts.digestHour !== undefined ? `0 ${opts.digestHour} * * *` : j.cron;
    try {
      await db.query(`UPDATE jobs SET cron=$2, tz=$3, run_at=$4 WHERE id=$1`, [j.id, cron, tz, nextCron(cron, tz, now)]);
    } catch (e) {
      log.warn({ err: e, job: j.id }, "rezone skipped a job");
    }
  }
}

export function nextCron(expr: string, tz: string, from = new Date()): Date {
  const c = new Cron(expr, { timezone: tz });
  const n = c.nextRun(from);
  if (!n) throw new Error(`cron ${expr} has no next run`);
  return n;
}

/** How long a claimed job is held before another instance may take it (a crash mid-run frees it after this). */
const LEASE = "3 minutes";
/** One-off jobs that throw are tried again: after one minute, then five, then given up. */
const RETRY_MS = [60_000, 300_000];

/**
 * Claims and runs what's due. The claim moves run_at forward by a lease inside one statement, with SKIP LOCKED, so
 * two instances overlapping during a redeploy can never both take the same reminder. Each timed run is logged with
 * how late it was, for /stats.
 */
export async function runDue(deps: SchedulerDeps, now = new Date()): Promise<number> {
  const tickStart = Date.now();
  // One at a time, each claim with its own fresh lease: a slow batch (everyone's 07:00 brief) can't let the jobs
  // still waiting at the back be claimed again by another instance and sent twice.
  const claim = async () => (await deps.db.query<Job & { was: string; attempts: number }>(
    `WITH due AS (
       SELECT id, run_at FROM jobs WHERE active AND run_at <= $1 ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED
     )
     UPDATE jobs j SET run_at = GREATEST($1::timestamptz, now()) + interval '${LEASE}' FROM due WHERE j.id = due.id
     RETURNING j.id, j.user_id, j.kind, j.payload, due.run_at AS was, j.cron, j.tz, j.attempts`,
    [now],
  ))[0];
  let count = 0;
  for (let job: (Job & { was: string; attempts: number }) | undefined = await claim(); job; job = count < 50 ? await claim() : undefined) {
    count++;
    job.payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
    job.run_at = job.was;
    const h = handlers.get(job.kind);
    let ok = true;
    const started = Date.now();
    job.lateMs = Math.max(0, now.getTime() + (started - tickStart) - new Date(job.was).getTime());
    try {
      if (h) await h(job, deps);
      else log.warn({ kind: job.kind }, "no handler for job");
    } catch (e) {
      ok = false;
      log.error({ err: e, job: job.id, kind: job.kind, attempt: job.attempts + 1 }, "job failed");
    }
    if (TIMED.includes(job.kind)) {
      // Lateness: from when it was due to when its handler began (the tick's clock plus time spent on earlier jobs).
      await recordRun(deps.db, job.kind, job.user_id, job.lateMs, ok);
    }
    // The tick's clock, moved on by however long this tick has run so far.
    const at = new Date(now.getTime() + (Date.now() - tickStart));
    if (job.cron) {
      await deps.db.query(`UPDATE jobs SET last_run=$2, run_at=$3, attempts=0 WHERE id=$1`, [
        job.id,
        now,
        nextCron(job.cron, job.tz ?? config.defaultTz, at),
      ]);
    } else if (!ok && job.attempts < RETRY_MS.length) {
      await deps.db.query(`UPDATE jobs SET attempts=attempts+1, run_at=$2 WHERE id=$1`, [
        job.id,
        new Date(now.getTime() + RETRY_MS[job.attempts]),
      ]);
    } else {
      await deps.db.query(`UPDATE jobs SET last_run=$2, active=false WHERE id=$1`, [job.id, now]);
    }
  }
  return count;
}

export function startLoop(deps: SchedulerDeps, intervalMs = 30_000) {
  // A tick that runs long (a busy 07:00) isn't joined by the next one from the same instance.
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await runDue(deps); } catch (e) { log.error({ err: e }, "scheduler tick failed"); } finally { busy = false; }
  };
  tick();
  return setInterval(tick, intervalMs);
}

/**
 * Proactive send with quiet-hours and daily-cap enforcement.
 * `exempt` bypasses the cap (user-requested reminders, medication slots).
 * Returns false if suppressed; the caller can reschedule to the next allowed time.
 */
export async function push(
  deps: SchedulerDeps,
  user: User,
  kind: string,
  text: string,
  opts: { exempt?: boolean; buttons?: { label: string; data: string }[]; now?: Date } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  if (!opts.exempt) {
    if (inQuietHours(now, user.tz, user.quiet_start, user.quiet_end)) return false;
    // A quiet day the person asked for: only what they set themselves (reminders, doses, check-ins) gets through.
    const quietUntil = Number(user.prefs?.quietUntil ?? 0);
    if (quietUntil > now.getTime()) return false;
    // Calm mode: nudges wait for the morning brief instead of arriving as pings.
    if (user.prefs?.calm === true && kind !== "digest") return false;
    const day = localDay(now, user.tz);
    const c = await deps.db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM pushes WHERE user_id=$1 AND kind NOT IN ('reminder','medication') AND (sent_at AT TIME ZONE $2)::date = $3::date`,
      [user.id, user.tz, day],
    );
    if (Number(c?.n ?? 0) >= config.maxPushesPerDay) return false;
  }
  // The kind travels with it so a lock-screen notification can keep health, mood and safety details private.
  const ok = await deps.send(user, { text, buttons: opts.buttons, kind });
  if (ok) await deps.db.query(`INSERT INTO pushes (user_id, kind, sent_at) VALUES ($1,$2,$3)`, [user.id, kind, now]);
  return ok;
}
