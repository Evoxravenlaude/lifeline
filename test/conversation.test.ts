/**
 * The conversational layer: follow-up questions that remember what was
 * asked, the bot explaining itself, and the voice pass on every reply.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { ensureUser, handleMessage, getUserById } from "../src/core/handler.js";
import { polish } from "../src/core/voice.js";
import { answerCapability, isCapabilityQuestion, helpIndex, overview, CAPABILITIES } from "../src/intent/capabilities.js";
import { parseRange, parseMoney } from "../src/core/time.js";
import { pipLine } from "../src/core/pip.js";

let db: Db;
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());

const fresh = async (id: string) => getUserById(db, (await ensureUser(db, "telegram", id, "Sage")).id).then((u) => u!);
const NOW = new Date("2026-10-27T10:00:00Z");

describe("follow-ups", () => {
  it("a trip with no dates asks once, then reads the next message as the answer", async () => {
    const u = await fresh("5001");
    const a = await handleMessage(db, u, "I'm going to accra", { channel: "telegram", now: NOW }); // "plan a trip to accra" now researches a full plan
    expect(a.text).toMatch(/^Accra, nice\. When are you going\?/);
    expect(a.buttons).toBeUndefined();
    const u2 = (await getUserById(db, u.id))!;
    expect((u2.prefs as any).thread?.action).toBe("trip.create");
    const b = await handleMessage(db, u2, "dec 20 to dec 27, budget 600 usd", { channel: "telegram", now: NOW });
    expect(b.text).toMatch(/^Accra, 20 to 27 December\./);
    expect(b.text).toContain("Budget 600 USD");
    expect(b.text).not.toContain("#");
    expect(b.buttons?.[0].label).toBe("Undo");
    expect((await getUserById(db, u.id))!.prefs).not.toHaveProperty("thread");
    const trips = await db.query<{ starts_on: Date | string }>(`SELECT starts_on FROM trips WHERE user_id=$1 AND status<>'cancelled'`, [u.id]);
    expect(trips).toHaveLength(1);
  });

  it("skip carries on without the detail; a second message about the same place updates, not duplicates", async () => {
    const u = await fresh("5002");
    await handleMessage(db, u, "I'm going to lisbon", { channel: "web", now: NOW });
    const s = await handleMessage(db, (await getUserById(db, u.id))!, "skip", { channel: "web", now: NOW });
    expect(s.text).toMatch(/^Lisbon, dates open\./);
    const again = await handleMessage(db, (await getUserById(db, u.id))!, "I'm going to lisbon from nov 3 to nov 9", { channel: "web", now: NOW });
    expect(again.text).toContain("Updated the trip you'd already started");
    expect(await db.query(`SELECT 1 FROM trips WHERE user_id=$1 AND status<>'cancelled'`, [u.id])).toHaveLength(1);
  });

  it("a reminder without a time asks when, and 'no' drops the question", async () => {
    const u = await fresh("5003");
    const a = await handleMessage(db, u, "remind me to call Ada", { channel: "sms", now: NOW });
    expect(a.text).toBe("When should I remind you to call Ada?");
    const b = await handleMessage(db, (await getUserById(db, u.id))!, "tomorrow at 9", { channel: "sms", now: NOW });
    expect(b.text).toMatch(/^Call Ada, tomorrow at 09:00\. I'll ping you here\./);
    const c = await handleMessage(db, (await getUserById(db, u.id))!, "remind me to stretch", { channel: "sms", now: NOW });
    expect(c.text).toContain("When");
    const d = await handleMessage(db, (await getUserById(db, u.id))!, "no", { channel: "sms", now: NOW });
    expect(d.text).toBe("Dropped it.");
    expect(await db.query(`SELECT 1 FROM reminders WHERE user_id=$1 AND NOT deleted`, [u.id])).toHaveLength(1);
  });

  it("changing the subject mid-question is honoured", async () => {
    const u = await fresh("5004");
    await handleMessage(db, u, "plan a trip to nairobi", { channel: "web", now: NOW });
    const r = await handleMessage(db, (await getUserById(db, u.id))!, "I spent 4500 naira on data", { channel: "web", now: NOW });
    expect(r.text).toMatch(/4,?500/);
    expect(r.text).not.toContain("Still waiting");
    expect((await getUserById(db, u.id))!.prefs).not.toHaveProperty("thread");
  });
});

describe("the bot explains itself", () => {
  it("tells a capability question from a request", () => {
    expect(isCapabilityQuestion("can you track my meds?")).toBe(true);
    expect(isCapabilityQuestion("how do I plan a trip")).toBe(true);
    expect(isCapabilityQuestion("what can you do")).toBe(true);
    expect(isCapabilityQuestion("do you do hackathons")).toBe(true);
    expect(isCapabilityQuestion("can you remind me at 9 tomorrow")).toBe(false);
    expect(isCapabilityQuestion("remind me to call Ada")).toBe(false);
  });
  it("answers specifically, with an example and what happens next", async () => {
    const a = answerCapability("can you track my meds?", "Sage")!;
    expect(a).toMatch(/^Yes\. I keep your doses/);
    expect(a).toContain("I take vitamin D at 8 and 8pm");
    expect(a).toContain("pharmacist");
    expect(answerCapability("do you do hackathons")).toContain("rank what's open");
    expect(answerCapability("can you book my flights")).toContain("don't book");
    expect(answerCapability("what can you do", "Sage")).toMatch(/^Sage, here's what I'm for/);
    expect(answerCapability("can you fly to the moon")).toBeNull();
    const u = await fresh("5005");
    const r = await handleMessage(db, u, "can you keep a shopping list?", { channel: "telegram", now: NOW });
    expect(r.text).toMatch(/^Yes\. I keep any list you name/);
  });
  it("help is an index in plain words, not a manual", () => {
    const h = helpIndex();
    expect(h).not.toMatch(/[—•]/);
    expect(h).toContain("Your day");
    expect(h.split("\n").length).toBeLessThan(60);
    for (const c of CAPABILITIES) { expect(c.say.length).toBeGreaterThan(0); expect(c.what).not.toMatch(/[—]/); }
    expect(overview()).not.toContain("/help");
  });
});

describe("voice", () => {
  it("removes em dashes, decorative emoji and robotic residue", () => {
    expect(polish("Reminder set: \"call Ada\" — tomorrow 9am ✅")).toBe("Reminder set: \"call Ada\", tomorrow 9am");
    expect(polish("⏰ Water plants")).toBe("Water plants");
    expect(polish("Successfully saved. Event has been added.")).toBe("Saved. Event is added.");
    expect(polish("Done 🔥", { persona: "hype" })).toBe("Done 🔥");
    expect(polish("a —b\n\n\n\nc")).toBe("A, b\n\nc");
  });
  it("Pip has a line for every state and none of them have emoji", () => {
    for (const s of ["idle", "return", "thinking", "pending", "done", "quiet", "morning", "late", "empty", "reminder", "error", "welcome"] as const) {
      const l = pipLine(s, { tz: "Africa/Lagos", prefs: {} });
      expect(l.length).toBeGreaterThan(5);
      expect(polish(l)).toBe(l);
    }
  });
  it("parses ranges and money the way people type them", () => {
    const r = parseRange("dec 20 to dec 27", "Africa/Lagos", NOW)!;
    expect(r.start.toISOString().slice(0, 10)).toBe("2026-12-20");
    expect(r.end!.toISOString().slice(0, 10)).toBe("2026-12-27");
    expect(parseRange("from the 3rd until the 9th of november", "Africa/Lagos", NOW)!.end!.toISOString().slice(0, 10)).toBe("2026-11-09");
    expect(parseMoney("budget 600 usd")).toEqual({ amount: 600, currency: "USD" });
    expect(parseMoney("$1,200")).toEqual({ amount: 1200, currency: "USD" });
    expect(parseMoney("80k naira")).toEqual({ amount: 80000, currency: "NGN" });
    expect(parseMoney("dec 20")).toBeNull();
  });
});
