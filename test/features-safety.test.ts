/** Safety: scam checks, safety contacts and check-ins, the emergency card, the legacy plan and the incident log. Every outside call is mocked. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { ensureUser, getUserById, handleCallback, handleMessage, type Reply } from "../src/core/handler.js";
import { registerSender } from "../src/core/dispatch.js";
import { runDue, schedule, type SchedulerDeps } from "../src/core/scheduler.js";
import { briefExtras, pluginLocationHandlers } from "../src/core/plugins.js";
import { copyButton } from "../src/core/format.js";
import { propose } from "../src/policy/engine.js";
import type { User } from "../src/policy/types.js";
import { lookAlike, redFlags } from "../src/modules/features/safety/scam.js";
import { looksSecret } from "../src/modules/features/safety/shared.js";
import { entryHash, GENESIS, verifyChain } from "../src/modules/features/safety/incident.js";
import { parseCheckin } from "../src/modules/features/safety/checkin.js";
import { parseByRules } from "../src/intent/rules.js";
import zlib from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { incidentPdf } from "../src/modules/features/safety/pdf.js";
import { lockScreenSvg } from "../src/modules/features/safety/lockscreen.js";
import { handleTextChannel } from "../src/channels/sms.js";

let db: Db;
const saved = { ...config };
const NOW = new Date();
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);

/** Telegram messages dispatched to people (consent requests, alerts), by their Telegram id. */
const tg: { to: string; text: string; buttons?: { label: string; data: string }[] }[] = [];
/** Emails sent through Resend. */
let mails: { to: string; subject: string; text: string }[] = [];
/** Scheduler pushes. */
const pushed: { to: number; text: string; buttons?: { label: string; data: string }[] }[] = [];
const deps = (): SchedulerDeps => ({ db, send: async (u, r) => { pushed.push({ to: u.id, text: r.text, buttons: r.buttons }); return true; }, getUser: (id) => getUserById(db, id) });

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Route = [RegExp, (url: string, init?: RequestInit) => Response | Promise<Response>];
function mockFetch(routes: Route[] = []) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input?.url ?? input);
    calls.push(url);
    if (/api\.resend\.com\/emails$/.test(url)) { const b = JSON.parse(String(init!.body)); mails.push({ to: b.to[0], subject: b.subject, text: b.text }); return json({ id: "em_1" }); }
    const r = routes.find(([re]) => re.test(url));
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return r[1](url, init);
  }));
  return calls;
}

beforeAll(async () => {
  db = await openTestDb();
  registerSender("telegram", async (to, reply) => { tg.push({ to, text: reply.text, buttons: reply.buttons }); });
});
afterAll(() => db.close());
beforeEach(() => {
  Object.assign(config, { openaiCompatKey: "", anthropicKey: "", geminiKey: "", openaiKey: "", modelProvider: "", resendKey: "re_test", emailFrom: "lifeline <bot@example.com>", smtpUrl: "", twilioSid: "", smsGatewayKey: "" });
  mockFetch();
  delete process.env.SAFE_BROWSING_KEY;
});
afterEach(() => { Object.assign(config, saved); vi.unstubAllGlobals(); tg.length = 0; mails = []; pushed.length = 0; });

const fresh = async (u: User) => (await getUserById(db, u.id))!;
const say = async (u: User, text: string, opts: { forwarded?: boolean; now?: Date } = {}): Promise<Reply> => handleMessage(db, await fresh(u), text, { channel: "telegram", ...opts });
/** Only safety jobs run in these tests; the brief and memory review stay out of the way. */
const onlySafetyJobs = () => db.query(`UPDATE jobs SET active=false WHERE kind NOT LIKE 'safety%'`);

/* ---------------- scams ---------------- */

describe("scam and fake-alert check", () => {
  const flagged = (t: string) => redFlags(t).flags.map((f) => f.say).join(" | ");

  it("catches real-world shapes from different countries", () => {
    // UK: tax refund with a look-alike link
    expect(flagged("HMRC: You are due a tax refund of £326.40. Claim within 24 hours at http://hmrc-refund.claim-now.info")).toMatch(/act fast[\s\S]*refund notice[\s\S]*HMRC/);
    // Nigeria: fake credit alert and a "sent by mistake" story
    expect(flagged("Acct:01****789 Amt:NGN250,000.00 CR Desc:TRF FROM CHIDI Bal:NGN251,200.00. Pls I sent it by mistake, kindly refund the excess to 0812 345 6789")).toMatch(/payment alert/);
    // Kenya: M-Pesa reversal trick
    expect(flagged("Confirmed. You have received Ksh 15,000.00 from JOHN KAMAU. Sorry I sent you money by mistake, please reverse the payment to 0722 000 111")).toMatch(/payment alert/);
    // US: someone asking for the code
    expect(flagged("This is Chase fraud department. We sent you a 6-digit code, read it back to us now to block the transaction")).toMatch(/one-time code/);
    // India: a job that charges a fee
    expect(flagged("Part time job! Earn Rs 5000 daily working from home. Pay registration fee of Rs 499 to start. WhatsApp +91 98765 43210")).toMatch(/Real employers/);
    // Crypto doubling and wallet draining
    expect(flagged("Official giveaway! Send 0.1 BTC and get 0.2 BTC back. Connect your wallet at https://tesla-x2.xyz")).toMatch(/multiply crypto[\s\S]*wallet connected/);
    // Philippines: gift cards
    expect(flagged("Your Globe account has an unpaid balance. Buy Google Play cards and send the codes to avoid disconnection")).toMatch(/gift cards/);
    // Family on a new number, keep it secret
    expect(flagged("Hi mum, I lost my phone, this is my new number. Can you send £200 for rent today? Don't tell dad")).toMatch(/new number[\s\S]*secret/);
    // Look-alikes: digit swap, look-alike alphabet, brand inside someone else's domain, shortener
    expect(lookAlike("paypa1.com")).toMatch(/look like PayPal/);
    expect(lookAlike("xn--pple-43d.com")).toMatch(/another alphabet/);
    expect(lookAlike("gtbank-verify.ng.xyz")).toMatch(/uses the name GTBank/);
    expect(lookAlike("paypal.com")).toBeNull();
    expect(lookAlike("paypal.co.uk")).toBeNull();
    expect(flagged("Package on hold, pay the redelivery fee: https://bit.ly/3xYz")).toMatch(/shortened/);
    // Mismatched sender
    expect(flagged("From: PayPal <service@paypal-support-team.com>\nYour account is limited.")).toMatch(/claims to be PayPal but was sent from/);
  });

  it("leaves ordinary messages alone", () => {
    for (const t of ["Hi Ada, dinner at 7 at Terra Kulture? Book here https://terrakulture.com", "Your Uber is arriving in 3 minutes", "Reminder: dentist appointment tomorrow at 10:30", "The meeting moved to Thursday, see you there"]) {
      expect(redFlags(t).flags, t).toEqual([]);
    }
    // A question about something being safe is not a message to scam-check ("No red flags found" would read as a yes).
    for (const t of ["is it safe to take ibuprofen with paracetamol", "is it safe to go out tonight?", "is this safe for kids"]) expect(parseByRules(t)?.action, t).not.toBe("scam.check");
    expect(parseByRules("is this a scam? URGENT verify your account")?.action).toBe("scam.check");
  });

  it("answers through the conversation with flags and what to do, never 'safe'", async () => {
    const u = await ensureUser(db, "telegram", "8001", "Kemi");
    const r = await say(u, "is this legit: URGENT your GTBank account will be blocked in 24 hours. Verify your BVN at http://gtbank-verify.ng.xyz");
    expect(r.text).toMatch(/Red flags/);
    expect(r.text).toMatch(/uses the name GTBank/);
    expect(r.text).toMatch(/What to do/);
    expect(r.text).not.toMatch(/\bsafe\b/i);
    expect(r.buttons?.[0]).toEqual({ label: "Report as a scam", data: "sf:sc:report" });
    const rep = await handleCallback(db, await fresh(u), "sf:sc:report");
    expect(rep.text).toMatch(/^Reported\./);
    expect(await db.query(`SELECT kind, value FROM safety_reports WHERE user_id=$1`, [u.id])).toEqual([{ kind: "link", value: "gtbank-verify.ng.xyz" }]);
    const ok = await say(u, "check this link https://www.bbc.co.uk/news");
    expect(ok.text).toMatch(/^No red flags found\./);
    expect(ok.text).not.toMatch(/\bsafe\b/i);
  });

  it("uses Google Safe Browsing when a key is set", async () => {
    process.env.SAFE_BROWSING_KEY = "sb_test";
    let body: any;
    mockFetch([[/safebrowsing\.googleapis\.com\/v4\/threatMatches:find\?key=sb_test/, (_u, init) => { body = JSON.parse(String(init!.body)); return json({ matches: [{ threatType: "SOCIAL_ENGINEERING", threat: { url: "http://cheap-deals.shop/login" } }] }); }]]);
    const u = await ensureUser(db, "telegram", "8002", "Lucas");
    const r = await say(u, "check this link http://cheap-deals.shop/login");
    expect(body.threatInfo.threatEntries).toEqual([{ url: "http://cheap-deals.shop/login" }]);
    expect(r.text).toMatch(/Google Safe Browsing lists cheap-deals\.shop as dangerous/);
    expect(r.text).toMatch(/Don't tap the link/);
  });

  it("looks crypto addresses up with GoPlus", async () => {
    const addr = "0x1234567890abcdef1234567890abcdef12345678";
    mockFetch([
      [/api\.gopluslabs\.io\/api\/v1\/address_security\/0x1234567890abcdef1234567890abcdef12345678\?chain_id=1$/, () => json({ code: 1, result: { phishing_activities: "1", stealing_attack: "1", cybercrime: "0" } })],
      [/api\.gopluslabs\.io\/api\/v1\/token_security\/1\?contract_addresses=/, () => json({ code: 1, result: {} })],
    ]);
    const u = await ensureUser(db, "telegram", "8003", "Mei");
    const r = await say(u, `check this address ${addr}`);
    expect(r.text).toMatch(/GoPlus has this address flagged for phishing, stealing funds/);
    expect(r.text).toMatch(/Don't send anything to that address/);
  });

  it("checks what was just forwarded, and warns the circle when someone reports it", async () => {
    const a = await ensureUser(db, "telegram", "8004", "Amaka");
    const b = await ensureUser(db, "telegram", "8005", "Bayo");
    await say(a, "Congratulations! You have won 5,000,000 naira in the MTN promo. Call +234 701 234 5678 and pay the processing fee to claim", { forwarded: true });
    const r = await say(a, "is this a scam");
    expect(r.text).toMatch(/won something you didn't enter/);
    expect(r.text).toMatch(/money up front/);
    expect((await say(a, "report this as a scam")).text).toMatch(/^Reported\./);
    const other = await say(b, "is +234 701 234 5678 a scam number");
    expect(other.text).toMatch(/Someone in your circle reported this number as a scam/);
    expect(other.text).not.toMatch(/Amaka/);
    const unknown = await say(b, "is +44 7700 900123 a scam number");
    expect(unknown.text).toMatch(/can't look phone numbers up/);
  });

  it("asks for the message when there's nothing to check, and reads the paste as the answer", async () => {
    const u = await ensureUser(db, "telegram", "8006", "Nia");
    expect((await say(u, "is this a scam")).text).toMatch(/^Paste the message/);
    expect((await say(u, "Your Netflix payment failed. Update your payment details within 24 hours: http://netflix-billing.help")).text).toMatch(/Red flags/);
  });
});

/* ---------------- contacts and check-ins ---------------- */

describe("safety contacts and check-ins", () => {
  let ada: User, tunde: User, bisi: User;
  beforeAll(async () => {
    ada = await ensureUser(db, "telegram", "9001", "Ada Obi");
    tunde = await ensureUser(db, "telegram", "9002", "Tunde Bakare");
    bisi = await ensureUser(db, "telegram", "9003", "Bisi Ade");
  });

  it("parses the ways people ask", () => {
    const now = new Date("2026-10-29T20:00:00Z");
    expect(parseCheckin("walking home, 25 min", "Africa/Lagos", now)).toEqual({ due: new Date("2026-10-29T20:25:00Z"), about: "walking home" });
    expect(parseCheckin("I'm in a taxi to the airport, in 40 minutes", "UTC", now).about).toBe("in a taxi to the airport");
    expect(parseCheckin("at 11pm", "Europe/London", now).due?.toISOString()).toBe("2026-10-29T23:00:00.000Z");
    expect(parseCheckin("on a first date", "UTC", now).due).toBeNull();
  });

  it("asks a lifeline contact with Yes and No, and only a yes makes them a contact", async () => {
    const r = await say(ada, "add my safety contact @tunde");
    expect(r.text).toMatch(/This asks tunde in lifeline to be your safety contact/);
    expect(tg).toHaveLength(0); // nothing reaches anyone before the yes
    await say(ada, "yes");
    const ask = tg.find((m) => m.to === "9002")!;
    expect(ask.text).toMatch(/Ada Obi would like you as a safety contact/);
    expect(ask.buttons?.map((b) => b.label)).toEqual(["Yes, I'll do it", "No, sorry"]);
    const yes = await handleCallback(db, await fresh(tunde), ask.buttons![0].data);
    expect(yes.text).toMatch(/^Thank you/);
    expect(tg.some((m) => m.to === "9001" && /Tunde said yes/.test(m.text))).toBe(true);
    expect((await handleCallback(db, await fresh(tunde), ask.buttons![0].data)).text).toMatch(/already answered/);
    // Bisi is asked but never answers.
    await say(ada, "add Bisi as my safety contact");
    await say(ada, "yes");
    expect(tg.some((m) => m.to === "9003")).toBe(true);
    // Someone who isn't the asked person can't press their button.
    const bisiAsk = tg.find((m) => m.to === "9003")!;
    expect((await handleCallback(db, await fresh(tunde), bisiAsk.buttons![0].data)).text).toMatch(/isn't there/);
  });

  it("asks an email contact, and only a YES from them counts; phones need texts switched on", async () => {
    config.inboundEmail = "lifeline@in.example.com";
    await say(ada, "add my safety contact ngozi@example.com");
    await say(ada, "yes");
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "ngozi@example.com", subject: "Ada Obi would like you as a safety contact" });
    expect(mails[0].text).toMatch(/reply to this email with YES/);
    expect((await say(ada, "my safety contacts")).text).toMatch(/ngozi@example\.com, hasn't answered yet/);
    expect(await handleTextChannel(db, "email", "Ngozi <ngozi@example.com>", "YES\n\n> quoted text")).toMatch(/You're Ada's safety contact now/);
    expect((await say(ada, "add my safety contact +44 7700 900123")).text).toMatch(/Texts aren't switched on here/);
    const list = (await say(ada, "my safety contacts")).text;
    expect(list).toMatch(/Tunde Bakare, said yes/);
    expect(list).toMatch(/ngozi@example\.com, said yes/);
    expect(list).toMatch(/Bisi Ade, hasn't answered yet/);
  });

  it("a check-in that ends with I'm safe sends nothing and deletes the location", async () => {
    const r = await say(ada, "check on me: walking home, 25 min", { now: NOW });
    expect(r.text).toMatch(/I'll check on you at \d\d:\d\d, walking home/);
    expect(r.text).toMatch(/I'll tell Tunde Bakare and ngozi@example\.com/);
    expect(r.text).toMatch(/doesn't replace emergency services/);
    expect(r.text).toMatch(/emergency number/);
    expect(r.buttons?.[0]).toMatchObject({ label: "I'm safe" });
    const loc = await pluginLocationHandlers()[0](db, await fresh(ada), { lat: 6.4541, lon: 3.3947, live: true }, NOW);
    expect(loc?.text).toMatch(/keep only the latest point/);
    expect((await briefExtras(db, await fresh(ada), NOW)).some((l) => /^Safety check-in running until \d\d:\d\d\.$/.test(l))).toBe(true);
    expect((await say(ada, "I'm safe")).text).toMatch(/^Glad you're safe/);
    const row = await db.one(`SELECT status, lat, lon FROM safety_checkins WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [ada.id]);
    expect(row).toMatchObject({ status: "safe", lat: null, lon: null });
    tg.length = 0; mails = [];
    await onlySafetyJobs();
    await runDue(deps(), later(120));
    expect(pushed).toHaveLength(0);
    expect(tg).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  it("a check-in that times out pings first, then alerts only confirmed contacts with the location", async () => {
    await say(ada, "I'm in a taxi to the airport, check on me in 40 minutes", { now: NOW });
    await pluginLocationHandlers()[0](db, await fresh(ada), { lat: 6.5774, lon: 3.3212, live: true }, later(10));
    await pluginLocationHandlers()[0](db, await fresh(ada), { lat: 6.5800, lon: 3.3300, live: true }, later(30));
    await onlySafetyJobs();
    await runDue(deps(), later(41));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ to: ada.id });
    expect(pushed[0].text).toMatch(/^Are you OK\? Tap I'm safe/);
    expect(tg).toHaveLength(0);
    pushed.length = 0;
    await runDue(deps(), later(52));
    const toTunde = pushed.find((p) => p.to === tunde.id)!;
    expect(toTunde.text).toMatch(/Ada Obi asked lifeline to check on them \(in a taxi to the airport\)/);
    expect(toTunde.text).toContain("https://maps.google.com/?q=6.58000,3.33000");
    expect(pushed.some((p) => p.to === bisi.id)).toBe(false);
    expect(mails.map((m) => m.to)).toEqual(["ngozi@example.com"]);
    expect(mails[0].text).toContain("maps.google.com");
    expect(pushed.find((p) => p.to === ada.id)?.text).toMatch(/I've let Tunde Bakare and ngozi@example\.com know/);
    // She taps I'm safe on the alert: the contacts hear she's OK, the location goes.
    const safe = (await fresh(ada)) && pushed.find((p) => p.to === ada.id)!.buttons![0].data;
    const r = await handleCallback(db, await fresh(ada), safe);
    expect(r.text).toMatch(/I've told Tunde Bakare and ngozi@example\.com you're OK/);
    expect(tg.some((m) => m.to === "9002" && /says they're safe now/.test(m.text))).toBe(true);
    expect((await db.one(`SELECT lat FROM safety_checkins WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [ada.id])).lat).toBeNull();
  });

  it("an alert nobody answers still deletes the location after two days", async () => {
    await say(ada, "check on me in 20 minutes", { now: NOW });
    await pluginLocationHandlers()[0](db, await fresh(ada), { lat: 51.5, lon: -0.12, live: false }, later(5));
    await onlySafetyJobs();
    await runDue(deps(), later(21));
    await runDue(deps(), later(32));
    expect((await db.one(`SELECT status, lat FROM safety_checkins WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [ada.id]))).toMatchObject({ status: "alerted", lat: 51.5 });
    await runDue(deps(), later(32 + 48 * 60 + 1));
    expect((await db.one(`SELECT status, lat FROM safety_checkins WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [ada.id]))).toEqual({ status: "expired", lat: null });
  });

  it("a plain \"I'm ok\" after the ping counts as safe, so nobody is alerted", async () => {
    await say(ada, "check on me in 20 minutes", { now: NOW });
    await onlySafetyJobs();
    expect((await say(ada, "I'm ok")).text).not.toMatch(/^Glad you're safe/); // before the ping it's just chat
    await runDue(deps(), later(21));
    expect(pushed.map((p) => p.text)).toEqual([expect.stringMatching(/^Are you OK\?/)]);
    expect((await say(ada, "yes I'm fine thanks")).text).toMatch(/^Glad you're safe/);
    pushed.length = 0;
    await runDue(deps(), later(40));
    expect(pushed).toHaveLength(0);
    expect(mails).toHaveLength(0);
  });

  it("writing to me after the ping, without tapping I'm safe, gets one more ask before anyone is told", async () => {
    await say(ada, "check on me in 20 minutes", { now: NOW });
    await onlySafetyJobs();
    await runDue(deps(), later(21));
    pushed.length = 0;
    await say(ada, "where's the nearest pharmacy");
    await runDue(deps(), later(32));
    expect(pushed.map((p) => [p.to, p.text])).toEqual([[ada.id, expect.stringMatching(/^You're here, but your check-in is still running\. Tap I'm safe if you are, or I'll let Tunde Bakare and ngozi@example\.com know at \d\d:\d\d\.$/)]]);
    expect(mails).toHaveLength(0);
    pushed.length = 0;
    await runDue(deps(), later(43));
    expect(pushed.some((p) => p.to === tunde.id && /haven't answered/.test(p.text))).toBe(true);
    // Cancelling after the alert tells the contacts it's over, rather than leaving them worried.
    tg.length = 0;
    expect((await say(ada, "cancel the check-in")).text).toMatch(/I've told Tunde Bakare and ngozi@example\.com you're OK/);
    expect(tg.some((m) => m.to === "9002" && /says they're safe now/.test(m.text))).toBe(true);
  });

  it("cancelling, extending, and leaving as a contact", async () => {
    await say(ada, "check in at 11pm", { now: NOW });
    expect((await say(ada, "give me 15 more minutes")).text).toMatch(/I'll check on you at \d\d:\d\d instead/);
    expect((await say(ada, "cancel the check-in")).text).toMatch(/Nothing will be sent/);
    await onlySafetyJobs();
    await runDue(deps(), later(24 * 60));
    expect(pushed).toHaveLength(0);
    expect((await say(tunde, "stop being a safety contact")).text).toMatch(/won't get safety alerts from Ada/);
    expect(tg.some((m) => m.to === "9001" && /can't be your safety contact any more/.test(m.text))).toBe(true);
    // With nobody confirmed, a check-in says it's only me.
    const r = await say(bisi, "check on me in 30 minutes");
    expect(r.text).toMatch(/only me checking on you/);
    await say(bisi, "cancel the check-in");
  });

  it("asks when, if no time was given", async () => {
    expect((await say(bisi, "check on me")).text).toMatch(/^When should I check on you\?/);
    expect((await say(bisi, "in 20 minutes")).text).toMatch(/^I'll check on you at/);
    await say(bisi, "cancel the check-in");
  });
});

/* ---------------- emergency card ---------------- */

describe("emergency card", () => {
  it("walks through it, pulls meds from the list, refuses ID numbers, copies cleanly", async () => {
    const u = await ensureUser(db, "telegram", "9101", "Lena Fischer");
    await say(u, "I'm taking Vitamin D at 8am and 8pm");
    expect((await say(u, "set up my emergency card")).text).toMatch(/Blood group\?/);
    expect((await say(u, "O+")).text).toMatch(/Any allergies\?/);
    expect((await say(u, "no known allergies")).text).toMatch(/conditions/);
    expect((await say(u, "next")).text).toMatch(/from my list.*Vitamin D/);
    expect((await say(u, "from my list")).text).toMatch(/Who should be called/);
    expect((await say(u, "Jonas (brother) +49 151 23456789")).text).toMatch(/Health plan/);
    const done = await say(u, "TK, passport C01X00T47");
    expect(done.text).toMatch(/emergency card is saved/);
    expect(done.text).toMatch(/government ID number/);
    const card = await say(u, "show my emergency card");
    expect(card.text).toContain("Blood group: O+");
    expect(card.text).toContain("Allergies: no known allergies");
    expect(card.text).toContain("Medications: Vitamin D");
    expect(card.text).not.toMatch(/passport|C01X00T47|Conditions/);
    expect(copyButton(card.text)?.label).toBe("Copy message");
    expect((await say(u, "my blood group is AB negative")).text).toMatch(/Blood group saved/);
    expect((await say(u, "show my emergency card")).text).toContain("Blood group: AB-");
    // Never in the brief.
    expect((await briefExtras(db, await fresh(u), new Date())).join(" ")).not.toMatch(/blood|allerg|Vitamin/i);
    expect((await say(u, "delete my emergency card")).text).toMatch(/deleted/);
    expect((await say(u, "show my emergency card")).text).toMatch(/don't have an emergency card/);
  });

  it("makes a lock-screen picture only when asked, phone-sized, with only what's on the card", async () => {
    const u = await ensureUser(db, "telegram", "9102", "Kwame Mensah");
    expect((await say(u, "lock screen card")).text).toMatch(/don't have an emergency card yet/);
    await say(u, "my blood group is B+");
    await say(u, "emergency card allergies: penicillin");
    const card = await say(u, "show my emergency card");
    expect(card.image).toBeUndefined(); // the text card stays as it was; the picture is opt-in
    expect(card.buttons).toContainEqual({ label: "Make it a lock-screen picture", data: "say:emergency card picture" });
    for (const s of ["emergency card picture", "lock screen card", "make my emergency card a wallpaper"]) expect(parseByRules(s)?.action, s).toBe("emergency.card_picture");
    const pic = await say(u, "emergency card picture");
    expect(pic.text).toMatch(/lock-screen picture/);
    expect(pic.text).toMatch(/top is left clear for the clock/);
    expect(pic.image?.mime).toBe("image/png");
    expect(pic.file).toMatchObject({ name: "emergency-card.png", mime: "image/png" });
    const png = Buffer.from(pic.file!.data, "base64");
    expect(pngSize(png)).toEqual({ width: 1080, height: 2340 });
    const svg = lockScreenSvg({ name: "Kwame Mensah", fields: [{ label: "Blood group", value: "B+" }, { label: "Allergies", value: "penicillin" }], updated: "30 Oct 2026" });
    expect(svg).toContain("B+");
    expect(svg).not.toMatch(/Medications|Health plan|Conditions/);
    // Nothing drawn in the clock's third of the screen apart from the background.
    const ys = [...svg.matchAll(/<(?:text|rect|line)[^>]*?\sy1?="(\d+(?:\.\d+)?)"/g)].map((m) => Number(m[1])).filter((y) => y > 0);
    expect(Math.min(...ys)).toBeGreaterThan(2340 / 3);
  });
});

/** Reads a PNG properly: checks the signature and every chunk's CRC, inflates the pixels, and returns the size from IHDR. */
function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true);
  let off = 8, width = 0, height = 0, bpp = 0;
  const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off), type = png.subarray(off + 4, off + 8).toString("latin1"), data = png.subarray(off + 8, off + 8 + len);
    expect(png.readUInt32BE(off + 8 + len)).toBe(zlib.crc32(png.subarray(off + 4, off + 8 + len)));
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); bpp = ({ 2: 3, 6: 4, 0: 1, 4: 2 } as Record<number, number>)[data[9]] * (data[8] / 8); }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
    if (type === "IEND") break;
  }
  expect(zlib.inflateSync(Buffer.concat(idat)).length).toBe(height * (1 + width * bpp));
  return { width, height };
}

/* ---------------- legacy plan ---------------- */

describe("if something happens to me", () => {
  it("refuses passwords, seed phrases and keys, and keeps where-to-find notes", async () => {
    expect(looksSecret("my bank password is Tolu1987!")).toBe("a password");
    expect(looksSecret("abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe("a seed phrase");
    expect(looksSecret("my seed phrase: one two three")).toBe("a seed phrase");
    expect(looksSecret(`0x${"ab".repeat(32)}`)).toBe("a private key");
    expect(looksSecret("the passwords are in 1Password and the emergency kit is in the safe")).toBeNull();
    expect(looksSecret("the password is in the blue notebook")).toBeNull();
    expect(looksSecret("please tell my sister that i love her and that she was always right about the garden")).toBeNull();
    const u = await ensureUser(db, "telegram", "9201", "Sara Haddad");
    const r = await say(u, "legacy note for omar@example.com: wallet seed phrase is abandon ability able about above absent absorb abstract absurd abuse access accident");
    expect(r.text).toMatch(/I haven't kept it\. I never store passwords, seed phrases or private keys/);
    expect(await db.query(`SELECT * FROM safety_legacy_items WHERE user_id=$1`, [u.id])).toHaveLength(0);
  });

  it("confirms exactly who gets what, pings three times, resets on any message, then sends", async () => {
    const sara = await ensureUser(db, "telegram", "9202", "Sara Haddad");
    const omar = await ensureUser(db, "telegram", "9203", "Omar Haddad");
    expect((await say(sara, "if something happens to me, tell leila@example.com: I love you. The cat goes to Bisi.")).text).toMatch(/^Kept for leila@example\.com\. Nothing is sent now/);
    expect((await say(sara, "legacy note for Omar: the deed is in the blue folder in my desk")).text).toMatch(/^Kept for Omar Haddad/);
    expect((await say(sara, "turn on my legacy plan after 7 days")).text).toMatch(/shortest window is 14 days/);
    const echo = await say(sara, "30");
    expect(echo.text).toMatch(/turns on your legacy plan/);
    expect(echo.text).toMatch(/leila@example\.com \(by email\): a message, "I love you\. The cat goes to Bisi\."/);
    expect(echo.text).toMatch(/Omar Haddad \(in lifeline\): a note/);
    expect(echo.buttons?.[0].label).toBe("Yes, go ahead");
    expect((await say(sara, "yes")).text).toMatch(/^Your legacy plan is on/);
    expect((await say(sara, "legacy status")).text).toMatch(/^Legacy plan: on, next check by \w{3} \d{1,2} \w{3}/);
    expect((await briefExtras(db, await fresh(sara), new Date())).join(" ")).not.toMatch(/legacy/i);

    await onlySafetyJobs();
    // No quiet hours here: check-ins wait for waking hours, and these times fall wherever the clock is.
    await db.query(`UPDATE users SET quiet_start=0, quiet_end=0 WHERE id=$1`, [sara.id]);
    const sweep = async (t: Date) => { await schedule(db, { kind: "safety_legacy_sweep", runAt: t }); await runDue(deps(), t); };
    const pingsTo = () => pushed.filter((p) => p.to === sara.id);
    const day = (n: number, base = Date.now()) => new Date(base + n * 86_400_000);

    await sweep(day(20));
    expect(pingsTo()).toHaveLength(0); // still inside the window
    await sweep(day(31));
    expect(pingsTo()).toHaveLength(1);
    expect(pingsTo()[0].text).toMatch(/30 days since I heard from you/);
    // Any message resets everything.
    await say(sara, "hello, I'm back from the retreat");
    await sweep(new Date(day(31).getTime() + 3_600_000));
    expect((await db.one(`SELECT stage FROM safety_legacy WHERE user_id=$1`, [sara.id])).stage).toBe(0);
    await sweep(day(40));
    expect(pingsTo()).toHaveLength(1);

    const t0 = new Date(day(31).getTime() + 3_600_000).getTime();
    await sweep(day(30.1, t0));
    expect(pingsTo()).toHaveLength(2);
    await sweep(day(31, t0)); // too soon for the second
    expect(pingsTo()).toHaveLength(2);
    await sweep(day(32.2, t0));
    expect(pingsTo()[2].text).toMatch(/^Checking in again/);
    await sweep(day(34.3, t0));
    expect(pingsTo()[3].text).toMatch(/^Last check\. If I don't hear from you in the next 3 days/);
    expect(mails).toHaveLength(0);
    expect(pushed.some((p) => p.to === omar.id)).toBe(false);
    await sweep(day(37.4, t0));
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: "leila@example.com", subject: "A message from Sara Haddad" });
    expect(mails[0].text).toMatch(/I love you\. The cat goes to Bisi\./);
    expect(pushed.find((p) => p.to === omar.id)?.text).toMatch(/Where to find things, from Sara:\n\nthe deed is in the blue folder/);
    expect((await say(sara, "legacy status")).text).toMatch(/^Legacy plan: sent on/);
  });

  it("the I'm here button resets, pause holds everything, cancel deletes", async () => {
    const u = await ensureUser(db, "telegram", "9204", "Yusuf Ali");
    await say(u, "legacy message for amina@example.com: thank you for everything");
    await say(u, "start my legacy plan");
    await say(u, "yes");
    await db.query(`UPDATE safety_legacy SET stage=2, stage_at=now() WHERE user_id=$1`, [u.id]);
    expect((await handleCallback(db, await fresh(u), "sf:lg:here")).text).toMatch(/Everything's reset/);
    expect((await db.one(`SELECT stage FROM safety_legacy WHERE user_id=$1`, [u.id])).stage).toBe(0);
    expect((await say(u, "pause my legacy plan")).text).toMatch(/paused/);
    await onlySafetyJobs();
    await schedule(db, { kind: "safety_legacy_sweep", runAt: later(60 * 24 * 90) });
    await runDue(deps(), later(60 * 24 * 90));
    expect(pushed.filter((p) => p.to === u.id)).toHaveLength(0);
    expect((await say(u, "legacy status")).text).toMatch(/^Legacy plan: paused/);
    expect((await say(u, "cancel my legacy plan")).text).toMatch(/cancelled/);
    expect(await db.query(`SELECT * FROM safety_legacy_items WHERE user_id=$1`, [u.id])).toHaveLength(0);
  });
});

/* ---------------- incident log ---------------- */

describe("incident log", () => {
  it("chains hashes, shows, exports by email, spots tampering, and deletes only after a yes", async () => {
    const u = await ensureUser(db, "telegram", "9301", "Priya Nair");
    await db.query(`UPDATE users SET prefs = prefs || '{"emailVerified":"priya@example.com"}'::jsonb WHERE id=$1`, [u.id]);
    expect((await say(u, "log incident: my manager shouted at me in front of the team again")).text).toMatch(/^Logged, .+\. That's entry 1/);
    await say(u, "log incident: landlord entered the flat without notice while I was at work");
    await say(u, "log incident: vendor refused a refund for the broken fridge, said 'not our problem'");
    const rows = await db.query(`SELECT * FROM safety_incidents WHERE user_id=$1 ORDER BY seq`, [u.id]);
    expect(rows.map((r: any) => r.seq)).toEqual([1, 2, 3]);
    expect(rows[0].prev_hash).toBe(GENESIS);
    expect(rows[1].prev_hash).toBe(rows[0].hash);
    expect(rows[2].prev_hash).toBe(rows[1].hash);
    expect(rows[0].hash).toBe(entryHash(1, new Date(rows[0].logged_at).toISOString(), rows[0].text, GENESIS));
    expect(verifyChain(rows)).toBeNull();

    const show = await say(u, "show my incident log");
    expect(show.text).toMatch(/3 entries/);
    const exp = await say(u, "export my incident log");
    expect(exp.text).toMatch(/^The chain checks out/);
    expect(exp.text).toMatch(/attached as a PDF, 3 entries/);
    expect(exp.text).not.toContain("sha256:"); // the reply stays short; the hashes are in the PDF and the email
    expect(exp.text).toMatch(/emailed a copy to priya@example\.com/);
    expect(exp.file).toMatchObject({ mime: "application/pdf" });
    expect(exp.file!.name).toMatch(/^incident-log-\d{4}-\d{2}-\d{2}\.pdf$/);
    const pdf = Buffer.from(exp.file!.data, "base64");
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(1);
    expect(mails[0]).toMatchObject({ to: "priya@example.com", subject: "Your incident log" });
    expect(mails[0].text).toContain(`sha256: ${rows[2].hash}`);

    await db.query(`UPDATE safety_incidents SET text='nothing happened' WHERE user_id=$1 AND seq=2`, [u.id]);
    expect((await say(u, "verify my incident log")).text).toMatch(/^Entry 2 doesn't match/);

    expect((await briefExtras(db, await fresh(u), new Date())).join(" ")).not.toMatch(/incident|landlord/i);
    const ask = await say(u, "delete my incident log");
    expect(ask.text).toMatch(/deletes your whole incident log for good/);
    expect(await db.query(`SELECT * FROM safety_incidents WHERE user_id=$1`, [u.id])).toHaveLength(3);
    expect((await say(u, "yes")).text).toMatch(/deleted, all 3 entries/);
    expect(await db.query(`SELECT * FROM safety_incidents WHERE user_id=$1`, [u.id])).toHaveLength(0);
  });

  it("builds a PDF that wraps long entries onto new pages, keeps the hashes, and hands over the exact text when a script isn't in the font", async () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({ seq: i + 1, when: `Mon ${i + 1} Jun 2026, 09:00`, text: i === 4 ? "The landlord came in again without notice and took photos of my room. ".repeat(70) : `Entry ${i + 1}: the vendor would not refund the deposit.`, hash: String(i).repeat(64).slice(0, 64) }));
    const one = await incidentPdf({ name: "Amara Okafor", exported: "Tue 30 Jun 2026, 10:00", tz: "Africa/Lagos", status: "The chain checks out.", entries: entries.slice(0, 2) });
    expect(Buffer.from(one.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(one.pages).toBe(1);
    const many = await incidentPdf({ name: null, exported: "Tue 30 Jun 2026, 10:00", tz: "Africa/Lagos", status: "The chain checks out.", entries });
    expect(many.pages).toBeGreaterThanOrEqual(3); // one very long entry spills over two pages on its own
    const doc = await PDFDocument.load(many.bytes);
    expect(doc.getPageCount()).toBe(many.pages);
    expect(doc.getTitle()).toBe("Incident log");
    expect(many.missing).toBe(false);
    // A script no font on any machine here has (Egyptian hieroglyphs): still a PDF, and the export says so and gives the exact text.
    const glyphs = "\u{13000}\u{13001}\u{13002}";
    const odd = await incidentPdf({ name: "Li Hua", exported: "x", tz: "Asia/Shanghai", status: "ok", entries: [{ seq: 1, when: "x", text: `the landlord wrote ${glyphs} on the door`, hash: "a".repeat(64) }] });
    expect(Buffer.from(odd.bytes).subarray(0, 5).toString()).toBe("%PDF-");
    expect(odd.missing).toBe(true);
    const u = await ensureUser(db, "telegram", "9303", "Li Hua");
    await say(u, `log incident: the landlord wrote ${glyphs} on the door`);
    const exp = await say(u, "export my incident log");
    expect(exp.file?.mime).toBe("application/pdf");
    expect(exp.text).toMatch(/aren't in the PDF's font, so here is the exact text too/);
    expect(exp.text).toContain(glyphs);
  });

  it("undo only takes back the newest entry", async () => {
    const u = await ensureUser(db, "telegram", "9302", "Diego Ruiz");
    const d = await propose({ db, user: u, now: new Date() }, "incident.log", { text: "the neighbour threatened me on the stairs" });
    expect(d.kind).toBe("ran");
    expect((await say(u, "undo")).text).toMatch(/Taken out of your incident log/);
  });
});
