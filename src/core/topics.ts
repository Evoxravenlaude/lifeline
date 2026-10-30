/**
 * Topics in the private chat (Telegram Bot API 9.3 and 9.4). With topics on, the one long chat becomes a few
 * threads: Money, Health, Trips, Work and Home. Pings about money land in Money, doses and cycle in Health, and
 * so on; reminders, the morning brief and anything about safety stay in the main chat, where they're seen.
 * Anything typed inside a topic is answered there.
 *
 * Channel-agnostic: the Telegram side registers the function that actually makes the topics.
 */

export const AREAS = ["money", "health", "trips", "work", "home"] as const;
export type Area = (typeof AREAS)[number];

export const AREA_NAMES: Record<Area, string> = { money: "Money", health: "Health", trips: "Trips", work: "Work", home: "Home" };

/** Telegram allows six icon colours for a topic. One each, so they're easy to tell apart. */
export const AREA_COLOURS: Record<Area, 0x6fb9f0 | 0xffd67e | 0xcb86db | 0x8eee98 | 0xff93b2 | 0xfb6f5f> = {
  money: 0x8eee98, health: 0xff93b2, trips: 0x6fb9f0, work: 0xcb86db, home: 0xffd67e,
};

/** Push kinds (scheduler push()) by area. Anything not listed stays in the main chat. */
const KIND: [RegExp, Area][] = [
  [/^(?:money|bill|bills|warranty|return|move|sub|iou|invoice|tax|rent|savings|circle)/, "money"],
  [/^(?:medication|cycle|well_(?:mood|radar|good|quit|care|lesson|buddy|task)|quit|water|checkup|symptom|measure)/, "health"],
  [/^(?:trip|flight|plan)/, "trips"],
  [/^(?:tech|statuspage|incidentio|gas|funding|claim|unlock|phone|transferred|delisted|creative|crt_|mint|drop|commission|hackathon|job|scout|launch|price|trading|polymarket)/, "work"],
  [/^(?:home|power|fuel|gen_|prayer|holiday|sport|outage)/, "home"],
];
/** Action names by area, for replies to messages typed outside a topic (used only to say where things will go). */
const ACTION: [RegExp, Area][] = [
  [/^(?:spend|money|iou|sub|budget|bill|debt|invoice|tax|rent|savings|circle|ajo|cooloff|warranty|return|document|paperwork|relocation)\./, "money"],
  [/^(?:medication|cycle|measure|habit|mood|good|checkup|symptom|quit|doctor|well)\./, "health"],
  [/^(?:trip|plan|flight)\./, "trips"],
  [/^(?:monitor|github|package|status|devtool|rotation|gas|walletwatch|tx|token|approvals|claim|funding|market|ens|tech|mint|drop|commission|opencall|release|idea|portfolio|job|hackathon|scout|company|launch|price|trade)\./, "work"],
  [/^(?:home|refill|power|outage|generator|upkeep|faith|prayer|holiday|sports|team|wrapped)\./, "home"],
];

export function areaOfKind(kind?: string): Area | null {
  if (!kind) return null;
  for (const [re, a] of KIND) if (re.test(kind)) return a;
  return null;
}
export function areaOfAction(action?: string): Area | null {
  if (!action) return null;
  for (const [re, a] of ACTION) if (re.test(action)) return a;
  return null;
}

export type TopicMap = Partial<Record<Area, number>>;
/** The person's topics, if they turned them on. */
export function topicsOf(prefs: Record<string, unknown>): TopicMap | null {
  const t = prefs.topics;
  if (!t || typeof t !== "object") return null;
  const out: TopicMap = {};
  for (const a of AREAS) { const v = (t as Record<string, unknown>)[a]; if (typeof v === "number" && v > 0) out[a] = v; }
  return Object.keys(out).length ? out : null;
}

/** Made by the Telegram channel: create the topics in this person's chat. Null when topics can't be made. */
type Maker = (telegramChatId: number, existing: TopicMap) => Promise<{ ok: true; topics: TopicMap } | { ok: false; why: "off" | "failed" }>;
let maker: Maker | null = null;
export function registerTopicMaker(fn: Maker) { maker = fn; }
export function topicMaker(): Maker | null { return maker; }
