/**
 * Pick the handful of tools that could plausibly apply to a message, so a
 * model call carries ~10 schemas instead of ~60. Keeps every provider cheaper
 * and keeps free tiers (Groq's per-minute token cap in particular) in range.
 * Scoring is lexical: message words against action names, descriptions and a
 * small cue map per module. Pure chat scores nothing and gets a tiny default set.
 */
import { allActions } from "../policy/registry.js";
import type { Action } from "../policy/types.js";
import { pluginCues } from "../core/plugins.js";

const CUES: Record<string, string[]> = {
  cycle: ["period", "cycle", "menstrual", "fertile", "ovulat", "cramps", "spotting", "flow", "pms", "late", "pregnan", "bloating", "tampon", "pad"],
  measure: ["weight", "weigh", "slept", "sleep", "water", "drank", "mood", "steps", "blood pressure", "bp", "bench", "squat", "deadlift", "kg", "hours", "tracking", "routine", "skincare", "heart rate"],
  reminder: ["remind", "forget", "nudge", "ping", "alarm", "later", "tonight", "tomorrow"],
  calendar: ["calendar", "schedule", "meeting", "call", "appointment", "event", "dinner", "lunch", "free", "busy", "week", "today", "tomorrow", "book"],
  medication: ["med", "meds", "pill", "pills", "tablet", "dose", "medicine", "medication", "vitamin", "prescription", "take", "taking"],
  class: ["class", "lecture", "lab", "timetable", "school", "uni", "course"],
  assignment: ["assignment", "homework", "essay", "exam", "test", "due", "submit"],
  trip: ["trip", "travel", "flight", "hotel", "airbnb", "pack", "packing", "going to", "visa", "itinerary"],
  habit: ["habit", "gym", "workout", "run", "ran", "streak", "yoga", "meditat", "read", "did"],
  spend: ["spent", "paid", "spend", "spending", "expense", "cost", "naira", "dollar", "money", "bought", "budget"],
  note: ["note", "jot", "write down", "notes"],
  memory: ["remember", "forget", "know about me", "memory"],
  date: ["birthday", "bday", "anniversary", "countdown", "days until", "days till"],
  weather: ["weather", "rain", "hot", "cold", "umbrella", "forecast"],
  fx: ["convert", "usd", "ngn", "gbp", "eur", "xaf", "rate", "naira", "dollars", "pounds", " to ", " in "],
  summarize: ["summar", "tldr", "http", "link", "article"],
  hackathon: ["hackathon", "colosseum", "ethglobal", "devpost", "superteam", "bounty", "ledger", "submitted", "won", "prize", "deadline", "interests"],
  price: ["price", "sol", "btc", "eth", "bnb", "coin", "token", "above", "below", "pump", "dump", "alert"],
  wallet: ["wallet", "address", "portfolio", "balance", "holdings"],
  jobs: ["job", "jobs", "hiring", "role", "greenhouse", "lever", "ashby", "remote"],
  launch: ["launch", "launches", "new repo", "github", "show hn", "contact", "reach"],
  scout: ["scout", "projects", "startups", "founders", "building", "niche", "outreach", "dm", "intro", "who's", "who is"],
  bill: ["bill", "airtime", "data bundle", "top up", "topup", "recharge", "electricity", "dstv", "pay"],
  trading: ["follow", "copy", "shadow", "polymarket", "pumpfun", "pump.fun", "trader"],
  persona: ["voice", "persona", "talk like", "sound like", "tone", "personality", "be more"],
  settings: ["timezone", "digest", "quiet", "email", "country", "my name"],
  digest: ["digest", "brief", "rundown", "my day", "morning"],
  image: ["draw", "picture", "image", "illustrat", "paint", "sketch", "generate", "wallpaper", "logo", "sticker", "artwork", "poster", "avatar", "pfp"],
  web: ["search", "google", "look up", "lookup", "latest", "news", "who won", "current", "score", "online", "find out", "reviews", "release date", "open now"],
  speech: ["voice note", "voice replies", "voice reply", "talk to me", "out loud", "read it", "read that", "read this", "say it", "speak", "voice message", "your voice", "sound like"],
  email: ["email", "mail me", "inbox", "e-mail"],
  game: ["play", "game", "trivia", "quiz", "riddle", "would you rather", "bored", "fun"],
  fun: ["roast", "hype", "decide", "pick for me", "choose for me", "coin", "flip", "dice", "roll", "8 ball", "8-ball", "magic", "wrapped", "fortune", "compliment", "joke"],
  list: ["todo", "to-do", "shopping", "list", "buy", "need to", "have to", "done", "finished", "bought", "task"],
};

const ALWAYS = ["reminder.create", "note.add", "memory.remember", "list.add"];

export function selectTools(text: string, max = 12): Action[] {
  const t = ` ${text.toLowerCase()} `;
  const words = new Set(t.split(/[^a-z0-9']+/).filter((w) => w.length > 2));
  const scored = allActions()
    .filter((a) => a.tier !== 3)
    .map((a) => {
      const mod = a.name.split(".")[0];
      let s = 0;
      if (t.includes(mod.slice(0, 6))) s += 6; // the module's own root word ("remind", "hackat", "calend") outranks shared cues like "tomorrow"
      for (const cue of [...(CUES[mod] ?? []), ...(pluginCues()[mod] ?? [])]) if (t.includes(cue.length > 3 || cue.includes(" ") ? cue : ` ${cue} `)) s += cue.includes(" ") ? 3 : 2;
      for (const w of a.name.replace(/[._]/g, " ").split(" ")) if (words.has(w)) s += 3;
      for (const w of a.description.toLowerCase().split(/[^a-z0-9']+/)) if (w.length > 4 && words.has(w)) s += 1;
      return { a, s };
    })
    .sort((x, y) => y.s - x.s);
  const picked = scored.filter((x) => x.s > 0).slice(0, max).map((x) => x.a);
  for (const name of ALWAYS) if (picked.length < max && !picked.some((a) => a.name === name)) {
    const a = allActions().find((x) => x.name === name);
    if (a) picked.push(a);
  }
  return picked;
}
