import { describe, expect, it } from "vitest";
import { pluginExamples } from "../src/core/plugins.js";
import "../src/modules/index.js";
import { allActions } from "../src/policy/registry.js";
import { parseByRules } from "../src/intent/rules.js";
import { parseLoose, normalise, splitTime } from "../src/intent/loose.js";

const NOW = new Date("2026-10-26T10:00:00Z");
const parse = (s: string) => parseByRules(s) ?? parseLoose(s, NOW);

/** One ordinary sentence per action. If an action is added without a sentence here, this test fails. */
const SENTENCES: Record<string, string[]> = {
  "image.draw": ["draw a lion in agbada", "draw me a sunset over Lagos", "make a picture of a cat in sunglasses", "generate an image of Pip as an astronaut"],
  "web.search": ["search who won the match last night", "google the price of a PS5", "look up opening hours for Shoprite Lekki"],
  "speech.settings": ["voice replies always", "voice replies off", "text only", "use a calm voice", "talk to me"],
  "speech.say": ["read that to me", "say that out loud"],
  "email.me": ["email me my shopping list", "email me my brief", "mail me the todo list"],
  "settings.verify_email": ["verify 482913", "code 482913"],
  "settings.city": ["I live in Berlin", "my city is Toronto", "I moved to Manila"],
  "email.send": ["email ada@example.com saying I'll be ten minutes late"],
  "game.play": ["play a game", "i'm bored", "quiz me", "trivia about football", "give me a riddle", "would you rather"],
  "fun.decide": ["flip a coin", "heads or tails?", "pick for me: jollof or fried rice", "pizza or suya, pick for me"],
  "fun.roll": ["roll a dice", "roll", "darts", "slots"],
  "fun.eightball": ["8 ball will I pass my exam", "magic 8 ball"],
  "fun.roast": ["roast me", "roast me about my spending"],
  "fun.hype": ["hype me up", "hype me up for my interview"],
  "fun.wrapped": ["my week wrapped", "how was my week", "wrapped"],
  "cycle.start": ["my period started today", "my period started yesterday", "started my period", "my period started on monday"],
  "cycle.end": ["my period ended", "period's over", "my period ended yesterday"],
  "cycle.log": ["cramps today", "heavy flow", "spotting", "headache and bloating", "took my pill", "took a pregnancy test: negative"],
  "cycle.status": ["when is my next period", "where am I in my cycle", "am I late", "fertile window"],
  "cycle.settings": ["my cycle is usually 30 days", "periods last 6 days", "stop period reminders", "don't put my cycle in the brief"],
  "cycle.forget": ["forget my cycle data", "delete my period history"],
  "measure.log": ["weight 72kg", "I weigh 72.4 kg", "slept 7 hours", "slept 6h30", "drank 2 litres of water", "8 glasses of water", "mood 4/5", "mood: tired", "bp 120/80", "10000 steps", "benched 80kg x5", "did my skincare routine"],
  "measure.show": ["how's my weight", "my sleep this week", "water this month"],
  "measure.list": ["what am I tracking"],
  "measure.forget": ["delete my weight entries"],
  "reminder.create": ["can you remind me to call Ada tomorrow at 9am", "don't let me forget rent on the 1st", "ping me about the standup in 20 minutes"],
  "reminder.list": ["what are my reminders", "reminders"],
  "reminder.delete": ["cancel the reminder about rent", "delete reminder 3"],
  "calendar.add": ["schedule dentist on friday at 3pm", "I have a meeting with Tolu tomorrow 2pm", "dinner with Ada saturday 7pm"],
  "calendar.list": ["what do I have today", "am I free tomorrow", "my schedule this week", "what's on this week"],
  "calendar.delete": ["cancel event #4", "delete the meeting 9"],
  "calendar.import_ics": [], // file upload only
  "medication.add": ["I'm taking Vitamin D at 8am and 8pm", "meds: amoxicillin at 7am, 3pm and 11pm"],
  "medication.list": ["what meds am I on", "my meds"],
  "medication.delete": ["stop med #2", "I'm off the pills #3"],
  "class.add": ["I have a class Algorithms on tuesday at 10:00 to 12:00 in Room 4", "class Databases on wed 2pm"],
  "class.list": ["my timetable", "classes"],
  "assignment.add": ["I have an assignment Lab 3 due next monday", "there's an exam on networks due dec 2"],
  "assignment.done": ["I submitted the assignment for Lab 3", "done assignment Lab 3"],
  "trip.create": ["I'm going to Accra on dec 20 until dec 27 with a budget of 600 usd", "plan a trip to Nairobi"],
  "trip.add_item": ["add a flight LOS-ACC to the trip on dec 20 7am", "booked the hotel Labadi Beach for my trip"],
  "trip.tick": ["packed the charger", "packed passport"],
  "trip.show": ["show my trip", "trip"],
  "habit.add": ["track habit gym 4x/week", "start tracking reading 5 times a week"],
  "habit.checkin": ["I went to the gym", "did gym yesterday", "worked out", "ran today"],
  "habit.list": ["my habits", "streaks"],
  "hackathon.news": ["send me new hackathons", "stop hackathons", "no more hackathon messages"],
  "spend.log": ["I spent 4500 naira on data", "paid $20 for lunch", "spent 2k on fuel"],
  "spend.summary": ["how much did I spend this week", "expenses month"],
  "note.add": ["note: the wifi password is behind the router", "jot down call the landlord"],
  "note.search": ["find notes about wifi", "search notes landlord"],
  "memory.remember": ["remember that I'm vegetarian", "keep in mind I hate early meetings"],
  "memory.forget": ["forget what I said about early meetings", "forget vegetarian"],
  "memory.list": ["what do you know about me", "show my memory"],
  "date.add": ["Ada's birthday is march 14", "countdown to visa appointment on dec 3", "our anniversary is june 9"],
  "date.list": ["upcoming birthdays", "dates"],
  "weather": ["what's the weather like in Lagos tomorrow", "weather Libreville", "is it going to rain in London today"],
  "fx": ["100 usd to ngn", "convert 50 pounds to naira", "how much is 2 sol in usd"],
  "summarize": ["summarize https://example.com/post", "tldr https://x.com/a/status/1"],
  "hackathon.discover": ["any hackathons for solana", "find me hackathons", "hackathons ai"],
  "hackathon.set_interests": ["I'm into solana, ai and defi", "interests: devtools, payments"],
  "hackathon.track": ["I'm entering Colosseum Frontier due nov 30", "track NEAR hackathon deadline nov 14"],
  "hackathon.update": ["submitted Frontier", "I won the NEAR hackathon", "got paid for Frontier"],
  "hackathon.ledger": ["my ledger", "what have I entered"],
  "price.check": ["what's sol right now", "how much is btc", "price eth sol"],
  "price.alert": ["let me know when sol goes above 250", "alert me if eth drops below 2k", "tell me when btc moves 5% in 6h"],
  "wallet.add": ["watch my wallet 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU on solana as main", "watch wallet 0x1234567890abcdef1234567890abcdef12345678 on base"],
  "portfolio": ["my portfolio", "what do I hold"],
  "jobs.watch": ["watch jobs at lever dorahacks for growth", "follow greenhouse stripe matching solana, bd"],
  "jobs.list": ["any new jobs", "jobs"],
  "launch.discover": ["what's launching", "new repos on github", "launches showhn"],
  "launch.contact": ["contact @gakonst", "how do I reach vbuterin"],
  "scout.find": ["who's building perps on solana", "find projects in ai agents for partnerships", "scout fintech africa to apply"],
  "scout.watch": ["keep scouting solana perps for partnerships", "watch scout ai agents"],
  "scout.draft_outreach": ["draft an outreach to Perpz about integrating their SDK", "outreach Perpz: want to integrate your SDK"],
  "bill.billers": ["which billers for airtime", "billers data"],
  "bill.pay": ["pay 2000 naira to BIL099 for 08012345678", "top up 1,500 airtime to BIL099 for 08012345678"],
  "bill.history": ["my bill history", "what bills have I paid"],
  "trading.follow_wallet": ["copy wallet 0x38e598961dd0456a7fb2e758bd433d3e59fb8a4a on polymarket max 10/trade 50/day", "follow 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU on pumpfun"],
  "trading.unfollow": ["stop following 7xKXtg", "unfollow whale"],
  "trading.shadow_report": ["how's the copy trading going", "shadow report"],
  "persona.set": ["talk like a tired pirate who loves spreadsheets", "switch your voice to degen", "be more formal", "voice coach"],
  "settings.update": ["my timezone is Europe/London", "send my digest at 8", "my email is sage@example.com", "timezone Africa/Lagos"],
  "digest.now": ["what's my day looking like", "brief me", "digest"],
  "list.add": ["add rice and eggs to my shopping list", "add call the bank to my todo list", "I need to buy milk, eggs and bread", "I have to do taxes and call the bank", "add rice to my shopping list", "todo: ship the deck"],
  "list.done": ["bought milk", "finished taxes", "crossed off call the bank"],
  "list.show": ["what's on my shopping list", "my todos", "lists"],
};

// Modules register their own example sentences (src/core/plugins.ts addExamples); they're checked the same way.
for (const [a, s] of Object.entries(pluginExamples())) SENTENCES[a] = [...(SENTENCES[a] ?? []), ...s];

describe("every action is reachable from ordinary sentences", () => {
  const actions = allActions().filter((a) => a.tier !== 3).map((a) => a.name);

  it("has example sentences for every registered action", () => {
    const missing = actions.filter((a) => !(a in SENTENCES));
    expect(missing).toEqual([]);
    const stale = Object.keys(SENTENCES).filter((a) => !actions.includes(a));
    expect(stale).toEqual([]);
  });

  for (const [action, sentences] of Object.entries(SENTENCES)) {
    for (const s of sentences) {
      it(`${action} ← "${s}"`, () => {
        const i = parse(s);
        expect(i, `no parse for "${s}"`).not.toBeNull();
        expect(i!.action).toBe(action);
        const a = allActions().find((x) => x.name === action)!;
        const ok = a.schema.safeParse(i!.args);
        expect(ok.success, `bad args for "${s}": ${JSON.stringify(i!.args)} ${ok.success ? "" : ok.error.issues[0]?.message}`).toBe(true);
      });
    }
  }
});

describe("loose parsing details", () => {
  it("strips politeness and keeps the ask", () => {
    expect(normalise("Hey, could you please remind me to stretch, thanks!")).toBe("remind me to stretch");
  });
  it("lifts the time out of a sentence", () => {
    expect(splitTime("call Ada tomorrow at 9am about the deck", NOW)).toEqual({ when: "tomorrow at 9am", rest: "call Ada about the deck" });
  });
  it("extracts arguments correctly", () => {
    expect(parse("can you remind me to call Ada tomorrow at 9am")?.args).toEqual({ text: "call Ada", when: "tomorrow at 9am" });
    expect(parse("I spent 2k on fuel")?.args).toMatchObject({ amount: 2000, currency: "NGN", category: "fuel" });
    expect(parse("paid $20 for lunch")?.args).toMatchObject({ amount: 20, currency: "USD" });
    expect(parse("let me know when sol goes above 250")?.args).toEqual({ coin: "sol", op: "above", target: 250 });
    expect(parse("alert me if eth drops below 2k")?.args).toEqual({ coin: "eth", op: "below", target: 2000 });
    expect(parse("I'm going to Accra on dec 20 until dec 27 with a budget of 600 usd")?.args).toEqual({ destination: "Accra", start: "dec 20", end: "dec 27", budget: 600, currency: "USD" });
    expect(parse("who's building perps on solana")?.args).toEqual({ niche: "perps on solana", objective: undefined });
    expect(parse("I need to buy milk, eggs and bread")?.args).toEqual({ list: "shopping", items: ["milk", "eggs", "bread"] });
    expect(parse("talk like a tired pirate who loves spreadsheets")?.args).toEqual({ custom: "tired pirate who loves spreadsheets" });
    expect(parse("be more formal")?.args).toEqual({ preset: "butler" });
  });
  it("does not misfire on chat", () => {
    for (const s of ["I spent the weekend in Lagos", "what do you think about my plan", "lol that's wild", "thanks", "how are you"]) {
      const i = parse(s);
      expect(i, `misfire on "${s}": ${JSON.stringify(i)}`).toBeNull();
    }
  });
});

describe("tool selection keeps model calls small", () => {
  it("picks relevant tools, caps the count, never includes tier 3", async () => {
    const { selectTools } = await import("../src/intent/select.js");
    const rem = selectTools("can you remind me to call Ada tomorrow at 9am").map((a) => a.name);
    expect(rem[0]).toBe("reminder.create");
    expect(rem.length).toBeLessThanOrEqual(12);
    const hack = selectTools("any good hackathons for solana this month?").map((a) => a.name);
    expect(hack).toContain("hackathon.discover");
    expect(hack).not.toContain("bill.pay");
    const chat = selectTools("can we talk about this later").map((a) => a.name);
    expect(chat.length).toBeLessThanOrEqual(12);
    expect(chat).toContain("reminder.create"); // "later" is a reminder cue; chat still carries the small default set
    expect(selectTools("lol ok").every((a) => a.tier !== 3)).toBe(true);
    const scout = selectTools("who's building perps on solana?").map((a) => a.name);
    expect(scout).toContain("scout.find");
  });
  it("chat fallback talks like a person, not a menu", async () => {
    const { chatFallback } = await import("../src/intent/index.js");
    expect(chatFallback("can we talk about this later", true)).toMatch(/whenever you're ready|No rush/);
    expect(chatFallback("hey", false)).not.toContain("•");
    expect(chatFallback("what do you think about solana?", false)).toContain("/help");
    expect(chatFallback("what do you think about solana?", true)).toContain("think that one through");
  });
});

describe("tool selection and smalltalk", () => {
  it("sends a small, relevant tool set instead of all of them", async () => {
    const { selectTools } = await import("../src/intent/model.js");
    const names = (s: string) => selectTools(s).map((a) => a.name);
    expect(names("can you remind me about rent on friday")).toContain("reminder.create");
    expect(names("can you remind me about rent on friday").length).toBeLessThanOrEqual(16);
    expect(names("who's building payments on base")).toContain("scout.find");
    expect(names("let me know when btc goes above 100k")).toContain("price.alert");
    expect(names("lol that's wild").length).toBeLessThanOrEqual(6); // generic fallback set only
    expect(names("lol that's wild")).toContain("note.add");
  });
  it("answers small talk without a model and never shows the command wall for it", async () => {
    const { smalltalk } = await import("../src/intent/smalltalk.js");
    expect(smalltalk("can we talk about this later")).toMatch(/ready|rush|say the word/i);
    expect(smalltalk("thanks!")).toBeTruthy();
    expect(smalltalk("how far", { persona: "pidgin" })).toMatch(/How far/);
    expect(smalltalk("hey", { persona: "pidgin" })).toMatch(/How far/);
    expect(smalltalk("remind me to call Ada")).toBeNull();
  });
});
