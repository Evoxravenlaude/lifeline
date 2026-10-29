/** Money and paperwork, end to end: words in, records kept, brief lines, and the one calm daily ping. No network. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DateTime } from "luxon";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { ensureUser, getUserById, handleCallback, handleMessage, handlePhoto } from "../src/core/handler.js";
import { runDue, type SchedulerDeps } from "../src/core/scheduler.js";
import { briefExtras } from "../src/core/plugins.js";
import { buildDigest } from "../src/modules/digest.js";
import { parseByRules } from "../src/intent/rules.js";
import { helpGroups } from "../src/intent/capabilities.js";
import { moneySweep } from "../src/modules/features/money/common.js";
import { simulate } from "../src/modules/features/money/spending.js";
import { idsIn } from "../src/modules/features/money/paperwork.js";
import { countryCode } from "../src/modules/features/money/recurring.js";
import type { User } from "../src/policy/types.js";

let db: Db;
const saved = { ...config };
const NOW = new Date("2026-10-29T09:00:00Z"); // Thursday, 10:00 in Berlin
const at = (iso: string) => new Date(iso);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const noKeys = { anthropicKey: "", geminiKey: "", openaiCompatKey: "", openaiKey: "", resendKey: "", smtpUrl: "", emailFrom: "" };

function mockFetch(routes: [RegExp, (url: string, init?: RequestInit) => Response][]) {
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

beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());
beforeEach(() => { Object.assign(config, noKeys); mockFetch([]); });
afterEach(() => { Object.assign(config, saved); vi.unstubAllGlobals(); });

let n = 88_000;
async function person(tz = "Europe/Berlin", prefs: Record<string, unknown> = { currency: "EUR" }, name = "Ada Obi"): Promise<User> {
  const u = await ensureUser(db, "telegram", String(++n), name);
  await db.query(`UPDATE users SET tz=$2, quiet_start=0, quiet_end=0, prefs = prefs || $3::jsonb WHERE id=$1`, [u.id, tz, JSON.stringify(prefs)]);
  await db.query(`UPDATE jobs SET tz=$2 WHERE user_id=$1`, [u.id, tz]);
  return (await getUserById(db, u.id))!;
}
const fresh = async (u: User) => (await getUserById(db, u.id))!;
const say = async (u: User, text: string, now = NOW) => handleMessage(db, await fresh(u), text, { channel: "telegram", now });
const press = async (u: User, data: string, now = NOW) => handleCallback(db, await fresh(u), data, now);
const button = (r: { buttons?: { label: string; data: string }[] }, re: RegExp) => r.buttons!.find((b) => re.test(b.label) || re.test(b.data))!.data;

const sent: { user: number; text: string; buttons?: { label: string; data: string }[] }[] = [];
const deps: SchedulerDeps = { get db() { return db; }, getUser: (id) => getUserById(db, id), send: async (u, r) => { sent.push({ user: u.id, ...r }); return true; } } as SchedulerDeps;
/** Make this person's money jobs due and run the scheduler for real, as the server would. */
async function runMoneyJobs(u: User) {
  await db.query(`UPDATE jobs SET run_at = now() - interval '1 minute' WHERE user_id=$1 AND kind LIKE 'money_%' AND active`, [u.id]);
  const before = sent.length;
  await runDue(deps, new Date());
  return sent.slice(before).filter((s) => s.user === u.id && !/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(s.text));
}
/** A local date a few days from the real today, for the scheduler tests (the job handler uses the real clock). */
const fromToday = (u: User, days: number) => DateTime.now().setZone(u.tz).plus({ days });

describe("IOUs", () => {
  it("keeps who owes whom, drafts a reminder you send yourself, and settles", async () => {
    const u = await person();
    expect((await say(u, "Ana owes me 40 for dinner by Saturday")).text).toMatch(/^Ana owes you €40 for dinner, due Saturday\. Say "remind Ana"/);
    expect((await say(u, "I owe Tunde 15000")).text).toMatch(/^You owe Tunde €15,000\./);
    const list = (await say(u, "who owes me")).text;
    expect(list).toMatch(/Owed to you: €40\.\n- Ana: €40 for dinner, due Saturday/);
    expect(list).toMatch(/You owe: €15,000\./);

    const r = await say(u, "remind Ana");
    expect(r.text).toMatch(/^A friendly one to send Ana yourself:\n\n```\nHey Ana/);
    expect(r.text).toMatch(/I never send these for you\./);
    const direct = await press(u, button(r, /direct/i));
    expect(direct.text).toMatch(/I still need the €40 for dinner back/);

    expect((await say(u, "Ana paid me back 20")).text).toBe("Ana paid €20; €20 still to come.");
    const done = await say(u, "Ana paid me back");
    expect(done.text).toBe("Ana's paid you back €20. All square.");
    expect((await press(u, button(done, /^Undo$/))).text).toBe("Back to owing.");
    expect((await say(u, "who owes me")).text).toMatch(/- Ana: €20 for dinner/);
    expect((await say(u, "I paid Tunde back")).text).toMatch(/You've paid Tunde back €15,000\. All square\./);
  });

  it("mentions money due back gently in the brief, once it's due", async () => {
    const u = await person("Africa/Accra", {});
    expect((await say(u, "Kwame owes me ₵200 for the tickets by Saturday")).text).toMatch(/Kwame owes you .*200 for the tickets/);
    expect(await briefExtras(db, await fresh(u), NOW)).toEqual([]);
    const sunday = at("2026-11-01T09:00:00Z");
    const lines = await briefExtras(db, await fresh(u), sunday);
    expect(lines.join("\n")).toMatch(/Kwame's .*200 for the tickets was due back yesterday\. "remind Kwame" drafts a friendly nudge\./);
    expect(await buildDigest(db, await fresh(u), sunday)).toContain(`"remind Kwame"`);
  });

  it("knows when there's nothing to chase", async () => {
    const u = await person();
    expect((await say(u, "remind Sipho")).text).toMatch(/I don't have anything Sipho owes you/);
    expect((await say(u, "who owes me")).text).toMatch(/^Nobody owes you anything/);
  });
});

describe("subscriptions and the renewal radar", () => {
  it("keeps renewals, adds up the month, and stops when you've cancelled", async () => {
    const u = await person();
    expect((await say(u, "Netflix 15.49 monthly renews on the 3rd")).text).toMatch(/^Netflix, €15\.49 a month, renews Tuesday\. I'll ping you 3 days before each renewal\./);
    expect((await say(u, "Spotify yearly 99 on 12 March")).text).toMatch(/^Spotify, €99 a year, renews 12 March 2027\..*about €23\.74 a month across 2 subscriptions/);
    const list = (await say(u, "my subscriptions")).text;
    expect(list).toMatch(/^About €23\.74 a month across 2 subscriptions\.\n- Netflix: €15\.49 a month, renews Tuesday\n- Spotify: €99 a year, renews 12 March 2027/);
    expect((await say(u, "Netflix renews on the 5th")).text).toMatch(/^Netflix, €15\.49 a month, renews 5 November/);

    const steps = (await say(u, "cancel Netflix")).text;
    expect(steps).toMatch(/usual way out of Netflix/);
    expect(steps).toMatch(/App Store or Google Play/);
    expect(steps).toMatch(/I can't cancel it for you\. Once it's done, say "I cancelled Netflix"/);

    expect((await say(u, "I cancelled Spotify")).text).toBe("Spotify is off the list. That's €8.25 a month back with you.");
    expect((await say(u, "my subscriptions")).text).toMatch(/across 1 subscription\./);
  });

  it("looks up the real cancellation steps when web search is on", async () => {
    Object.assign(config, { geminiKey: "g_test" });
    mockFetch([[/:generateContent/, () => json({ candidates: [{ content: { parts: [{ text: "1. Sign in at netflix.com\n2. Account, then Cancel Membership\n3. Confirm" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "https://help.netflix.com/en/node/407", title: "Netflix Help" } }] } }] })]]);
    const u = await person();
    const r = await say(u, "cancel my Canal+ subscription");
    expect(r.text).toMatch(/Sign in at netflix\.com/);
    expect(r.text).toMatch(/Sources: \[Netflix Help\]\(https:\/\/help\.netflix\.com/);
    expect(r.text).toMatch(/I can't cancel it for you/);
  });

  it("a receipt photo becomes a subscription, or a warranty", async () => {
    Object.assign(config, { geminiKey: "g_test" });
    const u = await person();
    for (const [suggestion, check] of [["Netflix subscription 15.49 monthly", `SELECT name, amount::text FROM money_subs WHERE user_id=$1`], ["warranty for the blender ends 1 Nov 2027", `SELECT item, kind FROM money_warranty WHERE user_id=$1`]] as const) {
      vi.unstubAllGlobals();
      mockFetch([[/:generateContent$/, () => json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ reply: "A receipt.", suggestion, label: "Keep it" }) }] } }] })]]);
      const r = await handlePhoto(db, await fresh(u), Buffer.from("jpg"), "image/jpeg", "add this", "telegram");
      expect(r.text).toMatch(/A receipt\./);
      expect((await db.query(check, [u.id])).length).toBe(1);
    }
    expect(await db.query(`SELECT name, amount::text FROM money_subs WHERE user_id=$1`, [u.id])).toEqual([{ name: "Netflix", amount: "15.49" }]);
  });

  it("pings once, three days before a renewal, through the scheduler", async () => {
    const u = await person();
    const d = fromToday(u, 3);
    await say(u, `Netflix 15.49 monthly renews on the ${d.day}`, new Date());
    const msgs = await runMoneyJobs(u);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/^Netflix renews \w+ for €15\.49; "cancel Netflix" gives the steps if you want out\.\n\nSay "stop money pings"/);
    expect(await runMoneyJobs(u)).toHaveLength(0);
  });
});

describe("documents and ID expiry", () => {
  it("keeps only the name and date, refuses numbers, and warns about a passport before a trip", async () => {
    const u = await person();
    await db.query(`INSERT INTO trips (user_id, destination, starts_on) VALUES ($1,'accra','2026-12-20')`, [u.id]);
    const r = await say(u, "my passport A12345678 expires 3 March 2027");
    expect(r.text).toMatch(/^Passport, expires 3 March 2027, in 4 months\./);
    expect(r.text).toMatch(/I've left the number out: I only keep the name and the date, never document numbers or scans\./);
    expect(r.text).toMatch(/under six months left when you go to Accra 20 December/);
    expect(JSON.stringify(await db.query(`SELECT * FROM money_docs WHERE user_id=$1`, [u.id]))).not.toContain("A12345678");
    expect(JSON.stringify(await db.query(`SELECT content FROM messages WHERE user_id=$1`, [u.id]))).not.toContain("A12345678");

    expect((await say(u, "driving licence expires June 2028")).text).toMatch(/^Driving licence, expires .*2028/);
    expect((await say(u, "visa ends 30 Nov")).text).toMatch(/^Visa, expires 30 November, in 5 weeks\./);
    expect((await say(u, "car insurance renews 1 Jan")).text).toMatch(/^Car insurance, renews 1 January 2027/);
    const docs = (await say(u, "my documents")).text;
    expect(docs).toMatch(/^4 documents, soonest first:\n- Visa: 30 November/);
    expect(docs).toMatch(/under six months left/);
    expect((await say(u, "when does my passport expire?")).text).toMatch(/^Passport: 3 March 2027/);

    const week = await briefExtras(db, await fresh(u), at("2026-11-23T09:00:00Z"));
    expect(week.join("\n")).toMatch(/Your visa expires 30 November, in 7 days/);
    expect((await say(u, "remove my visa")).text).toBe("Visa is off your documents.");
  });

  it("pings at 30 days through the daily job, and once", async () => {
    const u = await person();
    await say(u, `my visa expires ${fromToday(u, 25).toFormat("d LLLL yyyy")}`, new Date());
    const msgs = await runMoneyJobs(u);
    expect(msgs.map((m) => m.text).join("\n")).toMatch(/Your visa expires .*in 4 weeks\./);
    expect(await runMoneyJobs(u)).toHaveLength(0);
  });
});

describe("rent and home payments", () => {
  it("counts down monthly rent and logs payment", async () => {
    const u = await person();
    expect((await say(u, "rent 1200 due on the 1st monthly")).text).toBe(`Rent, €1,200 a month, due on the 1st of each month; next on Sunday. I'll remind you 3 days before, and "paid rent" logs it.`);
    expect((await briefExtras(db, await fresh(u), NOW)).join("\n")).toMatch(/Rent \(€1,200\) is due Sunday, in 3 days\./);
    const paid = await say(u, "paid rent");
    expect(paid.text).toBe("Rent paid, €1,200, logged. Next due 1 December.");
    expect((await say(u, "when is rent due?")).text).toMatch(/^Rent: €1,200 a month, next due 1 December, in 5 weeks\. Last paid/);
  });

  it("works out a monthly saving target for yearly rent", async () => {
    const u = await person("Africa/Lagos", {});
    const r = await say(u, "rent 1.8m due 1 March yearly");
    expect(r.text).toMatch(/^Rent, ₦1,800,000 a year, due 1 March 2027\. That's 5 months away, so putting aside about ₦360,000 a month gets you there\. I'll remind you 30 and 7 days before\./);
    expect((await say(u, "my rent")).text).toMatch(/next due 1 March 2027, in 4 months/);
  });

  it("asks when it's due if you don't say", async () => {
    const u = await person();
    expect((await say(u, "rent 950")).text).toMatch(/^When is it due\?/);
    expect((await say(u, "the 5th")).text).toMatch(/^Rent, €950 a month, due on the 5th of each month/);
  });

  it("pings three days before monthly rent", async () => {
    const u = await person();
    await say(u, `rent 900 due on the ${fromToday(u, 3).day} monthly`, new Date());
    const msgs = await runMoneyJobs(u);
    expect(msgs[0]?.text).toMatch(/^Rent of €900 is due \w+, in 3 days\./);
  });
});

describe("warranties and returns", () => {
  it("remembers both, reminds before, and clears", async () => {
    const u = await person();
    expect((await say(u, "warranty for the laptop ends 12 May 2027")).text).toMatch(/^Laptop warranty, until 12 May 2027, in 6 months\. I'll remind you a month before/);
    expect((await say(u, "return window for the shoes closes Friday")).text).toMatch(/^Shoes: the return window closes tomorrow\. That's very soon/);
    expect((await briefExtras(db, await fresh(u), NOW)).join("\n")).toMatch(/Last days to return: the shoes \(tomorrow\)\./);
    expect((await say(u, "my warranties")).text).toBe("- Shoes: return by tomorrow\n- Laptop: warranty until 12 May 2027");
    expect((await say(u, "returned the shoes")).text).toBe("Shoes returned; reminder cleared. Keep an eye out for the refund.");
    const late = await moneySweep(deps, await fresh(u), at("2027-04-20T08:00:00Z"));
    expect(late).toMatch(/The laptop warranty ends 12 May, in 3 weeks\. If anything's wrong with it, now's the time to claim\./);
  });
});

describe("impulse-spend cool-off", () => {
  it("parks a buy, asks again with this week's spending, and counts what waiting saved", async () => {
    const u = await person();
    await say(u, "I spent 30 on lunch");
    const r = await say(u, "I want to buy AirPods for 249");
    expect(r.text).toBe("AirPods, €249, parked until Saturday at 10:00. I'll ask you again then; if you still want them, they'll still be there.");
    const job = await db.one<{ run_at: string }>(`SELECT run_at FROM jobs WHERE user_id=$1 AND kind='money_cooloff'`, [u.id]);
    expect(new Date(job!.run_at).toISOString()).toBe("2026-10-31T09:00:00.000Z");

    const msgs = (await runMoneyJobs(u)).filter((m) => /AirPods/.test(m.text));
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/you wanted the AirPods for €249\. This week you've spent €30 so far\. Still want them\?/);
    expect(msgs[0].text).toMatch(/stop cool-off pings/);
    const skipped = await press(u, button(msgs[0], /^Skip it$/));
    expect(skipped.text).toBe("Skipped. That's €249 not spent; €249 saved by waiting so far.");

    expect((await say(u, "I want to buy a PS5 for 450 euros, park it for a week")).text).toMatch(/^PS5, €450, parked until Thu 5 Nov at 10:00\./);
    const keep = await say(u, "still want it");
    expect(keep.text).toBe("Then it's a considered buy. Enjoy the PS5.");
    expect((await press(u, button(keep, /Log the spend/))).text).toMatch(/€450 on shopping, logged/);
    expect((await say(u, "saved by waiting")).text).toMatch(/€249 saved by waiting so far\./);
  });
});

describe("debt payoff planner", () => {
  it("orders snowball and avalanche, times them, and celebrates a cleared debt gently", async () => {
    const u = await person();
    expect((await say(u, "debt: credit card 2400 at 24%, minimum 60")).text).toMatch(/^Credit card, €2,400 at 24% a year, minimum €60 a month\./);
    expect((await say(u, "loan app 300 at 10% monthly")).text).toMatch(/^Loan app, €300 at 10% a month\. That's about 120% a year/);
    await say(u, "debt: store card 200 at 30%, minimum 20");
    const plan = (await say(u, "my debt plan")).text;
    expect(plan).toMatch(/^€2,900 across 3 debts; minimums come to about €113 a month\./);
    expect(plan).toMatch(/\*\*Avalanche\*\*, highest interest first: loan app, then store card, then credit card\./);
    expect(plan).toMatch(/\*\*Snowball\*\*, smallest balance first: store card, then loan app, then credit card\./);
    expect(plan).toMatch(/"debt budget 170"/);
    expect(plan.match(/not financial advice/g)).toHaveLength(1);

    await say(u, "debt budget 400");
    expect((await say(u, "my debt plan")).text).toMatch(/At €400 a month, avalanche: clear in \d+ months, about €\d+ in interest\. Snowball: clear in \d+ months/);
    expect((await say(u, "paid 200 off the store card")).text).toBe("That's the store card cleared. One less thing to carry. 2 debts left, €2,700 to go.");
    expect((await say(u, "paid 100 off the credit card")).text).toBe("€100 off the credit card; €2,300 left.");
  });

  it("simulates fairly: more money clears sooner", () => {
    const debts = [{ id: 1, name: "a", balance: "1000", currency: "EUR", rate: "20", rate_period: "year", minimum: "30" }];
    expect(simulate(debts, [1], 100).months).toBeLessThan(simulate(debts, [1], 50).months);
    expect(simulate(debts, [1], 10).months).toBe(Infinity);
  });
});

describe("invoices for freelancers", () => {
  it("keeps invoices, escalates the reminder draft, and sends only after a yes with your address as reply-to", async () => {
    const u = await person();
    expect((await say(u, "invoice 1500 to Acme due 30 Nov")).text).toMatch(/^Invoice to Acme for €1,500, due 30 November\./);
    expect((await say(u, "my invoices")).text).toBe("1 open invoice, €1,500 in all.\n- Acme: €1,500, due 30 November");
    const dec10 = at("2026-12-10T09:00:00Z");
    const chase = (await say(u, "chase Acme", dec10)).text;
    expect(chase).toMatch(/^A firm reminder for Acme, 10 days late, ready to send yourself:\n\n```\nSubject: Overdue invoice: €1,500/);
    expect(chase).toMatch(/now 10 days overdue/);
    expect((await say(u, "draft a gentle reminder for Acme", dec10)).text).toMatch(/friendly reminder that my invoice for €1,500 was due on 30 November/);
    expect((await say(u, "chase Acme", at("2026-12-25T09:00:00Z"))).text).toMatch(/Subject: Final reminder: invoice for €1,500/);

    // No email set up: the draft only.
    expect((await say(u, "send it to Acme", dec10)).text).toMatch(/^Email isn't switched on here yet\. Here's the draft to send yourself:\n\n```/);
    await say(u, "no", dec10);

    // Email on, address confirmed: asks for the client's address, echoes the exact email, sends on yes.
    Object.assign(config, { resendKey: "re_test", emailFrom: "lifeline <bot@example.com>" });
    const calls = mockFetch([[/api\.resend\.com\/emails$/, () => json({ id: "e1" })]]);
    await db.query(`UPDATE users SET prefs = prefs || '{"emailVerified":"ada@example.com"}'::jsonb WHERE id=$1`, [u.id]);
    expect((await say(u, "send it to Acme", dec10)).text).toBe("What's Acme's email address?");
    const echo = await say(u, "it's ap@acme.com", dec10);
    expect(echo.text).toMatch(/^This emails ap@acme\.com from lifeline, with replies going to you:\n\nSubject: Overdue invoice: €1,500/);
    expect(echo.text).toMatch(/Go ahead\? This waits ten minutes for a yes\./);
    expect(calls).toHaveLength(0);
    expect((await say(u, "yes", dec10)).text).toBe("Sent to ap@acme.com. Replies come to ada@example.com.");
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body).toMatchObject({ to: ["ap@acme.com"], reply_to: "ada@example.com", subject: "Overdue invoice: €1,500" });
    expect(body.text).toMatch(/Thanks,\nAda/);

    expect((await say(u, "Acme paid", dec10)).text).toBe("Acme paid the €1,500. That's €1,500 paid this year across 1 invoice.");
    expect((await say(u, "my invoices", dec10)).text).toMatch(/^No open invoices/);
  });

  it("pings when an invoice runs late, then again only when it gets later", async () => {
    const u = await person();
    await say(u, "invoice 800 to Studio Lima due 30 Nov");
    const d1 = await moneySweep(deps, await fresh(u), at("2026-12-01T09:00:00Z"));
    expect(d1).toMatch(/^Studio Lima's invoice for €800 was due yesterday\./);
    expect(sent[sent.length - 1].buttons?.[0].data).toMatch(/^mn:inv:chase:\d+$/);
    expect(await moneySweep(deps, await fresh(u), at("2026-12-02T09:00:00Z"))).toBeNull();
    expect(await moneySweep(deps, await fresh(u), at("2026-12-08T09:00:00Z"))).toMatch(/is 8 days overdue/);
    const drafted = await press(u, sent[sent.length - 1].buttons![0].data, at("2026-12-08T09:00:00Z"));
    expect(drafted.text).toMatch(/A firm reminder for Studio Lima/);
  });
});

describe("tax-year companion", () => {
  it("sets your own deadline, asks your country once, logs income, and points to the official authority", async () => {
    const u = await person("Africa/Accra", {});
    const r = (await say(u, "my tax deadline is 30 April")).text;
    expect(r).toMatch(/^Your tax deadline: 30 April, in 6 months\. I'll remind you 30 and 7 days before\. I don't give tax advice, but I can point you to the right official site: which country do you file in\?/);
    expect((await say(u, "I file taxes in Ghana")).text).toMatch(/^Ghana\. For the rules themselves, the Ghana Revenue Authority is the official source\./);
    expect((await say(u, "my tax deadline is 30 April")).text).toMatch(/the Ghana Revenue Authority has the official rules\.$/);
    expect((await say(u, "log income 2000 from Acme")).text).toMatch(/2,000 from Acme, logged\. .*2,000 so far this tax year\./);
    expect((await say(u, "log crypto income 0.5 ETH from staking")).text).toMatch(/^0\.5 ETH from Staking, logged\./);
    const sum = (await say(u, "my income this year")).text;
    expect(sum).toMatch(/^Since 1 January: .*2,000 and 0\.5 ETH, across 2 payments\./);
    expect(sum).toMatch(/- Crypto: 0\.5 ETH/);
    expect(sum).toMatch(/not tax advice; the Ghana Revenue Authority has the rules/);
    expect((await briefExtras(db, await fresh(u), at("2027-04-01T09:00:00Z"))).join("\n")).toMatch(/Your tax deadline is 30 April, in 4 weeks\./);
  });

  it("pings 30 days out through the scheduler", async () => {
    const u = await person("Europe/London", { country: "GB", currency: "GBP" });
    await say(u, `my tax deadline is ${fromToday(u, 20).toFormat("d LLLL")}`, new Date());
    const msgs = await runMoneyJobs(u);
    expect(msgs[0]?.text).toMatch(/^Your tax deadline is .*, in 3 weeks\. HMRC on GOV\.UK has the official forms\./);
  });

  it("knows countries by name or code, anywhere", () => {
    expect(countryCode("Kenya")).toBe("KE");
    expect(countryCode("United Kingdom")).toBe("GB");
    expect(countryCode("uk")).toBe("GB");
    expect(countryCode("BR")).toBe("BR");
    expect(countryCode("Narnia")).toBeNull();
  });
});

describe("savings circles", () => {
  it("keeps the ledger, says whose turn it is, and nudges only you about who hasn't paid", async () => {
    const u = await person("America/New_York", {});
    const r = (await say(u, "start a savings circle: 6 people, 100 monthly, payout order Ana, Ben, Chi, Dayo, Efe, Femi")).text;
    expect(r).toMatch(/^Your savings circle is set: 6 people, \$100 monthly, so each payout is \$600\. Ana collects first, today; Ben next, 29 November\./);
    expect(r).toMatch(/I only keep the ledger; I never hold or move the money\./);
    expect((await say(u, "Ben paid this round")).text).toBe("Ben marked paid for round 1. 1 of 6 in; still to come: Ana, Chi, Dayo, Efe and Femi.");
    expect((await say(u, "Zed paid this round")).text).toMatch(/^Zed isn't in the savings circle/);
    const turn = (await say(u, "whose turn is it")).text;
    expect(turn).toMatch(/^Round 1 of 6: Ana collects \$600\./);
    expect(turn).toMatch(/Paid so far: Ben\. Still to mark: Ana, Chi, Dayo, Efe and Femi\. Next up: Ben, 29 November\./);
    expect((await say(u, "savings circle status")).text).toMatch(/- Round 1, Ana, today: now, 1 of 6 paid\n- Round 2, Ben, 29 November/);

    const later = at("2026-11-01T15:00:00Z");
    const nudge = await moneySweep(deps, await fresh(u), later);
    expect(nudge).toMatch(/^Savings circle round 1: Ana, Chi, Dayo, Efe and 1 more haven't been marked paid yet\. Say "Ana paid this round" when they do\./);
    expect(await moneySweep(deps, await fresh(u), at("2026-11-01T18:00:00Z"))).toBeNull();
  });

  it("asks who's in when you don't say", async () => {
    const u = await person();
    expect((await say(u, "start an ajo: 20000 monthly")).text).toMatch(/^Who's in it, in payout order\?/);
    expect((await say(u, "Bola, Chidi and Funke")).text).toMatch(/^Your ajo is set: 3 people, €20,000 monthly, so each payout is €60,000\. Bola collects first/);
  });
});

describe("relocation tracker", () => {
  it("builds a checklist, links document dates, and ticks items off", async () => {
    const u = await person();
    await say(u, "my passport expires 3 March 2027");
    const r = (await say(u, "I'm moving to Canada in March")).text;
    expect(r).toMatch(/^Canada, .*\. Your move checklist:\n- Passport valid long enough/);
    expect(r).toMatch(/\(passport expires 3 March 2027\), under six months left at your move date/);
    expect(r).toMatch(/- Police certificate\n- Proof of funds/);
    expect((await say(u, "tick flights")).text).toBe("Flights: done. 7 things left for Canada; next, passport valid long enough.");
    await say(u, "my police certificate expires 3 May 2027");
    const list = (await say(u, "my move checklist")).text;
    expect(list).toMatch(/: 1 of 8 done\./);
    expect(list).toMatch(/- Police certificate \(police certificate expires 3 May 2027\)/);
    expect(list).toMatch(/- Flights: done/);
  });

  it("tick falls back to your lists when there's no move", async () => {
    const u = await person();
    await say(u, "I need to buy rice");
    expect((await say(u, "tick off rice")).text).toMatch(/rice, done/i);
  });
});

describe("calm by design", () => {
  it("combines several things into one ping, says how to stop, and the off switch keeps them to the brief", async () => {
    const u = await person();
    await say(u, `Netflix 15.49 monthly renews on the ${fromToday(u, 2).day}`, new Date());
    await say(u, `my visa expires ${fromToday(u, 6).toFormat("d LLLL yyyy")}`, new Date());
    const msgs = await runMoneyJobs(u);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toMatch(/^A few money things today:\n- /);
    expect(msgs[0].text).toMatch(/\n- Netflix renews \w+ for €15\.49[.;]/);
    expect(msgs[0].text).toMatch(/\n- Your visa expires .*, in 6 days\./);
    expect(msgs[0].text).toMatch(/Say "stop money pings" to keep these to your morning brief\.$/);

    const v = await person();
    await say(v, `Spotify 9.99 monthly renews on the ${fromToday(v, 2).day}`, new Date());
    expect((await say(v, "stop money pings")).text).toMatch(/^No more money and paperwork pings\. They'll wait for your morning brief instead\. Say "money pings on"/);
    expect(await runMoneyJobs(v)).toHaveLength(0);
    expect((await briefExtras(db, await fresh(v), new Date())).join("\n")).toMatch(/Renewing soon: Spotify/);
    expect((await say(v, "money pings on")).text).toMatch(/^Money and paperwork pings are back on/);
  });

  it("calm mode holds the ping for the brief", async () => {
    const u = await person("Europe/Berlin", { currency: "EUR", calm: true });
    await say(u, `rent 700 due on the ${fromToday(u, 2).day} monthly`, new Date());
    expect(await runMoneyJobs(u)).toHaveLength(0);
    expect((await briefExtras(db, await fresh(u), new Date())).join("\n")).toMatch(/Rent \(€700\) is due/);
  });
});

describe("words and safety", () => {
  it("finds ID numbers and leaves dates and amounts alone", () => {
    expect(idsIn("my passport A12345678 expires 3 March 2027")).toEqual(["A12345678"]);
    expect(idsIn("licence no. 123456789")).toEqual(["123456789"]);
    expect(idsIn("expires 2027-03-03 or 03/03/2027, the 3rd")).toEqual([]);
  });

  it("doesn't catch ordinary chat or the core's own sentences", () => {
    const mine = /^(?:iou|invoice|savings|sub|rent|tax|doc|warranty|relocation|cooloff|debt|money)\./;
    for (const s of ["I spent 20 on lunch", "remind me to call Ada at 9", "my shopping list", "I spent the weekend in Lagos", "what do you think about my plan", "my patience expires soon", "I returned the call", "I'm moving to a new flat", "cancel the meeting", "how are you", "paid $20 for lunch", "who's next"]) {
      const i = parseByRules(s);
      expect(i && mine.test(i.action) ? `${s} → ${i.action}` : null).toBeNull();
    }
  });

  it("puts one card per feature in the right drawer", () => {
    const g = Object.fromEntries(helpGroups());
    expect(g["Money"]).toEqual(expect.arrayContaining(["ious", "subscriptions", "cooloff", "debt_plan", "invoices", "tax_year", "savings_circles"]));
    expect(g["Home and paperwork"]).toEqual(expect.arrayContaining(["documents", "rent", "warranties", "relocation"]));
  });
});
