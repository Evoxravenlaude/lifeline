/** Match scores from the listings, and why a device couldn't turn notifications on. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createECDH } from "node:crypto";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { ensureUser, handleMessage } from "../src/core/handler.js";
import { pushProblemsLine, recordPushProblem, vapidProblem } from "../src/core/webpush.js";

let db: Db;
const saved = { ...config };
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());
afterEach(() => { Object.assign(config, saved); vi.unstubAllGlobals(); });

describe("what's the score", () => {
  it("answers from the listings: live, full time, or not playing today", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const u = await ensureUser(db, "telegram", "9401", "Sage");
    const now = new Date();
    const t = await db.one<{ id: number }>(`INSERT INTO home_teams (source, ext_id, name, sport, refreshed_at) VALUES ('tsdb','133610','Chelsea','Soccer',now()) RETURNING id`);
    await db.query(`INSERT INTO home_follows (user_id, team_id) VALUES ($1,$2)`, [u.id, t!.id]);
    await db.query(`INSERT INTO home_matches (team_id, source, ext_id, home, away, starts_at, status, home_score, away_score, competition) VALUES ($1,'tsdb','e1','Chelsea','West Ham',$2,'live',1,0,'Premier League')`, [t!.id, new Date(now.getTime() - 40 * 60_000)]);
    const live = await handleMessage(db, u, "What the score count for Chelsea match", { channel: "telegram", now });
    expect(live.text).toBe("Chelsea 1, West Ham 0: on now (Premier League).");
    await db.query(`UPDATE home_matches SET status='finished', home_score=2, away_score=1`);
    expect((await handleMessage(db, u, "what's the score in the Chelsea match?", { channel: "telegram", now })).text).toBe("Full time: Chelsea 2, West Ham 1 (Premier League).");
    await db.query(`UPDATE home_matches SET starts_at = now() - interval '3 days'`);
    expect((await handleMessage(db, u, "Is Chelsea playing today", { channel: "telegram", now })).text).toMatch(/^Chelsea aren't playing today\. Last time: Chelsea 2, West Ham 1/);
  });
});

describe("notifications that won't turn on", () => {
  it("spots a public and private key that aren't a pair", () => {
    const a = createECDH("prime256v1"); a.generateKeys();
    const b = createECDH("prime256v1"); b.generateKeys();
    Object.assign(config, { vapidPublicKey: a.getPublicKey().toString("base64url"), vapidPrivateKey: a.getPrivateKey().toString("base64url"), vapidSubject: "mailto:me@example.com" });
    expect(vapidProblem()).toBeNull();
    Object.assign(config, { vapidPrivateKey: b.getPrivateKey().toString("base64url") });
    expect(vapidProblem()).toMatch(/aren't a pair/);
  });
  it("keeps what browsers said, grouped for /doctor", async () => {
    const u = await ensureUser(db, "telegram", "9402", "Ada");
    expect(await pushProblemsLine(db)).toMatch(/none/);
    await recordPushProblem(db, u.id, { name: "AbortError", message: "Registration failed - push service not available", browser: "Chrome on Android (installed)" });
    await recordPushProblem(db, u.id, { name: "AbortError", message: "Registration failed - push service not available", browser: "Chrome on Android (installed)" });
    expect(await pushProblemsLine(db)).toMatch(/1 person on Chrome on Android \(installed\): AbortError \(Registration failed - push service not available\)/);
  });
});
