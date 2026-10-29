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

export type JobHandler = (job: Job, deps: SchedulerDeps) => Promise<void>;

export interface Job {
  id: number;
  user_id: number | null;
  kind: string;
  payload: any;
  run_at: string;
  cron: string | null;
  tz: string | null;
}

export interface SchedulerDeps {
  db: Db;
  /** Deliver to the user's preferred channel with fallback (see core/dispatch). Returns false if no channel reached them. */
  send: (user: User, reply: { text: string; buttons?: { label: string; data: string }[] }) => Promise<boolean>;
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

export function nextCron(expr: string, tz: string, from = new Date()): Date {
  const c = new Cron(expr, { timezone: tz });
  const n = c.nextRun(from);
  if (!n) throw new Error(`cron ${expr} has no next run`);
  return n;
}

export async function runDue(deps: SchedulerDeps, now = new Date()): Promise<number> {
  const due = await deps.db.query<Job>(
    `SELECT id, user_id, kind, payload, run_at, cron, tz FROM jobs WHERE active AND run_at <= $1 ORDER BY run_at LIMIT 50`,
    [now],
  );
  for (const job of due) {
    job.payload = typeof job.payload === "string" ? JSON.parse(job.payload) : job.payload;
    const h = handlers.get(job.kind);
    try {
      if (h) await h(job, deps);
      else log.warn({ kind: job.kind }, "no handler for job");
    } catch (e) {
      log.error({ err: e, job: job.id }, "job failed");
    }
    if (job.cron) {
      await deps.db.query(`UPDATE jobs SET last_run=$2, run_at=$3 WHERE id=$1`, [
        job.id,
        now,
        nextCron(job.cron, job.tz ?? config.defaultTz, now),
      ]);
    } else {
      await deps.db.query(`UPDATE jobs SET last_run=$2, active=false WHERE id=$1`, [job.id, now]);
    }
  }
  return due.length;
}

export function startLoop(deps: SchedulerDeps, intervalMs = 30_000) {
  const tick = () => runDue(deps).catch((e) => log.error({ err: e }, "scheduler tick failed"));
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
  const ok = await deps.send(user, { text, buttons: opts.buttons });
  if (ok) await deps.db.query(`INSERT INTO pushes (user_id, kind, sent_at) VALUES ($1,$2,$3)`, [user.id, kind, now]);
  return ok;
}
