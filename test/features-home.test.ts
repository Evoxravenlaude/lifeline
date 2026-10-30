/** Home and the world: utilities, home jobs, circle outages, sports, faith, holidays, flights and the year wrapped. Every outside service is mocked. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { ensureUser, getUserById, handleCallback, handleMessage } from "../src/core/handler.js";
import { propose } from "../src/policy/engine.js";
import { briefExtras } from "../src/core/plugins.js";
import { runDue, schedule, type SchedulerDeps } from "../src/core/scheduler.js";
import { parseByRules } from "../src/intent/rules.js";
import type { User } from "../src/policy/types.js";
import { cachePut, parseCost } from "../src/modules/features/home/util.js";
import { forecast, supply } from "../src/modules/features/home/utilities.js";
import { readPractice } from "../src/modules/features/home/faith.js";
import { builtinHolidays, easter, longBreaks } from "../src/modules/features/home/holidays.js";
import { flightCode } from "../src/modules/features/home/flights.js";
import { DateTime } from "luxon";
import { config } from "../src/core/config.js";

let db: Db;
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); delete process.env.FOOTBALL_DATA_KEY; delete process.env.AVIATIONSTACK_KEY; });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function mockFetch(routes: [RegExp, (url: string, init?: RequestInit) => Response | Promise<Response>][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input?.url ?? input);
    calls.push({ url, init });
    const r = routes.find(([re]) => re.test(url));
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return r[1](url, init);
  }));
  return calls;
}
const at = (iso: string) => { const d = new Date(iso); vi.setSystemTime(d); return d; };
let seq = 9000;
async function person(name: string, tz = "Africa/Lagos", prefs: Record<string, unknown> = {}): Promise<User> {
  const u = await ensureUser(db, "telegram", String(seq++), name);
  await db.query(`UPDATE users SET tz=$2, quiet_start=0, quiet_end=0, prefs = prefs || $3::jsonb WHERE id=$1`, [u.id, tz, JSON.stringify(prefs)]);
  return (await getUserById(db, u.id))!;
}
const fresh = async (u: User) => (await getUserById(db, u.id))!;
const say = async (u: User, text: string, now = new Date()) => handleMessage(db, await fresh(u), text, { channel: "telegram", now });
const press = async (u: User, data: string, now = new Date()) => handleCallback(db, await fresh(u), data, now);
function scheduler() {
  const sent: { userId: number; text: string; buttons?: { label: string; data: string }[] }[] = [];
  const deps: SchedulerDeps = { db, getUser: (id) => getUserById(db, id), send: async (user, reply) => { sent.push({ userId: user.id, text: reply.text, buttons: reply.buttons }); return true; } };
  return { sent, deps, run: async (kind?: string) => { if (kind) await schedule(db, { kind, runAt: new Date(Date.now() - 1000) }); return runDue(deps, new Date(Date.now() + 60_000)); } };
}
const brief = async (u: User) => briefExtras(db, await fresh(u), new Date(), 20);

/* ------------------------------------------------------------------ */

describe("utilities and refills", () => {
  it("learns how long gas lasts, warns once two days out, and stops when asked", async () => {
    const u = await person("Ada");
    at("2026-09-01T09:00:00Z");
    const a = await say(u, "refilled the gas 12.5kg for 15000");
    expect(a.text).toBe("Gas, 12.5kg for ₦15,000, logged. After the next refill I'll know how long one lasts you and can warn you before it runs out.");
    expect(a.buttons?.[0].label).toBe("Undo");
    at("2026-10-01T09:00:00Z");
    const b = await say(u, "gas refill 12.5kg for ₦16,000");
    expect(b.text).toMatch(/^Gas, 12\.5kg for ₦16,000, logged\. A cylinder lasts you about 30 days, so I'd expect the next one around Sat 31 Oct\./);
    expect(b.text).toContain(`"stop the gas reminders"`);

    at("2026-10-29T10:00:00Z");
    expect(await brief(u)).toContain("Gas may run out around Saturday; a cylinder lasts you about 30 days.");
    const s = scheduler();
    await s.run("home_utilities");
    const mine = s.sent.filter((x) => x.userId === u.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toMatch(/Gas may run out around Saturday.*Say "stop the gas reminders" to turn these off\./);
    expect(mine[0].buttons?.map((b) => b.data)).toEqual(["hm:ref:gas", "hm:quiet:gas"]);
    await s.run("home_utilities");
    expect(s.sent.filter((x) => x.userId === u.id)).toHaveLength(1); // one ping per refill

    expect((await press(u, "hm:quiet:gas")).text).toMatch(/^No more gas reminders/);
    expect((await brief(u)).some((l) => /Gas/.test(l))).toBe(false);
    expect((await say(u, "start the gas reminders")).text).toMatch(/^Gas reminders are back on/);
  });

  it("reads prepaid meter units into a burn rate and shows the month's cost", async () => {
    const u = await person("Bisi");
    at("2026-10-20T08:00:00Z");
    expect((await say(u, "power units at 100")).text).toMatch(/^100 units on the meter\. Tell me the units again/);
    at("2026-10-24T08:00:00Z");
    expect((await say(u, "power units at 60")).text).toBe("60 units on the meter. At your pace that's about 6 days left.");
    at("2026-10-25T08:00:00Z");
    expect((await say(u, "topped up 50 kWh of electricity for 12000")).text).toMatch(/^Power, 50 kWh for ₦12,000, logged\./);
    at("2026-10-26T08:00:00Z");
    await say(u, "filled the generator with 10 litres for 9000");
    await say(u, "ran the generator 4 hours");
    const rows = await db.query<any>(`SELECT kind, qty::float AS qty, unit, cost::float AS cost, currency, at, pinged FROM home_refills WHERE user_id=$1 ORDER BY at`, [u.id]);
    const f = forecast(rows.map((r) => ({ ...r, at: new Date(r.at) })), "power")!;
    expect(f.perDay).toBe(10);
    expect(f.endAt.toISOString().slice(0, 10)).toBe("2026-11-04"); // 60 - 10 + 50 = 100 units at 10 a day
    at("2026-10-29T10:00:00Z");
    const r = await say(u, "my utilities");
    expect(r.text).toContain("Power: last topped up Sun 25 Oct (50 kWh); you use about 10 units a day, so around Wed 4 Nov.");
    expect(r.text).toContain("Generator fuel: last filled Mon 26 Oct (10 litres).");
    expect(r.text).toContain("Generator: 4 hours run this month.");
    expect(r.text).toContain("This month on utilities: ₦21,000.");
  });

  it("turns cuts into hours of supply, with a log to copy for the provider", async () => {
    const u = await person("Chidi");
    at("2026-10-29T09:00:00Z"); // 10:00 in Lagos
    const a = await say(u, "power cut from 6pm to 11pm");
    expect(a.text).toMatch(/^Power cut yesterday, 18:00 to 23:00 \(5 hours\), logged\./);
    expect((await say(u, "power is out")).text).toMatch(/^Power off since 10:00, noted\./);
    expect((await say(u, "no light since 4pm")).text).toMatch(/^I already have power off since 10:00/);
    at("2026-10-29T11:00:00Z");
    expect((await say(u, "light is back")).text).toBe("Power back after 2 hours. This week so far: 96% supply, 7 hours without.");
    const w = await say(u, "power this week");
    expect(w.text).toBe("Power this week: off for 7 hours across 2 cuts, so about 161 of 168 hours of supply (96%). Longest: Wed 28 Oct, 5 hours.");
    expect(w.buttons?.[0]).toEqual({ label: "Copy the log", data: "hm:log:power:7" });
    const log = await press(u, "hm:log:power:7");
    expect(log.text).toMatch(/^```\nPower supply log, 22 Oct to 29 Oct 2026\nWed 28 Oct: off 18:00 to 23:00 \(5 hours\)\nThu 29 Oct: off 10:00 to 12:00 \(2 hours\)\nTotal: 7 hours without power across 2 interruptions/);
    // Undo takes the last thing back.
    const water = await say(u, "water is off");
    expect(water.buttons?.some((b) => b.label === "Undo")).toBe(true);
    expect((await say(u, "undo")).text).toBe("Taken off the log.");
  });

  it("parses costs worldwide and never assumes a currency", () => {
    const lagos = { tz: "Africa/Lagos", prefs: {} }, paris = { tz: "Europe/Paris", prefs: {} };
    expect(parseCost("refill 6kg for 9000", lagos)).toEqual({ amount: 9000, currency: "NGN" });
    expect(parseCost("refill 6kg for 9000", paris)).toEqual({ amount: 9000, currency: "EUR" });
    expect(parseCost("came, 2000 litres for 8k", lagos)).toEqual({ amount: 8000, currency: "NGN" });
    expect(parseCost("for 20 usd", lagos)).toEqual({ amount: 20, currency: "USD" });
    expect(parseCost("12.5kg", lagos)).toBeNull();
    const s = supply([{ id: 1, kind: "power", started_at: new Date("2026-10-01T00:00:00Z"), ended_at: null }], new Date("2026-10-01T00:00:00Z"), new Date("2026-10-01T12:00:00Z"));
    expect(s.off).toBe(12);
  });
});

/* ------------------------------------------------------------------ */

describe("home maintenance", () => {
  it("keeps a cycle, pings once when it's due, and resets when done", async () => {
    const u = await person("Dayo");
    at("2026-04-28T08:00:00Z");
    const a = await say(u, "service the AC every 6 months");
    expect(a.text).toBe(`Service the AC, every 6 months. Next one due 28 Oct 2026 (counting from today). It shows in your morning note when it's due. Say "serviced the AC" when it's done, or "stop the AC job" to drop it.`);
    await say(u, "clean the water tank every 3 months, last done in august");
    at("2026-10-29T10:00:00Z");
    expect((await brief(u)).join(" ")).toBe("Home: Service the AC was due 28 Oct and clean the water tank due Saturday.");
    const s = scheduler();
    await s.run("home_upkeep");
    const mine = s.sent.filter((x) => x.userId === u.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toBe(`Service the AC was due 28 Oct. Say "serviced the AC" when it's done, or "stop the AC job" to drop it.`);
    await s.run("home_upkeep");
    expect(s.sent.filter((x) => x.userId === u.id)).toHaveLength(1);
    expect((await say(u, "serviced the AC")).text).toBe("Service the AC, done. Next 29 Apr 2027.");
    expect((await brief(u)).some((l) => /AC/.test(l))).toBe(false);
    const list = await say(u, "my home jobs");
    expect(list.text).toMatch(/^2 home jobs:\n- Clean the water tank, every 3 months: due /);
    expect((await say(u, "stop the AC job")).text).toBe("Service the AC is off the list.");
  });

  it("counts generator hours from the generator log", async () => {
    const u = await person("Efe");
    at("2026-10-01T08:00:00Z");
    expect((await say(u, "generator service every 100 hours")).text).toMatch(/^Generator service, every 100 hours\. I count the hours from your generator log/);
    await say(u, "ran the generator 60 hours");
    expect((await say(u, "my home jobs")).text).toContain("due in about 40 generator hours");
    at("2026-10-02T08:00:00Z");
    expect((await say(u, "generator on")).text).toMatch(/^Generator on\./);
    at("2026-10-02T12:30:00Z");
    expect((await say(u, "generator off")).text).toBe("Generator off after 4.5 hours.");
    await say(u, "ran the generator 40 hours");
    expect((await say(u, "my home jobs")).text).toContain("Generator service, every 100 hours: due now");
    expect((await press(u, `hm:job:done:${(await db.one<{ id: number }>(`SELECT id FROM home_jobs WHERE user_id=$1`, [u.id]))!.id}`)).text).toBe("Generator service, done. Next after 100 generator hours.");
  });
});

/* ------------------------------------------------------------------ */

describe("circle outage alerts", () => {
  it("a report waits for a yes, then followers hear once, merged, without names", async () => {
    at("2026-10-29T17:00:00Z");
    const follower = await person("Funmi");
    const reporter = await person("Gbenga");
    const second = await person("Hauwa");
    expect((await say(follower, "alert me about outages in Rumuola")).text).toMatch(/^I'll tell you when someone in the circle reports power, water or internet out in Rumuola/);
    const p = await say(reporter, "power is out in Rumuola");
    expect(p.text).toMatch(/^This tells anyone in the circle who follows outages in Rumuola that power is out there\. Your name isn't shared\.\n\nGo ahead\?/);
    const ok = await press(reporter, p.buttons![0].data);
    expect(ok.text).toMatch(/^Thanks\. One person following Rumuola will hear in a few minutes, without your name\./);
    at("2026-10-29T17:05:00Z");
    const s = scheduler();
    await s.run();
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0].userId).toBe(follower.id);
    expect(s.sent[0].text).toBe(`Power reported out in Rumuola since 18:00. Say "stop outage alerts for Rumuola" to stop these.`);
    expect(s.sent[0].text).not.toMatch(/Gbenga|Hauwa/);
    // A second report merges into one more line at most.
    const p2 = await say(second, "no light in rumuola");
    await press(second, p2.buttons![0].data);
    at("2026-10-29T17:10:00Z");
    await s.run();
    expect(s.sent).toHaveLength(2);
    expect(s.sent[1].text).toMatch(/^Power reported out in Rumuola since 18:00 \(2 reports\)\./);
    // Back on: no ping, a line in the follower's brief.
    at("2026-10-29T21:00:00Z");
    expect((await say(second, "light is back in Rumuola")).text).toMatch(/^Good news\. Power back in Rumuola/);
    at("2026-10-30T06:00:00Z");
    expect(await brief(follower)).toContain("Power back in Rumuola since 22:00.");
    expect((await say(follower, "stop outage alerts for Rumuola")).text).toBe("No more outage alerts for Rumuola.");
  });

  it("never takes an address", async () => {
    const u = await person("Ifeoma");
    const r = await say(u, "power is out in 12 Aba Road");
    expect(r.text).toMatch(/^I only share neighbourhood names, never addresses/);
    expect(await db.query(`SELECT * FROM home_area_reports WHERE user_id=$1`, [u.id])).toEqual([]);
    const d = await propose({ db, user: await fresh(u), now: new Date(), skipAsk: true }, "outage.follow", { area: "Flat 3 Kilimani" });
    expect(d.kind).toBe("error");
  });
});

/* ------------------------------------------------------------------ */

const ARSENAL = { idTeam: "133604", strTeam: "Arsenal", strSport: "Soccer", strLeague: "English Premier League" };
describe("sports", () => {
  it("follows a team, pings an hour before kickoff once, and puts the score in the brief", async () => {
    at("2026-10-29T10:00:00Z");
    const calls = mockFetch([
      [/thesportsdb\.com\/api\/v1\/json\/3\/searchteams\.php\?t=Arsenal$/, () => json({ teams: [ARSENAL] })],
      [/thesportsdb\.com\/api\/v1\/json\/3\/eventsnext\.php\?id=133604$/, () => json({ events: [{ idEvent: "2001", strHomeTeam: "Arsenal", strAwayTeam: "Chelsea", strTimestamp: "2026-10-29T11:00:00", strLeague: "English Premier League", strStatus: "Not Started" }] })],
      [/thesportsdb\.com\/api\/v1\/json\/3\/eventslast\.php\?id=133604$/, () => json({ results: [{ idEvent: "2000", strHomeTeam: "Arsenal", strAwayTeam: "Spurs", strTimestamp: "2026-10-28T19:00:00", intHomeScore: "2", intAwayScore: "1", strStatus: "Match Finished", strLeague: "English Premier League" }] })],
    ]);
    const u = await person("Jide");
    const r = await say(u, "follow Arsenal");
    expect(r.text).toBe(`Following Arsenal (English Premier League). Next: Arsenal v Chelsea, today at 12:00 (English Premier League). I'll ping you an hour before each game, and the score comes in your morning note. Say "stop following Arsenal" to stop.`);
    expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining(["https://www.thesportsdb.com/api/v1/json/3/searchteams.php?t=Arsenal", "https://www.thesportsdb.com/api/v1/json/3/eventsnext.php?id=133604", "https://www.thesportsdb.com/api/v1/json/3/eventslast.php?id=133604"]));
    expect(await brief(u)).toEqual(expect.arrayContaining(["Result: Arsenal 2, Spurs 1.", "Today: Arsenal v Chelsea at 12:00."]));
    const n = calls.length;
    const s = scheduler();
    await s.run("home_sports");
    expect(s.sent.filter((x) => x.userId === u.id).map((x) => x.text)).toEqual([`Arsenal v Chelsea kicks off at 12:00, in about an hour. Say "stop following Arsenal" to stop these.`]);
    await s.run("home_sports");
    expect(s.sent.filter((x) => x.userId === u.id)).toHaveLength(1);
    expect(calls.length).toBe(n); // fresh listings: no extra requests
    expect((await say(u, "my teams")).text).toMatch(/^You follow Arsenal\./);
    expect((await say(u, "stop following Arsenal")).text).toBe("Stopped following Arsenal.");
  });

  it("uses football-data.org for football when there's a key", async () => {
    at("2026-10-29T10:00:00Z");
    process.env.FOOTBALL_DATA_KEY = "fd_test";
    await cachePut(db, "fd:teams:PD", [{ id: 81, name: "FC Barcelona", shortName: "Barça", tla: "FCB" }, { id: 86, name: "Real Madrid CF", shortName: "Real Madrid", tla: "RMA" }]);
    const calls = mockFetch([
      [/searchteams\.php\?t=Barcelona$/, () => json({ teams: [{ idTeam: "133739", strTeam: "Barcelona", strSport: "Soccer", strLeague: "Spanish La Liga" }] })],
      [/^https:\/\/api\.football-data\.org\/v4\/teams\/81\/matches\?dateFrom=2026-10-26&dateTo=2026-11-08$/, (_u, init) => {
        expect((init!.headers as Record<string, string>)["X-Auth-Token"]).toBe("fd_test");
        return json({ matches: [{ id: 555, utcDate: "2026-11-01T20:00:00Z", status: "TIMED", competition: { name: "Primera Division", code: "PD" }, homeTeam: { id: 81, name: "FC Barcelona", shortName: "Barça" }, awayTeam: { id: 86, name: "Real Madrid CF", shortName: "Real Madrid" }, score: { fullTime: { home: null, away: null } } }] });
      }],
      [/^https:\/\/api\.football-data\.org\/v4\/competitions\/(PL|ELC)\/teams$/, () => json({ teams: [{ id: 57, name: "Arsenal FC", shortName: "Arsenal", tla: "ARS" }] })],
    ]);
    const u = await person("Kemi");
    expect((await say(u, "follow Barcelona")).text).toMatch(/^Following Barcelona \(Spanish La Liga\)\. Next: Barça v Real Madrid, Sunday at 21:00 \(Primera Division\)\./);
    expect((await say(u, "when do Barcelona play")).text).toBe("Barcelona: Barça v Real Madrid, Sunday at 21:00 (Primera Division).");
    // The shared poll learns two competitions' team lists per run, with the key, and maps teams to them.
    const s = scheduler();
    await s.run("home_sports");
    const fd = calls.filter((c) => /competitions/.test(c.url)).map((c) => c.url);
    expect(fd).toEqual(["https://api.football-data.org/v4/competitions/PL/teams", "https://api.football-data.org/v4/competitions/ELC/teams"]);
    expect(await db.one(`SELECT fd_id FROM home_teams WHERE name='Arsenal'`)).toEqual({ fd_id: "57" });
  });

  it("says so plainly when the listings can't be reached", async () => {
    mockFetch([[/thesportsdb/, () => { throw new Error("ECONNRESET"); }]]);
    const u = await person("Lola");
    expect((await say(u, "follow the Lakers")).text).toBe("I couldn't reach the sports listings just now. Try again in a few minutes.");
  });
});

/* ------------------------------------------------------------------ */

const KANO = { results: [{ name: "Kano", country_code: "NG", country: "Nigeria", timezone: "Africa/Lagos", latitude: 12, longitude: 8.5 }] };
const timings = (hijri = 5) => json({ code: 200, data: { timings: { Imsak: "04:50", Fajr: "05:00", Sunrise: "06:10", Dhuhr: "12:00", Asr: "15:20", Sunset: "17:55", Maghrib: "17:55", Isha: "19:05" }, date: { hijri: { month: { number: hijri } } }, meta: { timezone: "Africa/Lagos" } } });
describe("faith rhythms", () => {
  it("asks for the city once, then reminds at the prayers chosen", async () => {
    at("2026-10-29T10:00:00Z");
    const calls = mockFetch([
      [/geocoding-api\.open-meteo\.com\/v1\/search\?name=Kano/, () => json(KANO)],
      [/^https:\/\/api\.aladhan\.com\/v1\/timings\/29-10-2026\?latitude=12&longitude=8\.5$/, () => timings()],
    ]);
    const u = await person("Musa", "UTC");
    expect((await say(u, "Fajr and Maghrib reminders")).text).toMatch(/^Which city should I use\?/);
    const r = await say(u, "Kano");
    expect(r.text).toBe(`Fajr and Maghrib reminders, by the times in Kano. Today: Fajr 05:00, Maghrib 17:55. I'll ping you at each one. Say "stop the prayer reminders" to turn them off.`);
    expect(calls.some((c) => c.url === "https://api.aladhan.com/v1/timings/29-10-2026?latitude=12&longitude=8.5")).toBe(true);
    const jobs = await db.query<{ payload: any; run_at: string }>(`SELECT payload, run_at FROM jobs WHERE user_id=$1 AND kind='home_faith_ping' AND active`, [u.id]);
    expect(jobs.map((j) => j.payload.text)).toEqual(["Maghrib, 17:55."]); // Fajr has passed
    expect(new Date(jobs[0].run_at).toISOString()).toBe("2026-10-29T16:55:00.000Z");
    expect((await say(u, "prayer times today")).text).toBe("Prayer times today in Kano: Fajr 05:00, Sunrise 06:10, Dhuhr 12:00, Asr 15:20, Maghrib 17:55, Isha 19:05.");
    expect((await say(u, "what time is iftar")).text).toBe("Iftar in Kano today is at Maghrib, 17:55.");
    expect(await brief(u)).toContain("Prayer times in Kano: Fajr 05:00, Dhuhr 12:00, Asr 15:20, Maghrib 17:55, Isha 19:05.");
    at("2026-10-29T16:56:00Z");
    const s = scheduler();
    await s.run();
    expect(s.sent.filter((x) => x.userId === u.id).map((x) => x.text)).toEqual([`Maghrib, 17:55. Say "stop the prayer reminders" to turn these off.`]);
    expect((await say(u, "stop the prayer reminders")).text).toBe("Stopped: prayer time reminders.");
    expect(await db.query(`SELECT 1 FROM jobs WHERE user_id=$1 AND kind='home_faith_ping' AND active`, [u.id])).toEqual([]);
  });

  it("suhoor and iftar only in Ramadan", async () => {
    at("2026-10-29T10:00:00Z");
    mockFetch([[/geocoding/, () => json(KANO)], [/aladhan/, () => timings(5)]]);
    const u = await person("Nafisa", "Africa/Lagos", { city: "Kano" });
    expect((await say(u, "suhoor and iftar reminders")).text).toBe(`Suhoor and iftar reminders for Kano. They'll start when Ramadan does; I check the Islamic calendar each day. Say "stop the ramadan reminders" to turn them off.`);
    vi.unstubAllGlobals();
    at("2027-02-10T02:00:00Z");
    mockFetch([[/aladhan\.com\/v1\/timings\/10-02-2027/, () => timings(9)]]);
    const s = scheduler();
    await s.run("home_faith");
    const texts = (await db.query<{ payload: any }>(`SELECT payload FROM jobs WHERE user_id=$1 AND kind='home_faith_ping' AND active ORDER BY run_at`, [u.id])).map((j) => j.payload.text);
    expect(texts).toEqual(["Suhoor: Fajr is at 05:00, about 45 minutes from now.", "Iftar time, Maghrib 17:55."]);
  });

  it("any practice, at a time or at sunset where they live", async () => {
    at("2026-10-30T08:00:00Z"); // a Friday
    const calls = mockFetch([
      [/geocoding-api\.open-meteo\.com\/v1\/search\?name=London/, () => json({ results: [{ name: "London", country_code: "GB", country: "United Kingdom", timezone: "Europe/London", latitude: 51.5, longitude: -0.12 }] })],
      [/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=51\.5&longitude=-0\.12&daily=sunrise,sunset&timezone=auto&forecast_days=7$/, () => json({ daily: { time: ["2026-10-30"], sunrise: ["2026-10-30T07:00"], sunset: ["2026-10-30T16:40"] } })],
    ]);
    const u = await person("Ruth", "Europe/London", { city: "London" });
    expect((await say(u, "Shabbat candle lighting Friday sunset")).text).toBe(`Shabbat candle lighting, Fridays 18 minutes before sunset. I'll ping you 30 minutes before. Say "stop the shabbat candle lighting reminder" to stop it.`);
    expect(calls.some((c) => /api\.open-meteo\.com\/v1\/forecast/.test(c.url))).toBe(true);
    const job = await db.one<{ payload: any; run_at: string }>(`SELECT payload, run_at FROM jobs WHERE user_id=$1 AND kind='home_faith_ping' AND active`, [u.id]);
    expect(job!.payload.text).toBe("Shabbat candle lighting at 16:22, in 30 minutes.");
    expect(new Date(job!.run_at).toISOString()).toBe("2026-10-30T15:52:00.000Z");
    expect((await say(u, "Sunday service at 10")).text).toBe(`Sunday service, Sundays at 10:00. I'll ping you 30 minutes before. Say "stop the sunday service reminder" to stop it.`);
    expect((await say(u, "daily devotional at 6am")).text).toMatch(/^Devotional, every day at 06:00\. I'll ping you then\./);
    expect((await say(u, "my faith reminders")).text).toBe("- Shabbat candle lighting, Fridays at sunset\n- Sunday service, Sundays at 10:00\n- Devotional, every day at 06:00");
    expect((await say(u, "stop the Sunday service reminder")).text).toBe("Stopped: sunday service.");
  });

  it("reads practices without assuming anything", () => {
    expect(readPractice("Friday prayers at 1pm")).toMatchObject({ label: "Friday prayers", days: [5], time: "13:00", lead: 0 });
    expect(readPractice("puja every morning at 6:30")).toMatchObject({ label: "Puja morning", time: "06:30" });
    expect(readPractice("church")).toBeNull();
    expect(parseByRules("church wedding on saturday at 2pm")?.action).not.toBe("faith.practice");
  });
});

/* ------------------------------------------------------------------ */

const KE = [
  { date: "2026-11-05", localName: "Siku ya Mtihani", name: "Test Day", countryCode: "KE", global: true, counties: null, types: ["Public"] },
  { date: "2026-12-12", localName: "Jamhuri Day", name: "Jamhuri Day", countryCode: "KE", global: true, counties: null, types: ["Public"] },
  { date: "2026-12-25", localName: "Christmas Day", name: "Christmas Day", countryCode: "KE", global: true, counties: null, types: ["Public"] },
  { date: "2026-12-26", localName: "Boxing Day", name: "Boxing Day", countryCode: "KE", global: true, counties: null, types: ["Public"] },
];
describe("public holidays and long weekends", () => {
  it("asks for the country once, then finds holidays and the days off that make long weekends", async () => {
    at("2026-10-29T08:00:00Z");
    const calls = mockFetch([
      [/^https:\/\/date\.nager\.at\/api\/v3\/AvailableCountries$/, () => json([{ countryCode: "KE", name: "Kenya" }, { countryCode: "NG", name: "Nigeria" }])],
      [/^https:\/\/date\.nager\.at\/api\/v3\/PublicHolidays\/2026\/KE$/, () => json(KE)],
      [/^https:\/\/date\.nager\.at\/api\/v3\/PublicHolidays\/2027\/KE$/, () => json([])],
    ]);
    const u = await person("Wanjiru", "UTC");
    expect((await say(u, "next public holiday")).text).toMatch(/^Which country should I use for public holidays\?/);
    const r = await say(u, "Kenya");
    expect(r.text).toBe("Next public holiday in Kenya: Test Day (Siku ya Mtihani), Thu 5 Nov, in 7 days. Taking Fri 6 Nov off makes it 4 days in a row. After that: Jamhuri Day, Sat 12 Dec.");
    expect((await fresh(u)).prefs.country).toBe("KE");
    expect(calls.map((c) => c.url)).toContain("https://date.nager.at/api/v3/PublicHolidays/2026/KE");
    const l = await say(u, "long weekends this year");
    expect(l.text).toBe("Long weekends in Kenya for the rest of the year:\n- Thu 5 Nov (Test Day): take Fri 6 Nov off for 4 days in a row.\n- Fri 25 Dec (Christmas Day): 3 days off, Fri to Sun.");
    expect(await brief(u)).toContain("Test Day is a week today, Thu 5 Nov, a public holiday.");
  });

  it("says plainly when a country isn't covered, and when the service is down", async () => {
    at("2026-10-29T08:00:00Z");
    mockFetch([[/AvailableCountries/, () => json([{ countryCode: "KE" }])]]);
    const u = await person("Mahamat", "Africa/Ndjamena", { country: "TD" });
    await db.query(`DELETE FROM home_cache WHERE key='nager:countries'`);
    expect((await say(u, "next public holiday")).text).toBe("Nager.Date, where I get public holidays, doesn't cover Chad yet, so I can't list them. The government's own site will have them.");
    vi.unstubAllGlobals();
    await db.query(`DELETE FROM home_cache WHERE key LIKE 'nager:%'`);
    mockFetch([[/nager/, () => { throw new Error("ETIMEDOUT"); }]]);
    const k = await person("Zawadi", "Africa/Nairobi", { country: "KE" });
    expect((await say(k, "long weekends")).text).toBe("I couldn't reach the public holidays service just now. Try again in a few minutes.");
  });

  it("falls back to a built-in list for Gabon, with Easter Monday, Ascension and Whit Monday worked out", async () => {
    expect(easter(2026).toISODate()).toBe("2026-04-05");
    expect(easter(2027).toISODate()).toBe("2027-03-28");
    const ga = builtinHolidays("GA", 2026)!;
    expect(ga.map((h) => `${h.date} ${h.name}`)).toEqual([
      "2026-01-01 New Year's Day", "2026-04-06 Easter Monday", "2026-04-17 Women's Day", "2026-05-01 Labour Day", "2026-05-14 Ascension Day", "2026-05-25 Whit Monday",
      "2026-08-15 Assumption Day", "2026-08-16 Independence Day", "2026-08-17 Independence Day holiday", "2026-11-01 All Saints' Day", "2026-12-25 Christmas Day",
    ]);
    expect(builtinHolidays("TD", 2026)).toBeNull();

    at("2026-10-29T08:00:00Z");
    mockFetch([[/AvailableCountries/, () => json([{ countryCode: "KE" }])]]);
    await db.query(`DELETE FROM home_cache WHERE key LIKE 'nager:%' OR key LIKE 'cal:%'`);
    const u = await person("Yannick", "Africa/Libreville", { country: "GA" });
    const r = await say(u, "next public holiday");
    expect(r.text).toBe("Next public holiday in Gabon: All Saints' Day, Sun 1 Nov, in 3 days. After that: Christmas Day, Fri 25 Dec. That's from my own list for Gabon, since my holiday service doesn't cover it. Eid al-Fitr and Eid al-Adha move with the moon each year, so they aren't on it.");
    expect((await say(u, "long weekends in 2027")).text).toMatch(/^Long weekends in Gabon in 2027:\n- Fri 1 Jan \(New Year's Day\): 3 days off, Fri to Sun\.\n- Mon 29 Mar \(Easter Monday\): 3 days off, Sat to Mon\.\n- Thu 6 May \(Ascension Day\): take Fri 7 May off for 4 days in a row\.[\s\S]*Sat to Mon\.\n\nThat's from my own list for Gabon/);
    // The brief needs nothing from the network for it.
    at("2026-10-31T06:00:00Z");
    vi.unstubAllGlobals();
    mockFetch([]);
    expect(await brief(u)).toContain("Tomorrow is All Saints' Day, a public holiday.");

    // Nager.Date down altogether: Gabon still gets its built-in list.
    at("2026-10-29T08:00:00Z");
    await db.query(`DELETE FROM home_cache WHERE key LIKE 'nager:%'`);
    mockFetch([[/nager/, () => { throw new Error("ETIMEDOUT"); }]]);
    expect((await say(u, "next public holiday")).text).toMatch(/^Next public holiday in Gabon: All Saints' Day/);
  });

  it("uses Calendarific when a key is set and Nager.Date has no list, keeping only national holidays", async () => {
    at("2026-10-29T08:00:00Z");
    const saved = config.calendarificKey;
    config.calendarificKey = "cal_test";
    try {
      await db.query(`DELETE FROM home_cache WHERE key LIKE 'nager:%' OR key LIKE 'cal:%'`);
      const hol = (iso: string, name: string, type: string[]) => ({ name, description: "", country: { id: "ga", name: "Gabon" }, date: { iso, datetime: {} }, type, primary_type: type[0], locations: "All", states: "All" });
      const calls = mockFetch([
        [/AvailableCountries/, () => json([{ countryCode: "KE" }])],
        [/^https:\/\/calendarific\.com\/api\/v2\/holidays\?/, (url) => json({ meta: { code: 200 }, response: { holidays: url.includes("year=2026") ? [
          hol("2026-11-01", "All Saints' Day", ["National holiday"]), hol("2026-11-20", "Eid test", ["National holiday"]), hol("2026-11-10", "Some observance", ["Observance"]), hol("2026-12-25T00:00:00+01:00", "Christmas Day", ["National holiday", "Christian"]),
        ] : [] } })],
      ]);
      const u = await person("Ondo", "Africa/Libreville", { country: "GA" });
      const r = await say(u, "next public holiday");
      expect(r.text).toBe("Next public holiday in Gabon: All Saints' Day, Sun 1 Nov, in 3 days. After that: Eid test, Fri 20 Nov.");
      const url = calls.find((c) => c.url.includes("calendarific"))!.url;
      expect(url).toBe("https://calendarific.com/api/v2/holidays?api_key=cal_test&country=GA&year=2026");
    } finally { config.calendarificKey = saved; }
  });

  it("respects weekends that aren't Saturday and Sunday", () => {
    const breaks = longBreaks([{ date: "2026-11-05", localName: "", name: "X", global: true, counties: null }], "SA", DateTime.fromISO("2026-11-01"));
    expect(breaks[0].take?.map((d) => d.toISODate())).toBeUndefined(); // Thursday then a Friday weekend: 3 days off already
    expect(breaks[0].days).toBe(3);
  });
});

/* ------------------------------------------------------------------ */

const BA75 = { flight_date: "2026-10-29", flight_status: "scheduled", departure: { airport: "Heathrow", timezone: "Europe/London", scheduled: "2026-10-29T14:40:00+00:00", estimated: "2026-10-29T15:05:00+00:00", delay: 25, terminal: "5", gate: "B32" }, arrival: { airport: "Murtala Muhammed", timezone: "Africa/Lagos" }, airline: { name: "British Airways" }, flight: { iata: "BA75", number: "75" } };
describe("flight status", () => {
  it("without a key, says what it needs and makes no request", async () => {
    const calls = mockFetch([]);
    const u = await person("Obi");
    expect((await say(u, "status of BA75 tomorrow")).text).toBe("Flight status needs an AviationStack key on the server (AVIATIONSTACK_KEY; the free plan covers 100 checks a month). Until then, the airline's app or website has it.");
    expect(calls).toHaveLength(0);
  });

  it("checks on request and once, automatically, for a flight saved in a trip", async () => {
    at("2026-10-29T10:00:00Z");
    process.env.AVIATIONSTACK_KEY = "av_test";
    const calls = mockFetch([[/^https:\/\/api\.aviationstack\.com\/v1\/flights\?access_key=av_test&flight_iata=BA75$/, () => json({ data: [BA75] })]]);
    const u = await person("Pat", "Europe/London");
    expect((await say(u, "is BA75 on time")).text).toBe("BA75 (British Airways), Heathrow to Murtala Muhammed: scheduled to leave at 14:40 local time, about 25 minutes late, now 15:05. Terminal 5, gate B32.");
    expect((await say(u, "status of BA75 tomorrow")).text).toMatch(/^BA75 isn't in the live data for tomorrow yet/);
    const trip = await db.one<{ id: number }>(`INSERT INTO trips (user_id, destination, starts_on) VALUES ($1,'Lagos','2026-10-29') RETURNING id`, [u.id]);
    await db.query(`INSERT INTO trip_items (trip_id, kind, title, at) VALUES ($1,'flight','BA75 LHR to LOS',$2)`, [trip!.id, new Date("2026-10-29T13:40:00Z")]);
    const before = calls.length;
    const s = scheduler();
    await s.run("home_flights");
    await s.run("home_flights");
    expect(calls.length).toBe(before + 1); // one request, however often the job runs
    expect(s.sent.filter((x) => x.userId === u.id).map((x) => x.text)).toEqual([`${"BA75 (British Airways), Heathrow to Murtala Muhammed: scheduled to leave at 14:40 local time, about 25 minutes late, now 15:05. Terminal 5, gate B32."} Safe travels. Say "stop flight checks" to turn these off.`]);
    expect((await brief(u))[0]).toMatch(/^BA75 \(British Airways\)/);
    expect((await say(u, "is my flight on time")).text).toMatch(/^BA75 \(British Airways\)/);
    expect(flightCode("flight LOS-ACC on 20 dec")).toBeNull();
    expect(flightCode("KQ 532 to Nairobi")).toBe("KQ532");
  });

  it("won't send the key over plain http unless that's allowed, then falls back once", async () => {
    at("2026-10-29T10:00:00Z");
    process.env.AVIATIONSTACK_KEY = "av_test";
    const calls = mockFetch([
      [/^https:\/\/api\.aviationstack\.com/, () => json({ error: { code: "https_access_restricted", message: "Access Restricted" } })],
      [/^http:\/\/api\.aviationstack\.com\/v1\/flights\?access_key=av_test&flight_iata=BA75$/, () => json({ data: [{ ...BA75, flight_status: "landed", arrival: { airport: "Murtala Muhammed", actual: "2026-10-29T21:10:00+00:00" } }] })],
    ]);
    const u = await person("Queen");
    expect((await say(u, "flight status BA75")).text).toMatch(/would expose the server's key/);
    expect(calls.map((c) => c.url.split(":")[0])).toEqual(["https"]);
    process.env.AVIATIONSTACK_ALLOW_HTTP = "true";
    try {
      expect((await say(u, "flight status BA75")).text).toBe("BA75 (British Airways), Heathrow to Murtala Muhammed: landed at 21:10 local time.");
      expect(calls.map((c) => c.url.split(":")[0])).toEqual(["https", "https", "http"]);
    } finally { delete process.env.AVIATIONSTACK_ALLOW_HTTP; }
  });
});

/* ------------------------------------------------------------------ */

describe("year wrapped", () => {
  async function busyYear(name: string, trips: number) {
    at("2026-06-01T10:00:00Z");
    const u = await person(name);
    await say(u, "hello");
    await db.query(`INSERT INTO spend (user_id, amount, currency, category, spent_at) VALUES ($1, 50000, 'NGN', 'food', '2026-03-01'), ($1, 20000, 'NGN', 'data', '2026-04-01')`, [u.id]);
    await db.query(`INSERT INTO measures (user_id, name, value, at) VALUES ($1,'sleep',7,'2026-05-01'), ($1,'sleep',8,'2026-05-02'), ($1,'mood',2,'2026-05-02'), ($1,'weight',80,'2026-05-02')`, [u.id]);
    const h = await db.one<{ id: number }>(`INSERT INTO habits (user_id, name) VALUES ($1,'gym') RETURNING id`, [u.id]);
    for (const d of ["2026-02-01", "2026-02-02", "2026-02-03", "2026-02-04", "2026-02-05", "2026-03-10"]) await db.query(`INSERT INTO habit_checkins (habit_id, day) VALUES ($1,$2)`, [h!.id, d]);
    for (let i = 0; i < trips; i++) await db.query(`INSERT INTO trips (user_id, destination, starts_on, status) VALUES ($1,$2,$3,'planning')`, [u.id, ["accra", "Nairobi", "Lisbon"][i % 3], `2026-0${i + 2}-10`]);
    await db.query(`INSERT INTO reminders (user_id, text, due_at, done) VALUES ($1,'call mum','2026-04-01',true)`, [u.id]);
    return u;
  }

  it("tells the year calmly in cards, with nothing sensitive", async () => {
    const u = await busyYear("Sade", 2);
    at("2026-12-10T10:00:00Z");
    const r = await say(u, "my year wrapped");
    expect(r.text).toMatch(/^\*\*2026, wrapped\*\*\n\n\*\*You and me\*\*\n2 messages, most of them in (June|December)\./);
    expect(r.text).toContain("**Things done**\n1 reminder done.");
    expect(r.text).toContain("**Money**\n₦70,000 spent, mostly on food.");
    expect(r.text).toContain("**Rest and steps**\n7.5 hours of sleep a night on average.");
    expect(r.text).toContain("**Habits**\n6 check-ins; your longest run was 5 days of gym.");
    expect(r.text).toContain("**Out in the world**\n2 trips to Accra and Nairobi.");
    expect(r.text).not.toMatch(/mood|weight|cycle|period/i);
  });

  it("compares with the circle only among people who opted in, counts only", async () => {
    const u = await busyYear("Tunde", 3);
    at("2026-12-10T10:00:00Z");
    const first = await say(u, "compare my year with the circle");
    expect(first.text).toMatch(/^You're in\. Only counts are compared/);
    expect(first.text).toMatch(/wait for at least five of you/);
    const others = [await busyYear("Uche", 1), await busyYear("Vera", 2), await busyYear("Yemi", 1), await busyYear("Zara", 2)];
    for (const x of others.slice(0, 2)) await say(x, "compare my year with the circle");
    at("2026-12-10T10:00:00Z");
    expect((await say(u, "how does my year compare")).text).toMatch(/Only 2 others have opted in so far/);
    for (const x of others.slice(2)) await say(x, "compare my year with the circle");
    at("2026-12-10T10:00:00Z");
    const r = await say(u, "how does my year compare");
    expect(r.text).toBe("2026 beside 4 others who opted in:\n- Trips: you 3 trips, the middle of the circle 1.5 trips\n- Places: you 3 places, the middle of the circle 1.5 places\n- Longest habit run: you 5 days, the middle of the circle 5 days\n- Reminders done: you 1 reminder, the middle of the circle 1 reminder");
    expect(r.text).not.toMatch(/Uche|Vera|₦|NGN|sleep/);
    expect((await say(u, "stop comparing my year")).text).toBe("You're out of the circle comparison.");
  });

  it("arrives once in late December, through the calm channel, and can be skipped", async () => {
    const u = await busyYear("Wale", 1);
    const skip = await busyYear("Xola", 1);
    expect((await say(skip, "no year wrapped")).text).toBe("No year wrapped in December; you can still ask for it.");
    at("2026-12-28T11:00:00Z");
    const s = scheduler();
    await s.run("home_yearwrap");
    await s.run("home_yearwrap");
    const mine = s.sent.filter((x) => x.userId === u.id && /wrapped\*\*/.test(x.text));
    expect(mine).toHaveLength(1);
    expect(mine[0].text).toMatch(/^\*\*2026, wrapped\*\*[\s\S]*Say "no year wrapped" to skip this next December\.$/);
    expect(mine[0].buttons).toEqual([{ label: "Compare with the circle", data: "hm:wr:cmp" }]);
    expect(s.sent.some((x) => x.userId === skip.id && /2026, wrapped/.test(x.text))).toBe(false);
    expect((await press(u, "hm:wr:cmp")).text).toMatch(/^You're in\./);
  });
});

describe("words", () => {
  it("reach every feature without a model and leave other sentences alone", () => {
    const cases: [string, string][] = [
      ["power is out in Rumuola", "outage.report"], ["power is out", "utility.outage"], ["light is back in Rumuola", "outage.clear"], ["light is back", "utility.outage"],
      ["follow Arsenal", "sports.follow"], ["when do Barcelona play", "sports.next"], ["status of BA75 tomorrow", "flight.status"], ["my year wrapped", "yearwrap.show"],
      ["service the AC every 6 months", "homejob.add"], ["next public holiday", "holiday.next"], ["Sunday service at 10", "faith.practice"],
    ];
    for (const [s, a] of cases) expect(parseByRules(s)?.action, s).toBe(a);
    for (const s of ["weather London tomorrow", "plan a trip to Accra", "remind me to call mum at 6", "I spent 4500 naira on data", "follow greenhouse stripe matching solana, bd", "stop following 7xKXtg", "water this month", "check on my mood weekly"]) {
      expect(parseByRules(s)?.action ?? "", s).not.toMatch(/^(?:utility|homejob|outage|sports|faith|holiday|flight|yearwrap)\./);
    }
  });
});
