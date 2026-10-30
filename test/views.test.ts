/**
 * The website's read-only views (src/web/views.ts): the day timeline, the cycle calendar and the emergency card,
 * each only for the signed-in person. And files in web chat replies (src/web/replies.ts): passed through to the
 * page from /api/chat and /api/button, checked on the way.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import { z } from "zod";
import { DateTime } from "luxon";
import { createWeb } from "../src/web/server.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { ensureUser, createLinkCode, handleMessage } from "../src/core/handler.js";
import { register } from "../src/policy/registry.js";
import { defineAction } from "../src/policy/types.js";
import { addButtons, addRules } from "../src/core/plugins.js";
import { pageFile, pageReply } from "../src/web/replies.js";

let db: Db;
let web: ReturnType<typeof createWeb>;

async function signIn(tgId: string, name: string, tz = "Africa/Lagos") {
  const u = await ensureUser(db, "telegram", tgId, name);
  await db.query(`UPDATE users SET tz=$2 WHERE id=$1`, [u.id, tz]);
  const code = await createLinkCode(db, u.id);
  const r = await web.request("/auth/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  const cookie = /ll_session=[0-9a-f]{64}/.exec(r.headers.get("set-cookie") ?? "")![0];
  return { user: { ...u, tz }, cookie };
}
async function get(path: string, cookie?: string) {
  const r = await web.request(path, { headers: cookie ? { cookie } : {} });
  return { status: r.status, json: (await r.json()) as any, cache: r.headers.get("cache-control") };
}
async function post(path: string, body: unknown, cookie: string) {
  const r = await web.request(path, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as any };
}

/* Midday in Lagos today: everything below is placed around it. */
const NOW = DateTime.now().setZone("Africa/Lagos").set({ hour: 12, minute: 0, second: 0, millisecond: 0 });
const TODAY = NOW.toISODate()!;
const at = (h: number, m = 0, days = 0) => NOW.plus({ days }).set({ hour: h, minute: m }).toJSDate();
const dayISO = (days: number) => NOW.plus({ days }).toISODate()!;

beforeAll(async () => {
  db = await openTestDb();
  web = createWeb(db, "lifeline_bot");
});
afterAll(async () => { await db.close(); });
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW.toJSDate()); });
afterEach(() => { vi.useRealTimers(); });

describe("GET /api/day", () => {
  let ada: Awaited<ReturnType<typeof signIn>>, ben: Awaited<ReturnType<typeof signIn>>;
  let ironLog = 0, callMum = 0;
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW.toJSDate());
    ada = await signIn("7101", "Ada Obi");
    ben = await signIn("7102", "Ben");
    const id = ada.user.id;
    await db.query(`INSERT INTO events (user_id, title, starts_at, ends_at) VALUES ($1,'standup',$2,$3)`, [id, at(9), at(9, 30)]);
    await db.query(`INSERT INTO events (user_id, title, starts_at, location) VALUES ($1,'dentist',$2,'Allen Avenue')`, [id, at(15)]);
    await db.query(`INSERT INTO events (user_id, title, starts_at, deleted) VALUES ($1,'cancelled thing',$2,true)`, [id, at(16)]);
    callMum = (await db.one<{ id: number }>(`INSERT INTO reminders (user_id, text, due_at) VALUES ($1,'call mum',$2) RETURNING id`, [id, at(10)]))!.id;
    await db.query(`INSERT INTO reminders (user_id, text, due_at) VALUES ($1,'pay rent',$2)`, [id, at(18)]);
    await db.query(`INSERT INTO reminders (user_id, text, due_at, done) VALUES ($1,'water plants',$2,true)`, [id, at(8)]);
    await db.query(`INSERT INTO classes (user_id, name, weekday, start_time, end_time, location) VALUES ($1,'algorithms',$2,'13:00','15:00','Room 4')`, [id, NOW.weekday % 7]);
    const vit = (await db.one<{ id: number }>(`INSERT INTO medications (user_id, name, dose, times, created_at) VALUES ($1,'vitamin d','1 tablet',$2,$3) RETURNING id`, [id, ["08:00", "20:00"], at(12, 0, -3)]))!.id;
    await db.query(`INSERT INTO medication_logs (medication_id, scheduled_for, status, taken_at) VALUES ($1,$2,'taken',$2)`, [vit, at(8, 1)]);
    const iron = (await db.one<{ id: number }>(`INSERT INTO medications (user_id, name, times, created_at) VALUES ($1,'iron',$2,$3) RETURNING id`, [id, ["10:00"], at(12, 0, -3)]))!.id;
    ironLog = (await db.one<{ id: number }>(`INSERT INTO medication_logs (medication_id, scheduled_for) VALUES ($1,$2) RETURNING id`, [iron, at(10)]))!.id;
    const trip = (await db.one<{ id: number }>(`INSERT INTO trips (user_id, destination, starts_on, ends_on) VALUES ($1,'lisbon',$2,$3) RETURNING id`, [id, dayISO(-1), dayISO(3)]))!.id;
    await db.query(`INSERT INTO trip_items (trip_id, kind, title, at) VALUES ($1,'activity','fado night',$2)`, [trip, at(21)]);
  });

  it("needs a session", async () => {
    expect((await get("/api/day")).status).toBe(401);
  });

  it("lays out today by time, with what's done and what's left", async () => {
    const r = await get("/api/day", ada.cookie);
    expect(r.status).toBe(200);
    expect(r.cache).toMatch(/no-store/);
    const d = r.json;
    expect(d).toMatchObject({ date: TODAY, label: "Today", offset: 0, nowTime: "12:00" });
    expect(d.items.map((i: any) => [i.time, i.kind, i.title, i.state])).toEqual([
      ["08:00", "rem", "Water plants", "done"],
      ["08:00", "dose", "Vitamin d", "done"],
      ["09:00", "event", "Standup", "done"],
      ["10:00", "rem", "Call mum", "passed"],
      ["10:00", "dose", "Iron", "passed"],
      ["13:00", "class", "Algorithms", "next"],
      ["15:00", "event", "Dentist", "next"],
      ["18:00", "rem", "Pay rent", "next"],
      ["20:00", "dose", "Vitamin d", "next"],
      ["21:00", "trip", "Fado night", "next"],
    ]);
    const by = (t: string, k: string) => d.items.find((i: any) => i.title === t && i.kind === k);
    expect(by("Vitamin d", "dose")).toMatchObject({ note: "Taken", sub: "1 tablet" });
    expect(by("Iron", "dose")).toMatchObject({ note: "Waiting on you", actions: [{ label: "Taken", data: `med:taken:${ironLog}` }, { label: "Skip", data: `med:skip:${ironLog}` }] });
    expect(by("Call mum", "rem")).toMatchObject({ note: "Not ticked off", actions: [{ label: "Done", data: `rem:done:${callMum}` }, { label: "Snooze", data: `rem:snooze:${callMum}` }] });
    expect(by("Water plants", "rem").actions).toBeUndefined();
    expect(by("Algorithms", "class")).toMatchObject({ end: "15:00", sub: "Room 4" });
    expect(by("Dentist", "event")).toMatchObject({ sub: "Allen Avenue" });
    expect(by("Fado night", "trip")).toMatchObject({ sub: "Lisbon" });
    expect(d.allDay).toEqual([{ title: "Lisbon trip", sub: "Day 2 of 5" }]);
    expect(d.counts).toEqual({ done: 5, left: 5 });
  });

  it("steps to yesterday and tomorrow", async () => {
    const y = (await get(`/api/day?date=${dayISO(-1)}`, ada.cookie)).json;
    expect(y).toMatchObject({ label: "Yesterday", offset: -1, allDay: [{ title: "Lisbon trip", sub: "You set off" }] });
    expect(y.items.map((i: any) => [i.time, i.title, i.state, i.note])).toEqual([
      ["08:00", "Vitamin d", "passed", "Not marked"],
      ["10:00", "Iron", "passed", "Not marked"],
      ["20:00", "Vitamin d", "passed", "Not marked"],
    ]);
    const t = (await get(`/api/day?date=${dayISO(1)}`, ada.cookie)).json;
    expect(t).toMatchObject({ label: "Tomorrow", offset: 1, counts: { done: 0, left: 3 } });
    expect(t.items.every((i: any) => i.state === "next" && i.kind === "dose")).toBe(true);
    const far = (await get(`/api/day?date=${dayISO(5)}`, ada.cookie)).json;
    expect(far.label).toBe(NOW.plus({ days: 5 }).toFormat("cccc d LLLL"));
  });

  it("refuses days it can't read or that are too far away", async () => {
    for (const q of ["nope", "2026-13-40", "2026-02-30"]) expect((await get(`/api/day?date=${q}`, ada.cookie)).json.error).toBe("date");
    expect((await get(`/api/day?date=${dayISO(-400)}`, ada.cookie)).json.error).toBe("range");
  });

  it("only ever shows the signed-in person's own day", async () => {
    const d = (await get("/api/day", ben.cookie)).json;
    expect(d.items).toEqual([]);
    expect(d.allDay).toEqual([]);
  });
});

describe("GET /api/cycle", () => {
  let ada: Awaited<ReturnType<typeof signIn>>, ben: Awaited<ReturnType<typeof signIn>>, cy: Awaited<ReturnType<typeof signIn>>;
  const merged = async (cookie: string, isos: string[]) => {
    const months = [...new Set(isos.map((s) => s.slice(0, 7)))];
    const out = new Map<string, any>();
    for (const m of months) for (const d of (await get(`/api/cycle?month=${m}`, cookie)).json.days) out.set(d.date, d);
    return out;
  };
  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW.toJSDate());
    ada = await signIn("7201", "Ada");
    ben = await signIn("7202", "Ben");
    cy = await signIn("7203", "Cy");
    await db.query(`INSERT INTO cycles (user_id, started_on, ended_on) VALUES ($1,$2,$3)`, [ada.user.id, dayISO(-30), dayISO(-26)]);
    await db.query(`INSERT INTO cycles (user_id, started_on) VALUES ($1,$2)`, [ada.user.id, dayISO(-2)]);
    await db.query(`INSERT INTO cycle_logs (user_id, day, kind, value) VALUES ($1,$2,'symptom','cramps')`, [ada.user.id, dayISO(-1)]);
    await db.query(`UPDATE users SET prefs = prefs || '{"cycle":{"reminders":true}}'::jsonb WHERE id=$1`, [cy.user.id]);
  });

  it("isn't shown to someone who doesn't track their cycle", async () => {
    const r = await get("/api/cycle", ben.cookie);
    expect(r.json).toEqual({ shown: false });
    expect(r.cache).toMatch(/no-store/);
  });

  it("marks logged period days, the predicted next period and the fertile window", async () => {
    const r = await get("/api/cycle", ada.cookie);
    expect(r.json).toMatchObject({ shown: true, tracking: true, month: TODAY.slice(0, 7), today: TODAY, lead: DateTime.fromISO(`${TODAY.slice(0, 7)}-01`).weekday - 1 });
    expect(r.json.picture).toMatchObject({ length: 28, periodLength: 5, nextStart: dayISO(26), fertileStart: dayISO(7), fertileEnd: dayISO(13), lateBy: 0 });
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => dayISO(a + i));
    const days = await merged(ada.cookie, range(-32, 32));
    const where = (k: string) => [...days.values()].filter((d) => d[k]).map((d) => d.date);
    expect(where("period")).toEqual([...range(-30, -26), ...range(-2, 0)].filter((s) => days.has(s)));
    expect(where("predicted")).toEqual(range(26, 30).filter((s) => days.has(s)));
    expect(where("fertile")).toEqual(range(7, 13).filter((s) => days.has(s)));
    expect(where("today")).toEqual([TODAY]);
    expect(days.get(dayISO(-1)).notes).toBe(1);
    const logs = (await get(`/api/cycle?month=${dayISO(-1).slice(0, 7)}`, ada.cookie)).json.logs;
    expect(logs).toContainEqual({ day: dayISO(-1), kind: "symptom", value: "cramps" });
  });

  it("leaves predictions off when the period is late", async () => {
    vi.setSystemTime(NOW.plus({ days: 29 }).toJSDate()); // three days past the expected start, and inside the 30-day session
    const r = await get(`/api/cycle?month=${dayISO(26).slice(0, 7)}`, ada.cookie);
    expect(r.json.picture.lateBy).toBeGreaterThan(0);
    expect(r.json.days.some((d: any) => d.predicted || d.fertile)).toBe(false);
  });

  it("shows an empty calendar to someone who turned tracking on but hasn't logged a period", async () => {
    const r = (await get("/api/cycle", cy.cookie)).json;
    expect(r).toMatchObject({ shown: true, tracking: false, picture: null });
    expect(r.days.some((d: any) => d.period || d.predicted || d.fertile)).toBe(false);
  });

  it("moves month to month, within reach", async () => {
    const r = (await get("/api/cycle?month=2026-01", ada.cookie));
    if (Math.abs(DateTime.fromISO("2026-01-01").diff(DateTime.fromISO(`${TODAY.slice(0, 7)}-01`), "months").months) <= 24) {
      expect(r.json).toMatchObject({ month: "2026-01", label: "January 2026", prev: "2025-12", next: "2026-02" });
      expect(r.json.days).toHaveLength(31);
    }
    expect((await get("/api/cycle?month=2026-13", ada.cookie)).json.error).toBe("month");
    expect((await get("/api/cycle?month=nope", ada.cookie)).json.error).toBe("month");
    expect((await get("/api/cycle?month=1990-01", ada.cookie)).json.error).toBe("range");
  });

  it("never shows one person's cycle to anyone else", async () => {
    expect((await get("/api/cycle", ben.cookie)).json).toEqual({ shown: false });
    expect((await get("/api/cycle")).status).toBe(401);
  });
});

describe("GET /api/emergency", () => {
  it("gives the card's text to its owner only", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW.toJSDate());
    const ada = await signIn("7301", "Ada Obi");
    const ben = await signIn("7302", "Ben");
    expect((await get("/api/emergency", ada.cookie)).json).toEqual({ card: null });
    await handleMessage(db, ada.user as any, "my blood group is O+", { channel: "web" });
    await handleMessage(db, ada.user as any, "emergency card allergies: penicillin", { channel: "web" });
    const r = await get("/api/emergency", ada.cookie);
    expect(r.cache).toMatch(/no-store/);
    expect(r.json.card).toMatch(/^Emergency card: Ada Obi\n/);
    expect(r.json.card).toMatch(/Blood group: O\+/);
    expect(r.json.card).toMatch(/Allergies: penicillin/);
    expect(r.json.card).not.toMatch(/```/);
    expect((await get("/api/emergency", ben.cookie)).json).toEqual({ card: null });
    expect((await get("/api/emergency")).status).toBe(401);
  });
});

describe("files in web chat replies", () => {
  const ics = Buffer.from("BEGIN:VCALENDAR\nEND:VCALENDAR\n").toString("base64");
  beforeAll(() => {
    register(
      defineAction({ name: "testfile.send", tier: 1, description: "test only", schema: z.object({}), async run() { return { reply: "Here it is.", file: { data: ics, name: "../../plans/trip<1>.ics", mime: "text/calendar" } }; } }),
      defineAction({ name: "testfile.broken", tier: 1, description: "test only", schema: z.object({}), async run() { return { reply: "Here it is.", file: { data: "not base64!", name: "x.txt", mime: "text/plain" } }; } }),
    );
    addRules([/^send me the test file$/i, () => ({ action: "testfile.send", args: {} })], [/^send me the broken file$/i, () => ({ action: "testfile.broken", args: {} })]);
    addButtons("tfile", async () => ({ text: "From the button.", file: { data: ics, name: "invite.ics", mime: "text/calendar" } }));
  });

  it("passes a file from /api/chat and /api/button to the page, with a safe name", async () => {
    const { cookie } = await signIn("7401", "Ada");
    const r = await post("/api/chat", { text: "send me the test file" }, cookie);
    expect(r.json.text).toMatch(/Here it is/);
    expect(r.json.file).toEqual({ data: ics, name: "trip-1-.ics", mime: "text/calendar" });
    const b = await post("/api/button", { data: "tfile:go" }, cookie);
    expect(b.json.file).toEqual({ data: ics, name: "invite.ics", mime: "text/calendar" });
  });

  it("leaves a broken file off rather than handing it to the browser", async () => {
    const { cookie } = await signIn("7402", "Ben");
    const r = await post("/api/chat", { text: "send me the broken file" }, cookie);
    expect(r.json.text).toMatch(/Here it is/);
    expect(r.json).not.toHaveProperty("file");
  });

  it("checks names and types", () => {
    expect(pageFile({ data: ics, name: "", mime: "<script>" })).toEqual({ data: ics, name: "lifeline-file", mime: "application/octet-stream" });
    expect(pageFile({ data: ics, name: "C:\\Users\\me\\..hidden.pdf", mime: "Application/PDF" })).toEqual({ data: ics, name: "hidden.pdf", mime: "application/pdf" });
    expect(pageFile({ data: "", name: "a", mime: "text/plain" })).toBeNull();
    expect(pageFile("nope")).toBeNull();
    expect(pageReply({ text: "hi" })).toEqual({ text: "hi" });
    expect(pageReply({ text: "hi", file: { data: "%%%", name: "a", mime: "text/plain" } })).toEqual({ text: "hi" });
  });
});
