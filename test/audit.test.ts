/** Fixes from the v19 audit: clock changes, brief timing, reminders that can't be lost or doubled, secrets, and limits. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { ensureUser, handleMessage } from "../src/core/handler.js";
import { parseWhen, parseClock } from "../src/core/time.js";
import { onJob, rezone, runDue, schedule, type SchedulerDeps } from "../src/core/scheduler.js";
import { confirmPending, propose } from "../src/policy/engine.js";
import { redact } from "../src/core/redact.js";
import { resolveLog } from "../src/modules/medications.js";
import { handleTextChannel, _linkMisses } from "../src/channels/sms.js";
import { complete, _resting } from "../src/intent/providers.js";
import { config } from "../src/core/config.js";
import type { User } from "../src/policy/types.js";

let db: Db;
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());

describe("clock changes", () => {
  it("keeps a time said in words on the wall clock across the end of US summer time", () => {
    const now = new Date("2026-10-31T16:00:00Z"); // Saturday; New York falls back on Sunday 1 November
    expect(parseWhen("tuesday at 9am", "America/New_York", now)!.toISOString()).toBe("2026-11-03T14:00:00.000Z");
    expect(parseWhen("tomorrow at 9", "America/New_York", now)!.toISOString()).toBe("2026-11-01T14:00:00.000Z");
    expect(parseWhen("in 20 minutes", "America/New_York", now)!.toISOString()).toBe("2026-10-31T16:20:00.000Z");
  });
  it("reads noon and midnight as clock times", () => {
    expect(parseClock("noon")).toEqual([12, 0]);
    expect(parseClock("midnight")).toEqual([0, 0]);
  });
});

describe("brief timing", () => {
  it("moves the next brief at once when the zone or the hour changes", async () => {
    const u = await ensureUser(db, "telegram", "8801", "Kemi");
    const now = new Date("2026-11-01T00:00:00Z");
    await rezone(db, u.id, "Australia/Sydney", { digestHour: 6, now });
    const j = await db.one<{ run_at: string; tz: string; cron: string }>(`SELECT run_at, tz, cron FROM jobs WHERE user_id=$1 AND kind='digest'`, [u.id]);
    expect(j).toMatchObject({ tz: "Australia/Sydney", cron: "0 6 * * *" });
    // 06:00 in Sydney (UTC+11 in November) is 19:00 UTC the day before.
    expect(new Date(j!.run_at).toISOString()).toBe("2026-11-01T19:00:00.000Z");
    const review = await db.one<{ tz: string }>(`SELECT tz FROM jobs WHERE user_id=$1 AND kind='memory_review'`, [u.id]);
    expect(review?.tz).toBe("Australia/Sydney");
  });
  it("skips a brief that would arrive more than three hours late, and sends one that's on time", async () => {
    const u = await ensureUser(db, "telegram", "8802", "Tobi");
    const sent: string[] = [];
    const deps: SchedulerDeps = { db, send: async (_u, r) => { sent.push(r.text); return true; }, getUser: async (id) => db.one<User>(`SELECT * FROM users WHERE id=$1`, [id]) };
    const due = new Date("2026-11-02T07:00:00Z");
    await db.query(`UPDATE jobs SET run_at=$2 WHERE user_id=$1 AND kind='digest'`, [u.id, due]);
    await runDue(deps, new Date(due.getTime() + 4 * 3_600_000));
    expect(sent).toHaveLength(0);
    const next = await db.one<{ run_at: string }>(`SELECT run_at FROM jobs WHERE user_id=$1 AND kind='digest'`, [u.id]);
    await runDue(deps, new Date(next!.run_at));
    expect(sent).toHaveLength(1);
  });
});

describe("reminders", () => {
  it("tries a one-off again when nothing reached the person, and a repeating one moves its date on", async () => {
    const u = await ensureUser(db, "telegram", "8803", "Ada");
    let up = false;
    const sent: string[] = [];
    const deps: SchedulerDeps = { db, send: async (_u, r) => { if (!up) return false; sent.push(r.text); return true; }, getUser: async (id) => db.one<User>(`SELECT * FROM users WHERE id=$1`, [id]) };
    const now = new Date("2026-11-03T10:00:00Z");
    const ctx = { db, user: u, now, sourceMessage: "test" };
    await propose(ctx, "reminder.create", { text: "call the bank", when: "in 5 minutes" });
    const at = new Date(now.getTime() + 5 * 60_000);
    await runDue(deps, at);
    expect(sent).toHaveLength(0);
    up = true;
    await runDue(deps, new Date(at.getTime() + 61_000));
    expect(sent).toEqual(["Reminder: Call the bank."]);

    await propose(ctx, "reminder.create", { text: "water the plants", when: "tomorrow 8am", repeat: "0 8 * * *" });
    const rep = await db.one<{ id: number; due_at: string }>(`SELECT id, due_at FROM reminders WHERE user_id=$1 AND cron IS NOT NULL`, [u.id]);
    const job = await db.one<{ run_at: string }>(`SELECT run_at FROM jobs WHERE kind='reminder' AND payload->>'reminderId' = $1`, [String(rep!.id)]);
    await runDue(deps, new Date(job!.run_at));
    const after = await db.one<{ due_at: string }>(`SELECT due_at FROM reminders WHERE id=$1`, [rep!.id]);
    expect(new Date(after!.due_at).getTime()).toBeGreaterThan(new Date(job!.run_at).getTime());
    const { handleCallback } = await import("../src/core/handler.js");
    const done = await handleCallback(db, u, `rem:done:${rep!.id}`, new Date(job!.run_at));
    expect(done.text).toMatch(/^Done for this time\. It rings again/);
  });
});

describe("one tap, one action", () => {
  it("runs a confirmed action once even when the yes arrives twice at the same moment", async () => {
    const u = await ensureUser(db, "telegram", "8804", "Femi");
    const ctx = { db, user: u, now: new Date(), sourceMessage: "test" };
    const d = await propose(ctx, "account.delete", {});
    expect(d.kind).toBe("pending");
    const id = (d as any).pendingId;
    const [a, b] = await Promise.all([confirmPending(ctx, id), confirmPending(ctx, id)]);
    expect([a.kind, b.kind].filter((k) => k === "ran")).toHaveLength(1);
    expect(await db.query(`SELECT 1 FROM jobs WHERE kind='account_erase' AND payload->>'userId' = $1`, [String(u.id)])).toHaveLength(1);
  });
  it("counts a dose once when Taken is tapped on two devices", async () => {
    const u = await ensureUser(db, "telegram", "8805", "Ngozi");
    const m = await db.one<{ id: number }>(`INSERT INTO medications (user_id, name, times, days_left) VALUES ($1,'Iron',ARRAY['08:00'],10) RETURNING id`, [u.id]);
    const l = await db.one<{ id: number }>(`INSERT INTO medication_logs (medication_id, scheduled_for) VALUES ($1, now()) RETURNING id`, [m!.id]);
    expect(await resolveLog(db, u.id, l!.id, "taken")).toBe(true);
    expect(await resolveLog(db, u.id, l!.id, "taken")).toBe(true);
    expect((await db.one<{ days_left: number }>(`SELECT days_left FROM medications WHERE id=$1`, [m!.id]))!.days_left).toBe(9);
  });
});

describe("secrets", () => {
  const w = "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");
  it("hides a seed phrase written numbered, capitalised or one word per line", () => {
    expect(redact(w.map((x, i) => `${i + 1}. ${x}`).join(" "))).toBe("[hidden seed phrase]");
    expect(redact(w.map((x) => x[0].toUpperCase() + x.slice(1)).join(" "))).toBe("[hidden seed phrase]");
    expect(redact(`my words:\n${w.join("\n")}`)).toBe("my words:\n[hidden seed phrase]");
  });
  it("leaves an ordinary long sentence alone", () => {
    const s = "Remind me tomorrow at nine to call the bank about the card and the loan please";
    expect(redact(s)).toBe(s);
  });
});

describe("link codes by text", () => {
  it("stops a sender after five wrong codes in an hour", async () => {
    _linkMisses.clear();
    for (let i = 0; i < 5; i++) expect(await handleTextChannel(db, "email", "guess@example.com", `link ${String(i).padStart(6, "a")}`)).toMatch(/didn't work/);
    expect(await handleTextChannel(db, "email", "guess@example.com", "link abcdef")).toMatch(/Too many codes/);
    expect(await handleTextChannel(db, "email", "other@example.com", "link abcdef")).toMatch(/didn't work/);
  });
});

describe("a provider that's down", () => {
  it("is tried once, not again without tools, and sits out the next message", async () => {
    const saved = { ...config };
    _resting.clear();
    Object.assign(config, { openaiCompatKey: "k", openaiCompatBaseUrl: "https://example.test/v1", geminiKey: "", anthropicKey: "" });
    let calls = 0;
    vi.stubGlobal("fetch", async () => { calls++; return new Response("upstream broke", { status: 503 }); });
    try {
      await expect(complete({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [{ name: "a", description: "a", parameters: { type: "object", properties: {} } } as any] })).rejects.toBeTruthy();
      const first = calls;
      expect(first).toBe(1);
      expect(_resting.size).toBe(1);
    } finally { Object.assign(config, saved); vi.unstubAllGlobals(); _resting.clear(); }
  });
});

describe("leaving", () => {
  it("keeps live codes and notification keys out of the export, and stops keeping things once deletion starts", async () => {
    const { exportUser } = await import("../src/modules/account.js");
    const u = await ensureUser(db, "telegram", "8806", "Bola");
    await db.query(`INSERT INTO link_codes (code, user_id, expires_at) VALUES ('zz9911', $1, now() + interval '10 minutes')`, [u.id]);
    await db.query(`UPDATE users SET prefs = prefs || '{"emailPending":{"code":"123456"}}'::jsonb WHERE id=$1`, [u.id]);
    const out = await exportUser(db, u.id);
    expect(out.link_codes).toBeUndefined();
    expect(JSON.stringify(out.you)).not.toContain("123456");
    await db.query(`UPDATE users SET prefs = prefs || '{"deleting":true}'::jsonb WHERE id=$1`, [u.id]);
    const r = await handleMessage(db, { ...u, prefs: { ...u.prefs, deleting: true } }, "remind me to stretch at 5pm", { channel: "telegram" });
    expect(r.text).toMatch(/being deleted/);
  });
});

void onJob; void schedule;
