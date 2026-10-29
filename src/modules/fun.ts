/**
 * The fun bits: games, decisions, dice, roasts, hype and the week wrapped.
 * Everything works without a model (small built-in banks); with one, it's fresh every time.
 */
import { parseByRules } from "../intent/rules.js";
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../policy/types.js";
import { register } from "../policy/registry.js";
import type { Db } from "../core/db.js";
import { complete, providerName } from "../intent/providers.js";
import { personaPrompt } from "../intent/persona.js";
import { overBudget, recordUsage } from "../core/budget.js";
import { parseJson } from "../core/media.js";
import { log } from "../core/log.js";

const pick = <T>(a: T[]): T => a[Math.floor(Math.random() * a.length)];

/** A short model call in the user's voice. Null when there's no model or it's over budget. */
async function think(db: Db, user: User, instruction: string, o: { json?: boolean; max?: number } = {}): Promise<string | null> {
  if (!providerName() || (await overBudget(db, user.id))) return null;
  try {
    const r = await complete({
      system: `You are lifeline, a quick-witted personal assistant for a small circle of friends; your mascot is Pip, a tortoise in brass spectacles. ${personaPrompt(user.prefs)}\nNo emoji unless the voice uses them. No em dashes.`,
      messages: [{ role: "user", content: instruction }], json: o.json, maxTokens: o.max ?? 500,
    });
    if (!r) return null;
    await recordUsage(db, user.id, r.usage.input, r.usage.output);
    return r.text || null;
  } catch (e: any) { log.warn({ err: e?.message }, "fun model call failed"); return null; }
}

/* ---------------- games ---------------- */

export interface Game { kind: "trivia" | "wyr" | "riddle"; q: string; options?: string[]; answer?: number | string; note?: string; hint?: string; at: number; misses?: number }
/** A game's short id, carried in its buttons so an old message can't answer a newer game. */
export const gid = (g: Game) => (g.at % 46656).toString(36);
interface Score { played: number; right: number; streak: number; best: number }

export const TRIVIA: [string, string[], number, string][] = [
  ["Which planet has the shortest day?", ["Jupiter", "Earth", "Mars", "Venus"], 0, "Jupiter spins once in under ten hours."],
  ["How many hearts does an octopus have?", ["One", "Two", "Three", "Eight"], 2, "Two pump blood to the gills, one to the rest of the body."],
  ["What's the most widely spoken language in Africa by total speakers?", ["Swahili", "Arabic", "Hausa", "Yoruba"], 1, "Arabic, counting North Africa; Swahili is the biggest lingua franca south of the Sahara."],
  ["Which country has the most pyramids?", ["Egypt", "Mexico", "Sudan", "Peru"], 2, "Sudan has around 200 Nubian pyramids, more than Egypt."],
  ["How long can a tortoise live?", ["About 30 years", "About 60 years", "Over 150 years", "About 10 years"], 2, "Some giant tortoises pass 150. Pip plans to."],
  ["What's the hardest natural substance?", ["Quartz", "Diamond", "Titanium", "Graphene"], 1, "Diamond, though lab-made materials push close."],
  ["Which city hosted the first modern Olympics in 1896?", ["Paris", "London", "Athens", "Rome"], 2, "Athens, fittingly."],
  ["What colour is a polar bear's skin?", ["White", "Pink", "Black", "Grey"], 2, "Black skin, see-through fur."],
  ["Which is the longest river in the world by most measures?", ["Amazon", "Nile", "Yangtze", "Congo"], 1, "The Nile, by the usual measure, though the Amazon has its fans."],
  ["How many bones are in the adult human body?", ["186", "206", "226", "256"], 1, "206. Babies start with closer to 300."],
];
const WYR: [string, string, string, string][] = [
  ["have a personal chef", "a personal driver", "Fed like royalty.", "Never stuck in traffic again."],
  ["always be ten minutes early", "always be five minutes late", "The quiet power of the early.", "Fashionably, consistently late."],
  ["know every language", "play every instrument", "Talk to anyone, anywhere.", "The life of every party."],
  ["live by the beach", "live in the mountains", "Salt air it is.", "Cool air and a view."],
  ["give up music for a year", "give up your phone for a month", "Silence is brave.", "A month of being unreachable. Respect."],
  ["have free flights forever", "free food forever", "The world is yours.", "Never paying for jollof again."],
];
const RIDDLES: [string, string, string][] = [
  ["What has keys but can't open locks?", "a piano", "You play it."],
  ["The more you take, the more you leave behind. What are they?", "footsteps", "Think about walking."],
  ["What gets wetter the more it dries?", "a towel", "You use it after a bath."],
  ["What has a neck but no head?", "a bottle", "You drink from it."],
  ["I'm tall when I'm young and short when I'm old. What am I?", "a candle", "I give light."],
  ["What can travel around the world while staying in a corner?", "a stamp", "Think post."],
];

async function newGame(db: Db, user: User, kind: Game["kind"], topic?: string): Promise<Game> {
  const seen: string[] = Array.isArray(user.prefs.gameSeen) ? (user.prefs.gameSeen as string[]) : [];
  const avoid = seen.length ? ` Don't repeat any of these: ${seen.slice(-8).join(" | ")}.` : "";
  const about = topic ? ` about ${topic}` : "";
  if (kind === "trivia") {
    const j = parseJson((await think(db, user, `One fun multiple-choice trivia question${about || " on any topic: science, history, Africa, music, sport, film, food, geography"}. Medium difficulty, surprising answer. JSON: {"question": string, "options": [4 short options], "answer": index 0-3, "fact": one fun line explaining it}.${avoid}`, { json: true })) ?? "");
    if (j?.question && Array.isArray(j.options) && j.options.length === 4 && Number.isInteger(j.answer) && j.answer >= 0 && j.answer <= 3) return { kind, q: j.question, options: j.options.map(String), answer: Number(j.answer), note: j.fact, at: Date.now() };
    const fresh = TRIVIA.filter((t) => !seen.includes(t[0]));
    const [q, options, answer, note] = pick(fresh.length ? fresh : TRIVIA);
    return { kind, q, options, answer, note, at: Date.now() };
  }
  if (kind === "wyr") {
    const j = parseJson((await think(db, user, `One playful "would you rather"${about}, two short options that are genuinely hard to choose between. JSON: {"a": string, "b": string, "after_a": a short witty reaction if they pick a, "after_b": the same for b}.${avoid}`, { json: true })) ?? "");
    if (j?.a && j?.b) return { kind, q: `Would you rather ${j.a}, or ${j.b}?`, options: [String(j.a), String(j.b)], note: JSON.stringify([j.after_a ?? "Bold.", j.after_b ?? "Respect."]), at: Date.now() };
    const [a, b, ra, rb] = pick(WYR);
    return { kind, q: `Would you rather ${a}, or ${b}?`, options: [a, b], note: JSON.stringify([ra, rb]), at: Date.now() };
  }
  const j = parseJson((await think(db, user, `One clever riddle${about} with a short, fair answer. JSON: {"riddle": string, "answer": a few words, "hint": one nudge}.${avoid}`, { json: true })) ?? "");
  if (j?.riddle && j?.answer) return { kind, q: j.riddle, answer: String(j.answer), hint: j.hint, at: Date.now() };
  const [q, answer, hint] = pick(RIDDLES);
  return { kind, q, answer, hint, at: Date.now() };
}

async function saveGame(db: Db, user: User, g: Game | null, score?: Score) {
  const seen = Array.isArray(user.prefs.gameSeen) ? (user.prefs.gameSeen as string[]) : [];
  const patch: Record<string, unknown> = { game: g };
  if (g) patch.gameSeen = [...seen, g.q].slice(-30);
  if (score) patch.gameScore = score;
  await db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [user.id, JSON.stringify(patch)]);
  Object.assign(user.prefs, patch);
}
const scoreOf = (user: User): Score => ({ played: 0, right: 0, streak: 0, best: 0, ...(user.prefs.gameScore as Partial<Score> | undefined) });
const LETTERS = ["A", "B", "C", "D"];

export function gameReply(g: Game): { reply: string; buttons: { label: string; data: string }[] } {
  if (g.kind === "trivia") return { reply: g.q, buttons: g.options!.map((o, i) => ({ label: `${LETTERS[i]}. ${o}`.slice(0, 60), data: `g:t:${gid(g)}:${i}` })) };
  if (g.kind === "wyr") return { reply: g.q, buttons: g.options!.map((o, i) => ({ label: o.charAt(0).toUpperCase() + o.slice(1, 58), data: `g:w:${gid(g)}:${i}` })) };
  return { reply: `${g.q}\n\nType your answer.`, buttons: riddleButtons(g) };
}
const riddleButtons = (g: Game) => [{ label: "A hint", data: `g:r:${gid(g)}:hint` }, { label: "Tell me", data: `g:r:${gid(g)}:show` }];
const again = (kind: Game["kind"]) => [{ label: "Another one", data: `g:new:${kind}` }, { label: "Something else", data: "g:new:any" }];
const KINDS: Game["kind"][] = ["trivia", "wyr", "riddle"];

const gamePlay = defineAction({
  name: "game.play",
  tier: 1,
  description: "Play a quick game: kind is trivia (quiz), wyr (would you rather) or riddle; 'topic' optional (e.g. football, Nollywood, science). Use for 'I'm bored', 'play a game', 'quiz me', 'give me a riddle'.",
  schema: z.object({ kind: z.enum(["trivia", "wyr", "riddle"]).optional(), topic: z.string().optional() }),
  async run(args, ctx) {
    const g = await newGame(ctx.db, ctx.user, args.kind ?? pick(KINDS), args.topic);
    await saveGame(ctx.db, ctx.user, g);
    return gameReply(g);
  },
});

const norm = (s: string) => s.toLowerCase().replace(/^(?:an?|the)\s+/, "").replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();

/** A typed answer to an open riddle or quiz. Null when the message isn't one, so it's read as normal. */
export async function gameAnswer(db: Db, user: User, text: string): Promise<{ text: string; buttons?: { label: string; data: string }[]; sticker?: string } | null> {
  const g = user.prefs.game as Game | null | undefined;
  if (!g || Date.now() - g.at > 15 * 60_000) return null;
  const t = text.trim();
  // Anything that reads as a request is a request: the game steps aside.
  if (parseByRules(t)) { await saveGame(db, user, null); return null; }
  if (/^(?:stop|quit|end|no|nah|skip|enough|cancel|i give up|give up)[.!]*$/i.test(t)) {
    await saveGame(db, user, null);
    return { text: g.kind === "riddle" ? `Fair. It was ${g.answer}.` : g.kind === "trivia" ? `Fair. It was ${LETTERS[g.answer as number]}, ${g.options![g.answer as number]}.` : "Fair enough." };
  }
  if (g.kind === "trivia") {
    const i = /^[a-d]$/i.test(t) ? LETTERS.indexOf(t.toUpperCase()) : g.options!.findIndex((o) => norm(o) === norm(t) && norm(t) !== "");
    return i < 0 ? null : answerGame(db, user, `t:${gid(g)}:${i}`);
  }
  if (g.kind === "riddle") {
    if (t.split(/\s+/).length > 6 || /\?$/.test(t)) return null;
    const guess = norm(t), want = norm(String(g.answer)) || String(g.answer).toLowerCase().trim();
    const ok = guess !== "" && (guess === want || (guess.length > 2 && want.includes(guess)) || guess.includes(want));
    const s = scoreOf(user);
    if (ok) { s.played++; s.right++; s.streak++; s.best = Math.max(s.best, s.streak); await saveGame(db, user, null, s); return { text: `${pick(["Yes!", "Got it.", "Sharp.", "Correct."])} It's ${g.answer}.${s.streak > 1 ? ` That's ${s.streak} in a row.` : ""}`, buttons: again("riddle"), sticker: s.streak >= 3 ? "cheers" : undefined }; }
    const misses = (g.misses ?? 0) + 1;
    if (misses >= 3) { s.played++; s.streak = 0; await saveGame(db, user, null, s); return { text: `Three guesses down. It was ${g.answer}.`, buttons: again("riddle") }; }
    await saveGame(db, user, { ...g, misses });
    return { text: pick(["Not quite. Another guess?", "Nope, but close-ish. Try again?", "Good guess, wrong answer. Again?"]), buttons: riddleButtons(g) };
  }
  return null;
}

/** A game button: "t:2", "w:0", "r:hint", "r:show", "new:trivia". */
export async function answerGame(db: Db, user: User, data: string): Promise<{ text: string; buttons?: { label: string; data: string }[]; sticker?: string }> {
  const parts = data.split(":");
  const k = parts[0];
  if (k === "new") {
    const v = parts[1];
    const g = await newGame(db, user, v === "any" || !KINDS.includes(v as any) ? pick(KINDS) : (v as Game["kind"]));
    await saveGame(db, user, g);
    const r = gameReply(g);
    return { text: r.reply, buttons: r.buttons };
  }
  const g = user.prefs.game as Game | null | undefined;
  const [id, v] = parts.length >= 3 ? [parts[1], parts[2]] : [null, parts[1]];
  if (!g || (id !== null && id !== gid(g))) return { text: "That game's finished. Want another?", buttons: again(g?.kind ?? "trivia") };
  const s = scoreOf(user);
  if (k === "t" && g.kind === "trivia") {
    const i = Number(v);
    if (!(i >= 0 && i < (g.options?.length ?? 0))) return { text: "That game's moved on. Want another?", buttons: again("trivia") };
    const right = i === g.answer;
    s.played++; if (right) { s.right++; s.streak++; s.best = Math.max(s.best, s.streak); } else s.streak = 0;
    await saveGame(db, user, null, s);
    const head = right ? pick(["Correct!", "Yes, that's it.", "Nailed it.", "Right!"]) : `Not this time. It's ${LETTERS[g.answer as number]}, ${g.options![g.answer as number]}.`;
    const streak = right && s.streak > 1 ? ` ${s.streak} in a row${s.streak >= s.best && s.streak > 2 ? ", your best yet" : ""}.` : "";
    return { text: `${head}${streak}${g.note ? `\n\n${g.note}` : ""}\n\nYou're on ${s.right} of ${s.played}.`, buttons: again("trivia"), sticker: right && s.streak >= 3 ? "cheers" : undefined };
  }
  if (k === "w" && g.kind === "wyr") {
    if (!g.options![Number(v)]) return { text: "That game's moved on. Want another?", buttons: again("wyr") };
    const after = (() => { try { return JSON.parse(g.note ?? "[]"); } catch { return []; } })();
    await saveGame(db, user, null);
    return { text: `${g.options![Number(v)].charAt(0).toUpperCase()}${g.options![Number(v)].slice(1)}. ${after[Number(v)] ?? "Interesting choice."}`, buttons: again("wyr") };
  }
  if (k === "r" && g.kind === "riddle") {
    if (v === "hint") return { text: g.hint ? `Hint: ${g.hint}` : "No hints on this one. Have a guess.", buttons: [{ label: "Tell me", data: `g:r:${gid(g)}:show` }] };
    s.played++; s.streak = 0;
    await saveGame(db, user, null, s);
    return { text: `It's ${g.answer}.`, buttons: again("riddle") };
  }
  return { text: "That game's moved on. Want another?", buttons: again(g.kind) };
}

/* ---------------- decisions, dice and the 8 ball ---------------- */

const decide = defineAction({
  name: "fun.decide",
  tier: 1,
  description: "Decide for the user: pick one of their 'options' (e.g. jollof or fried rice), or flip a coin when there are none. For 'pick for me', 'choose', 'flip a coin', 'heads or tails'.",
  schema: z.object({ options: z.array(z.string().min(1)).optional() }),
  async run(args) {
    const opts = (args.options ?? []).map((s) => s.trim()).filter(Boolean);
    if (opts.length < 2) return { reply: `${pick(["Heads.", "Tails."])} ${pick(["The coin has spoken.", "No take-backs.", "Best of three if you must."])}` };
    const x = pick(opts);
    return { reply: pick([`${x}. Final answer.`, `Go with ${x}. Don't overthink it.`, `${x}, obviously.`, `Pip's shell says ${x}.`, `${x}. You already knew that.`]) };
  },
});

const DICE: Record<string, [string, number]> = { dice: ["🎲", 6], darts: ["🎯", 6], basketball: ["🏀", 5], football: ["⚽", 5], bowling: ["🎳", 6], slots: ["🎰", 64] };
const roll = defineAction({
  name: "fun.roll",
  tier: 1,
  description: "Roll a die or play a quick luck game: kind is dice, darts, basketball, football, bowling or slots.",
  schema: z.object({ kind: z.enum(["dice", "darts", "basketball", "football", "bowling", "slots"]).optional() }),
  async run(args) {
    const [emoji, sides] = DICE[args.kind ?? "dice"];
    const n = 1 + Math.floor(Math.random() * sides);
    return { reply: args.kind && args.kind !== "dice" ? `Your shot: ${n} out of ${sides}.` : `You rolled a ${n}.`, dice: emoji };
  },
});

const BALL = ["Without a doubt.", "Yes, and soon.", "Signs point to yes.", "Ask again after you've eaten.", "The shell is cloudy. Try later.", "Don't count on it.", "No. Respectfully.", "It's looking good.", "Unclear, but I like your odds.", "Absolutely not.", "Yes, if you stop overthinking it.", "Only if you ask nicely."];
const eightBall = defineAction({
  name: "fun.eightball",
  tier: 1,
  description: "Answer a yes-or-no question like a magic 8 ball, for fun.",
  schema: z.object({ question: z.string().optional() }),
  async run() { return { reply: pick(BALL) }; },
});

/* ---------------- roast, hype and the week wrapped ---------------- */

export interface WeekStats { messages: number; remindersDone: number; spend: { currency: string; total: number; top: string | null }[]; sleepAvg: number | null; steps: number | null; checkins: number; topHabit: string | null }

export async function weekStats(db: Db, user: User, now = new Date()): Promise<WeekStats> {
  const since = DateTime.fromJSDate(now).setZone(user.tz).minus({ days: 7 }).toJSDate();
  const n = async (sql: string) => Number((await db.one<{ n: string }>(sql, [user.id, since]))?.n ?? 0);
  const spend = await db.query<{ currency: string; total: string; top: string | null }>(
    `SELECT currency, SUM(amount)::text AS total, (SELECT category FROM spend s2 WHERE s2.user_id=$1 AND s2.spent_at >= $2 AND s2.currency=s.currency GROUP BY category ORDER BY SUM(amount) DESC LIMIT 1) AS top
     FROM spend s WHERE user_id=$1 AND spent_at >= $2 GROUP BY currency ORDER BY SUM(amount) DESC`, [user.id, since]);
  const sleep = await db.one<{ a: string | null }>(`SELECT AVG(value)::text AS a FROM measures WHERE user_id=$1 AND name='sleep' AND at >= $2`, [user.id, since]);
  const steps = await db.one<{ s: string | null }>(`SELECT SUM(value)::text AS s FROM measures WHERE user_id=$1 AND name='steps' AND at >= $2`, [user.id, since]);
  const habit = await db.one<{ name: string; n: string }>(`SELECT h.name, count(*)::text AS n FROM habit_checkins c JOIN habits h ON h.id=c.habit_id WHERE h.user_id=$1 AND c.day >= $2::date GROUP BY h.name ORDER BY count(*) DESC LIMIT 1`, [user.id, since]);
  return {
    messages: await n(`SELECT count(*)::text AS n FROM messages WHERE user_id=$1 AND role='user' AND created_at >= $2`),
    remindersDone: await n(`SELECT count(*)::text AS n FROM reminders WHERE user_id=$1 AND done AND due_at >= $2`),
    spend: spend.map((r) => ({ currency: r.currency, total: Number(r.total), top: r.top })),
    sleepAvg: sleep?.a ? Math.round(Number(sleep.a) * 10) / 10 : null,
    steps: steps?.s ? Math.round(Number(steps.s)) : null,
    checkins: await n(`SELECT count(*)::text AS n FROM habit_checkins c JOIN habits h ON h.id=c.habit_id WHERE h.user_id=$1 AND c.day >= $2::date`),
    topHabit: habit?.name ?? null,
  };
}

const money = (amount: number, currency: string) => { try { return new Intl.NumberFormat("en-GB", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(amount); } catch { return `${Math.round(amount).toLocaleString("en-GB")} ${currency}`; } };

export function wrappedLines(s: WeekStats): string[] {
  const lines: string[] = [];
  if (s.messages) lines.push(`${s.messages} messages to me`);
  if (s.remindersDone) lines.push(`${s.remindersDone} reminder${s.remindersDone === 1 ? "" : "s"} done`);
  for (const sp of s.spend.slice(0, 2)) lines.push(`${money(sp.total, sp.currency)} spent${sp.top && sp.top !== "other" ? `, mostly on ${sp.top}` : ""}`);
  if (s.sleepAvg) lines.push(`${s.sleepAvg} hours of sleep a night`);
  if (s.steps) lines.push(`${s.steps.toLocaleString("en-GB")} steps`);
  if (s.checkins) lines.push(`${s.checkins} habit check-in${s.checkins === 1 ? "" : "s"}${s.topHabit ? `, ${s.topHabit} leading` : ""}`);
  return lines;
}

const wrapped = defineAction({
  name: "fun.wrapped",
  tier: 1,
  description: "The user's week, wrapped: their last seven days in numbers (messages, reminders done, spending, sleep, steps, habits) with a playful line.",
  schema: z.object({}),
  async run(_a, ctx) {
    const s = await weekStats(ctx.db, ctx.user, ctx.now);
    const lines = wrappedLines(s);
    if (!lines.length) return { reply: "Your week, wrapped: it's a blank page so far. Tell me what you spend, sleep and get done, and next week's will have numbers in it." };
    const quip = (await think(ctx.db, ctx.user, `Here is someone's week in numbers: ${lines.join("; ")}. Write one short, playful, specific line about it, warm not mean. Output the line only.`, { max: 120 }))?.trim();
    return { sticker: "cheers", reply: `**Your week, wrapped**\n${lines.map((l) => `- ${l}`).join("\n")}${quip ? `\n\n${quip}` : ""}` };
  },
});

const roast = defineAction({
  name: "fun.roast",
  tier: 1,
  description: "Roast the user affectionately, using their real week (spending, sleep, reminders, habits) or something they name. Only when they ask to be roasted.",
  schema: z.object({ about: z.string().optional() }),
  async run(args, ctx) {
    const lines = wrappedLines(await weekStats(ctx.db, ctx.user, ctx.now));
    const t = await think(ctx.db, ctx.user, `Roast me, ${ctx.user.name?.split(" ")[0] ?? "the user"}, like a funny friend would: sharp, specific, affectionate, never cruel about looks, body or anything they can't change. Three to five short lines.${args.about ? ` Roast this: ${args.about}.` : ""} My week: ${lines.join("; ") || "they've told me almost nothing, which is its own roast"}.`, { max: 300 });
    if (t) return { reply: t.trim() };
    const sp = lines.find((l) => /spent/.test(l));
    return { reply: sp ? `${sp}. Bold strategy. Let's see if it pays off.` : "You asked a tortoise to roast you. That's the roast." };
  },
});

const hype = defineAction({
  name: "fun.hype",
  tier: 1,
  description: "Hype the user up before something (an exam, a pitch, a date, the gym): an energetic pep talk, sent as a voice note too.",
  schema: z.object({ about: z.string().optional() }),
  async run(args, ctx) {
    const t = await think(ctx.db, ctx.user, `Hype me up${args.about ? ` for ${args.about}` : ""}. Three or four punchy lines, specific, like a best friend in my corner. Spoken out loud, so no lists or symbols.`, { max: 220 });
    return { reply: t?.trim() || `You've done harder things than ${args.about ?? "this"}. Walk in like you belong there, because you do. Go.`, speak: true };
  },
});

register(gamePlay, decide, roll, eightBall, wrapped, roast, hype);
