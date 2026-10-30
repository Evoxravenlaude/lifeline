/** What came from "what to add next": reactions, streaming, topics, rich messages, the group's card and invites, and Pip. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import "../src/telegram/group.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { ensureUser, handleMessage } from "../src/core/handler.js";
import { parseByRules } from "../src/intent/rules.js";
import { complete, throttle } from "../src/intent/providers.js";
import { toRichHtml } from "../src/core/format.js";
import { areaOfAction, areaOfKind, registerTopicMaker, topicsOf } from "../src/core/topics.js";
import { cardRich, cardVoice, closePoll, dueCards, duePolls, groupButton, groupCommand, inviteIcs, recordVote, rememberCard, rememberPoll, type GroupMsg } from "../src/telegram/group.js";
import { carried, catchUp, keptDays, nextThing, THINGS, thingsArt } from "../src/core/pipthings.js";
import { dashboardFacts, dashboardSvg } from "../src/core/dashboard.js";
import { onlyConfirms, QUICK } from "../src/telegram/bot.js";

let db: Db;
const saved = { ...config };
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());
afterEach(() => { Object.assign(config, saved); vi.unstubAllGlobals(); });

const sse = (events: unknown[]) => new Response(new ReadableStream({
  start(c) { const e = new TextEncoder(); for (const ev of events) c.enqueue(e.encode(`data: ${JSON.stringify(ev)}\n\n`)); c.enqueue(e.encode("data: [DONE]\n\n")); c.close(); },
}), { headers: { "content-type": "text/event-stream" } });

describe("took my meds", () => {
  it("reaches the action from plain words, and leaves everyday sentences alone", () => {
    expect(parseByRules("took my meds")?.action).toBe("medication.taken");
    expect(parseByRules("I've just taken my morning medication")?.action).toBe("medication.taken");
    expect(parseByRules("meds taken")?.action).toBe("medication.taken");
    expect(parseByRules("took my metformin dose")).toEqual({ action: "medication.taken", args: { match: "metformin" } });
    expect(parseByRules("took my time")?.action).not.toBe("medication.taken");
    expect(parseByRules("took my kids to school")?.action).not.toBe("medication.taken");
  });

  it("marks the waiting dose as taken, can be undone, and is a quiet log on Telegram", async () => {
    const u = await ensureUser(db, "telegram", "7101", "Ife");
    const med = await db.one<{ id: number }>(`INSERT INTO medications (user_id, name, times) VALUES ($1,'Metformin',ARRAY['08:00']) RETURNING id`, [u.id]);
    const log = await db.one<{ id: number }>(`INSERT INTO medication_logs (medication_id, scheduled_for) VALUES ($1, now() - interval '1 hour') RETURNING id`, [med!.id]);
    const r = await handleMessage(db, u, "took my meds", { channel: "telegram" });
    expect(r.text).toMatch(/Metformin, taken\. Logged\./);
    expect(r.action).toBe("medication.taken");
    expect(QUICK[r.action!]).toBe("💊");
    expect(onlyConfirms(r)).toBe(true);
    expect((await db.one<{ status: string }>(`SELECT status FROM medication_logs WHERE id=$1`, [log!.id]))!.status).toBe("taken");
    await handleMessage(db, u, "undo", { channel: "telegram" });
    expect((await db.one<{ status: string }>(`SELECT status FROM medication_logs WHERE id=$1`, [log!.id]))!.status).toBe("pending");
  });

  it("a reply that says more than 'logged' is still sent in words", () => {
    expect(onlyConfirms({ text: "Gym, logged. 7 days running.", celebrate: true })).toBe(false);
    expect(onlyConfirms({ text: "Logged.\nThat's three of four doses today." })).toBe(false);
    expect(onlyConfirms({ text: "Sleep 7 h. Logged.", buttons: [{ label: "Undo", data: "undo:4" }] })).toBe(true);
  });

  it("reactions can be turned off with a sentence", async () => {
    const u = await ensureUser(db, "telegram", "7102", "Bola");
    const r = await handleMessage(db, u, "reply to my logs", { channel: "telegram" });
    expect(r.text).toMatch(/in words/);
    expect((await db.one<{ v: boolean }>(`SELECT (prefs->>'reactions')::boolean AS v FROM users WHERE id=$1`, [u.id]))!.v).toBe(false);
  });
});

describe("streaming answers", () => {
  it("passes the text along as it's written, and returns the same finished answer", async () => {
    Object.assign(config, { anthropicKey: "", geminiKey: "", openaiCompatKey: "k", openaiCompatBaseUrl: "https://api.groq.com/openai/v1", modelProvider: "openai" });
    let sent: any = null;
    vi.stubGlobal("fetch", vi.fn(async (_u: any, init: any) => {
      sent = JSON.parse(init.body);
      return sse([{ choices: [{ delta: { content: "Lagos " } }] }, { choices: [{ delta: { content: "traffic is " } }] }, { choices: [{ delta: { content: "lighter on Sundays." } }], x_groq: { usage: { prompt_tokens: 9, completion_tokens: 6 } } }]);
    }));
    const seen: string[] = [];
    const r = await complete({ system: "s", messages: [{ role: "user", content: "q" }], onText: (t) => seen.push(t) });
    expect(sent.stream).toBe(true);
    expect(seen).toEqual(["Lagos ", "Lagos traffic is ", "Lagos traffic is lighter on Sundays."]);
    expect(r).toMatchObject({ text: "Lagos traffic is lighter on Sundays.", usage: { input: 9, output: 6 } });
  });

  it("puts a streamed tool call back together and never shows its arguments", async () => {
    Object.assign(config, { anthropicKey: "", geminiKey: "", openaiCompatKey: "k", openaiCompatBaseUrl: "https://api.groq.com/openai/v1", modelProvider: "openai" });
    vi.stubGlobal("fetch", vi.fn(async () => sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "reminder__create", arguments: "{\"text\":\"call" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: " mum\"}" } }] } }] },
    ])));
    const seen: string[] = [];
    const r = await complete({ system: "s", messages: [{ role: "user", content: "q" }], onText: (t) => seen.push(t) });
    expect(seen).toEqual([]);
    expect(r!.toolCall).toEqual({ name: "reminder__create", args: { text: "call mum" } });
  });

  it("stops when the person presses Stop, keeping what was written", async () => {
    Object.assign(config, { anthropicKey: "", geminiKey: "", openaiCompatKey: "k", openaiCompatBaseUrl: "https://api.groq.com/openai/v1", modelProvider: "openai" });
    const ac = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_u: any, init: any) => new Response(new ReadableStream({
      start(c) {
        const e = new TextEncoder();
        c.enqueue(e.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "First part." } }] })}\n\n`));
        init.signal.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" })));
      },
    }), { headers: { "content-type": "text/event-stream" } })));
    const r = await complete({ system: "s", messages: [{ role: "user", content: "q" }], onText: (t) => { if (t === "First part.") ac.abort(); }, signal: ac.signal });
    expect(r).toMatchObject({ text: "First part.", stopped: true });
  });

  it("throttles drafts and can cancel the last one", async () => {
    vi.useFakeTimers();
    const got: string[] = [];
    const t = throttle((x) => got.push(x), 500);
    t.push("a"); t.push("ab"); t.push("abc");
    expect(got).toEqual(["a"]);
    vi.advanceTimersByTime(600);
    expect(got).toEqual(["a", "abc"]);
    t.push("abcd"); t.cancel();
    vi.advanceTimersByTime(600);
    expect(got).toEqual(["a", "abc"]);
    vi.useRealTimers();
  });
});

describe("rich messages", () => {
  it("turns the reply's markdown into headings, lists, tables and folded sources", () => {
    const html = toRichHtml("**This week**\n- Rent, `₦850,000`\n- Data, 4,500\n\n| Day | Hours |\n|---|---|\n| Mon | 6 |\n\nAll good & calm.\n\n**Sources**\n1. [Gov](https://gov.example/x?a=1&b=2)");
    expect(html).toContain("<h3>This week</h3>");
    expect(html).toContain("<ul><li>Rent, <code>₦850,000</code></li><li>Data, 4,500</li></ul>");
    expect(html).toContain("<table><tr><th>Day</th><th>Hours</th></tr><tr><td>Mon</td><td>6</td></tr></table>");
    expect(html).toContain("<p>All good &amp; calm.</p>");
    expect(html).toContain(`<details><summary>Sources</summary><ol><li><a href="https://gov.example/x?a=1&amp;b=2">Gov</a></li></ol></details>`);
    expect(toRichHtml("```\nconst x = 1 < 2;\n```")).toBe("<pre>const x = 1 &lt; 2;</pre>");
  });
});

describe("topics", () => {
  it("files pings and actions by area, and keeps reminders and the brief in the main chat", () => {
    expect(areaOfKind("money_daily")).toBe("money");
    expect(areaOfKind("medication")).toBe("health");
    expect(areaOfKind("statuspage")).toBe("work");
    expect(areaOfKind("power")).toBe("home");
    expect(areaOfKind("reminder")).toBeNull();
    expect(areaOfKind("digest")).toBeNull();
    expect(areaOfKind("safety_checkin_due")).toBeNull();
    expect(areaOfAction("spend.log")).toBe("money");
    expect(areaOfAction("trip.plan")).toBe("trips");
  });

  it("makes the topics when asked, and says plainly when Telegram has them off", async () => {
    const u = await ensureUser(db, "telegram", "7201", "Chidi");
    registerTopicMaker(async () => ({ ok: false, why: "off" }));
    expect((await handleMessage(db, u, "use topics", { channel: "telegram" })).text).toMatch(/@BotFather/);
    registerTopicMaker(async (_chat, existing) => ({ ok: true, topics: { ...existing, money: 11, health: 12, trips: 13, work: 14, home: 15 } }));
    const r = await handleMessage(db, u, "tidy my chat into topics", { channel: "telegram" });
    expect(r.text).toMatch(/├ Money[\s\S]*└ Home/);
    const fresh = await db.one<{ prefs: Record<string, unknown> }>(`SELECT prefs FROM users WHERE id=$1`, [u.id]);
    expect(topicsOf(fresh!.prefs)).toEqual({ money: 11, health: 12, trips: 13, work: 14, home: 15 });
    const now = (await db.one<any>(`SELECT * FROM users WHERE id=$1`, [u.id]))!;
    expect((await handleMessage(db, now, "stop using topics", { channel: "telegram" })).text).toMatch(/main chat again/);
  });
});

describe("the group's card, invites and private shares", () => {
  const CHAT = -100777;
  const ana = { id: 9101, name: "Ana Silva", username: "ana" };
  const msg = (cmd: string, args: string, extra: Partial<GroupMsg> = {}): GroupMsg => ({ chatId: CHAT, title: "Flat 9", from: ana, cmd, args, mentions: [], ...extra });
  beforeAll(async () => {
    const a = await ensureUser(db, "telegram", String(ana.id), "Ana Silva");
    await db.query(`UPDATE users SET tz='Africa/Lagos', prefs = prefs || '{"country":"NG","username":"ana"}'::jsonb WHERE id=$1`, [a.id]);
    const b = await ensureUser(db, "telegram", "9102", "Ben Okafor");
    await db.query(`UPDATE users SET prefs = prefs || '{"username":"ben"}'::jsonb WHERE id=$1`, [b.id]);
    await db.query(`INSERT INTO group_chats (chat_id, title, added_by, tz, currency) VALUES ($1,'Flat 9',$2,'Africa/Lagos','NGN')`, [CHAT, a.id]);
  });

  it("shows each person their own share, privately, when lifeline knows them", async () => {
    const out = await groupCommand(db, msg("split", "36000 dinner @ben @cy", { mentions: [{ name: "ben", username: "ben" }, { name: "cy", username: "cy" }] }));
    expect(out!.privately).toHaveLength(1); // Ben is in the circle; Cy isn't, and Ana paid
    expect(out!.privately![0]).toMatchObject({ tgId: 9102 });
    expect(out!.privately![0].text).toMatch(/Your share of dinner is ₦12,000, to @ana\. Only you can see this\./);
    expect(out!.remember?.bill).toBeTypeOf("number");
  });

  it("closes a time poll into the evening most can do, with an invite to keep", async () => {
    const now = new Date("2026-10-30T09:00:00Z");
    const w = await groupCommand(db, msg("when", "movie night at 8pm"), now);
    expect(w!.poll!.question).toBe("When works for movie night?");
    await rememberPoll(db, CHAT, "poll-1", 555, ana.id, w!.remember!.poll!, now);
    await recordVote(db, "poll-1", { id: 1, name: "Ana" }, [1, 2]);
    await recordVote(db, "poll-1", { id: 2, name: "Ben" }, [2]);
    await recordVote(db, "poll-1", { id: 3, name: "Cy" }, [6]); // none of these
    expect(await duePolls(db, new Date(now.getTime() + 3_600_000))).toEqual([]);
    const out = await closePoll(db, "poll-1", now);
    expect(out!.text).toMatch(/\*\*Movie night: Sunday 1 November at 20:00\*\*/);
    expect(out!.text).toMatch(/2 of 3 can make it \(Ana, Ben\)/);
    expect(out!.stopPoll).toBe(555);
    const ics = Buffer.from(out!.file!.data, "base64").toString();
    expect(ics).toMatch(/DTSTART:20261101T190000Z/); // 20:00 in Lagos
    expect(out!.file!.name).toBe("movie-night.ics");
    expect(await closePoll(db, "poll-1", now)).toBeNull();
    const cal = await groupButton(db, CHAT, { id: 1, name: "Ana" }, out!.buttons![0][0].data);
    expect(cal.calendar).toEqual({ title: "Movie night", startIso: "2026-11-01T20:00:00.000+01:00" });
  });

  it("an invite escapes what the calendar format needs", () => {
    expect(inviteIcs("dinner; drinks, games", "2026-11-01T19:00:00", "UTC")).toMatch(/SUMMARY:Dinner\\; drinks\\, games/);
  });

  it("records a voice card and sends it all together at midnight on the day, once", async () => {
    const now = new Date("2026-10-30T10:00:00Z");
    const out = await groupCommand(db, msg("card", "@ben 1 November", { mentions: [{ name: "ben", username: "ben" }] }), now);
    expect(out!.text).toMatch(/A birthday card for @ben/);
    expect(out!.text).toMatch(/midnight on Sunday 1 November/);
    await rememberCard(db, out!.remember!.card!, 900);
    expect(await cardVoice(db, CHAT, 900, { id: 1, name: "Ana" }, "voice-a", 9)).toBe("kept");
    expect(await cardVoice(db, CHAT, 900, { id: 1, name: "Ana" }, "voice-a2", 8)).toBe("replaced");
    expect(await cardVoice(db, CHAT, 900, { id: 3, name: "Cy" }, "voice-c", 75)).toBe("too long");
    expect(await cardVoice(db, CHAT, 901, { id: 3, name: "Cy" }, "voice-c", 5)).toBeNull();
    expect(await dueCards(db, new Date("2026-10-31T22:30:00Z"))).toEqual([]); // 23:30 in Lagos
    const due = await dueCards(db, new Date("2026-10-31T23:05:00Z"));
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ chatId: CHAT, name: "ben", tgId: 9102, voices: [{ name: "Ana", fileId: "voice-a2", seconds: 8 }] });
    const rich = cardRich(due[0]);
    expect(rich.blocks[0]).toEqual({ type: "heading", text: "Happy birthday, ben", size: 1 });
    expect(rich.blocks.at(-1)).toEqual({ type: "voice_note", voice_note: { type: "voice_note", media: "voice-a2", duration: 8 }, caption: { text: "From Ana" } });
    expect(await dueCards(db, new Date("2026-10-31T23:20:00Z"))).toEqual([]);
  });

  it("asks for the day, and won't start a card for today", async () => {
    expect((await groupCommand(db, msg("card", "Ben")))!.text).toMatch(/Which day/);
    expect((await groupCommand(db, msg("card", "Ben today")))!.text).toMatch(/no midnight left/);
  });
});

describe("Pip grows with you", () => {
  it("earns things from kept days in total, and never loses one", async () => {
    const u = await ensureUser(db, "telegram", "7301", "Tolu");
    const h = await db.one<{ id: number }>(`INSERT INTO habits (user_id, name, target_per_week) VALUES ($1,'walk',7) RETURNING id`, [u.id]);
    for (let i = 0; i < 8; i++) await db.query(`INSERT INTO habit_checkins (habit_id, day) VALUES ($1, ($2::date - $3::int))`, [h!.id, "2026-10-30", i * 3]); // never two days in a row
    expect(await keptDays(db, u.id)).toBe(8);
    const first = await catchUp(db, u);
    expect(first.fresh.map((t) => t.key)).toEqual(["scarf"]);
    expect((await catchUp(db, u)).fresh).toEqual([]);
    await db.query(`DELETE FROM habit_checkins WHERE habit_id=$1`, [h!.id]);
    const again = await catchUp(db, u);
    expect(again.all.map((t) => t.key)).toEqual(["scarf"]);
    expect(nextThing(8)?.key).toBe("lantern");
    expect(carried(u.prefs).map((t) => t.key)).toEqual(["scarf"]);
  });

  it("draws what he carries on the dashboard, and shows them when asked", async () => {
    const u = await ensureUser(db, "telegram", "7301", "Tolu");
    const fresh = (await db.one<any>(`SELECT * FROM users WHERE id=$1`, [u.id]))!;
    const d = await dashboardFacts(db, fresh, new Date("2026-10-30T09:00:00Z"));
    expect(d.things).toEqual(["scarf"]);
    expect(dashboardSvg(d)).toContain(THINGS[0].svg);
    expect(thingsArt([], 0, 0, 100)).toBe("");
    const r = await handleMessage(db, fresh, "pip's things", { channel: "telegram" });
    expect(r.text).toMatch(/^Pip carries a scarf\./);
    expect(r.text).toMatch(/Next: a lantern, at 21 days/);
    expect(r.image?.mime).toBe("image/png");
  }, 30_000);
});
