/**
 * Rule-based fallback parser. Covers the daily sentences so the bot works
 * without a model key (and so tests are deterministic). Anything it can't
 * match returns null and the model handles it.
 */
import { pluginRules } from "../core/plugins.js";
export interface Intent {
  action: string;
  args: Record<string, unknown>;
}

const RULES: [RegExp, (m: RegExpMatchArray) => Intent][] = [
  // reminders
  // time first: "remind me at 9 tomorrow to stretch", "remind me tomorrow to call Ada"
  [/^remind me ((?:at|on|in|by|today|tomorrow|tonight|next|this|every)\b.*?)\s+(?:to|that|about)\s+(.+)$/i, (m) => ({ action: "reminder.create", args: { text: m[2], when: m[1] } })],
  [/^remind me (?:to )?(.+?)\s+(?:at|on|in|today|tomorrow|tonight|next|this)\s+(.+)$/i, (m) => ({ action: "reminder.create", args: { text: m[1], when: m[0].slice(m[0].indexOf(m[1]) + m[1].length).trim() } })],
  [/^remind me (?:to )?(.+)$/i, (m) => ({ action: "reminder.create", args: { text: m[1] } })],
  [/^(?:list|show|my) reminders$/i, () => ({ action: "reminder.list", args: {} })],
  [/^(?:delete|remove|cancel) reminder (?:#?(\d+)|(.+))$/i, (m) => ({ action: "reminder.delete", args: m[1] ? { id: Number(m[1]) } : { match: m[2] } })],

  // calendar
  [/^(?:add|schedule|put)\s+(?!.*\b(?:trip|shopping|todo|list)\b)(.+?)\s+(?:on|at|for)\s+(.+?)(?:\s+(?:at|in)\s+(.+))?$/i, (m) => ({ action: "calendar.add", args: { title: m[1], when: m[3] ? `${m[2]} ${m[3]}` : m[2] } })],
  [/^(?:what'?s|whats|show)\s+(?:on\s+)?(?:my\s+)?(?:calendar|schedule|plan)\s*(today|tomorrow|this week|week|month)?/i, (m) => ({ action: "calendar.list", args: { range: norm(m[1]) } })],
  [/^(?:delete|remove) event #?(\d+)$/i, (m) => ({ action: "calendar.delete", args: { id: Number(m[1]) } })],

  // medications
  [/^(?:add )?med(?:ication|s)?\s+(.+?)\s+(?:at|every day at|daily at)\s+(.+)$/i, (m) => ({ action: "medication.add", args: { name: m[1], times: m[2].split(/\s*(?:,|and|&)\s*/) } })],
  [/^(?:list|show|my) (?:meds|medications)$/i, () => ({ action: "medication.list", args: {} })],
  [/^stop med(?:ication)? #?(\d+)$/i, (m) => ({ action: "medication.delete", args: { id: Number(m[1]) } })],

  // classes
  [/^(?:add )?class\s+(.+?)\s+(?:on\s+)?(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+(?:at\s+)?(\S+)(?:\s*[-–to]+\s*(\S+))?(?:\s+(?:at|in)\s+(.+))?$/i, (m) => ({ action: "class.add", args: { name: m[1], day: m[2], start: m[3], end: m[4], location: m[5] } })],
  [/^(?:my )?(?:classes|timetable)$/i, () => ({ action: "class.list", args: {} })],
  [/^(?:assignment|exam|homework)\s+(.+?)\s+due\s+(.+)$/i, (m) => ({ action: "assignment.add", args: { title: m[1], due: m[2] } })],
  [/^(?:done|finished|submitted) (?:assignment|homework) (.+)$/i, (m) => ({ action: "assignment.done", args: { match: m[1] } })],

  // trips
  [/^plan (?:a )?trip to (.+?)(?:\s+from\s+(.+?))?(?:\s+(?:to|until|till)\s+(.+?))?(?:\s+budget\s+(\d+)\s*([a-z]{3})?)?$/i, (m) => ({ action: "trip.create", args: { destination: m[1], start: m[2], end: m[3], budget: m[4] ? Number(m[4]) : undefined, currency: m[5]?.toUpperCase() } })],
  [/^add (flight|stay|hotel|transport|activity|todo|pack)\s+(.+?)\s+to (?:the |my )?trip(?:\s+(?:on|at)\s+(.+))?$/i, (m) => ({ action: "trip.add_item", args: { kind: m[1].toLowerCase() === "hotel" ? "stay" : m[1].toLowerCase(), title: m[2], at: m[3] } })],
  [/^packed\s+(.+)$/i, (m) => ({ action: "trip.tick", args: { match: m[1] } })],
  [/^(?:show |my )?trip$/i, () => ({ action: "trip.show", args: {} })],

  // habits / spend / notes / memory
  [/^track habit (.+?)(?:\s+(\d)x?(?:\/| per )week)?$/i, (m) => ({ action: "habit.add", args: { name: m[1], target_per_week: m[2] ? Number(m[2]) : undefined } })],
  [/^(?:done|finished) with (.+)$/i, (m) => ({ action: "list.done", args: { match: m[1] } })],
  [/^(?:did|done)\s+(?!my\s+(?:[a-z]+\s+)?(?:skin ?care|hair ?care|face|beard|wash day|nail|self[- ]care|[a-z]+\s+routine)\b)(.+?)(\s+yesterday)?$/i, (m) => ({ action: "habit.checkin", args: { name: m[1], day: m[2] ? "yesterday" : "today" } })],
  [/^(?:my )?habits$/i, () => ({ action: "habit.list", args: {} })],
  [/^spent\s+([\d,.]+)\s*(naira|dollars?|pounds?|cfa|[a-z]{3})?\s*(?:on\s+)?(.+)?$/i, (m) => ({ action: "spend.log", args: { amount: Number(m[1].replace(/,/g, "")), currency: cur(m[2]), category: m[3]?.split(/\s+/)[0], note: m[3] } })],
  [/^(?:spend|spending|expenses)\s*(week|month)?$/i, (m) => ({ action: "spend.summary", args: { range: m[1]?.toLowerCase() } })],
  [/^note:?\s+(.+)$/i, (m) => ({ action: "note.add", args: { text: m[1] } })],
  [/^(?:find|search) notes?\s+(.+)$/i, (m) => ({ action: "note.search", args: { query: m[1] } })],
  [/^remember (?:that )?(.+)$/i, (m) => ({ action: "memory.remember", args: { fact: m[1] } })],
  [/^forget (?!(?:all\s+)?(?:of\s+)?my\s+(?:cycle|period|menstrual)\s+(?:data|history|tracking|logs?)$)(?:that |about )?(.+)$/i, (m) => ({ action: "memory.forget", args: { match: m[1] } })],

  // hackathons
  [/^(?:send me|show me|give me|turn on|i want)\s+(?:new\s+)?hackathons?(?:\s+(?:in|with)\s+(?:my|the)\s+(?:brief|morning note|digest))?$|^hackathon (?:news|suggestions) on$/i, () => ({ action: "hackathon.news", args: { on: true } })],
  [/^(?:stop|no more|turn off|don'?t send(?: me)?|i don'?t want)\s+(?:the\s+|any\s+)?(?:new\s+)?hackathons?(?:\s+(?:news|messages|suggestions|updates))?$|^hackathon (?:news|suggestions) off$/i, () => ({ action: "hackathon.news", args: { on: false } })],
  [/^(?:hackathons?|find hackathons?|discover)(?:\s+(.+))?$/i, (m) => ({ action: "hackathon.discover", args: { tag: m[1] } })],
  // Only a hackathon by name or with a deadline: "track my period" or "track my order" are not entries.
  [/^track (?!(?:my|a|an|the|our|this|that|it)\b)(.+?\bhackathon\b.*?|.+?)\s+(?:due|deadline)\s+(.+)$|^track (?:the )?hackathon (.+)$/i, (m) => ({ action: "hackathon.track", args: { title: m[1] ?? m[3], deadline: m[2] } })],
  [/^(?:ledger|my entries|my hackathons)$/i, () => ({ action: "hackathon.ledger", args: {} })],
  // "submitted my tax return", "won the lottery", "lost my phone" are life, not the ledger.
  [/^(?:submitted|registered|building|won|lost|withdrew|withdrawn)\s+(?!(?:my|a|an|some|it|that|this|our|his|her|their|for|to|on|in|at|me|you|him|them|us|everything|nothing|track|sleep|weight)\b)(?!the\s+(?!.*\b(?:hackathon|buildathon|bounty|hack)\b))(.+)$/i, (m) => ({ action: "hackathon.update", args: { match: m[1], status: m[0].split(/\s/)[0].toLowerCase().replace("withdrew", "withdrawn") } })],
  [/^(?:got paid|payout received)\s+for\s+(?![\d$₦£€])(?!(?:my|the|a|an|lunch|dinner|breakfast|work|it|that|this)\b)(.+)$|^paid\s+for\s+(?:the\s+)?(.+?\s+(?:hackathon|bounty|buildathon))$/i, (m) => ({ action: "hackathon.update", args: { match: m[1] ?? m[2], payout_received: "today" } })],
  [/^(?:interests:|my interests are)\s*(.+)$/i, (m) => ({ action: "hackathon.set_interests", args: { tags: m[1].split(/\s*,\s*/) } })],

  // trading (shadow)
  [/^follow\s+(\S{20,})\s+on\s+(polymarket|pumpfun)(?:\s+max\s+([\d.]+)(?:\/trade)?\s+([\d.]+)(?:\/day)?)?/i, (m) => ({ action: "trading.follow_wallet", args: { address: m[1], venue: m[2].toLowerCase(), max_per_trade: Number(m[3] ?? 10), max_per_day: Number(m[4] ?? 50) } })],
  [/^unfollow\s+(.+)$/i, (m) => ({ action: "trading.unfollow", args: { match: m[1] } })],
  [/^shadow report$/i, () => ({ action: "trading.shadow_report", args: {} })],

  // prices / portfolio / jobs / launches / bills / persona
  [/^(?:alert|tell me)(?: me)? (?:when|if)\s+(\w+)\s+(?:goes |is |drops |rises )?(above|below|over|under)\s+\$?([\d,.]+)(k)?$/i, (m) => ({ action: "price.alert", args: { coin: m[1], op: /above|over/i.test(m[2]) ? "above" : "below", target: Number(m[3].replace(/,/g, "")) * (m[4] ? 1000 : 1) } })],
  [/^(?:alert|tell me)(?: me)? (?:when|if)\s+(\w+)\s+moves\s+(\d+)%(?:\s+in\s+(\d+)h)?$/i, (m) => ({ action: "price.alert", args: { coin: m[1], op: "move", target: Number(m[2]), pct_window: m[3] ? Number(m[3]) : 24 } })],
  [/^price(?:s)?\s+(?:of\s+)?(.+)$/i, (m) => ({ action: "price.check", args: { coins: m[1].split(/[\s,]+/).filter(Boolean) } })],
  [/^watch wallet\s+(\S+)\s+on\s+(\w+)(?:\s+(?:as|called)\s+(.+))?$/i, (m) => ({ action: "wallet.add", args: { address: m[1], chain: m[2].toLowerCase(), label: m[3] } })],
  [/^portfolio$/i, () => ({ action: "portfolio", args: {} })],
  [/^watch jobs\s+(greenhouse|lever|ashby|remoteok|remotive)(?:\s+(\S+))?(?:\s+for\s+(.+))?$/i, (m) => ({ action: "jobs.watch", args: { ats: m[1].toLowerCase(), slug: m[2], keywords: m[3]?.split(/\s*,\s*/) } })],
  [/^jobs$/i, () => ({ action: "jobs.list", args: {} })],
  [/^launches(?:\s+(showhn|github|dexboost))?$/i, (m) => ({ action: "launch.discover", args: { source: m[1]?.toLowerCase() } })],
  [/^contact\s+(\S+)$/i, (m) => ({ action: "launch.contact", args: { github_login: m[1].replace(/^@/, "") } })],
  [/^billers\s+(.+)$/i, (m) => ({ action: "bill.billers", args: { category: m[1] } })],
  [/^(?:pay|top ?up)\s+(\d[\d,]*)\s*(?:naira|ngn)?\s+(?:to\s+)?(\S+)\s+(?:for\s+)?(\S+)$/i, (m) => ({ action: "bill.pay", args: { amount: Number(m[1].replace(/,/g, "")), biller_code: m[2], customer: m[3] } })],
  [/^(?:persona|voice)\s+(?!(?:replies|reply|notes?|messages?)\b)(.+)$/i, (m) => ({ action: "persona.set", args: m[1].length > 12 && !/^[a-z]+$/i.test(m[1]) ? { custom: m[1] } : { preset: m[1] } })],

  // lists / dates / weather / fx / summarize / scout
  [/^(?:add )?(?:to )?(todo|shopping)(?: list)?:?\s+(.+)$/i, (m) => ({ action: "list.add", args: { list: m[1].toLowerCase(), items: m[2].split(/\s*,\s*/) } })],
  [/^(?:bought|got|ticked)\s+(.+)$/i, (m) => ({ action: "list.done", args: { match: m[1] } })],
  [/^(?:show |my )?(todo|todos|shopping|lists?)$/i, (m) => ({ action: "list.show", args: { list: /^lists?$/i.test(m[1]) ? undefined : m[1].replace(/s$/, "").toLowerCase() } })],
  // Only a name before "birthday": "Delete the bank reminder and add Bunmi's birthday on the 2nd" is two asks, for the model.
  [/^(?!(?:cancel|delete|remove|drop|move|change|set|add|put|remind|make|create|save)\b)(?!.*\b(?:and|then|also)\s+(?:cancel|delete|remove|drop|move|change|set|add|put|remind|make|create|save)\b.*(?:birthday|bday|anniversary))(.+?(?:birthday|bday|anniversary))\s+(?:is\s+)?(?:on\s+)?(.+)$/i, (m) => ({ action: "date.add", args: { label: m[1], on: m[2] } })],
  [/^countdown\s+(?:to\s+)?(.+?)\s+(?:on\s+)?((?:\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|next|tomorrow).*)$/i, (m) => ({ action: "date.add", args: { label: m[1], on: m[2], kind: "countdown" } })],
  [/^(?:dates|birthdays|countdowns)$/i, () => ({ action: "date.list", args: {} })],
  [/^weather(?:\s+in)?\s+(.+?)(?:\s+(today|tomorrow))?$/i, (m) => ({ action: "weather", args: { city: m[1], day: m[2]?.toLowerCase() } })],
  [/^([\d,.]+)\s*([a-z]{3,5})\s+(?:to|in)\s+([a-z]{3,5})$/i, (m) => ({ action: "fx", args: { amount: Number(m[1].replace(/,/g, "")), from: m[2], to: m[3] } })],
  [/^(?:summari[sz]e|tldr)\s+(https?:\/\/\S+)(?:\s+(.+))?$/i, (m) => ({ action: "summarize", args: { url: m[1], focus: m[2] } })],
  [/^scout\s+(.+?)(?:\s+(?:for|to)\s+(.+))?$/i, (m) => ({ action: "scout.find", args: { niche: m[1], objective: m[2] } })],
  [/^watch scout\s+(.+?)(?:\s+(?:for|to)\s+(.+))?$/i, (m) => ({ action: "scout.watch", args: { niche: m[1], objective: m[2] } })],
  [/^(?:draft )?outreach (?:to )?(.+?)\s*[:—-]\s*(.+)$/i, (m) => ({ action: "scout.draft_outreach", args: { project: m[1], ask: m[2] } })],

  // digest / settings
  [/^(?:digest|brief|today|morning)$/i, () => ({ action: "digest.now", args: {} })],
  [/^(?:set )?timezone\s+(\S+)$/i, (m) => ({ action: "settings.update", args: { tz: m[1] } })],
  [/^(?:digest at|set digest)\s+(\d{1,2})/i, (m) => ({ action: "settings.update", args: { digest_hour: Number(m[1]) } })],
  [/^(?:my )?country\s+([a-z]{2})$/i, (m) => ({ action: "settings.update", args: { country: m[1] } })],
  [/^(?:my )?email\s+(\S+@\S+)$/i, (m) => ({ action: "settings.update", args: { email: m[1] } })],
  // Fun.
  [/^\/(?:play|games?)$|^(?:let'?s )?play(?: a)?(?: game)?$|^i'?m (?:so )?bored$|^(?:entertain me|surprise me)$/i, () => ({ action: "game.play", args: {} })],
  [/^(?:trivia|quiz me|(?:give me |a )?(?:a )?(?:trivia|quiz)(?: question)?)(?: (?:on|about) (.+))?$/i, (m) => ({ action: "game.play", args: { kind: "trivia", topic: m[1] } })],
  [/^(?:give me |tell me )?(?:a )?riddle(?: (?:on|about) (.+))?$/i, (m) => ({ action: "game.play", args: { kind: "riddle", topic: m[1] } })],
  [/^would you rather(?: (?:on|about) (.+))?$/i, (m) => ({ action: "game.play", args: { kind: "wyr", topic: m[1] } })],
  [/^(?:flip a coin|coin ?flip|heads or tails)\??$/i, () => ({ action: "fun.decide", args: {} })],
  [/^(?:pick|choose|decide)(?: for me)?[:,]?\s+(.+?)\s+or\s+(.+?)\??$/i, (m) => ({ action: "fun.decide", args: { options: [...m[1].split(/,\s*/), m[2]] } })],
  [/^(.+?)\s+or\s+(.+?)[?,]?\s+(?:pick|choose|decide)(?: for me)?\??$/i, (m) => ({ action: "fun.decide", args: { options: [...m[1].split(/,\s*/), m[2]] } })],
  [/^roll(?: a| the)?(?: dice| die)?$/i, () => ({ action: "fun.roll", args: { kind: "dice" } })],
  [/^(?:throw|play|shoot)?\s*(darts|basketball|football|bowling|slots)$/i, (m) => ({ action: "fun.roll", args: { kind: m[1].toLowerCase() } })],
  [/^(?:magic )?8[ -]?ball[:,]?\s*(.*)$/i, (m) => ({ action: "fun.eightball", args: { question: m[1] || undefined } })],
  [/^roast me(?: (?:about|on|for) (.+))?$/i, (m) => ({ action: "fun.roast", args: { about: m[1] } })],
  [/^hype me(?: up)?(?: (?:for|before) (.+))?$/i, (m) => ({ action: "fun.hype", args: { about: m[1] } })],
  [/^(?:my )?(?:week )?wrapped$|^my week in numbers$|^how was my week$/i, () => ({ action: "fun.wrapped", args: {} })],
  [/^(?:my )?currency(?: is)?\s+([a-z]{3})$/i, (m) => ({ action: "settings.update", args: { currency: m[1].toUpperCase() } })],
  [/^(?:i live in|my city is|i moved to|i(?:'ve| have) moved to|set my city to|my home is in)\s+(.{2,60})$/i, (m) => ({ action: "settings.city", args: { city: m[1] } })],
  [/^(?:verify|code|confirm)\s*:?\s*(\d{6})$/i, (m) => ({ action: "settings.verify_email", args: { code: m[1] } })],
  // Email.
  [/^(?:e-?mail|mail) me (.{2,})$/i, (m) => ({ action: "email.me", args: { body: m[1] } })],
  [/^(?:e-?mail|mail) (\S+@\S+?)[,:]? (?:saying|that|to say|and say|telling (?:them|him|her))[:,]? (.{2,})$/i, (m) => ({ action: "email.send", args: { to: m[1], subject: m[2].split(/[.!?]/)[0].slice(0, 60), body: m[2].charAt(0).toUpperCase() + m[2].slice(1) } })],
  // Pictures, search, voice.
  [/^(?:please\s+)?(?:draw|sketch|paint|illustrate)(?: me)?\s+(.{2,})$/i, (m) => ({ action: "image.draw", args: { prompt: m[1] } })],
  [/^(?:please\s+)?(?:make|generate|create)(?: me)? (?:an? )?(?:picture|image|illustration|drawing|wallpaper|sticker|pfp|avatar)(?: of)?\s+(.{2,})$/i, (m) => ({ action: "image.draw", args: { prompt: m[1] } })],
  [/^(?:search|google|look up|search for|search the web for)\s+(.{2,})$/i, (m) => ({ action: "web.search", args: { query: m[1] } })],
  [/^(?:voice replies|voice notes?|talk back)\s+(on|off|always)$/i, (m) => ({ action: "speech.settings", args: { replies: m[1].toLowerCase() === "on" ? "mirror" : m[1].toLowerCase() } })],
  [/^(?:text only|no voice(?: notes| replies)?|stop (?:talking|the voice notes))$/i, () => ({ action: "speech.settings", args: { replies: "off" } })],
  [/^(?:talk to me|reply (?:with|in) voice(?: notes?)?|always (?:talk|reply in voice))$/i, () => ({ action: "speech.settings", args: { replies: "always" } })],
  [/^(?:use|switch to|change to)? ?(?:an? |the )?(warm|upbeat|calm|deep|lively|gentle|bright|easy) voice$/i, (m) => ({ action: "speech.settings", args: { voice: m[1].toLowerCase() } })],
  [/^(?:say|read) (?:that|it|this) (?:out loud|aloud|to me)|^read (?:that|it) to me$/i, () => ({ action: "speech.say", args: {} })],
];

function norm(s?: string) {
  if (!s) return undefined;
  const v = s.toLowerCase();
  return v === "this week" ? "week" : v;
}
function cur(s?: string) {
  const v = (s ?? "").toLowerCase();
  if (!v) return undefined;
  if (v === "naira") return "NGN";
  if (v.startsWith("dollar")) return "USD";
  if (v.startsWith("pound")) return "GBP";
  if (v === "cfa") return "XAF";
  return v.toUpperCase();
}

/** Something only a real request carries: a number, a link, an address or hash, a handle, a pasted message. */
export const SPECIFIC = /\d|https?:\/\/|\b0x[0-9a-f]{6,}|@\w{3,}|:\s*\S/i;

export function parseByRules(text: string): Intent | null {
  const t = text.trim().replace(/[.!]+$/, "");
  const tryAll = (x: string) => {
    for (const [re, fn] of [...pluginRules(), ...RULES]) {
      const m = x.match(re);
      const hit = m ? fn(m) : null;
      if (hit) return hit;
    }
    return null;
  };
  // "can you explain tx 0x…", "please check this link …": the ask without the politeness.
  const plain = t.replace(/^(?:(?:hey|hi|ok|okay),?\s+)?(?:(?:can|could|would|will) you(?: please)?|please|pls|kindly)\s+(?=\S)/i, "").replace(/\?$/, "");
  return tryAll(t) ?? (plain !== t && SPECIFIC.test(plain) ? tryAll(plain) : null);
}
