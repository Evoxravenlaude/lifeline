/** Period and cycle tracking, and measures (weight, sleep, water, mood, lifts, routines). */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { ensureUser, handleMessage, getUserById, createLinkCode } from "../src/core/handler.js";
import { cyclePicture, cycleKind, pastDay } from "../src/modules/cycle.js";
import { normaliseMeasure } from "../src/modules/measures.js";
import { createWeb } from "../src/web/server.js";
import { buildDigest } from "../src/modules/digest.js";

let db: Db;
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());

const NOW = new Date("2026-10-27T10:00:00Z"); // Tuesday, Lagos 11:00
const fresh = async (id: string) => (await getUserById(db, (await ensureUser(db, "telegram", id, "Ada")).id))!;
const say = async (uid: number, t: string) => handleMessage(db, (await getUserById(db, uid))!, t, { channel: "telegram", now: NOW });

describe("cycle prediction", () => {
  it("defaults to 28 days from one start", () => {
    const p = cyclePicture([{ started_on: "2026-10-20", ended_on: null }], {}, "2026-10-27");
    expect(p).toMatchObject({ tracking: true, day: 8, length: 28, nextStart: "2026-11-17", ovulation: "2026-11-03", fertileStart: "2026-10-29", fertileEnd: "2026-11-04", lateBy: 0, irregular: false, inPeriod: false });
  });
  it("learns a 30-day rhythm and period length from history", () => {
    const rows = ["2026-07-01", "2026-07-31", "2026-08-30", "2026-09-29"].map((d) => ({ started_on: d, ended_on: null as string | null }));
    rows[0].ended_on = "2026-07-06"; rows[1].ended_on = "2026-08-05";
    const p = cyclePicture(rows, {}, "2026-10-10");
    expect(p.length).toBe(30);
    expect(p.periodLength).toBe(6);
    expect(p.nextStart).toBe("2026-10-29");
    expect(p.day).toBe(12);
  });
  it("uses the person's stated length when there is no history", () => {
    expect(cyclePicture([{ started_on: "2026-10-01", ended_on: null }], { avgLength: 32 }, "2026-10-05").nextStart).toBe("2026-11-02");
  });
  it("flags irregular cycles and counts days late", () => {
    const irregular = cyclePicture(["2026-05-01", "2026-05-20", "2026-07-05", "2026-07-30"].map((d) => ({ started_on: d, ended_on: null })), {}, "2026-08-01");
    expect(irregular.irregular).toBe(true);
    const late = cyclePicture([{ started_on: "2026-09-01", ended_on: null }, { started_on: "2026-09-29", ended_on: null }], {}, "2026-11-02");
    expect(late.nextStart).toBe("2026-10-27");
    expect(late.lateBy).toBe(6);
    expect(cyclePicture([], {}, "2026-10-01").tracking).toBe(false);
  });
  it("reads past days and sorts notes into kinds", () => {
    expect(pastDay("yesterday", "Africa/Lagos", NOW)).toBe("2026-10-26");
    expect(pastDay("on the 1st", "Africa/Lagos", NOW)).toBe("2026-10-01");
    expect(pastDay("the 28th", "Africa/Lagos", NOW)).toBe("2026-09-28");
    expect(pastDay("on monday", "Africa/Lagos", NOW)).toBe("2026-10-26");
    expect(cycleKind("cramps")).toBe("symptom");
    expect(cycleKind("heavy flow")).toBe("flow");
    expect(cycleKind("spotting")).toBe("flow");
    expect(cycleKind("mood low")).toBe("mood");
    expect(cycleKind("took my pill")).toBe("pill");
    expect(cycleKind("pregnancy test: negative")).toBe("test");
  });
});

describe("cycle in conversation, no model", () => {
  it("start, symptoms, end, status, settings, brief, forget", async () => {
    const u = await fresh("7001");
    const a = await say(u.id, "my period started on the 1st");
    expect(a.text).toMatch(/^Period started Thu 1 Oct\. Next one likely around Thu 29 Oct\./);
    expect(a.text).toContain("forget my cycle data");
    expect(a.buttons?.[0].label).toBe("Undo");
    for (const t of ["cramps today", "heavy flow", "spotting", "mood low", "headache and bloating", "took my pill", "took a pregnancy test: negative"]) expect((await say(u.id, t)).text, t).toMatch(/noted for today/);
    expect((await say(u.id, "my period ended on the 6th")).text).toMatch(/^Period ended Tue 6 Oct, 6 days this time/);
    const again = await say(u.id, "period started yesterday");
    expect(again.text).toMatch(/^Period started Mon 26 Oct/);
    expect(again.text).not.toContain("forget my cycle data"); // only the first time
    const st = await say(u.id, "when is my next period");
    expect(st.text).toMatch(/^Day 2 of your cycle, so you're on your period\./);
    expect(st.text).toContain("not birth control");
    for (const t of ["where am I in my cycle", "am I late", "my cycle", "fertile window"]) expect((await say(u.id, t)).text, t).toMatch(/^Day 2 of your cycle/);
    expect((await say(u.id, "my cycle is usually 30 days")).text).toMatch(/30-day cycle/);
    expect((await say(u.id, "periods last 6 days")).text).toMatch(/about 6 days/);
    expect((await say(u.id, "stop period reminders")).text).toMatch(/no more reminders/i);
    expect(await buildDigest(db, (await getUserById(db, u.id))!, NOW)).toContain("Cycle: day 2, on your period.");
    await say(u.id, "don't put my cycle in the brief");
    expect(await buildDigest(db, (await getUserById(db, u.id))!, NOW)).not.toContain("Cycle:");
    expect(await db.query(`SELECT 1 FROM jobs WHERE user_id=$1 AND kind='cycle_check' AND active`, [u.id])).toHaveLength(1);

    const f = await say(u.id, "forget my cycle data");
    expect(f.buttons?.map((b) => b.label)).toEqual(["Yes, go ahead", "No"]);
    expect(f.text).toContain("can't be undone");
    expect(await db.query(`SELECT 1 FROM cycles WHERE user_id=$1`, [u.id])).not.toHaveLength(0); // nothing until yes
    const yes = await say(u.id, "yes");
    expect(yes.text).toMatch(/^Gone\./);
    expect(await db.query(`SELECT 1 FROM cycles WHERE user_id=$1 UNION ALL SELECT 1 FROM cycle_logs WHERE user_id=$1`, [u.id])).toHaveLength(0);
    expect((await getUserById(db, u.id))!.prefs).not.toHaveProperty("cycle");
  });
});

describe("measures, no model", () => {
  it("normalises names", () => {
    expect(normaliseMeasure("slept").name).toBe("sleep");
    expect(normaliseMeasure("benched").name).toBe("bench press");
    expect(normaliseMeasure("BP").name).toBe("blood pressure");
    expect(normaliseMeasure("my weight").name).toBe("weight");
  });
  it("logs, compares, shows, lists; habits and spending still route where they did", async () => {
    const u = await fresh("7002");
    const cases: [string, RegExp][] = [
      ["weight 72kg", /^Weight 72 kg\. Logged\.$/],
      ["I weigh 72.4 kg", /^Weight 72\.4 kg\. Logged\. That's 0\.4 kg up on last time\.$/],
      ["slept 7 hours", /^Sleep 7 hours\. Logged\./],
      ["slept 6h30", /^Sleep 6\.5 hours\. Logged\. That's 0\.5 hours down/],
      ["drank 2 litres of water", /^Water 2 litres\. Logged\./],
      ["8 glasses of water", /^Water 8 glasses\. Logged\./],
      ["mood 4/5", /^Mood 4\/5\. Logged\./],
      ["mood: tired", /^Mood: tired\. Logged\./],
      ["bp 120/80", /^Blood pressure 120\/80 mmHg\. Logged\./],
      ["10000 steps", /^Steps 10,000\. Logged\./],
      ["benched 80kg x5", /^Bench press 80 kg, x5\. Logged\./],
      ["did my skincare routine", /^Skincare routine, done for today\. Logged\./],
    ];
    for (const [t, re] of cases) expect((await say(u.id, t)).text, t).toMatch(re);
    expect((await say(u.id, "how's my weight")).text).toMatch(/^Weight this week: about 72\.2 kg on average, low 72, high 72\.4\./);
    expect((await say(u.id, "my sleep this week")).text).toMatch(/^Sleep this week:/);
    expect((await say(u.id, "water this month")).text).toMatch(/^Water this month:/);
    expect((await say(u.id, "what am I tracking")).text).toMatch(/^8 things tracked\./);
    expect((await say(u.id, "did gym")).text).toMatch(/^Gym, logged/);
    expect((await say(u.id, "I spent 4500 naira on data")).text).toMatch(/4,?500/);
    const f = await say(u.id, "forget my weight");
    expect(f.text).not.toContain("deletes every weight"); // plain "forget X" stays a memory forget
  });
});

describe("/api/health", () => {
  it("returns the cycle picture and measures for the signed-in person only", async () => {
    const a = createWeb(db, "lifeline_bot");
    const u = await fresh("7003");
    const login = async () => { const code = await createLinkCode(db, u.id); const r = await a.request("/auth/link", { method: "POST", body: JSON.stringify({ code }), headers: { "content-type": "application/json" } }); return r.headers.get("set-cookie")!.split(";")[0]; };
    const cookie = await login();
    const empty = await (await a.request("/api/health", { headers: { cookie } })).json();
    expect(empty).toEqual({ cycle: { tracking: false }, measures: [] });
    await handleMessage(db, (await getUserById(db, u.id))!, "my period started yesterday", { channel: "web" });
    await handleMessage(db, (await getUserById(db, u.id))!, "cramps today", { channel: "web" });
    await handleMessage(db, (await getUserById(db, u.id))!, "weight 70kg", { channel: "web" });
    const h = await (await a.request("/api/health", { headers: { cookie } })).json();
    expect(h.cycle).toMatchObject({ tracking: true, day: 2, length: 28, inPeriod: true });
    expect(h.cycle.history).toHaveLength(1);
    expect(h.cycle.logs[0]).toMatchObject({ kind: "symptom", value: "cramps" });
    expect(h.measures[0]).toMatchObject({ name: "weight", unit: "kg", last: { value: 70 }, avg7: 70 });
    expect(h.measures[0].points).toHaveLength(1);
    expect((await a.request("/api/health")).status).toBe(401);
  });
});
