/**
 * Plan a trip properly: a few anchors first (when, from where, what kind of trip), then real research (visas for the
 * person's passport, getting there, where to stay, what to do, food), written up as a page they can open and share,
 * with a short reply that leads with the one thing that sets the clock (usually the visa).
 * Every fact comes from a live web search; the model only arranges what was found and says when something is unsure.
 * Without a model or search it says so and starts a simple trip with a packing list instead.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type Ctx } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema } from "../core/plugins.js";
import { complete, providerName } from "../intent/providers.js";
import { overBudget, recordUsage } from "../core/budget.js";
import { allow, draw, parseJson, search } from "../core/media.js";
import { findCity } from "../core/geo.js";
import { countryOf } from "../core/money.js";
import { config } from "../core/config.js";
import { webAddress } from "../core/ways.js";
import { log } from "../core/log.js";

addSchema(`CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), kind TEXT NOT NULL DEFAULT 'trip', title TEXT NOT NULL, data JSONB NOT NULL, hero BYTEA, hero_mime TEXT, created_at TIMESTAMPTZ DEFAULT now(), deleted BOOLEAN NOT NULL DEFAULT false)`);

export interface TripPlan {
  title: string; destination: string; when: string; from: string | null; style: string | null;
  clock: string;          // the one thing that sets the clock
  summary: string;        // two or three sentences
  visa: string; gettingThere: string; budget: string;
  stay: { area: string; why: string }[];
  days: { title: string; items: string[] }[];
  food: string[]; tips: string[]; packing: string[];
  questions: string[];    // what would sharpen the next pass
  sources: { title: string; url: string }[];
  passport: string | null; made: string;
}

/** Where the plan pages are served: the server's own address (it renders them), else the website. */
export const planBase = () => (config.publicUrl || webAddress() || "").replace(/\/$/, "");
export const planUrl = (id: string) => `${planBase()}/plan/${id}`;

/** "February 2027, from Abuja. Hikes and food" → the anchors. */
export function readAnchors(text: string): { when?: string; from?: string; style?: string } {
  const t = text.trim().replace(/\s+/g, " ");
  const from = /\b(?:from|leaving from|flying from|out of)\s+([A-Za-zÀ-ÿ' .-]{2,40}?)(?=[,.;]|\s+(?:in|on|around|for|and|with)\b|$)/i.exec(t)?.[1]?.trim();
  const when = /\b((?:early |mid |late |mid-|end of |start of )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?(?:\s+(?:to|until|-)\s+\d{1,2}(?:st|nd|rd|th)?(?:\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)?(?:\s+\d{4})?)?|next (?:week|month|year|summer|winter|spring|autumn)|this (?:summer|winter|spring|autumn|weekend)|christmas|easter|new year)/i.exec(t)?.[1];
  const rest = t.replace(from ? new RegExp(`\\b(?:from|leaving from|flying from|out of)\\s+${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i") : /$^/, " ")
    .replace(when ? new RegExp(when.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") : /$^/, " ")
    .replace(/^[\s,.;-]+|[\s,.;-]+$/g, "").replace(/\s*[,.;]\s*/g, ", ").replace(/^(?:and|,)\s*/i, "").trim();
  return { ...(when ? { when } : {}), ...(from ? { from } : {}), ...(rest.length >= 3 ? { style: rest.slice(0, 120) } : {}) };
}

const say = async (ctx: Ctx, step: string) => { try { await ctx.progress?.(step); } catch { /* the steps are a nicety */ } };

async function research(ctx: Ctx, q: string): Promise<{ answer: string; sources: { title: string; url: string }[] } | null> {
  const r = await search(q, ctx.user.tz).catch(() => null);
  return r ? { answer: r.answer, sources: (r.sources ?? []).slice(0, 4).map((s: any) => ({ title: String(s.title ?? s.url).slice(0, 90), url: String(s.url) })) } : null;
}

const plan = defineAction({
  name: "trip.plan",
  tier: 1,
  description: "Research and write up a full trip plan (visa for their passport, getting there, where to stay, a day-by-day, food, tips) as a page they can open, for when someone says 'help me plan a trip to X' or 'plan my trip to X'. Asks for when and where they're travelling from first. For simply recording a trip with dates, use trip.create instead.",
  schema: z.object({ destination: z.string().min(2).max(60), when: z.string().max(60).optional(), from: z.string().max(60).optional(), style: z.string().max(120).optional() }),
  needs(args) {
    if (args.when && args.from) return null;
    const d = args.destination.replace(/\b\w/g, (c) => c.toUpperCase());
    return { need: "anchors", question: `Happy to plan ${d}. A few anchors so I build the right trip: when are you thinking, and where are you travelling from? And is it more hikes and sights, or food and slow days?` };
  },
  fill(need, answer) {
    if (need !== "anchors") return null;
    const a = readAnchors(answer);
    return a.when || a.from ? { ...a } : null;
  },
  async run(args, ctx) {
    const dest = args.destination.trim();
    if (!providerName() || (await overBudget(ctx.db, ctx.user.id))) {
      return { reply: `I can't research a full plan right now (that needs the model and web search). Say "I'm going to ${dest}${args.when ? ` ${args.when}` : ""}" and I'll start the trip with a packing list and reminders.` };
    }
    await say(ctx, `Reading up on ${dest}`);
    const home = args.from ? await findCity(args.from).catch(() => null) : null;
    const passportCountry = (typeof ctx.user.prefs.passport === "string" ? ctx.user.prefs.passport : null) ?? home?.countryName ?? null;
    const country = countryOf(ctx.user);
    const when = args.when ?? "soon";
    await say(ctx, passportCountry ? `Visa rules for a ${passportCountry} passport` : "Visa rules");
    const visa = await research(ctx, `Visa requirements for ${passportCountry ?? "travellers"} passport holders visiting ${dest} in ${when}${home?.countryName ? `, applying from ${home.countryName}` : ""}: which visa, where to apply, how long it takes, documents.`);
    await say(ctx, `Getting there${args.from ? ` from ${args.from}` : ""}`);
    const route = await research(ctx, `How to travel to ${dest}${args.from ? ` from ${args.from}` : ""} in ${when}: usual routes, connections, nearest airport, typical journey time and rough fares.`);
    await say(ctx, "Where to stay, what to do, where to eat");
    const things = await research(ctx, `${dest} in ${when}${args.style ? ` for someone who wants ${args.style}` : ""}: best areas or towns to stay, specific hotels by name, top things to do (with what's open or good that season), notable restaurants including any Michelin-starred ones, local food to try, weather.`);
    if (!visa && !route && !things) return { reply: `I couldn't reach web search just now, so I won't guess at a plan. Try again in a few minutes, or say "I'm going to ${dest}" to start a simple trip.` };
    await say(ctx, "Writing it up");
    const facts = [visa && `VISA:\n${visa.answer}`, route && `GETTING THERE:\n${route.answer}`, things && `STAY, DO, EAT:\n${things.answer}`].filter(Boolean).join("\n\n");
    const r = await complete({
      system: "You turn research notes into a trip plan. Use only facts in the notes; when the notes are unsure or silent, say so briefly rather than inventing (no made-up prices, opening hours or names). Plain, warm, specific. No emoji, no em dashes. Output JSON only.",
      messages: [{ role: "user", content: `Trip: ${dest}, ${when}${args.from ? `, from ${args.from}` : ""}${args.style ? `, style: ${args.style}` : ""}. Passport: ${passportCountry ?? "unknown"}.\n\nNotes:\n${facts}\n\nJSON with keys: title (short), clock (one sentence: the single thing to start first and why, e.g. the visa), summary (2 to 3 sentences: where to base, the big dinner, the one activity), visa (2 to 4 sentences), gettingThere (2 to 4 sentences), budget (1 to 2 sentences, only what the notes support), stay (up to 3 {area, why}), days (2 to 5 {title, items: 2 to 4 short strings}), food (up to 5), tips (up to 5), packing (up to 8 short items for that place and season), questions (2 short questions that would sharpen the plan).` }],
      json: true, maxTokens: 1800,
    }).catch((e) => { log.warn({ err: e?.message }, "plan write-up failed"); return null; });
    if (!r) return { reply: "I did the research but couldn't write it up just now. Try again in a minute?" };
    await recordUsage(ctx.db, ctx.user.id, r.usage.input, r.usage.output);
    const j = parseJson(r.text) as Partial<TripPlan> | null;
    if (!j?.clock || !Array.isArray(j.days)) return { reply: "I did the research but the write-up came out garbled. Try again in a minute?" };
    const arr = <T,>(x: unknown, n: number): T[] => (Array.isArray(x) ? (x as T[]).slice(0, n) : []);
    const p: TripPlan = {
      title: String(j.title ?? dest).slice(0, 80), destination: dest, when, from: args.from ?? null, style: args.style ?? null,
      clock: String(j.clock), summary: String(j.summary ?? ""), visa: String(j.visa ?? ""), gettingThere: String(j.gettingThere ?? ""), budget: String(j.budget ?? ""),
      stay: arr<any>(j.stay, 3).map((s) => ({ area: String(s.area ?? ""), why: String(s.why ?? "") })),
      days: arr<any>(j.days, 6).map((d) => ({ title: String(d.title ?? ""), items: arr<string>(d.items, 5).map(String) })),
      food: arr<string>(j.food, 6).map(String), tips: arr<string>(j.tips, 6).map(String), packing: arr<string>(j.packing, 10).map(String), questions: arr<string>(j.questions, 2).map(String),
      sources: [...(visa?.sources ?? []), ...(route?.sources ?? []), ...(things?.sources ?? [])].filter((s, i, a) => /^https?:\/\//.test(s.url) && a.findIndex((x) => x.url === s.url) === i).slice(0, 10),
      passport: passportCountry, made: ctx.now.toISOString(),
    };
    let hero: { data: Buffer; mime: string } | null = null;
    if (allow("image", ctx.user.id)) {
      await say(ctx, "A picture for the top");
      const month = /(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i.exec(when)?.[0] ?? "";
      hero = await draw(`A calm, wide landscape photograph of ${dest}${month ? ` in ${month}` : ""}, soft natural light, no people in focus, no text`).catch(() => null);
    }
    const id = randomBytes(12).toString("base64url");
    await ctx.db.query(`INSERT INTO plans (id, user_id, kind, title, data, hero, hero_mime) VALUES ($1,$2,'trip',$3,$4,$5,$6)`, [id, ctx.user.id, p.title, JSON.stringify(p), hero?.data ?? null, hero?.mime ?? null]);
    const url = planUrl(id);
    const lines = [
      `Your ${dest} plan is ready: ${url}`,
      "",
      p.clock,
      ...(p.summary ? ["", p.summary] : []),
      ...(p.questions.length ? ["", `To shape the next pass: ${p.questions.join(" ")}`] : []),
      "",
      `_Anyone with the link can open it${p.passport || p.from ? `, and it mentions ${[p.passport ? "your passport country" : "", p.from ? "where you're leaving from" : ""].filter(Boolean).join(" and ")}` : ""}. Say "delete my ${dest} plan" to take it down._`,
    ];
    void country;
    const buttons = [
      ...(/^https:\/\//.test(url) ? [{ label: "Open the plan", data: `webapp:${url}` }] : []),
      { label: "Add to my trips", data: `say:I'm going to ${dest}${args.when ? ` ${args.when}` : ""}`.slice(0, 64) },
    ];
    return { reply: lines.join("\n"), buttons, undo: { payload: { id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE plans SET deleted=true WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Plan taken down. The link no longer opens.";
  },
});

const planDelete = defineAction({
  name: "plan.delete",
  tier: 1,
  description: "Take down a shared plan page (the link stops working). 'match' is the destination or title.",
  schema: z.object({ match: z.string().min(2) }),
  async run(args, ctx) {
    const rows = await ctx.db.query<{ id: string; title: string }>(`UPDATE plans SET deleted=true WHERE user_id=$1 AND NOT deleted AND (title ILIKE $2 OR data->>'destination' ILIKE $2) RETURNING id, title`, [ctx.user.id, `%${args.match.trim()}%`]);
    return { reply: rows.length ? `Taken down: ${rows.map((r) => r.title).join(", ")}. The link${rows.length > 1 ? "s" : ""} no longer open.` : `I don't have a plan for ${args.match.trim()}.` };
  },
});

const planList = defineAction({
  name: "plan.list",
  tier: 1,
  description: "List the person's plan pages with their links.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ id: string; title: string; created_at: string }>(`SELECT id, title, created_at FROM plans WHERE user_id=$1 AND NOT deleted ORDER BY created_at DESC LIMIT 8`, [ctx.user.id]);
    if (!rows.length) return { reply: "No plans yet. Say \"help me plan a trip to Lisbon\" and I'll research one." };
    return { reply: ["**Your plans**", ...rows.map((r) => `- ${r.title}, ${DateTime.fromJSDate(new Date(r.created_at)).setZone(ctx.user.tz).toFormat("d LLL")}: ${planUrl(r.id)}`)].join("\n") };
  },
});

register(plan, planDelete, planList);

/** "itinerary for tomorrow", "a visit to my parents", "my meal plan": a day, people at home or another kind of plan. */
const NOT_PLACE = /^(?:my|our|his|her|their|the (?:meeting|party|office|kids|family|wedding|day|week|weekend|event|conference)|tomorrow|today|tonight|next (?:week|month)|the week|work|school|class|meal|diet|workout|phone|data|payment|savings|study|business|lesson|training|insurance|pension|health|mobile|cell|budget|project|marketing|content)\b/i;
const place = (s: string) => !NOT_PLACE.test(s.trim());

addRules(
  // "plan a trip to X" stays the quick trip (dates and a packing list); asking for help, research or an itinerary gets the full plan.
  [/^(?:(?:can you |could you |please )?help me plan|plan me|plan out|research|map out|put together|build me|make me)\s+(?:a |my |our |the )?(?:trip|holiday|vacation|getaway|weekend away|honeymoon|visit|itinerary)\s+(?:to|in|for)\s+([^\d,?]{2,40}?)(?:\s+(?:in|for|around)\s+((?:early |mid |late )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s+\d{4})?|next (?:week|month|year|summer|winter)))?(?:,?\s+from\s+([A-Za-zÀ-ÿ' .-]{2,40}))?\??$/i,
    (m) => (place(m[1]) ? { action: "trip.plan", args: { destination: m[1].trim(), ...(m[2] ? { when: m[2] } : {}), ...(m[3] ? { from: m[3].trim() } : {}) } } : null)],
  [/^(?:an? )?itinerary for\s+([^\d,?]{2,40}?)\??$/i, (m) => (place(m[1]) ? { action: "trip.plan", args: { destination: m[1].trim() } } : null)],
  [/^(?:delete|remove|take down)\s+(?:my |the )?(.+?)\s+plan(?: page)?$/i, (m) => (place(m[1]) ? { action: "plan.delete", args: { match: m[1] } } : null)],
  [/^(?:my plans|my trip plans|show my plans)$/i, () => ({ action: "plan.list", args: {} })],
);
addExamples("trip.plan", ["help me plan a trip to Liechtenstein", "help me plan a trip to Bali in March from Lagos", "research a weekend away in Porto", "itinerary for Kyoto"]);
addExamples("plan.delete", ["delete my Liechtenstein plan"]);
addExamples("plan.list", ["my plans"]);
addCues("trip", ["plan a trip", "itinerary", "visa", "holiday", "vacation", "getaway", "where to stay"]);
addCapability({
  key: "tripplan", name: "Trip plans, researched",
  cues: ["plan a trip", "itinerary", "visa", "holiday", "where to stay", "what to do in"],
  what: "Say where you want to go. I ask when and from where, then look up the visa for your passport, how to get there, where to stay, what to do and where to eat, and write it up as a page you can open and share.",
  say: ["help me plan a trip to Liechtenstein", "help me plan a trip to Bali in March from Lagos", "my plans"],
  then: "The reply leads with the one thing to start first, usually the visa. Tap Add to my trips to keep reminders and a packing list.",
  limits: "Needs the model and web search. Facts come from live search; check prices and visa rules with the official source before paying.",
}, "Your day");
