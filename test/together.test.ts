/** Groups, guest calls, the Mini App sign-in, kinder streaks and money said in any currency. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import "../src/telegram/group.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { ensureUser, handleMessage } from "../src/core/handler.js";
import { dueBirthdays, groupActive, groupButton, groupCommand, guestAnswer, parseDayMonth, wordsToCommand, type GroupMsg } from "../src/telegram/group.js";
import { signInitData, verifyInitData } from "../src/core/webapp.js";
import { streakOf } from "../src/modules/life.js";
import { parseMoney } from "../src/core/time.js";
import { createWeb } from "../src/web/server.js";

let db: Db;
const saved = { ...config };
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());
afterEach(() => { Object.assign(config, saved); vi.unstubAllGlobals(); });

const CHAT = -100123;
const ana = { id: 9001, name: "Ana Silva", username: "ana" };
const msg = (cmd: string, args: string, extra: Partial<GroupMsg> = {}): GroupMsg => ({ chatId: CHAT, title: "Flat 4", from: ana, cmd, args, mentions: [], ...extra });

describe("groups", () => {
  beforeAll(async () => {
    const u = await ensureUser(db, "telegram", String(ana.id), "Ana Silva");
    await db.query(`UPDATE users SET tz='Europe/Lisbon', prefs = prefs || '{"country":"PT"}'::jsonb WHERE id=$1`, [u.id]);
  });

  it("only switches on for someone in the circle", async () => {
    expect(await groupActive(db, -555, "Strangers", 777777)).toBe(false);
    expect(await groupActive(db, CHAT, "Flat 4", ana.id)).toBe(true);
    const g = await db.one<{ currency: string; tz: string }>(`SELECT currency, tz FROM group_chats WHERE chat_id=$1`, [CHAT]);
    expect(g).toMatchObject({ currency: "EUR", tz: "Europe/Lisbon" });
  });

  it("splits a bill, and people mark themselves paid", async () => {
    const out = await groupCommand(db, msg("split", "120 dinner @ben @cy", { mentions: [{ name: "ben", username: "ben" }, { name: "cy", username: "cy" }] }));
    expect(out!.text).toMatch(/Dinner, €120/);
    expect(out!.text).toMatch(/€40 each/);
    expect(out!.text).toMatch(/@ben: owes €40/);
    expect(out!.text).toMatch(/@ana: paid/);
    const pay = out!.buttons![0][0].data;
    const ben = await groupButton(db, CHAT, { id: 42, name: "Ben", username: "Ben" }, pay);
    expect(ben.toast).toMatch(/paid/i);
    expect(ben.edit!.text).toMatch(/@ben: paid/);
    const stranger = await groupButton(db, CHAT, { id: 43, name: "Dee", username: "dee" }, pay);
    expect(stranger.toast).toMatch(/not in this split/);
    const notPayer = await groupButton(db, CHAT, { id: 42, name: "Ben", username: "ben" }, out!.buttons![1][0].data);
    expect(notPayer.toast).toMatch(/Only whoever paid/);
    const tab = await groupCommand(db, msg("tab", ""));
    expect(tab!.text).toMatch(/@cy owes @ana €40 for dinner/);
    const all = await groupButton(db, CHAT, { id: ana.id, name: "Ana", username: "ana" }, out!.buttons![1][0].data);
    expect(all.edit!.text).toMatch(/All square/);
    expect((await groupCommand(db, msg("tab", "")))!.text).toMatch(/All square/);
  });

  it("splits between a number of people, in any currency", async () => {
    const out = await groupCommand(db, msg("split", "₹900 cab between 3"));
    expect(out!.text).toMatch(/Cab, ₹900/);
    expect(out!.text).toMatch(/₹300 each/);
  });

  it("asks for what's missing only to the person who asked", async () => {
    const out = await groupCommand(db, msg("split", "dinner"));
    expect(out!.ephemeral).toBe(true);
    expect((await groupCommand(db, msg("split", "50 lunch")))!.text).toMatch(/Who's in/);
  });

  it("keeps a shared list", async () => {
    const added = await groupCommand(db, msg("list", "rice, eggs and oil"));
    expect(added!.text).toMatch(/Added 3 things/);
    const tick = added!.buttons!.find((r) => r[0].label === "Got eggs")![0].data;
    const r = await groupButton(db, CHAT, ana, tick);
    expect(r.edit!.text).toMatch(/eggs \(got it\)/);
    const cleared = await groupButton(db, CHAT, ana, "gr:clear");
    expect(cleared.edit!.text).not.toMatch(/eggs/);
  });

  it("makes polls for a time and for trivia", async () => {
    const w = await groupCommand(db, msg("when", "movie night?"), new Date("2026-10-29T10:00:00Z"));
    expect(w!.poll!.question).toBe("When works for movie night?");
    expect(w!.poll!.options[0]).toBe("Tonight");
    expect(w!.poll!.options.at(-1)).toBe("None of these work");
    expect(w!.poll!.multiple).toBe(true);
    const t = await groupCommand(db, msg("trivia", ""));
    expect(t!.poll!.correct).toBeTypeOf("number");
  });

  it("says happy birthday once, on the day, in the group's morning", async () => {
    expect(parseDayMonth("12 March")).toEqual({ month: 3, day: 12 });
    expect(parseDayMonth("March 12th")).toEqual({ month: 3, day: 12 });
    expect(parseDayMonth("31/02")).toBeNull();
    const r = await groupCommand(db, msg("birthday", "30 October"));
    expect(r!.text).toMatch(/30 October/);
    expect(await dueBirthdays(db, new Date("2026-10-30T07:00:00Z"))).toEqual([]); // 08:00 in Lisbon
    expect(await dueBirthdays(db, new Date("2026-10-30T09:30:00Z"))).toEqual([{ chatId: CHAT, text: "Happy birthday, Ana. Have a good one." }]);
    expect(await dueBirthdays(db, new Date("2026-10-30T12:00:00Z"))).toEqual([]);
  });

  it("reads plain words after a mention", () => {
    expect(wordsToCommand("split 60 pizza with @ben")).toEqual({ cmd: "split", args: "60 pizza with @ben" });
    expect(wordsToCommand("who owes")).toEqual({ cmd: "tab", args: "" });
    expect(wordsToCommand("how are you")).toBeNull();
  });

  it("a guest call works out a split, and never answers from anyone's records", async () => {
    expect(await guestAnswer(db, { id: 5, name: "Zed" }, "@lifeline_bot split 90 between 3", "lifeline_bot")).toBe("90 between 3 is 30 each.");
    expect(await guestAnswer(db, { id: 5, name: "Zed" }, "@lifeline_bot what's on my calendar", "lifeline_bot")).toMatch(/Message @lifeline_bot to start/);
  });
});

describe("Mini App sign-in", () => {
  it("accepts Telegram's signed launch data and nothing else", async () => {
    const token = "123:abc";
    const now = Date.now();
    const good = signInitData({ auth_date: String(Math.floor(now / 1000)), query_id: "q1", user: JSON.stringify({ id: 7007, first_name: "Kofi" }) }, token);
    expect(verifyInitData(good, token, now)?.id).toBe(7007);
    expect(verifyInitData(good, "123:other", now)).toBeNull();
    expect(verifyInitData(good.replace("Kofi", "Kofe"), token, now)).toBeNull();
    expect(verifyInitData(good, token, now + 2 * 86_400_000)).toBeNull();
    expect(verifyInitData("", token, now)).toBeNull();
  });

  it("signs in on the web server and works with the token alone", async () => {
    config.telegramToken = "123:abc";
    const web = createWeb(db, "lifeline_bot");
    const initData = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 7008, first_name: "Mei" }) }, "123:abc");
    const r = await web.request("/auth/webapp", { method: "POST", body: JSON.stringify({ initData }), headers: { "content-type": "application/json" } });
    const j = await r.json();
    expect(j.ok).toBe(true);
    const me = await (await web.request("/api/me", { headers: { authorization: `Bearer ${j.token}` } })).json();
    expect(me.name).toBe("Mei");
    const bad = await web.request("/auth/webapp", { method: "POST", body: JSON.stringify({ initData: initData.replace("Mei", "Mia") }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(401);
    // Another account's cookie in the same browser never wins over this tab's own token.
    const other = signInitData({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 7009, first_name: "Ola" }) }, "123:abc");
    const o = await (await web.request("/auth/webapp", { method: "POST", body: JSON.stringify({ initData: other }), headers: { "content-type": "application/json" } })).json();
    const mixed = await (await web.request("/api/me", { headers: { authorization: `Bearer ${j.token}`, cookie: `ll_session=${o.token}` } })).json();
    expect(mixed.name).toBe("Mei");
  });
});

describe("kinder streaks", () => {
  it("lets one rest day a week keep the run going", () => {
    expect(streakOf(["2026-10-29", "2026-10-28", "2026-10-27"], "2026-10-29")).toEqual({ run: 3, best: 3, restYesterday: false });
    expect(streakOf(["2026-10-29", "2026-10-27", "2026-10-26"], "2026-10-29")).toMatchObject({ run: 3, restYesterday: true });
    expect(streakOf(["2026-10-29", "2026-10-27", "2026-10-25", "2026-10-24"], "2026-10-29").run).toBe(2);
    expect(streakOf(["2026-10-29", "2026-10-20", "2026-10-19", "2026-10-18", "2026-10-17"], "2026-10-29")).toMatchObject({ run: 1, best: 4 });
  });

  it("says so kindly in the reply", async () => {
    const u = await ensureUser(db, "telegram", "8101", "Lena");
    const h = await db.one<{ id: number }>(`INSERT INTO habits (user_id, name, target_per_week) VALUES ($1,'yoga',7) RETURNING id`, [u.id]);
    const { localDay } = await import("../src/core/time.js");
    const today = localDay(new Date(), u.tz);
    const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    for (const n of [2, 3, 4]) await db.query(`INSERT INTO habit_checkins (habit_id, day) VALUES ($1,$2)`, [h!.id, day(n)]);
    const r = await handleMessage(db, u, "did yoga", { channel: "telegram" });
    expect(r.text).toMatch(/4 days running/);
    expect(r.text).toMatch(/rest day/);
  });
});

describe("money in any currency", () => {
  it("reads signs and words from around the world", () => {
    expect(parseMoney("2500 INR")).toEqual({ amount: 2500, currency: "INR" });
    expect(parseMoney("R$ 90")).toEqual({ amount: 90, currency: "BRL" });
    expect(parseMoney("¥3000")).toEqual({ amount: 3000, currency: "JPY" });
    expect(parseMoney("150 aed")).toEqual({ amount: 150, currency: "AED" });
    expect(parseMoney("80k naira")).toEqual({ amount: 80000, currency: "NGN" });
    expect(parseMoney("3 eggs")).toBeNull();
  });
});

describe("the core, after the features came in", () => {
  it("never stores a pasted key, token, card number or seed phrase", async () => {
    const { redact } = await import("../src/core/redact.js");
    expect(redact("my stripe key is sk_" + "live_51Habcdefghijklmnopqrstuv")).toBe("my stripe key is [hidden key]");
    expect(redact("card 4242 4242 4242 4242 exp 12/28")).toBe("card [hidden card number] exp 12/28");
    expect(redact("abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe("[hidden seed phrase]");
    // A few ordinary words in front don't let it through.
    expect(redact("here they are abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe("here they are [hidden seed phrase]");
    expect(redact("keep this safe abandon ability able about above absent absorb abstract absurd abuse access accident thanks")).toBe("keep this [hidden seed phrase]"); // neighbouring ordinary words may go too; better than keeping the phrase
    expect(redact("explain tx 0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060")).toMatch(/0x5c50/);
    expect(redact("0x5c504ed432cb51138bcf09aa5e8a410dd4a1e204ef84bfed1be16dfba1b22060")).toBe("[hidden key]");
    expect(redact("the wifi password is in the drawer")).toBe("the wifi password is in the drawer");
    expect(redact("my password is hunter22")).toBe("my password is [hidden]");
    expect(redact("I need to buy rice, eggs and bread for the party on Saturday")).toBe("I need to buy rice, eggs and bread for the party on Saturday");
    const u = await ensureUser(db, "telegram", "8201", "Ivo");
    await handleMessage(db, u, "my github token is ghp_abcdefghijklmnopqrstuvwxyz0123", { channel: "telegram" });
    const saved = await db.query<{ content: string }>(`SELECT content FROM messages WHERE user_id=$1 AND role='user'`, [u.id]);
    expect(saved.map((r) => r.content).join(" ")).not.toMatch(/ghp_/);
  });

  it("answers someone in crisis first, even mid-question", async () => {
    const u = await ensureUser(db, "telegram", "8202", "Noor");
    await handleMessage(db, u, "remind me tomorrow", { channel: "telegram" }); // opens a follow-up question
    const r = await handleMessage(db, u, "note: I want to die", { channel: "telegram" });
    expect(r.text).toMatch(/findahelpline\.com/);
    const film = await handleMessage(db, u, "watched suicide squad last night", { channel: "telegram" });
    expect(film.text).not.toMatch(/findahelpline/);
  });

  it("checks a forwarded message that smells like a scam", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const u = await ensureUser(db, "telegram", "8203", "Ama");
    const r = await handleMessage(db, u, "Dear customer, you have received NGN 250,000. Click https://gtbank-alerts.top to confirm and send back the excess", { channel: "telegram", forwarded: true });
    expect(r.text).toMatch(/Red flags/);
  });

  it("reads a request inside a polite question, and still answers real questions about itself", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    const u = await ensureUser(db, "telegram", "8204", "Rui");
    const q = await handleMessage(db, u, "can you track my meds?", { channel: "telegram" });
    expect(q.text).toMatch(/medication|dose|meds/i);
    const link = await handleMessage(db, u, "can you check this link https://bit.ly/abc", { channel: "telegram" });
    expect(link.text).toMatch(/shortened/i);
  });
});

describe("after the review", () => {
  it("leaves everyday sentences alone", async () => {
    const { parseByRules } = await import("../src/intent/rules.js");
    const wrong: Record<string, RegExp> = {
      "I slipped on the ice": /^quit\./, "my phone died on 3 March": /^remembrance\./, "the deadline passed on 4 June": /^remembrance\./,
      "the door unlocks on friday": /^claim\./, "my insurance claim closes on friday": /^claim\./, "I claimed my bag": /^claim\./,
      "I rotated the tyres": /^rotation\./, "rotate the tyres every 6 months": /^rotation\./, "watch tv/netflix": /^github\./,
      "stop watching tv": /^tech\./, "stop watching me": /^tech\./, "I saw Dune": /^touch\./, "I visited Paris": /^touch\./,
      "no contact with the client yet": /^quit\./, "I stopped caring": /^quit\./, "I have stopped eating": /^quit\./,
      "is it safe to take ibuprofen with paracetamol": /^scam\./, "I'm going to die laughing": /^crisis\./,
    };
    for (const [s, re] of Object.entries(wrong)) expect(parseByRules(s)?.action ?? "", s).not.toMatch(re);
    expect(parseByRules("call mum every morning")).toMatchObject({ action: "touch.add", args: { every_days: 1 } });
    expect(parseByRules("remind me to call the suicide prevention line for my friend")?.action).toBe("reminder.create");
  });

  it("a safety contact by text can say no, and the person is told", async () => {
    const { contactReply } = await import("../src/modules/features/safety/checkin.js");
    const u = await ensureUser(db, "telegram", "8301", "Femi");
    await db.query(`INSERT INTO safety_contacts (user_id, kind, target, label, status) VALUES ($1,'phone','+447700900123','+447700900123','asked')`, [u.id]);
    expect(await contactReply(db, "sms", "+44 7700 900123", "maybe")).toBeNull();
    expect(await contactReply(db, "sms", "+44 7700 900123", "STOP")).toMatch(/You won't hear from lifeline/);
    expect((await db.one<{ status: string }>(`SELECT status FROM safety_contacts WHERE user_id=$1`, [u.id]))!.status).toBe("declined");
  });
});

describe("the last two open items", () => {
  it("refuses a name that resolves to a private address at connect time (DNS rebinding)", async () => {
    const { safeLookup } = await import("../src/core/safefetch.js");
    const err = await new Promise<any>((done) => safeLookup("localhost", {}, (e: any) => done(e)));
    expect(err?.code).toBe("EBLOCKEDADDR");
  });

  it("works out the other person's clock from their number or city", async () => {
    const { zoneForPhone } = await import("../src/core/phonezone.js");
    const { theirZone } = await import("../src/modules/features/wellbeing/people.js");
    expect(zoneForPhone("+234 803 123 4567")).toEqual({ country: "NG", tz: "Africa/Lagos" });
    expect(zoneForPhone("+44 7700 900123")).toEqual({ country: "GB", tz: "Europe/London" });
    expect(zoneForPhone("+1 416 555 0100")).toEqual({ country: "US", tz: null });
    const owner = { id: 1, tz: "Europe/London", prefs: { country: "GB" } } as any;
    expect(await theirZone(owner, "+2348031234567")).toBe("Africa/Lagos");
    expect(await theirZone(owner, "+447700900123")).toBe("Europe/London");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [{ name: "Toronto", country_code: "CA", country: "Canada", timezone: "America/Toronto", latitude: 43.7, longitude: -79.4 }] }), { headers: { "content-type": "application/json" } })));
    expect(await theirZone(owner, "+14165550100", "Toronto")).toBe("America/Toronto");
  });
});

describe("the new menu, the app and plans", () => {
  it("signs card links, refuses tampered ones, and draws a card", async () => {
    const { cardUrl, cardOk, cardPng } = await import("../src/web/extras.js");
    config.publicUrl = "https://lifeline.example.com"; config.telegramToken = "123:abc";
    const u = await ensureUser(db, "telegram", "8401", "Ada Okafor");
    const url = new URL(cardUrl(u.id, "home")!);
    const [uid, kind, exp, sig, v] = [Number(url.searchParams.get("u")), "home", Number(url.searchParams.get("e")), url.searchParams.get("s")!, url.searchParams.get("v")!];
    expect(cardOk(uid, kind, exp, sig, new Date(), v)).toBe(true);
    expect(cardOk(uid, kind, exp, sig, new Date(), "zz")).toBe(false); // the minute is signed too
    expect(cardOk(uid + 1, kind, exp, sig, new Date(), v)).toBe(false);
    expect(cardOk(uid, "money", exp, sig, new Date(), v)).toBe(false);
    expect(cardOk(uid, kind, exp, sig, new Date((exp + 10) * 1000), v)).toBe(false);
    config.telegramToken = "";
    expect(cardOk(uid, kind, exp, sig, new Date(), v)).toBe(false); // no bot token, nothing is signed
    config.telegramToken = "123:abc";
    config.publicUrl = "http://insecure.example.com";
    expect(cardUrl(u.id, "home")).toBeNull();
    const png = await cardPng(db, u.id, "home");
    expect(png!.subarray(1, 4).toString()).toBe("PNG");
    const page = await cardPng(db, u.id, "money");
    expect(page!.length).toBeGreaterThan(1000);
  }, 30_000);

  it("knows it has a website and an app", async () => {
    config.webUrl = "https://lifeline.example.com";
    const u = await ensureUser(db, "telegram", "8402", "Bo");
    const r = await handleMessage(db, u, "do you have a website?", { channel: "telegram" });
    expect(r.text).toMatch(/lifeline\.example\.com/);
    expect(r.buttons?.[0].data).toBe("webapp:https://lifeline.example.com/");
  });

  it("only suggests new hackathons to people who asked", async () => {
    const { wantsHackathonNews } = await import("../src/modules/hackathons.js");
    expect(wantsHackathonNews({ prefs: {} })).toBe(false);
    expect(wantsHackathonNews({ prefs: { tags: ["ai"] } })).toBe(true);
    expect(wantsHackathonNews({ prefs: { tags: ["ai"], hackathonNews: false } })).toBe(false);
    const u = await ensureUser(db, "telegram", "8403", "Cy");
    expect((await handleMessage(db, u, "send me new hackathons", { channel: "telegram" })).text).toMatch(/morning note/);
  });

  it("reads the anchors of a trip, and a plan page renders and comes down", async () => {
    const { readAnchors } = await import("../src/modules/planner.js");
    expect(readAnchors("February 2027, from Abuja Nigeria. Hike and Travel, food and lounge")).toMatchObject({ when: "February 2027", from: "Abuja Nigeria", style: expect.stringMatching(/Hike and Travel/) });
    expect(readAnchors("next month from Berlin")).toMatchObject({ when: "next month", from: "Berlin" });
    const { planHtml } = await import("../src/web/plans.js");
    const html = planHtml("abcdefghijklmnop", { title: "Liechtenstein in February", destination: "Liechtenstein", when: "February 2027", from: "Abuja", style: null, clock: "Apply for a Schengen visa first.", summary: "", visa: "Schengen visa via the Swiss embassy.", gettingThere: "", budget: "", stay: [{ area: "Triesenberg", why: "Mountain views." }], days: [{ title: "Vaduz", items: ["Castle walk"] }], food: [], tips: [], packing: ["Boots"], questions: [], sources: [{ title: "Swiss embassy", url: "https://example.com/<x>" }], passport: "Nigeria", made: new Date().toISOString() }, false);
    expect(html).toMatch(/Start here\.<\/b> Apply for a Schengen visa first\./);
    expect(html).toMatch(/Visa, for a Nigeria passport/);
    expect(html).not.toMatch(/<x>/);
    const u = await ensureUser(db, "telegram", "8404", "Dee");
    await db.query(`INSERT INTO plans (id, user_id, title, data) VALUES ('abcdefghijklmnop',$1,'Liechtenstein in February','{"destination":"Liechtenstein"}')`, [u.id]);
    const web = createWeb(db, "lifeline_bot");
    expect((await web.request("/plan/abcdefghijklmnop")).status).toBe(200);
    expect((await handleMessage(db, u, "delete my Liechtenstein plan", { channel: "telegram" })).text).toMatch(/Taken down/);
    expect((await web.request("/plan/abcdefghijklmnop")).status).toBe(404);
  });

  it("without a model, a plan request starts nothing it can't finish", async () => {
    const u = await ensureUser(db, "telegram", "8405", "Eli");
    const ask = await handleMessage(db, u, "help me plan a trip to Liechtenstein", { channel: "telegram" });
    expect(ask.text).toMatch(/when are you thinking, and where are you travelling from/);
    const r = await handleMessage(db, u, "February 2027, from Abuja", { channel: "telegram" });
    expect(r.text).toMatch(/can't research a full plan right now|I'm going to Liechtenstein/);
  });
});

describe("after the second review", () => {
  it("keeps adding Telegram to an account separate from signing in", async () => {
    const { startWebLogin, answerWebLogin, pollWebLogin, webLoginPurpose } = await import("../src/core/weblogin.js");
    const link = startWebLogin({ forUserId: 5, forName: "Ada" });
    expect(webLoginPurpose(link)).toEqual({ purpose: "link", forName: "Ada" });
    answerWebLogin(link, 99, true);
    expect(pollWebLogin(link).state).toBe("expired"); // a link request can't sign a browser in
    const link2 = startWebLogin({ forUserId: 5, forName: "Ada" });
    answerWebLogin(link2, 99, true);
    expect(pollWebLogin(link2, { purpose: "link", forUserId: 6 }).state).toBe("expired"); // only for the account that asked
    const link3 = startWebLogin({ forUserId: 5, forName: "Ada" });
    answerWebLogin(link3, 99, true);
    expect(pollWebLogin(link3, { purpose: "link", forUserId: 5 })).toEqual({ state: "approved", userId: 99 });
    const signin = startWebLogin();
    answerWebLogin(signin, 98, true);
    expect(pollWebLogin(signin, { purpose: "link", forUserId: 5 }).state).toBe("expired");
  });

  it("only ever posts notifications to the real push services", async () => {
    const { cleanSubscription } = await import("../src/core/webpush.js");
    const keys = { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" };
    expect(cleanSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys })).not.toBeNull();
    expect(cleanSubscription({ endpoint: "https://web.push.apple.com/abc", keys })).not.toBeNull();
    expect(cleanSubscription({ endpoint: "https://internal.example.com/hook", keys })).toBeNull();
    expect(cleanSubscription({ endpoint: "https://169.254.169.254/latest", keys })).toBeNull();
  });

  it("reads 'interest rates' as news, not hackathon interests", async () => {
    const { parseByRules } = await import("../src/intent/rules.js");
    expect(parseByRules("interest rates are up")?.action).not.toBe("hackathon.set_interests");
    expect(parseByRules("interests: devtools, payments")?.action).toBe("hackathon.set_interests");
    for (const s of ["track my period", "lost my phone", "won the lottery", "paid for lunch", "minted it", "sold my phone for 120 usdc", "I delivered the pizza", "homework done for tomorrow", "itinerary for tomorrow", "delete my meal plan", "the price drop is on friday"]) {
      expect(parseByRules(s)?.action ?? "", s).not.toMatch(/^(?:hackathon|mint|commission|release|trip\.plan|plan\.|drop)\b/);
    }
  });

  it("keeps a mint's local time right across a clock change", async () => {
    const { parseMoment } = await import("../src/modules/features/creative/shared.js");
    const user = { id: 1, tz: "America/New_York", prefs: {} } as any;
    const m = parseMoment("Nov 6 2026 at 5pm my time", user, new Date("2026-10-29T12:00:00Z"))!;
    expect(m.at.toISOString()).toBe("2026-11-06T22:00:00.000Z"); // 17:00 EST, after the clocks went back
  });
});
