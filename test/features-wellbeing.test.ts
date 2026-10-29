/** Wellbeing and people: every feature end to end, opt-in respected, calm mode and quiet days hold pings, nothing private in the brief. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { ensureUser, getUserById, handleCallback, handleMessage, type Reply } from "../src/core/handler.js";
import { runDue, type SchedulerDeps } from "../src/core/scheduler.js";
import { buildDigest } from "../src/modules/digest.js";
import type { User } from "../src/policy/types.js";
import { handleCareSms } from "../src/modules/features/wellbeing/index.js";
import { radarSees, patterns } from "../src/modules/features/wellbeing/mind.js";
import { healthSummary } from "../src/modules/features/wellbeing/health.js";
import { CRISIS } from "../src/modules/features/wellbeing/shared.js";
import { parseByRules } from "../src/intent/rules.js";

let db: Db;
const saved = { ...config };
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());
const OFFLINE = { anthropicKey: "", geminiKey: "", openaiCompatKey: "", modelProvider: "" as const, smsProvider: "" as const, smsGatewayKey: "", smsGatewayFrom: "", twilioSid: "", twilioToken: "", twilioFrom: "", smtpUrl: "", resendKey: "", emailFrom: "", maxPushesPerDay: 50 };
beforeEach(() => {
  Object.assign(config, OFFLINE);
  // Tests never touch the network: anything not mocked on purpose fails loudly.
  vi.stubGlobal("fetch", vi.fn(async (u: any) => { throw new Error(`unexpected fetch ${String(u?.url ?? u)}`); }));
});
afterEach(() => { Object.assign(config, saved); vi.unstubAllGlobals(); });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function mockFetch(routes: [RegExp, (url: string, init?: RequestInit) => Response][]) {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input?.url ?? input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const r = routes.find(([re]) => re.test(url));
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return r[1](url, init);
  }));
  return calls;
}

let seq = 0;
async function person(name = "Ada", prefs: Record<string, unknown> = {}, tz = "UTC"): Promise<User> {
  const u = await ensureUser(db, "telegram", String(77000 + ++seq), name);
  await db.query(`UPDATE users SET tz=$3, quiet_start=0, quiet_end=0, prefs = prefs || $2::jsonb WHERE id=$1`, [u.id, JSON.stringify(prefs), tz]);
  return (await getUserById(db, u.id))!;
}
const fresh = async (u: User) => (await getUserById(db, u.id))!;
const say = async (u: User, text: string, now?: Date): Promise<Reply> => handleMessage(db, await fresh(u), text, { channel: "telegram", now });
const tap = async (u: User, data: string, now?: Date): Promise<Reply> => handleCallback(db, await fresh(u), data, now);
const setPrefs = (u: User, p: Record<string, unknown>) => db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [u.id, JSON.stringify(p)]);
const brief = async (u: User, now = new Date()) => buildDigest(db, await fresh(u), now, { peek: true });
const jobs = (u: User, kind: string) => db.query<{ id: number; payload: any; run_at: string }>(`SELECT id, payload, run_at FROM jobs WHERE user_id=$1 AND kind=$2 AND active`, [u.id, kind]);
const dueNow = (id: number) => db.query(`UPDATE jobs SET run_at=$2 WHERE id=$1`, [id, new Date(Date.now() - 60_000)]);

/** Run every due job of this area with a fake sender. Other areas' and the core's jobs are paused so only ours speak. */
async function runMine(when = new Date(Date.now() + 2 * 86_400_000)) {
  await db.query(`UPDATE jobs SET active=false WHERE kind NOT LIKE 'well_%' AND active`);
  const sent: { userId: number; text: string; buttons?: { label: string; data: string }[] }[] = [];
  const deps: SchedulerDeps = { db, getUser: (id) => getUserById(db, id), send: async (u, r) => { sent.push({ userId: u.id, text: r.text, buttons: r.buttons }); return true; } };
  for (let i = 0; i < 10 && (await runDue(deps, when)) > 0; i++);
  return { sent, to: (u: User) => sent.filter((s) => s.userId === u.id) };
}
const daysAgo = (n: number, hour = 9) => DateTime.utc().minus({ days: n }).set({ hour, minute: 0 }).toJSDate();

/* ------------------------------------------------------------------ */

describe("nothing starts unasked", () => {
  it("a new person has no wellbeing jobs, pings or brief lines", async () => {
    const u = await person("Zed");
    expect(await db.query(`SELECT kind FROM jobs WHERE user_id=$1 AND kind LIKE 'well_%'`, [u.id])).toHaveLength(0);
    const { to } = await runMine();
    expect(to(u)).toHaveLength(0);
    const b = await brief(u);
    expect(b).not.toMatch(/catch-up|mood|good things|counter|lesson|pattern|checkup/i);
  });
});

describe("1. keep in touch", () => {
  it("sets a cadence, nudges in the brief with a starter from notes, and resets when they talk", async () => {
    const u = await person("Sage");
    expect((await say(u, "call Mum every Sunday")).text).toMatch(/^Mum, every Sunday\. I'll mention it in your morning brief/);
    const r = await say(u, "check in with Ese if we haven't talked in 3 weeks");
    expect(r.text).toMatch(/^Ese, every 3 weeks/);
    expect(r.text).toMatch(/stop keeping in touch with Ese/);
    await db.query(`UPDATE well_people SET created_at = now() - interval '30 days' WHERE user_id=$1 AND name='Ese'`, [u.id]);
    await say(u, "note: Ese started a new job at the bank");
    const due = await say(u, "who should I catch up with");
    expect(due.text).toMatch(/^Ese is due a catch-up\./);
    expect(due.text).toMatch(/Something to ask Ese about: "Ese started a new job at the bank"/);
    expect(await brief(u)).toMatch(/Ese is due a catch-up\. Something to ask Ese about/);
    const done = await say(u, "talked to Ese");
    expect(done.text).toMatch(/started Ese's clock again/);
    expect(await brief(u)).not.toMatch(/Ese is due/);
    expect((await say(u, "called Bisi")).text).toMatch(/not keeping track of Bisi/);
  });

  it("pings only when asked, says how to stop the first time, and the button resets it", async () => {
    const u = await person("Kemi");
    await say(u, "keep in touch with Tolu every 2 weeks and ping me");
    await db.query(`UPDATE well_people SET created_at = now() - interval '20 days' WHERE user_id=$1`, [u.id]);
    expect(await jobs(u, "well_touch")).toHaveLength(1);
    const { to } = await runMine();
    const m = to(u);
    expect(m).toHaveLength(1);
    expect(m[0].text).toMatch(/^Tolu is due a catch-up\./);
    expect(m[0].text).toMatch(/Say "stop keeping in touch with Tolu" any time to stop these/);
    expect(await brief(u)).not.toMatch(/Tolu/); // pinged, so not repeated in the brief
    expect((await tap(u, m[0].buttons![0].data)).text).toMatch(/clock starts again/);
    expect((await say(u, "stop keeping in touch with Tolu")).text).toBe("No more nudges about Tolu.");
  });
});

describe("2. health admin and the doctor summary", () => {
  it("keeps checkups on the person's schedule and mentions them in the brief only when due", async () => {
    const u = await person("Ife");
    expect((await say(u, "dental checkup every 6 months")).text).toMatch(/^Dental checkup, every 6 months\. I'll mention it in your morning brief when it's due, around \w+/);
    expect((await say(u, "smear test every 3 years")).text).toMatch(/every 3 years/);
    expect((await say(u, "flu jab every October")).text).toMatch(/^Flu jab, every October/);
    expect(await brief(u)).not.toMatch(/Dental/);
    await db.query(`UPDATE well_checkups SET next_due = (now() AT TIME ZONE 'UTC')::date + 7 WHERE user_id=$1 AND name='Dental checkup'`, [u.id]);
    expect(await brief(u)).toMatch(/Dental checkup is due next week\. Say "had my dental checkup" once it's done\./);
    const d = await say(u, "had my dental checkup");
    expect(d.text).toMatch(/^Dental checkup, done\. The next one is due around/);
    expect(await brief(u)).not.toMatch(/Dental/);
    expect((await say(u, "my checkups")).text).toMatch(/Smear test, every 3 years/);
  });

  it("logs symptoms privately and builds a plain 90-day summary, emailed when there's a confirmed address", async () => {
    const u = await person("Tunde", { emailVerified: "tunde@example.com" });
    for (const s of ["bp 120/80", "bp 135/85", "weight 72kg", "slept 7 hours", "slept 6 hours", "mood 4/5"]) await say(u, s);
    expect((await say(u, "log symptom: headache, mild")).text).toBe("Headache, mild, kept privately. Ask for \"my doctor summary\" before an appointment and it'll be in there.");
    const med = await db.one<{ id: number }>(`INSERT INTO medications (user_id, name, dose, times) VALUES ($1,'Amlodipine','5mg',ARRAY['08:00']) RETURNING id`, [u.id]);
    for (const st of ["taken", "taken", "skipped"]) await db.query(`INSERT INTO medication_logs (medication_id, scheduled_for, status) VALUES ($1, now() - interval '2 days', $2)`, [med!.id, st]);
    Object.assign(config, { resendKey: "re_test", emailFrom: "lifeline <hi@example.com>" });
    const calls = mockFetch([[/api\.resend\.com\/emails$/, () => json({ id: "e1" })]]);
    const r = await say(u, "doctor on Friday, give me my summary");
    expect(r.text).toMatch(/^Your last 90 days, as you logged them/);
    expect(r.text).toMatch(/```[\s\S]*Not a diagnosis[\s\S]*```/);
    expect(r.text).toMatch(/Blood pressure: 2 readings, lowest 120\/80, highest 135\/85, latest 135\/85/);
    expect(r.text).toMatch(/Weight: 1 reading, 72 to 72 kg/);
    expect(r.text).toMatch(/Sleep: 2 nights logged, average 6\.5 hours/);
    expect(r.text).toMatch(/Mood \(self-rated\): 1 entry, average 4 out of 5/);
    expect(r.text).toMatch(/Amlodipine \(5mg\), 08:00: 2 taken, 1 skipped, 0 not answered/);
    expect(r.text).toMatch(/: headache, mild/);
    expect(r.text).toMatch(/I've emailed a copy to tunde@example\.com/);
    expect(calls[0].body.to).toEqual(["tunde@example.com"]);
    expect(calls[0].body.text).toMatch(/Blood pressure/);
    // No interpretation words, ever.
    expect(r.text).not.toMatch(/\b(?:high|normal|healthy|concerning|should|risk)\b/i);
    // Private: none of it reaches the brief.
    expect(await brief(u)).not.toMatch(/headache|Blood pressure|summary/i);
  });

  it("says plainly when there's nothing to summarise, and offers email setup when there's no address", async () => {
    const u = await person("Nia");
    expect((await say(u, "summary for my doctor")).text).toMatch(/nothing logged from the last 90 days/);
    await say(u, "log symptom: dizzy after standing");
    expect((await say(u, "my health summary")).text).toMatch(/Say "my email is \.\.\." and confirm the code/);
    expect(await healthSummary(db, await fresh(u), new Date())).toMatch(/dizzy after standing/);
  });
});

describe("3. mood check-ins, the burnout radar and the crisis path", () => {
  it("is opt-in, taps 1 to 5, keeps a few words, and says how to stop the first time only", async () => {
    const u = await person("Bisi");
    expect((await say(u, "check on my mood every evening")).text).toMatch(/^I'll check in every evening at 20:00 with a quick 1 to 5\..*Say "stop mood check-ins" any time\.$/s);
    let { to } = await runMine();
    expect(to(u)).toHaveLength(1);
    expect(to(u)[0].text).toMatch(/^How was today, 1 to 5\?/);
    expect(to(u)[0].text).toMatch(/Say "stop mood check-ins" any time to stop these/);
    expect(to(u)[0].buttons!.map((b) => b.data)).toEqual(["wb:m:1", "wb:m:2", "wb:m:3", "wb:m:4", "wb:m:5", "wb:m:stop"]);
    ({ to } = await runMine(new Date(Date.now() + 4 * 86_400_000)));
    expect(to(u)[0].text).not.toMatch(/stop these/);

    const low = await tap(u, "wb:m:2");
    expect(low.text).toBe("Thank you for telling me. Go gently tonight. If you want to say more, I'm listening.");
    expect((await say(u, "rough day at work, too many meetings")).text).toBe("Kept, just for you.");
    const m = await db.one<{ value: string; note: string }>(`SELECT value::text, note FROM measures WHERE user_id=$1 AND name='mood' ORDER BY id DESC LIMIT 1`, [u.id]);
    expect(Number(m!.value)).toBe(2);
    expect(m!.note).toBe("2/5, rough day at work, too many meetings");
    // A command after the tap is still a command.
    await tap(u, "wb:m:4");
    expect((await say(u, "slept 7 hours")).text).toMatch(/^Sleep 7 hours\. Logged\./);
    expect((await say(u, "stop mood check-ins")).text).toMatch(/^Mood check-ins are off/);
    expect(await jobs(u, "well_mood")).toHaveLength(0);
  });

  it("on a low day offers one of the person's own good things back", async () => {
    const u = await person("Chi");
    await db.query(`INSERT INTO well_good (user_id, text, day) VALUES ($1, 'swam in the sea with Ama', (now() - interval '6 days')::date)`, [u.id]);
    const r = await tap(u, "wb:m:1");
    expect(r.buttons?.[0]).toEqual({ label: "Something you wrote", data: "wb:g:one" });
    expect((await tap(u, "wb:g:one")).text).toMatch(/you wrote: "swam in the sea with Ama"/);
  });

  it("calm mode and quiet days hold the check-in pings", async () => {
    const calm = await person("Dayo");
    await say(calm, "check on my mood every evening");
    await setPrefs(calm, { calm: true });
    const quiet = await person("Efe");
    await say(quiet, "check on my mood weekly");
    await setPrefs(quiet, { quietUntil: Date.now() + 30 * 86_400_000 });
    const { to } = await runMine(new Date(Date.now() + 8 * 86_400_000));
    expect(to(calm)).toHaveLength(0);
    expect(to(quiet)).toHaveLength(0);
  });

  it("notices two weeks of lower mood and sleep once, softly, and holds it for the brief in calm mode", async () => {
    const u = await person("Femi");
    await say(u, "check on my mood every evening");
    for (let d = 16; d <= 40; d += 2) await db.query(`INSERT INTO measures (user_id, name, value, note, at) VALUES ($1,'mood',4,'4/5',$2), ($1,'sleep',8,NULL,$2)`, [u.id, daysAgo(d)]);
    for (const d of [1, 3, 5, 8, 10, 12]) await db.query(`INSERT INTO measures (user_id, name, value, note, at) VALUES ($1,'mood',2,'2/5',$2), ($1,'sleep',5.5,NULL,$2)`, [u.id, daysAgo(d)]);
    expect(await radarSees(db, await fresh(u), new Date())).toBe(true);
    const [radar] = await jobs(u, "well_radar");
    await dueNow(radar.id);
    await db.query(`UPDATE jobs SET active=false WHERE user_id=$1 AND kind='well_mood'`, [u.id]);
    const { to } = await runMine(new Date(Date.now() + 60_000));
    expect(to(u)).toHaveLength(1);
    expect(to(u)[0].text).toMatch(/^Something I noticed, just between us: your mood and your sleep have both been lower than usual/);
    expect(to(u)[0].text).toMatch(/That's okay\./);
    expect(to(u)[0].text).toContain("https://findahelpline.com");
    // Once a month at most.
    await dueNow(radar.id);
    expect((await runMine(new Date(Date.now() + 60_000))).to(u)).toHaveLength(0);

    const c = await person("Gozie");
    await say(c, "watch for burnout");
    for (let d = 16; d <= 40; d += 2) await db.query(`INSERT INTO measures (user_id, name, value, note, at) VALUES ($1,'mood',4,'4/5',$2), ($1,'sleep',8,NULL,$2)`, [c.id, daysAgo(d)]);
    for (const d of [1, 3, 5, 8, 10, 12]) await db.query(`INSERT INTO measures (user_id, name, value, note, at) VALUES ($1,'mood',2,'2/5',$2), ($1,'sleep',5.5,NULL,$2)`, [c.id, daysAgo(d)]);
    await setPrefs(c, { calm: true });
    const [r2] = await jobs(c, "well_radar");
    await dueNow(r2.id);
    expect((await runMine(new Date(Date.now() + 60_000))).to(c)).toHaveLength(0);
    expect(await brief(c)).toMatch(/Something I noticed, just between us/); // the Today panel only looks: it stays for the brief
    expect(await buildDigest(db, await fresh(c), new Date())).toMatch(/Something I noticed, just between us/);
    expect(await brief(c)).not.toMatch(/Something I noticed/); // shown once
  });

  it("does not see a dip that isn't there", async () => {
    const u = await person("Hassan");
    for (let d = 1; d <= 40; d += 2) await db.query(`INSERT INTO measures (user_id, name, value, note, at) VALUES ($1,'mood',4,'4/5',$2), ($1,'sleep',7.5,NULL,$2)`, [u.id, daysAgo(d)]);
    expect(await radarSees(db, await fresh(u), new Date())).toBe(false);
  });

  it("meets words of self-harm with warmth, findahelpline.com and the local emergency number, never one country's helpline", async () => {
    const uk = await person("Ola", { country: "GB" });
    const r = await say(uk, "I want to kill myself");
    expect(r.text).toMatch(/^I'm really glad you told me\./);
    expect(r.text).toContain("https://findahelpline.com");
    expect(r.text).toMatch(/please call 999, the emergency number where you are/);
    const nowhere = await person("Pat", {}, "Pacific/Fiji");
    const r2 = await say(nowhere, "honestly I don't want to be alive anymore");
    expect(r2.text).toMatch(/your local emergency number/);
    expect(r2.text).toContain("findahelpline.com");
    expect(r2.text).not.toMatch(/Samaritans|988|Lifeline Australia|\bshould\b/i);
    // Through a mood note too.
    await tap(nowhere, "wb:m:1");
    expect((await say(nowhere, "mood note: I keep thinking about ending my life")).text).toContain("findahelpline.com");
    // Everyday phrases don't trip it.
    for (const s of ["I cut myself cooking", "this traffic is killing me", "I'm dying to see the film"]) expect(CRISIS.test(s), s).toBe(false);
  });
});

describe("4. three good things", () => {
  it("asks in the evening when asked, saves the answer privately, and shows recent ones", async () => {
    const u = await person("Ama");
    expect((await say(u, "ask me for three good things at 9pm")).text).toMatch(/^Every evening at 21:00 I'll ask for three good things/);
    const { to } = await runMine();
    expect(to(u)[0].text).toMatch(/^Three good things from today\? Small ones count\./);
    expect(to(u)[0].text).toMatch(/Say "stop good things" any time to stop these/);
    expect((await say(u, "the bus was on time, lunch with Ada, finished my book")).text).toBe("Kept, all of them. Sleep well.");
    expect((await say(u, "good things: a nap")).text).toBe("Kept. Sleep well.");
    const list = await say(u, "my good things");
    expect(list.text).toMatch(/lunch with Ada/);
    expect(await brief(u)).not.toMatch(/lunch with Ada|good things/i);
    expect((await say(u, "stop good things")).text).toMatch(/^No more good-things prompts/);
  });
});

describe("5. quit and no-contact counters", () => {
  const NOW = new Date("2026-10-29T10:00:00Z");
  it("never starts a counter from how someone feels or a basic need", () => {
    for (const t of ["I stopped caring", "I have stopped eating", "I stopped sleeping", "I gave up trying", "I gave up waiting"]) expect(parseByRules(t)?.action, t).not.toBe("quit.start");
    expect(parseByRules("I gave up drinking 3 days ago")?.action).toBe("quit.start");
  });
  it("counts days and money in the person's currency, keeps their reason, and talks them down", async () => {
    const u = await person("Jide", { currency: "EUR" });
    const r = await say(u, "I quit smoking on 1 Oct, a pack is 12", NOW);
    expect(r.text).toMatch(/^Smoking: 28 days since 1 Oct, about €336 not spent on it\./);
    expect(r.buttons?.[0].label).toBe("Talk me down");
    expect((await say(u, "my reason: I want to run with my kids", NOW)).text).toBe("Kept. I'll show you this when it's hard.");
    const t = await tap(u, r.buttons![0].data, NOW);
    expect(t.text).toMatch(/^Breathe in for four/);
    expect(t.text).toMatch(/You wrote: "I want to run with my kids"/);
    expect((await say(u, "talk me down", NOW)).text).toMatch(/28 days so far/);
  });

  it("meets a slip with no shame and keeps the longest run", async () => {
    const u = await person("Kola");
    await say(u, "I quit smoking on 1 Oct", NOW);
    const s = await say(u, "had a slip today", NOW);
    expect(s.text).toBe("Thank you for telling me. A slip isn't a failure. 28 days still happened, and your longest run, 28 days, stays on the record. Today is day one again, and that's allowed.");
    expect(s.text).not.toMatch(/you failed|broke|streak lost|reset to zero/i);
    expect((await say(u, "my counters", NOW)).text).toMatch(/^Smoking: starting today\. Longest run 28 days\./);
  });

  it("is private by default, in the brief only when asked, and handles no contact", async () => {
    const u = await person("Lara");
    expect((await say(u, "no contact with my ex since Monday", NOW)).text).toMatch(/^No contact with your ex: 3 days since 26 Oct\. I'll keep count, privately\./);
    expect(await brief(u, NOW)).not.toMatch(/ex|No contact/);
    await say(u, "show my counters in the brief", NOW);
    expect(await brief(u, NOW)).toMatch(/No contact with your ex: 3 days\./);
  });

  it("marks a milestone quietly, once, and calm mode holds it", async () => {
    const u = await person("Musa");
    expect((await say(u, "stopped betting 7 days ago")).text).toMatch(/^Betting: 7 days since/);
    const sweep = await jobs(u, "well_quit");
    expect(sweep).toHaveLength(1);
    await dueNow(sweep[0].id);
    const { to } = await runMine(new Date(Date.now() + 60_000));
    expect(to(u)).toHaveLength(1);
    expect(to(u)[0].text).toMatch(/^7 days without betting today\. Quietly proud of you\./);
    await dueNow(sweep[0].id);
    expect((await runMine(new Date(Date.now() + 60_000))).to(u)).toHaveLength(0);
    // The sticker comes on a milestone day, never in calm mode.
    expect((await say(u, "my counters")).sticker).toBe("cheers");
    await setPrefs(u, { calm: true });
    expect((await say(u, "my counters")).sticker).toBeUndefined();
    await db.query(`UPDATE well_quits SET started_on = (now() AT TIME ZONE 'UTC')::date - 14, milestone=7 WHERE user_id=$1`, [u.id]);
    await dueNow(sweep[0].id);
    expect((await runMine(new Date(Date.now() + 60_000))).to(u)).toHaveLength(0);
  });
});

describe("6. remembrance dates", () => {
  it("keeps the day quietly, sends one gentle message in their own words only when asked, and never in on this day", async () => {
    const u = await person("Nkem");
    const r = await say(u, "Dad passed on 4 June 2019");
    expect(r.text).toMatch(/^I'm so sorry about Dad\. I've kept 4 June, quietly\. It won't show up anywhere unless you want it to\./);
    expect(r.buttons!.map((b) => b.label)).toEqual(["Yes, on the day", "No, just keep it", "Undo"]);
    expect(await jobs(u, "well_remember")).toHaveLength(0);
    expect((await tap(u, r.buttons![0].data)).text).toMatch(/^I'll send you one gentle message on 4 June\. If there are words/);
    expect((await say(u, "words for Dad: you taught me to be brave")).text).toBe("Kept. On 4 June I'll send you your words, and nothing else.");
    const [j] = await jobs(u, "well_remember");
    await dueNow(j.id);
    const { to } = await runMine(new Date(Date.now() + 60_000));
    expect(to(u)).toEqual([expect.objectContaining({ text: "Thinking of Dad with you today. You wrote:\n\n\"you taught me to be brave\"" })]);
    const next = await jobs(u, "well_remember");
    expect(next).toHaveLength(1);
    expect(new Date(next[0].run_at).getTime()).toBeGreaterThan(Date.now() + 30 * 86_400_000);

    // On this day: a happy trip shows; anything about Dad or grief never does.
    const today = DateTime.utc();
    const lastYear = today.minus({ years: 1 });
    await db.query(`INSERT INTO trips (user_id, destination, starts_on, ends_on, status) VALUES ($1,'accra',$2,$3,'done')`, [u.id, lastYear.minus({ days: 1 }).toISODate(), lastYear.plus({ days: 2 }).toISODate()]);
    await db.query(`INSERT INTO notes (user_id, text, created_at) VALUES ($1,'Dad and I went fishing at the lake',$2), ($1,'the funeral was so hard',$2)`, [u.id, lastYear.set({ hour: 12 }).toJSDate()]);
    const b = await brief(u);
    expect(b).toMatch(/A year ago today you were in Accra\./);
    expect(b).not.toMatch(/fishing|funeral|Dad/);
    expect((await say(u, "on this day")).text).toBe("A year ago today you were in Accra.");
    expect((await say(u, "stop on this day")).text).toMatch(/^No more on this day/);
    expect(await brief(u)).not.toMatch(/Accra/);
    // Never in Wrapped.
    expect((await say(u, "my week wrapped")).text).not.toMatch(/Dad|brave/);
  });

  it("keeps a remembered birthday, and calm mode moves the day's message into the brief", async () => {
    const u = await person("Obi", { calm: true });
    const t = DateTime.utc();
    const r = await say(u, `remembrance: ${t.day} ${t.toFormat("LLLL")}, Grandma's birthday`);
    expect(r.text).toMatch(/^I've kept Grandma's birthday, \d+ \w+, quietly\./);
    expect(await brief(u)).not.toMatch(/Grandma/);
    await tap(u, r.buttons![0].data);
    expect(await brief(u)).toMatch(/Today is Grandma's birthday\. Thinking of you\. Go gently\./);
    expect((await say(u, "no message for Grandma")).text).toMatch(/won't send anything/);
    expect(await brief(u)).not.toMatch(/Grandma/);
  });
});

describe("7. caregiver mode", () => {
  it("says plainly when text messages aren't switched on", async () => {
    const u = await person("Pemi");
    const r = await say(u, "remind Mum to take her blood pressure pill at 8am by text on +44 7700 900123");
    expect(r.text).toMatch(/text messages aren't switched on here yet/);
    expect(await db.query(`SELECT 1 FROM well_care WHERE user_id=$1`, [u.id])).toHaveLength(0);
  });

  it("asks for the number, needs a yes from the person and then from Mum, texts daily, and alerts quietly after two hours", async () => {
    Object.assign(config, { smsProvider: "httpsms", smsGatewayKey: "k", smsGatewayFrom: "+2348000000000" });
    const sms = mockFetch([[/api\.httpsms\.com\/v1\/messages\/send/, () => json({ ok: true })]]);
    const u = await person("Sage");
    const ask = await say(u, "remind Mum to take her blood pressure pill at 8am by text");
    expect(ask.text).toBe("What's Mum's mobile number? Include the country code, like +44 7700 900123.");
    const echo = await say(u, "+44 7700 900123");
    expect(echo.text).toMatch(/^This texts Mum at \+447700900123 once, to ask if they're happy to get a daily text at 08:00 their time \(London\): "Time to take your blood pressure pill\./);
    expect(echo.text).toMatch(/Go ahead\? This waits ten minutes for a yes\./);
    expect(sms).toHaveLength(0);
    const sent = await tap(u, echo.buttons![0].data);
    expect(sent.text).toBe("Sent. Nothing starts until Mum replies YES, and I'll tell you either way.");
    expect(sms[0].body).toMatchObject({ to: "+447700900123" });
    expect(sms[0].body.content).toMatch(/^Hi Mum, this is lifeline, a reminder service\. Sage would like me to text you each day at 08:00: "Time to take your blood pressure pill\." Reply YES to agree/);
    expect(await jobs(u, "well_care_dose")).toHaveLength(0); // nothing until she agrees

    expect(await handleCareSms(db, "+44 7700 900123", "hello?")).toBeNull();
    expect(await handleCareSms(db, "+15550001111", "YES")).toBeNull();
    expect(await handleCareSms(db, "+447700900123", "Yes")).toBe("Thank you. I'll text you at 08:00 each day. Reply TAKEN when it's done, or STOP to end these any time.");
    let { to } = await runMine(new Date(Date.now() + 60_000));
    expect(to(u)[0].text).toMatch(/^Mum said yes\./);

    const [dose] = await jobs(u, "well_care_dose");
    await dueNow(dose.id);
    ({ to } = await runMine(new Date(Date.now() + 3 * 3_600_000)));
    expect(sms.at(-1)!.body.content).toBe("Hi Mum, time to take your blood pressure pill. Reply TAKEN when you have.");
    expect(to(u)).toEqual([expect.objectContaining({ text: "No reply from Mum yet about the 08:00 reminder (take their blood pressure pill). You might want to check in." })]);

    // This time she replies, and no alert comes.
    await dueNow(dose.id);
    await db.query(`UPDATE jobs SET active=false WHERE kind='well_care_check'`);
    await runMine(new Date(Date.now() + 60_000));
    expect(await handleCareSms(db, "+447700900123", "taken")).toBe("Thank you, noted.");
    ({ to } = await runMine(new Date(Date.now() + 3 * 3_600_000)));
    expect(to(u).filter((m) => /No reply/.test(m.text))).toHaveLength(0);

    expect(await handleCareSms(db, "+447700900123", "STOP")).toBe("Stopped. You won't get any more texts from lifeline.");
    ({ to } = await runMine(new Date(Date.now() + 60_000)));
    expect(to(u)[0].text).toBe("Mum asked to stop the daily texts, so they've stopped.");
    expect(await jobs(u, "well_care_dose")).toHaveLength(0);
  });
});

describe("8. the dreaded-task breaker", () => {
  it("splits a task into five-minute steps without a model, one at a time, with a 25-minute check-in and a quiet cheer", async () => {
    const u = await person("Rami");
    const r = await say(u, "help me do my taxes");
    expect(r.text).toMatch(/^Your taxes, in 6 small steps of about five minutes\. Just this one for now:\n\n\*\*Step 1 of 6\*\*\nFind last year's papers/);
    expect(r.buttons!.map((b) => b.label)).toEqual(["Done", "Skip", "Check in at 25 min"]);
    const id = r.buttons![0].data.split(":")[3];
    expect((await tap(u, `wb:t:c:${id}`)).text).toMatch(/^I'll check in at \d\d:\d\d\. Keep going with this one\./);
    const { to } = await runMine(new Date(Date.now() + 30 * 60_000));
    expect(to(u)[0].text).toBe("25 minutes. How's your taxes going? You're on step 1 of 6.");
    let last = await tap(u, `wb:t:d:${id}`);
    expect(last.text).toMatch(/^Nice\. Next:\n\n\*\*Step 2 of 6\*\*/);
    for (let i = 0; i < 5; i++) last = await tap(u, `wb:t:d:${id}`);
    expect(last.text).toBe("That's all of it. Your taxes, done. That was the hard part, and you did it.");
    expect(last.sticker).toBe("cheers");
    expect((await tap(u, `wb:t:d:${id}`)).text).toBe("That one's already finished.");
  });

  it("uses the model's steps when there is one, and no sticker in calm mode", async () => {
    Object.assign(config, { openaiCompatKey: "gsk_test", openaiCompatBaseUrl: "https://api.groq.com/openai/v1", modelProvider: "openai" });
    mockFetch([[/chat\/completions$/, () => json({ choices: [{ message: { content: JSON.stringify({ steps: ["Fill one bin bag with rubbish.", "Load the dishwasher.", "Wipe the counter by the cooker."] }) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } })]]);
    const u = await person("Sade", { calm: true });
    const r = await say(u, "I keep putting off cleaning the kitchen");
    expect(r.text).toMatch(/^Cleaning the kitchen, in 3 small steps.*\nFill one bin bag with rubbish\.$/s);
    const id = r.buttons![0].data.split(":")[3];
    await tap(u, `wb:t:s:${id}`);
    await tap(u, `wb:t:d:${id}`);
    const end = await tap(u, `wb:t:d:${id}`);
    expect(end.text).toBe("That's the list. You got through it; the skipped bits can wait for another day.");
    expect(end.sticker).toBeUndefined();
  });
});

describe("9. time capsule", () => {
  it("seals a letter, never shows it early, and delivers it once, untouched", async () => {
    const u = await person("Tari");
    const body = "Be proud of how far you've come — and *don't* forget the band.";
    const r = await say(u, `a letter to myself in 6 months: ${body}`);
    expect(r.text).toMatch(/^Sealed\. I'll send it to you on \w{3} \d+ \w+ \d{4}, exactly as you wrote it, and not before\./);
    expect((await say(u, "my time capsules")).text).toMatch(/^One sealed letter, arriving .*What's inside stays sealed until then\.$/);
    expect((await say(u, "my time capsules")).text).not.toContain("band");
    const [j] = await jobs(u, "well_capsule");
    expect(new Date(j.run_at).getTime()).toBeGreaterThan(Date.now() + 150 * 86_400_000);
    await dueNow(j.id);
    const { to } = await runMine(new Date(Date.now() + 60_000));
    expect(to(u)).toHaveLength(1);
    expect(to(u)[0].text).toContain(`\`\`\`\n${body}\n\`\`\``);
    expect(to(u)[0].text).toMatch(/^A letter from you, written on \d+ \w+ \d{4}:/);
    await dueNow(j.id);
    expect((await runMine(new Date(Date.now() + 60_000))).to(u)).toHaveLength(0);
  });

  it("asks for a birthday it doesn't know", async () => {
    const u = await person("Uche");
    expect((await say(u, "time capsule for my birthday: hi you, happy birthday")).text).toBe("When's your birthday? I'll deliver it then.");
    expect((await say(u, "3 May")).text).toMatch(/^Sealed\. I'll send it to you on \w{3} 3 May \d{4}/);
  });
});

describe("11. life patterns", () => {
  it("is opt-in, finds a plain pattern that holds for weeks, and says it's not a cause, on Mondays only", async () => {
    const u = await person("Vera", { currency: "USD" });
    const now = DateTime.fromISO("2026-11-02T09:00:00Z"); // a Monday
    for (let d = 1; d <= 36; d++) {
      const day = now.minus({ days: d });
      const big = d % 2 === 0;
      await db.query(`INSERT INTO measures (user_id, name, value, unit, at) VALUES ($1,'sleep',$2,'hours',$3)`, [u.id, big ? 7.25 : 8, day.set({ hour: 7 }).toJSDate()]);
      await db.query(`INSERT INTO spend (user_id, amount, currency, category, spent_at) VALUES ($1,$2,'USD','food',$3)`, [u.id, big ? 100 : 10, day.set({ hour: 13 }).toJSDate()]);
    }
    expect(await brief(u, now.toJSDate())).not.toMatch(/pattern/i);
    const p = await patterns(db, await fresh(u), now.toJSDate());
    expect(p[0]).toBe("You slept about 45 minutes less on days you spent more than usual.");
    const r = await say(u, "show me patterns", now.toJSDate());
    expect(r.text).toMatch(/^Here's one that holds right now: You slept about 45 minutes less on days you spent more than usual\. A pattern, not a cause\./);
    expect(await brief(u, now.toJSDate())).toMatch(/A pattern from the last few weeks: You slept about 45 minutes less on days you spent more than usual\. A pattern, not a cause\./);
    expect(await brief(u, now.plus({ days: 1 }).toJSDate())).not.toMatch(/A pattern/);
    expect((await say(u, "stop the patterns", now.toJSDate())).text).toBe("No more patterns.");
  });
});

describe("12. accountability buddies", () => {
  it("asks first, pairs on yes, shows each other's check-ins kindly, cheers, and ends", async () => {
    const ana = await person("Ana Silva");
    const tolu = await person("Tolu Bello");
    expect((await say(tolu, "my buddy name is tolu")).text).toMatch(/^You're @tolu here\./);
    expect((await say(ana, "buddy up on reading with @nobody")).text).toMatch(/^I can't find @nobody here\./);
    const echo = await say(ana, "buddy up on running with @tolu");
    expect(echo.text).toMatch(/^This sends @tolu a request to be running buddies\..*nothing else\. Either of you can end it any time\./s);
    expect((await tap(ana, echo.buttons![0].data)).text).toBe("Sent. I'll tell you when Tolu answers.");
    let { to } = await runMine(new Date(Date.now() + 60_000));
    const req = to(tolu)[0];
    expect(req.text).toMatch(/^Ana would like to be running buddies with you\./);
    expect(await brief(tolu)).toMatch(/Ana asked to be running buddies\. Say "yes to Ana's buddy request"/);
    expect((await tap(tolu, req.buttons![0].data)).text).toMatch(/^You're running buddies with Ana\./);
    ({ to } = await runMine(new Date(Date.now() + 60_000)));
    expect(to(ana)[0].text).toMatch(/^Tolu said yes\./);

    await say(tolu, "did running yesterday");
    expect(await brief(ana)).toMatch(/Running with Tolu: Tolu checked in yesterday\. Rest days count too\./);
    const tb = await brief(tolu);
    expect(tb).toMatch(/Running with Ana: Ana took a rest day yesterday\. Say "cheer Ana" to send a kind word\./);
    expect(tb).not.toMatch(/missed|failed|broke/i);
    expect((await say(tolu, "cheer Ana")).text).toBe("Sent your cheer to Ana.");
    ({ to } = await runMine(new Date(Date.now() + 60_000)));
    expect(to(ana)[0].text).toBe("Tolu is cheering you on with running. Rest days count too.");
    expect((await say(ana, "end running buddies")).text).toMatch(/^Ended\./);
    expect(await brief(ana)).not.toMatch(/Running with/);
  });
});

describe("13. language drops", () => {
  it("is opt-in, works without a model for common languages, sits in the brief or comes as a ping, and stops", async () => {
    const u = await person("Wale");
    expect(await brief(u)).not.toMatch(/Spanish/);
    expect((await say(u, "teach me Spanish, 2 minutes a day")).text).toMatch(/^Spanish, two minutes a day, in your morning brief/);
    expect(await brief(u)).not.toMatch(/Spanish today/); // only looking doesn't make the day's lesson
    const b = await buildDigest(db, await fresh(u), new Date()); // the real morning note does
    expect(b).toMatch(/Spanish today: hola \(hello\), gracias \(thank you\), por favor \(please\)\./);
    expect(b).toMatch(/Try: "Hola, un café, por favor\." It means: Hello, a coffee, please\./);
    expect(await brief(u)).toBe(b); // the same lesson all day
    expect((await say(u, "teach me Swahili")).text).toMatch(/^I can only teach Spanish, French, Portuguese, German and Italian/);
    expect((await say(u, "stop the lessons")).text).toMatch(/^No more Spanish lessons/);
    expect(await brief(u)).not.toMatch(/Spanish today/);

    const p = await person("Xena");
    expect((await say(p, "teach me French by ping at 6pm")).text).toMatch(/^French, two minutes a day, as a ping at 18:00/);
    const { to } = await runMine();
    expect(to(p)[0].text).toMatch(/^French today: bonjour \(hello\)/);
    expect(to(p)[0].text).toMatch(/Say "stop the lessons" any time to stop these/);
    expect(await brief(p)).not.toMatch(/French today/);
    await setPrefs(p, { calm: true });
    expect((await runMine(new Date(Date.now() + 4 * 86_400_000))).to(p)).toHaveLength(0);
  });
});

describe("privacy", () => {
  it("keeps sensitive things out of the brief and Wrapped, and deletes them on request", async () => {
    const u = await person("Yemi");
    await say(u, "log symptom: migraine, severe");
    await say(u, "good things: tea with Gran");
    await say(u, "I quit vaping today");
    await say(u, "Grandpa passed on 9 May 2020");
    await tap(u, "wb:m:2");
    const b = await brief(u);
    expect(b).not.toMatch(/migraine|tea with Gran|vaping|Grandpa|mood/i);
    expect((await say(u, "my week wrapped")).text).not.toMatch(/migraine|Gran|vaping|Grandpa/i);
    const del = await say(u, "delete my symptom log");
    expect(del.text).toMatch(/^This deletes your symptom log\. It can't be undone\./);
    expect((await tap(u, del.buttons![0].data)).text).toBe("Deleted. Your symptom log is gone.");
    expect(await db.query(`SELECT 1 FROM well_symptoms WHERE user_id=$1`, [u.id])).toHaveLength(0);
  });
});
