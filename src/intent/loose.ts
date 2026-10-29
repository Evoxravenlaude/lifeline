/**
 * Loose natural-language layer. Sits between the strict command rules and
 * the model: it understands ordinary sentences ("can you remind me about
 * rent on the 1st", "how much is sol right now", "I spent 4500 naira on
 * data", "who's building perps on solana?") without a model key, and gives
 * the model a cheaper first pass when there is one.
 *
 * Approach: normalise politeness, find the time expression with chrono and
 * lift it out, then match intent families by cue words and build the action
 * arguments from what's left. Every registered Tier 1/2 action is reachable
 * from here (test/coverage.test.ts proves it).
 */
import * as chrono from "chrono-node";
import type { Intent } from "./rules.js";
import { PERSONAS } from "./persona.js";

const FILLER = /^(?:hey|hi|yo|ok|okay|so|um|please|pls|plz|kindly|can you|could you|would you|will you|i want you to|i need you to|i'?d like you to|help me|let'?s|just)\s*,?\s+/i;
const TRAIL = /(?:\s*,?\s*(?:please|pls|plz|thanks|thank you|for me|ok)|[?.!,])+\s*$/i;

export function normalise(text: string): string {
  let t = text.trim().replace(/\s+/g, " ");
  for (let i = 0; i < 4; i++) t = t.replace(FILLER, "");
  return t.replace(TRAIL, "").trim();
}

/** Lift the first time/date expression out of a sentence. */
export function splitTime(text: string, now = new Date()): { when: string | null; rest: string } {
  const r = chrono.parse(text, now, { forwardDate: true })[0];
  if (!r) return { when: null, rest: text };
  const before = text.slice(0, r.index).replace(/\s+(?:at|on|by|for|around|in|this|next|every)\s*$/i, "");
  const after = text.slice(r.index + r.text.length);
  return { when: r.text, rest: `${before} ${after}`.replace(/\s+/g, " ").trim() };
}

const strip = (s: string, ...res: RegExp[]) => res.reduce((a, re) => a.replace(re, ""), s).replace(/\s+/g, " ").trim();
const cur = (s?: string) => {
  const v = (s ?? "").toLowerCase();
  if (!v) return undefined;
  if (/naira|ngn|₦/.test(v)) return "NGN";
  if (/dollar|usd|\$/.test(v)) return "USD";
  if (/pound|gbp|£/.test(v)) return "GBP";
  if (/cfa|xaf/.test(v)) return "XAF";
  if (/euro|eur|€/.test(v)) return "EUR";
  return v.toUpperCase().slice(0, 3);
};
const COIN = /\b(btc|bitcoin|eth|ethereum|sol|solana|bnb|usdc|usdt|ton|hype|bonk|wif|jup|arb|op|matic|pol)\b/i;

type Rule = { test: RegExp; build: (t: string, m: RegExpMatchArray, now: Date) => Intent | null };

const MEASURE_NAMES = "weight|sleep|water|mood|steps|blood pressure|bp|bench(?: press)?|squat|deadlift|heart rate|blood sugar|skincare|skin ?care|hair ?care";

const RULES: Rule[] = [
  // ---- cycle (before memory, so "forget my cycle data" isn't read as a memory) ----
  { test: /^(?:forget|delete|clear|wipe)\s+(?:all\s+)?(?:of\s+)?my\s+(?:cycle|period|menstrual)\s+(?:data|history|tracking|logs?)$/i, build: () => ({ action: "cycle.forget", args: {} }) },
  { test: /^(?:my\s+)?period\s+(?:started|came|began|is here|arrived|just started|has started)(?:\s+(.+))?$|^(?:i\s+)?(?:started|got)\s+my\s+period(?:\s+(.+))?$|^(?:i'?m|i am)\s+on\s+my\s+period(?:\s+(?:since\s+)?(.+))?$/i,
    build: (_t, m) => { const w = m[1] ?? m[2] ?? m[3]; return { action: "cycle.start", args: w ? { when: w } : {} }; } },
  { test: /^(?:my\s+)?period\s+(?:ended|stopped|finished|is over|has ended|has stopped)(?:\s+(.+))?$|^(?:my\s+)?period'?s\s+(?:over|done|finished)(?:\s+(.+))?$/i,
    build: (_t, m) => { const w = m[1] ?? m[2]; return { action: "cycle.end", args: w ? { when: w } : {} }; } },
  { test: /^(?:when(?:'s| is| will be)\s+my\s+next\s+period|when\s+will\s+my\s+period\s+(?:come|start)|where\s+am\s+i\s+in\s+my\s+cycle|am\s+i\s+late|is\s+my\s+period\s+late|(?:show\s+)?my\s+cycle|cycle\s+status|how\s+long\s+(?:until|till)\s+my\s+(?:next\s+)?period|(?:my\s+)?fertile\s+window|when\s+am\s+i\s+(?:fertile|ovulating)|when\s+do\s+i\s+ovulate)$/i,
    build: () => ({ action: "cycle.status", args: {} }) },
  { test: /^my\s+cycle\s+is\s+(?:usually\s+|normally\s+|about\s+|around\s+)?(\d{2})\s+days?(?:\s+long)?$/i, build: (_t, m) => ({ action: "cycle.settings", args: { avg_length: Number(m[1]) } }) },
  { test: /^(?:my\s+)?periods?\s+(?:usually\s+|normally\s+)?lasts?\s+(?:about\s+|around\s+)?(\d{1,2})\s+days?$/i, build: (_t, m) => ({ action: "cycle.settings", args: { period_length: Number(m[1]) } }) },
  { test: /^(stop|turn off|pause|no more|start|turn on|resume)\s+(?:my\s+)?(?:period|cycle)\s+reminders$/i, build: (_t, m) => ({ action: "cycle.settings", args: { reminders: /^(?:start|turn on|resume)$/i.test(m[1]) } }) },
  { test: /^(don'?t|do not|stop)?\s*(?:put|show|include|putting|showing|including)\s+my\s+cycle\s+in\s+the\s+(?:morning\s+)?(?:brief|digest)$/i, build: (_t, m) => ({ action: "cycle.settings", args: { in_brief: !m[1] } }) },
  { test: /^(?:i\s+)?took\s+(?:an?\s+)?(pregnancy|ovulation)\s+test[:,]?\s*(?:it(?:'s| was)\s+)?(.*)$/i, build: (_t, m) => ({ action: "cycle.log", args: { what: `${m[1].toLowerCase()} test${m[2] ? `: ${m[2]}` : ""}` } }) },
  { test: /^(?:i\s+)?took\s+my\s+((?:birth control|contraceptive)\s+)?pill(?:\s+(today|yesterday|this morning|last night))?$/i, build: (_t, m) => ({ action: "cycle.log", args: { what: `took my ${m[1] ?? ""}pill`.replace(/\s+/g, " "), ...(m[2] ? { when: m[2] } : {}) } }) },
  { test: /^(?:(?:i\s+have|i've\s+got|i\s+got|having|bad|really bad|some|a\s+bit\s+of)\s+)?((?:cramps|period pain|headache|migraine|bloating|bloated|spotting|heavy flow|light flow|medium flow|heavy bleeding|light bleeding|clots|tender breasts|sore breasts|back ?ache|lower back pain|acne|breakout|nausea|cravings|fatigue|mood swings?|low mood|mood low|irritable|anxious|emotional|teary|pms)(?:\s*(?:,|and)\s*(?:cramps|period pain|headache|migraine|bloating|bloated|spotting|clots|tender breasts|sore breasts|back ?ache|lower back pain|acne|nausea|cravings|fatigue|mood swings?|low mood|irritable|anxious|emotional|teary|pms))*)(\s+(?:today|yesterday|this morning|last night|tonight))?$/i,
    build: (_t, m) => ({ action: "cycle.log", args: { what: m[1], ...(m[2] ? { when: m[2].trim() } : {}) } }) },

  // ---- measures: weight, sleep, water, mood, steps, blood pressure, lifts, routines ----
  { test: /^(?:my\s+)?(?:weight|body ?weight)(?:\s+(?:is|was|today))?\s*:?\s*(\d+(?:\.\d+)?)\s*(kg|kgs|kilos?|lbs?|pounds?)?$|^i\s+weigh(?:ed)?\s+(\d+(?:\.\d+)?)\s*(kg|kgs|kilos?|lbs?|pounds?)?(?:\s+(?:today|this morning))?$/i,
    build: (_t, m) => ({ action: "measure.log", args: { name: "weight", value: Number(m[1] ?? m[3]), unit: m[2] ?? m[4] ?? "kg" } }) },
  { test: /^(?:i\s+)?(?:slept|sleep|got)\s+(?:for\s+|about\s+|around\s+)?(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?)(?:\s*(?:and\s*)?(\d{1,2})\s*(?:m|mins?|minutes?)?)?(?:\s+(?:of\s+sleep\s*)?(last night|yesterday))?$/i,
    build: (_t, m) => ({ action: "measure.log", args: { name: "sleep", value: Math.round((Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0)) * 100) / 100, unit: "hours", ...(m[3] ? { when: m[3] } : {}) } }) },
  { test: /^(?:i\s+)?(?:drank|had)\s+(\d+(?:\.\d+)?)\s*(litres?|liters?|l|ml|glasses|glass|cups?|bottles?)\s+(?:of\s+)?water(?:\s+today)?$|^(\d+(?:\.\d+)?)\s*(litres?|liters?|l|ml|glasses|glass|cups?|bottles?)\s+of\s+water(?:\s+today)?$|^water:?\s*(\d+(?:\.\d+)?)\s*(litres?|liters?|l|ml|glasses|cups?|bottles?)?$/i,
    build: (_t, m) => ({ action: "measure.log", args: { name: "water", value: Number(m[1] ?? m[3] ?? m[5]), unit: m[2] ?? m[4] ?? m[6] ?? "litres" } }) },
  { test: /^(?:my\s+)?mood\s*:?\s*(\d{1,2})\s*(?:\/|out of)\s*(\d{1,2})$/i, build: (_t, m) => ({ action: "measure.log", args: { name: "mood", value: Number(m[1]), note: `${m[1]}/${m[2]}` } }) },
  { test: /^(?:my\s+)?mood\s*:\s*([a-z][a-z ,'-]{1,60})$/i, build: (_t, m) => ({ action: "measure.log", args: { name: "mood", note: m[1].trim() } }) },
  { test: /^(?:my\s+)?(?:bp|blood pressure)(?:\s+(?:is|was|today))?\s*:?\s*(\d{2,3})\s*(?:\/|over)\s*(\d{2,3})$/i, build: (_t, m) => ({ action: "measure.log", args: { name: "blood pressure", value: Number(m[1]), note: `${m[1]}/${m[2]}`, unit: "mmHg" } }) },
  { test: /^(?:i\s+)?(?:walked\s+|did\s+)?(\d{1,3}(?:,\d{3})+|\d{3,6}|\d+(?:\.\d+)?k)\s+steps(?:\s+today)?$|^steps:?\s*(\d[\d,]*)$/i,
    build: (_t, m) => { const raw = (m[1] ?? m[2]).replace(/,/g, ""); return { action: "measure.log", args: { name: "steps", value: /k$/i.test(raw) ? Number(raw.slice(0, -1)) * 1000 : Number(raw), unit: "steps" } }; } },
  { test: /^(?:i\s+)?(bench(?:ed)?|bench press(?:ed)?|squat(?:ted)?|dead ?lift(?:ed)?|ohp|overhead pressed|pressed)\s+(\d+(?:\.\d+)?)\s*(kg|kgs|lbs?)?(?:\s*(?:x|for|×)\s*(\d+)(?:\s*reps?)?)?(?:\s*(?:x|for|×)\s*(\d+)\s*sets?)?$/i,
    build: (_t, m) => ({ action: "measure.log", args: { name: m[1], value: Number(m[2]), unit: m[3] ?? "kg", ...(m[4] ? { note: `x${m[4]}${m[5] ? `, ${m[5]} sets` : ""}` } : {}) } }) },
  { test: /^(?:i\s+)?(?:did|done|finished)\s+my\s+((?:morning |night |evening )?(?:skin ?care|hair ?care|face|beard|wash day|nail|self[- ]care)(?:\s+routine)?|[a-z]+\s+routine)(?:\s+(today|this morning|last night))?$/i,
    build: (_t, m) => ({ action: "measure.log", args: { name: m[1].toLowerCase().replace(/\s+routine$/, "").replace(/skin ?care/, "skincare").replace(/hair ?care/, "haircare") + " routine", ...(m[2] ? { when: m[2] } : {}) } }) },
  { test: new RegExp(`^(?:how(?:'s| is| has)|show(?: me)?|what(?:'s| is))\\s+my\\s+(${MEASURE_NAMES})(?:\\s+(?:been|going|looking))?(?:\\s+(this week|this month|lately|recently|over the last (\\d+) days))?$`, "i"),
    build: (_t, m) => ({ action: "measure.show", args: { name: m[1], ...(m[2] ? { days: m[3] ? Number(m[3]) : /month/i.test(m[2]) ? 30 : 7 } : {}) } }) },
  { test: new RegExp(`^(?:my\\s+)?(${MEASURE_NAMES})\\s+(this week|this month|lately|recently|over the last (\\d+) days)$`, "i"),
    build: (_t, m) => ({ action: "measure.show", args: { name: m[1], days: m[3] ? Number(m[3]) : /month/i.test(m[2]) ? 30 : 7 } }) },
  { test: new RegExp(`^(?:delete|clear|wipe|erase)\\s+(?:all\\s+)?(?:of\\s+)?my\\s+(${MEASURE_NAMES})\\s+(?:entries|data|history|logs?|records)$`, "i"), build: (_t, m) => ({ action: "measure.forget", args: { name: m[1] } }) },
  { test: /^(?:what\s+am\s+i\s+tracking|what\s+do\s+you\s+track\s+for\s+me|(?:my|show my)\s+(?:measures|trackers|stats))$/i, build: () => ({ action: "measure.list", args: {} }) },

  // ---- memory / meta ----
  { test: /^(?:what do you (?:know|remember) about me|what have you got on me|show (?:my )?memory)/i, build: () => ({ action: "memory.list", args: {} }) },
  { test: /^(?:remember|note that|keep in mind|don'?t forget that)\s+(?!to\b)(.+)/i, build: (_t, m) => ({ action: "memory.remember", args: { fact: m[1] } }) },
  { test: /^forget\s+(?:that |about |what i said about )?(.+)/i, build: (_t, m) => ({ action: "memory.forget", args: { match: m[1] } }) },
  { test: /^(?:talk|speak|sound|act)\s+(?:like|as)\s+(?:an? )?(.+)|^(?:change|switch|set)\s+(?:your )?(?:voice|tone|personality|persona)\s+(?:to )?(.+)|^be\s+(?:more\s+)?(hype|dry|formal|plain|direct|a coach|a butler|degen|a mentor)/i,
    build: (_t, m) => { const v = (m[1] ?? m[2] ?? m[3]).trim(); const key = Object.keys(PERSONAS).find((k) => v.toLowerCase().includes(k)) ?? (/formal/i.test(v) ? "butler" : /direct/i.test(v) ? "plain" : null); return { action: "persona.set", args: key ? { preset: key } : { custom: v } }; } },
  { test: /^(?:my )?(?:time ?zone|tz)\s+(?:is\s+)?(?:now\s+)?([A-Za-z]+\/[A-Za-z_]+)|^i(?:'m| am) (?:now )?in\s+([A-Za-z]+\/[A-Za-z_]+)/i, build: (_t, m) => ({ action: "settings.update", args: { tz: m[1] ?? m[2] } }) },
  { test: /^(?:send|do) (?:my |the )?(?:digest|brief|briefing|morning (?:message|update)) at (\d{1,2})/i, build: (_t, m) => ({ action: "settings.update", args: { digest_hour: Number(m[1]) } }) },
  { test: /^(?:my )?(?:email|e-mail) (?:is |address is )?(\S+@\S+)/i, build: (_t, m) => ({ action: "settings.update", args: { email: m[1] } }) },
  { test: /^(?:call me|my name is|my name'?s)\s+([A-Za-z][\w'-]{1,30}(?:\s[A-Za-z][\w'-]{1,30})?)[.!]?$/i, build: (_t, m) => ({ action: "settings.update", args: { name: m[1].replace(/\b[a-z]/g, (c) => c.toUpperCase()) } }) },
  { test: /^(?:what'?s|how'?s|give me)\s+(?:my |the )?(?:day|digest|brief|briefing|morning|rundown)(?: (?:look|looking) like)?$|^(?:brief|digest|rundown) me/i, build: () => ({ action: "digest.now", args: {} }) },

  // ---- lists ----
  { test: /^(?:add|put) (.+?) (?:to|on) (?:my |the )?shopping(?: list)?$/i, build: (_t, m) => ({ action: "list.add", args: { list: "shopping", items: m[1].split(/\s*(?:,|\band\b)\s*/) } }) },
  { test: /^(?:add|put) (.+?) (?:to|on) (?:my |the )?(?:todo|to-?do|tasks?)(?: list)?$/i, build: (_t, m) => ({ action: "list.add", args: { list: "todo", items: [m[1]] } }) },
  { test: /^(?:i (?:need|have) to buy|add .+ to (?:my |the )?shopping|shopping(?: list)?:?)\s*(.+)/i, build: (_t, m) => ({ action: "list.add", args: { list: "shopping", items: strip(m[1], /^(?:i (?:need|have) to buy|add)\s+/i, /\s+to (?:my |the )?shopping(?: list)?$/i).split(/\s*(?:,|\band\b)\s*/) } }) },
  { test: /^(?:i (?:need|have|got) to|todo:?|to-?do:?|add .+ to (?:my |the )?(?:todo|to-?do|tasks?)(?: list)?)\s*(.+)/i, build: (_t, m) => ({ action: "list.add", args: { list: "todo", items: strip(m[1], /^add\s+/i, /\s+to (?:my |the )?(?:todo|to-?do|tasks?)(?: list)?$/i).split(/\s*(?:,|\band then\b|\band\b)\s*/) } }) },
  { test: /^(?:i )?(?:bought|got(?! paid)|picked up|grabbed)\s+(.+)/i, build: (_t, m) => ({ action: "list.done", args: { match: m[1], list: "shopping" } }) },
  { test: /^(?:i )?(?:finished|completed|did|done with|crossed off|tick(?:ed)? off)\s+(?:the |my )?(.+?)(?: task| todo)?$/i, build: (_t, m) => ({ action: "list.done", args: { match: m[1] } }) },
  { test: /^(?:what'?s on|show|what'?s in|open)\s+(?:my |the )?(shopping|todo|to-?do|task)s?(?: list)?|^(?:my )?(?:lists|todos|tasks)$/i, build: (_t, m) => ({ action: "list.show", args: { list: m[1] ? m[1].toLowerCase().replace(/-/, "").replace("task", "todo") : undefined } }) },

  // ---- reminders / calendar ----
  { test: /^what'?s on\s+(today|tomorrow|this week|next week|this month)$/i, build: (_t, m) => ({ action: "calendar.list", args: { range: norm(m[1]) } }) },
  { test: /^(?:what|anything)\s+(?:do i have|is on|have i got|am i doing)\s*(?:on|for)?\s*(?:my )?(?:calendar|schedule|plan|day)?\s*(today|tomorrow|this week|next week|this month)?|^(?:my )?(?:schedule|calendar|agenda|plans?)\s*(?:for )?(today|tomorrow|this week|this month)?$|^(?:am i|anything)\s+(?:free|busy)\s*(today|tomorrow|this week)?/i,
    build: (_t, m) => ({ action: "calendar.list", args: { range: norm(m[1] ?? m[2] ?? m[3]) } }) },
  { test: /^(?:what|which|any|list|show)\s+(?:are my |my )?reminders|^(?:reminders|what am i supposed to remember)$/i, build: () => ({ action: "reminder.list", args: {} }) },
  { test: /^(?:remind me|nudge me|ping me|don'?t let me forget|make sure i|i (?:need|have) to remember)\s*(?:to|about|that|of)?\s*(.+)/i,
    build: (_t, m, now) => { const { when, rest } = splitTime(m[1], now); return { action: "reminder.create", args: { text: rest || m[1], ...(when ? { when } : {}) } }; } },
  { test: /^(?:cancel|delete|remove|scrap|drop)\s+(?:the |my )?reminder\s*(?:to |about |for )?(.*)/i, build: (_t, m) => ({ action: "reminder.delete", args: m[1] ? { match: m[1] } : {} }) },
  { test: /^(?:cancel|delete|remove|scrap)\s+(?:the |my )?(?:event|meeting|appointment)\s*#?(\d+)/i, build: (_t, m) => ({ action: "calendar.delete", args: { id: Number(m[1]) } }) },

  // ---- medications ----
  { test: /^(?:i'?m (?:on|taking)|i take|add (?:my )?(?:meds?|medication|medicine|pills?)|meds?:?|medication:?)\s+(.+?)\s+(?:at|every day at|daily at|mornings? at|nights? at)\s+(.+)/i,
    build: (_t, m) => ({ action: "medication.add", args: { name: strip(m[1], /\b(?:tablets?|pills?|capsules?)\b/i), times: m[2].split(/\s*(?:,|and|&)\s*/) } }) },
  { test: /^(?:what|which|list|show)\s+(?:meds|medications|medicine|pills)|^(?:my )?(?:meds|medications|pills)$|^(?:did i take|how'?s my adherence)/i, build: () => ({ action: "medication.list", args: {} }) },
  { test: /^(?:stop|remove|delete|i'?m off)\s+(?:the |my )?(?:med(?:ication)?s?|pills?)\s*#?(\d+)/i, build: (_t, m) => ({ action: "medication.delete", args: { id: Number(m[1]) } }) },

  // ---- classes ----
  { test: /^(?:i have|add|my)\s+(?:a )?(?:class|lecture|lab|tutorial)\s+(?:called |for )?(.+?)\s+(?:on\s+|every\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(?:at\s+|from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)(?:\s*(?:-|–|to|till|until)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?(?:\s+(?:at|in)\s+(.+))?/i,
    build: (_t, m) => ({ action: "class.add", args: { name: m[1], day: m[2], start: m[3].trim(), end: m[4]?.trim(), location: m[5] } }) },
  { test: /^(?:my )?(?:classes|timetable|lectures|school schedule)|^(?:what|which)\s+class(?:es)?\s+(?:do i have|today)/i, build: () => ({ action: "class.list", args: {} }) },
  { test: /^(?:i have|add|there'?s)\s+(?:an? |my )?(?:assignment|homework|essay|exam|test|project|lab report)\s+(?:on |for |called |about )?(.+?)\s+(?:due|by|on)\s+(.+)/i, build: (_t, m) => ({ action: "assignment.add", args: { title: m[1], due: m[2] } }) },
  { test: /^(?:i )?(?:submitted|handed in|turned in|finished)\s+(?:my |the )?(?:assignment|homework|essay|lab)\s+(?:on |for )?(.+)/i, build: (_t, m) => ({ action: "assignment.done", args: { match: m[1] } }) },

  // ---- trips ----
  { test: /^(?:i'?m |we'?re )?(?:going|travel+ing|flying|heading)\s+to\s+(.+?)(?:\s+(?:on|from)\s+(.+?))?(?:\s+(?:to|until|till|through)\s+(.+?))?(?:\s+(?:with a )?budget\s+(?:of )?(\d[\d,]*)\s*([a-z]{3})?)?$|^plan(?:ning)?\s+(?:a |my )?trip\s+to\s+(.+)/i,
    build: (_t, m) => { if (m[6]) return { action: "trip.create", args: { destination: m[6] } }; return { action: "trip.create", args: { destination: m[1], start: m[2], end: m[3], budget: m[4] ? Number(m[4].replace(/,/g, "")) : undefined, currency: m[5]?.toUpperCase() } }; } },
  { test: /^(?:add|put|book(?:ed)?)\s+(?:a |the |my )?(flight|hotel|stay|airbnb|train|bus|transport|activity|tour|visit)\s+(.+?)\s+(?:to|on|for)\s+(?:the |my )?trip(?:\s+(?:on|at)\s+(.+))?/i,
    build: (_t, m) => ({ action: "trip.add_item", args: { kind: ({ hotel: "stay", airbnb: "stay", train: "transport", bus: "transport", tour: "activity", visit: "activity" } as any)[m[1].toLowerCase()] ?? m[1].toLowerCase(), title: m[2], at: m[3] } }) },
  { test: /^(?:i )?packed\s+(?:the |my )?(.+)|^(?:tick|check)\s+(.+?)\s+off (?:the )?(?:packing|trip)/i, build: (_t, m) => ({ action: "trip.tick", args: { match: m[1] ?? m[2] } }) },
  { test: /^(?:show|what'?s|how'?s)\s+(?:my |the )?(?:trip|itinerary|travel plan)|^(?:my )?trip$/i, build: () => ({ action: "trip.show", args: {} }) },

  // ---- habits / spend / notes / dates ----
  { test: /^(?:start )?track(?:ing)?\s+(?:my |the |a )?(?:habit\s+)?(.+?)(?:\s+(\d)\s*(?:x|times)\s*(?:a|per|\/)\s*week)?$/i, build: (_t, m) => ({ action: "habit.add", args: { name: m[1], target_per_week: m[2] ? Number(m[2]) : undefined } }) },
  { test: /^(?:i )?(?:went to|hit|did|finished|completed)\s+(?:the |my )?(gym|workout|run|yoga|reading|meditation|.+?)(?:\s+(yesterday|today))?$|^(?:worked out|ran|meditated|read)(?:\s+(yesterday|today))?$/i,
    build: (t, m) => ({ action: "habit.checkin", args: { name: m[1] ?? t.replace(/\s+(yesterday|today)$/i, "").replace(/^worked out$/i, "gym").replace(/^ran$/i, "run").replace(/^meditated$/i, "meditation").replace(/^read$/i, "reading"), day: /yesterday/i.test(t) ? "yesterday" : "today" } }) },
  { test: /^(?:my )?habits|^(?:how am i doing|streaks?)(?: on my habits)?$/i, build: () => ({ action: "habit.list", args: {} }) },
  { test: /^(?:i )?(?:spent|paid|dropped|blew|used)\s+(?:about |around )?(?:₦|\$|£|€)?([\d,.]+)\s*(naira|dollars?|pounds?|euros?|cfa|k\b|(?!for\b|on\b|at\b)[a-z]{3}\b)?\s*(?:on|for|at)?\s*(.+)?/i,
    build: (_t, m) => { const unit = m[2]?.toLowerCase(); if (unit && unit !== "k" && !/^(naira|dollars?|pounds?|euros?|cfa|ngn|usd|gbp|eur|xaf|ghs|kes|zar)$/.test(unit)) return null; let amt = Number(m[1].replace(/,/g, "")); if (unit === "k") amt *= 1000; return { action: "spend.log", args: { amount: amt, currency: unit === "k" ? "NGN" : cur(m[2] ?? _t.match(/[₦$£€]/)?.[0]), category: m[3]?.split(/\s+/)[0], note: m[3] } }; } },
  { test: /^(?:how much (?:have i|did i) spen[dt]|what did i spend|spending|expenses|my spend)\s*(?:this )?(week|month)?/i, build: (_t, m) => ({ action: "spend.summary", args: { range: m[1]?.toLowerCase() } }) },
  { test: /^(?:note|jot|write)(?: down| this)?:?\s+(.+)/i, build: (_t, m) => ({ action: "note.add", args: { text: m[1] } }) },
  { test: /^(?:find|search|look up|what did i note about)\s+(?:my |in )?notes?\s*(?:about |for |on )?(.+)/i, build: (_t, m) => ({ action: "note.search", args: { query: m[1] } }) },
  { test: /^(.+?(?:'s)?\s+(?:birthday|bday|anniversary))\s+(?:is\s+)?(?:on\s+)?(.+)/i, build: (_t, m) => ({ action: "date.add", args: { label: m[1], on: m[2] } }) },
  { test: /^(?:count ?down|how (?:long|many days) (?:until|till|to))\s+(?:to\s+)?(.+?)(?:\s+(?:on|is)\s+(.+))?$/i, build: (_t, m, now) => { const s = splitTime(m[2] ?? m[1], now); return s.when ? { action: "date.add", args: { label: m[2] ? m[1] : s.rest || m[1], on: s.when, kind: "countdown" } } : { action: "date.list", args: {} }; } },
  { test: /^(?:upcoming |any )?(?:birthdays|dates|anniversaries|countdowns)(?: coming up)?/i, build: () => ({ action: "date.list", args: {} }) },

  // ---- weather / fx / summarise ----
  { test: /^(?:what'?s |how'?s )?(?:the )?weather\s*(?:like )?(?:in |at |for )?(.+?)(?:\s+(today|tomorrow))?$|^(?:is it|will it)\s+(?:going to )?(?:rain|be hot|be cold)\s+(?:in\s+)?(.+?)(?:\s+(today|tomorrow))?$/i, build: (_t, m) => ({ action: "weather", args: { city: (m[1] ?? m[3]).replace(/\s+(?:right )?now$/i, ""), day: (m[2] ?? m[4])?.toLowerCase() } }) },
  { test: /^(?:convert |how much is |what'?s )?([\d,.]+)\s*(naira|dollars?|pounds?|euros?|cfa|[a-z]{3,4})\s+(?:to|in|into)\s+(naira|dollars?|pounds?|euros?|cfa|[a-z]{3,4})/i, build: (_t, m) => ({ action: "fx", args: { amount: Number(m[1].replace(/,/g, "")), from: cur(m[2]), to: cur(m[3]) } }) },
  { test: /^(?:summari[sz]e|tl;?dr|what'?s this about|read this)[:\s]+(?:this\s+)?(https?:\/\/\S+)(?:\s+(.+))?/i, build: (_t, m) => ({ action: "summarize", args: { url: m[1], focus: m[2] } }) },

  // ---- hackathons ----
  { test: /^(?:any|find|show|what|which|are there)\s+(?:me )?(?:new |good |open |upcoming )?hackathons?\s*(?:for |on |in |about )?(.*)/i, build: (_t, m) => ({ action: "hackathon.discover", args: { tag: strip(m[1], /^(?:right now|this week|coming up|open)$/i) || undefined } }) },
  { test: /^(?:i'?m (?:into|interested in)|my interests are|rank (?:hackathons )?by)\s+(.+)/i, build: (_t, m) => ({ action: "hackathon.set_interests", args: { tags: m[1].split(/\s*(?:,|\band\b)\s*/) } }) },
  { test: /^(?:i'?m (?:entering|doing|joining|in)|track|i registered for|add)\s+(?:the )?(.+?)(?:\s+hackathon)?(?:\s+(?:due|deadline|closes|ends)\s+(.+))?$/i, build: (_t, m) => ({ action: "hackathon.track", args: { title: m[1], deadline: m[2] } }) },
  { test: /^(?:i )?(?:submitted|shipped|won|lost|withdrew from|got paid for|registered for|started building)\s+(?:my |the )?(.+)/i,
    build: (t, m) => { const s = t.match(/^(?:i )?(submitted|shipped|won|lost|withdrew|got paid|registered|started building)/i)![1].toLowerCase(); const status = ({ shipped: "submitted", withdrew: "withdrawn", registered: "registered", "started building": "building" } as any)[s] ?? s; return s === "got paid" ? { action: "hackathon.update", args: { match: m[1], payout_received: "today" } } : { action: "hackathon.update", args: { match: m[1].replace(/\s+hackathon$/i, ""), status } }; } },
  { test: /^(.+?)\s+status\s+(interested|registered|building|submitted|won|lost|withdrawn)$/i, build: (_t, m) => ({ action: "hackathon.update", args: { match: m[1], status: m[2].toLowerCase() } }) },
  { test: /^(?:my )?(?:ledger|hackathon (?:entries|list|status)|what have i entered|win rate)/i, build: () => ({ action: "hackathon.ledger", args: {} }) },

  // ---- prices / portfolio ----
  { test: /^(?:what'?s|how much is|price of|check)\s+(?:the )?(?:price of )?(.+?)(?:\s+(?:right )?now|\s+today|\s+at)?$/i, build: (_t, m) => { const coins = (m[1].match(new RegExp(COIN.source, "gi")) ?? []); return coins.length ? { action: "price.check", args: { coins } } : null; } },
  { test: /^(?:let me know|tell me|alert me|ping me|notify me)\s+(?:when|if|once)\s+(\w+)\s+(?:goes |gets |is |drops |rises |climbs )?(above|below|over|under|past|hits)\s+\$?([\d,.]+)(k)?/i, build: (_t, m) => ({ action: "price.alert", args: { coin: m[1], op: /above|over|past|hits/i.test(m[2]) ? "above" : "below", target: Number(m[3].replace(/,/g, "")) * (m[4] ? 1000 : 1) } }) },
  { test: /^(?:let me know|tell me|alert me)\s+(?:when|if)\s+(\w+)\s+(?:moves|swings|changes)\s+(?:by )?(\d+)\s*%(?:\s+(?:in|within)\s+(\d+)\s*h)?/i, build: (_t, m) => ({ action: "price.alert", args: { coin: m[1], op: "move", target: Number(m[2]), pct_window: m[3] ? Number(m[3]) : 24 } }) },
  { test: /^(?:watch|track|add)\s+(?:my |this )?(?:wallet|address)\s+(\S{20,})\s+on\s+(\w+)(?:\s+(?:as|called|labelled)\s+(.+))?/i, build: (_t, m) => ({ action: "wallet.add", args: { address: m[1], chain: m[2].toLowerCase(), label: m[3] } }) },
  { test: /^(?:my )?(?:portfolio|balances?|holdings|net worth|what do i hold)/i, build: () => ({ action: "portfolio", args: {} }) },

  // ---- jobs / launches / scout / bills / trading ----
  { test: /^(?:watch|follow|track)\s+(?:jobs? (?:at|on|from)\s+)?(greenhouse|lever|ashby|remoteok|remotive)(?:\s+(\S+))?(?:\s+(?:for|matching)\s+(.+))?/i, build: (_t, m) => ({ action: "jobs.watch", args: { ats: m[1].toLowerCase(), slug: m[2], keywords: m[3]?.split(/\s*,\s*/) } }) },
  { test: /^(?:(?:any|new|show|find|me|open|the)\s+)*jobs?(?:\s+(?:for me|today|this week))?$/i, build: () => ({ action: "jobs.list", args: {} }) },
  { test: /^(?:what'?s |any |show |new )?(?:launch(?:es|ing)|just launched|new (?:repos|tools|tokens))(?:\s+on\s+(showhn|github|dexboost|hn|dex))?/i, build: (_t, m) => ({ action: "launch.discover", args: { source: ({ hn: "showhn", dex: "dexboost" } as any)[m[1]?.toLowerCase() ?? ""] ?? m[1]?.toLowerCase() } }) },
  { test: /^(?:contact|how do i reach|find (?:the )?contact for)\s+@?([\w-]+)$/i, build: (_t, m) => ({ action: "launch.contact", args: { github_login: m[1] } }) },
  { test: /^(?:scout|find|look for|who'?s building|who is building|search for|discover)\s+(?:me )?(?:new |upcoming |early )?(?:projects?|startups?|teams?|protocols?|founders?|people)?\s*(?:in|on|around|doing|working on)?\s*(.+?)(?:\s+(?:for|to|so i can|because i want to)\s+(.+))?$/i,
    build: (_t, m) => (m[1] ? { action: "scout.find", args: { niche: m[1].replace(/^(?:the )?(?:space|niche|area)\s+/i, ""), objective: m[2] } } : null) },
  { test: /^(?:keep (?:scouting|watching|an eye on)|watch (?:the )?(?:niche|space))\s+(.+?)(?:\s+(?:for|to)\s+(.+))?$/i, build: (_t, m) => ({ action: "scout.watch", args: { niche: m[1], objective: m[2] } }) },
  { test: /^(?:draft|write)\s+(?:an? )?(?:outreach|message|dm|email|intro)\s+(?:to|for)\s+(.+?)\s*(?:[:—-]|about|asking|saying)\s+(.+)/i, build: (_t, m) => ({ action: "scout.draft_outreach", args: { project: m[1], ask: m[2] } }) },
  { test: /^(?:which|list|show|find)\s+(?:billers?|providers?)\s+(?:for )?(.+)|^billers?\s+(.+)/i, build: (_t, m) => ({ action: "bill.billers", args: { category: m[1] ?? m[2] } }) },
  { test: /^(?:pay|top ?up|buy|recharge|send)\s+(?:₦|ngn)?\s*([\d,]+)\s*(?:naira|ngn)?\s+(?:of )?(?:airtime |data )?(?:to|for|on)\s+(\S+)\s+(?:for|on|to)\s+(\S+)/i, build: (_t, m) => ({ action: "bill.pay", args: { amount: Number(m[1].replace(/,/g, "")), biller_code: m[2], customer: m[3] } }) },
  { test: /^(?:my )?(?:bill|payment|airtime)\s+history|^(?:what|which) bills (?:have i|did i) pa(?:y|id)/i, build: () => ({ action: "bill.history", args: {} }) },
  { test: /^(?:copy|follow|shadow|mirror)\s+(?:wallet |trader )?(\S{20,})\s+on\s+(polymarket|pump ?fun|pumpfun)(?:.*?max\s+([\d.]+)(?:\/| per )?trade)?(?:.*?([\d.]+)(?:\/| per )?day)?/i, build: (_t, m) => ({ action: "trading.follow_wallet", args: { address: m[1], venue: m[2].replace(/\s/, "").toLowerCase(), max_per_trade: Number(m[3] ?? 10), max_per_day: Number(m[4] ?? 50) } }) },
  { test: /^(?:unfollow|stop (?:following|copying|shadowing))\s+(.+)/i, build: (_t, m) => ({ action: "trading.unfollow", args: { match: m[1] } }) },
  { test: /^(?:how (?:are|is) (?:the |my )?(?:copy|shadow|followed)|shadow (?:report|results|performance)|how'?s the copy ?trading)/i, build: () => ({ action: "trading.shadow_report", args: {} }) },
  // lowest priority: generic 'something with a time' → calendar event
  { test: /^(?:schedule|book|set up|put|block|i have|i'?ve got|there'?s)\s+(?:an? |my |the )?(.+)|^(?:meeting|call|dinner|lunch|appointment|interview|date|flight|exam)\b.*/i,
    build: (t, m, now) => { const { when, rest } = splitTime(m[1] ?? t, now); if (!when) return null; const title = strip(rest, /^(?:an? |my |the )/i, /\s*(?:with|at|in)\s*$/i); return title ? { action: "calendar.add", args: { title, when } } : null; } },
  // last of all: a few words and a clock time ("standup today at 12:15", "gym 6pm") is an event
  { test: /^(?![^]*\?$)(?!(?:what|when|where|who|why|how|is|are|can|could|do|does|should)\b)(.{2,48}?)\s+(?:today|tonight|tomorrow|on \w+|at|by)?\s*(?:at\s+)?\d{1,2}(?::\d{2})?\s*(?:am|pm)?$/i,
    build: (t, _m, now) => { const { when, rest } = splitTime(t, now); if (!when || !/\d/.test(when)) return null; const title = strip(rest, /^(?:an? |my |the )/i, /\s+(?:today|tonight|tomorrow|at|on|by)$/i); return title && title.split(/\s+/).length <= 6 ? { action: "calendar.add", args: { title, when } } : null; } },
];

function norm(s?: string) {
  if (!s) return undefined;
  const v = s.toLowerCase();
  if (v === "this week" || v === "next week") return "week";
  if (v === "this month") return "month";
  return v;
}

export function parseLoose(text: string, now = new Date()): Intent | null {
  const t = normalise(text);
  if (!t) return null;
  for (const r of RULES) {
    const m = t.match(r.test);
    if (!m) continue;
    try {
      const i = r.build(t, m, now);
      if (i) return i;
    } catch { /* try next */ }
  }
  return null;
}
