/** The scheduler's claim, retries and lateness log, and the six owner numbers behind /stats. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { ensureUser, handleMessage } from "../src/core/handler.js";
import { onJob, runDue, schedule, type SchedulerDeps } from "../src/core/scheduler.js";
import { recordModel, recordPush, stats, statsText } from "../src/core/health.js";
import { parseByRules } from "../src/intent/rules.js";

let db: Db;
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());

const depsFor = (): SchedulerDeps => ({ db, send: async () => true, getUser: async () => undefined });

describe("scheduler", () => {
  it("never hands the same due job to two overlapping runs", async () => {
    let runs = 0;
    onJob("t_once", async () => { runs++; await new Promise((r) => setTimeout(r, 20)); });
    const now = new Date("2026-11-01T09:00:00Z");
    await schedule(db, { kind: "t_once", runAt: new Date(now.getTime() - 1000) });
    const [a, b] = await Promise.all([runDue(depsFor(), now), runDue(depsFor(), now)]);
    expect(a + b).toBe(1);
    expect(runs).toBe(1);
  });

  it("tries a failed one-off again after a minute, then five, then lets it go", async () => {
    let tries = 0;
    onJob("t_flaky", async () => { tries++; throw new Error("network"); });
    const id = await schedule(db, { kind: "t_flaky", runAt: new Date("2026-11-01T10:00:00Z") });
    const at = (m: number) => new Date(Date.parse("2026-11-01T10:00:00Z") + m * 60_000);
    await runDue(depsFor(), at(0));
    let j = await db.one<{ active: boolean; attempts: number; run_at: string }>(`SELECT active, attempts, run_at FROM jobs WHERE id=$1`, [id]);
    expect(j).toMatchObject({ active: true, attempts: 1 });
    expect(new Date(j!.run_at).getTime()).toBe(at(1).getTime());
    await runDue(depsFor(), at(1));
    j = await db.one(`SELECT active, attempts, run_at FROM jobs WHERE id=$1`, [id]);
    expect(new Date(j!.run_at).getTime()).toBe(at(6).getTime());
    await runDue(depsFor(), at(6));
    j = await db.one(`SELECT active, attempts, run_at FROM jobs WHERE id=$1`, [id]);
    expect(j!.active).toBe(false);
    expect(tries).toBe(3);
  });

  it("keeps a job that succeeds after a failure, and logs how late each reminder was", async () => {
    let n = 0;
    onJob("reminder", async () => { if (n++ === 0) throw new Error("once"); });
    const due = new Date("2026-11-01T11:00:00Z");
    await schedule(db, { kind: "reminder", runAt: due });
    await runDue(depsFor(), new Date(due.getTime() + 20_000));
    await runDue(depsFor(), new Date(due.getTime() + 80_000));
    const rows = await db.query<{ ok: boolean; late_ms: number }>(`SELECT ok, late_ms FROM job_runs WHERE kind='reminder' ORDER BY id`);
    expect(rows.map((r) => r.ok)).toEqual([false, true]);
    expect(rows[0].late_ms).toBeGreaterThanOrEqual(20_000);
    expect(rows[0].late_ms).toBeLessThan(25_000);
  });
});

describe("/stats", () => {
  it("counts on-time share, delivered notifications and rescues, and says when there's nothing yet", async () => {
    const fresh = await openTestDb();
    try {
      const empty = statsText(await stats(fresh));
      expect(empty).toContain("nothing to count yet");
      const u = await ensureUser(fresh, "telegram", "9901", "Owner");
      const now = new Date();
      for (const late of [1000, 2000, 90_000]) await fresh.query(`INSERT INTO job_runs (kind, user_id, late_ms, ok) VALUES ('reminder',$1,$2,true)`, [u.id, late]);
      await recordPush(fresh, u.id, true, 201);
      await recordPush(fresh, u.id, false, 410);
      for (let i = 0; i < 9; i++) await recordModel(fresh, u.id, "fast");
      await recordModel(fresh, u.id, "smart");
      await recordModel(fresh, u.id, "rescued");
      const s = await stats(fresh, now);
      expect(s.onTime).toEqual({ pct: 66.7, of: 3 });
      expect(s.pushes).toEqual({ pct: 50, of: 2 });
      expect(s.cost.rescuedPct).toBe(10);
      expect(statsText(s)).toMatch(/66\.7% of 3 \(target 99%\)/);
    } finally { await fresh.close(); }
  });
});

describe("what did you do for me this week", () => {
  it("is a plain rule, and an empty week gets a first thing to try", async () => {
    expect(parseByRules("what did you do for me this week?")?.action).toBe("recap.week");
    expect(parseByRules("weekly recap")?.action).toBe("recap.week");
    const u = await ensureUser(db, "telegram", "9902", "Ada");
    const r = await handleMessage(db, u, "what did you do for me this week?", { channel: "telegram" });
    expect(r.text).toMatch(/quiet week/i);
  });
});
