/**
 * The six numbers that say whether lifeline is trusted and growing, counted from its own database (no tracking
 * scripts): reminders on time, notifications that land, first wins, notifications on, week-4 retention, and what
 * thinking costs. Shown to the owner with /stats. The audit doc's "How we'll know" section explains the targets.
 */
import type { Db } from "./db.js";
import { addSchema } from "./plugins.js";

addSchema(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS job_runs (id SERIAL PRIMARY KEY, kind TEXT NOT NULL, user_id INT, late_ms INT NOT NULL, ok BOOLEAN NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS job_runs_at ON job_runs (at);
CREATE TABLE IF NOT EXISTS push_log (id SERIAL PRIMARY KEY, user_id INT, ok BOOLEAN NOT NULL, status INT, at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS model_events (id SERIAL PRIMARY KEY, user_id INT, kind TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now())`);

/** Kinds of job a person is waiting on, for "reminders on time". */
export const TIMED = ["reminder", "med_slot", "class_alert", "assignment_alert", "event_alert", "trip_alert", "date_alert", "safety_checkin_due", "crt_drop", "well_care_dose"];

export async function recordRun(db: Db, kind: string, userId: number | null, lateMs: number, ok: boolean): Promise<void> {
  await db.query(`INSERT INTO job_runs (kind, user_id, late_ms, ok) VALUES ($1,$2,$3,$4)`, [kind, userId, Math.max(0, Math.min(lateMs, 2_000_000_000)), ok]).catch(() => {});
}
export async function recordPush(db: Db, userId: number, ok: boolean, status: number | null): Promise<void> {
  await db.query(`INSERT INTO push_log (user_id, ok, status) VALUES ($1,$2,$3)`, [userId, ok, status]).catch(() => {});
}
export async function recordModel(db: Db, userId: number, kind: "fast" | "smart" | "rescued"): Promise<void> {
  await db.query(`INSERT INTO model_events (user_id, kind) VALUES ($1,$2)`, [userId, kind]).catch(() => {});
}

const num = async (db: Db, sql: string, args: unknown[] = []) => Number((await db.one<{ n: string | null }>(sql, args).catch(() => undefined))?.n ?? 0);
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export interface Stats {
  onTime: { pct: number | null; of: number };
  pushes: { pct: number | null; of: number };
  firstWin: { pct: number | null; of: number };
  notificationsOn: { pct: number | null; of: number };
  week4: { pct: number | null; of: number };
  cost: { perActiveDay: number | null; rescuedPct: number | null; answers: number };
}

/** The last seven days (thirty for the slower numbers), as of `now`. */
export async function stats(db: Db, now = new Date()): Promise<Stats> {
  const d7 = new Date(now.getTime() - 7 * 86_400_000), d30 = new Date(now.getTime() - 30 * 86_400_000);
  const timedRuns = await num(db, `SELECT count(*)::text AS n FROM job_runs WHERE at >= $1 AND kind = ANY($2)`, [d7, TIMED]);
  const timedOk = await num(db, `SELECT count(*)::text AS n FROM job_runs WHERE at >= $1 AND kind = ANY($2) AND ok AND late_ms <= 60000`, [d7, TIMED]);
  const pushAll = await num(db, `SELECT count(*)::text AS n FROM push_log WHERE at >= $1`, [d7]);
  const pushOk = await num(db, `SELECT count(*)::text AS n FROM push_log WHERE at >= $1 AND ok`, [d7]);
  // A first win: something real kept (an action that ran) within ten minutes of joining.
  const newcomers = await num(db, `SELECT count(*)::text AS n FROM users WHERE created_at >= $1`, [d30]);
  const won = await num(db, `SELECT count(*)::text AS n FROM users u WHERE u.created_at >= $1 AND EXISTS (SELECT 1 FROM audit_log a WHERE a.user_id=u.id AND a.outcome='ran' AND a.action NOT LIKE 'settings.%' AND a.action NOT LIKE 'persona.%' AND a.created_at <= u.created_at + interval '10 minutes')`, [d30]);
  const webPeople = await num(db, `SELECT count(DISTINCT user_id)::text AS n FROM sessions WHERE created_at >= $1`, [d30]);
  const withPush = await num(db, `SELECT count(DISTINCT p.user_id)::text AS n FROM push_subscriptions p WHERE p.user_id IN (SELECT user_id FROM sessions WHERE created_at >= $1)`, [d30]);
  const cohort = await num(db, `SELECT count(*)::text AS n FROM users WHERE created_at BETWEEN $1 AND $2`, [new Date(now.getTime() - 35 * 86_400_000), new Date(now.getTime() - 28 * 86_400_000)]);
  const kept = await num(db, `SELECT count(*)::text AS n FROM users u WHERE u.created_at BETWEEN $1 AND $2 AND EXISTS (SELECT 1 FROM audit_log a WHERE a.user_id=u.id AND a.outcome='ran' AND a.created_at >= $3)`, [new Date(now.getTime() - 35 * 86_400_000), new Date(now.getTime() - 28 * 86_400_000), d7]);
  const spend = await num(db, `SELECT COALESCE(sum(usd),0)::text AS n FROM model_usage WHERE created_at >= $1`, [d7]);
  const activeDays = await num(db, `SELECT count(*)::text AS n FROM (SELECT DISTINCT user_id, (created_at AT TIME ZONE 'UTC')::date FROM messages WHERE role='user' AND created_at >= $1) x`, [d7]);
  const answers = await num(db, `SELECT count(*)::text AS n FROM model_events WHERE at >= $1 AND kind IN ('fast','smart')`, [d7]);
  const rescued = await num(db, `SELECT count(*)::text AS n FROM model_events WHERE at >= $1 AND kind='rescued'`, [d7]);
  return {
    onTime: { pct: pct(timedOk, timedRuns), of: timedRuns },
    pushes: { pct: pct(pushOk, pushAll), of: pushAll },
    firstWin: { pct: pct(won, newcomers), of: newcomers },
    notificationsOn: { pct: pct(withPush, webPeople), of: webPeople },
    week4: { pct: pct(kept, cohort), of: cohort },
    cost: { perActiveDay: activeDays ? Math.round((spend / activeDays) * 10000) / 10000 : null, rescuedPct: pct(rescued, answers), answers },
  };
}

/** For /stats: each number against its target, in plain lines. */
export function statsText(s: Stats): string {
  const v = (x: { pct: number | null; of: number }, target: number, what: string) =>
    x.pct === null ? `${what}: nothing to count yet` : `${what}: ${x.pct}% of ${x.of} ${x.pct >= target ? "(on target)" : `(target ${target}%)`}`;
  return [
    "**How lifeline is doing** (last 7 days; first wins and notifications over 30)",
    `- ${v(s.onTime, 99, "Reminders and doses on time, within a minute")}`,
    `- ${v(s.pushes, 95, "App notifications that reached a device")}`,
    `- ${v(s.firstWin, 70, "New people who kept something real in their first 10 minutes")}`,
    `- ${v(s.notificationsOn, 70, "Web and app people with notifications on")}`,
    `- ${v(s.week4, 40, "Week-4 people still keeping things")}`,
    `- Thinking cost: ${s.cost.perActiveDay === null ? "nothing yet" : `$${s.cost.perActiveDay} per active person per day (target under $0.05)`}; ${s.cost.rescuedPct === null ? "no model replies counted yet" : `${s.cost.rescuedPct}% of ${s.cost.answers} replies needed the stronger model to step in (target under 10%)`}.`,
  ].join("\n");
}
