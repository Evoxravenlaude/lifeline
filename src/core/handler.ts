/**
 * Channel-agnostic brain. Telegram, web, SMS and iMessage all call these two
 * functions; they differ only in how they render buttons.
 *
 * Order of reading a message:
 *   1. yes / no / undo / link, which are about the last thing we said
 *   2. an open follow-up ("When are you going?"): the message is the answer first
 *   3. a question about what the bot can do
 *   4. intent: rules, model, loose language, small talk
 * Every reply passes through the voice pass before it leaves.
 */
import { everythingIndex } from "../intent/capabilities.js";
import { parseByRules } from "../intent/rules.js";
import { parseLoose } from "../intent/loose.js";
import { allow, mediaAbilities, search, see } from "./media.js";
import { answerGame, gameAnswer } from "../modules/fun.js";
import { log } from "./log.js";
import { BROKE } from "./humanize.js";
import { waysIn } from "./ways.js";
import { toPlain } from "./format.js";
import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { config } from "./config.js";
import { schedule } from "./scheduler.js";
import { polish, personaOf } from "./voice.js";
import type { Attachment, Ctx, Thread, User } from "../policy/types.js";
import { getAction } from "../policy/registry.js";
import { cancelPending, confirmPending, latestPending, propose, undo, type Decision } from "../policy/engine.js";
import { resolveIntent } from "../intent/index.js";
import { answerCapability, isCapabilityQuestion } from "../intent/capabilities.js";
import { openThread, setThread, SKIP } from "../intent/thread.js";
import { parseRange, parseWhen, parseMoney } from "./time.js";
import { markDone, snooze } from "../modules/reminders.js";
import { resolveLog } from "../modules/medications.js";

export type Channel = "telegram" | "web" | "sms" | "imessage" | "email";

export interface Reply extends Attachment {
  text: string;
  buttons?: { label: string; data: string }[];
}

export async function findUserByIdentity(db: Db, channel: Channel, externalId: string): Promise<User | undefined> {
  return db.one<User>(`SELECT u.* FROM users u JOIN identities i ON i.user_id=u.id WHERE i.channel=$1 AND i.external_id=$2`, [channel, externalId]);
}

/** Find or create a user for an identity. New users only auto-create on Telegram (allow-listed); other channels must link. */
export async function ensureUser(db: Db, channel: Channel, externalId: string, name?: string): Promise<User> {
  const existing = await findUserByIdentity(db, channel, externalId);
  if (existing) return existing;
  if (channel === "telegram") {
    const legacy = await db.one<User>(`SELECT * FROM users WHERE telegram_id=$1`, [Number(externalId)]);
    if (legacy) {
      await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,'telegram',$2) ON CONFLICT DO NOTHING`, [legacy.id, externalId]);
      return legacy;
    }
  }
  const [qs, qe] = config.quietHours;
  const u = (await db.one<User>(
    `INSERT INTO users (telegram_id, name, tz, digest_hour, quiet_start, quiet_end, preferred_channel) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [channel === "telegram" ? Number(externalId) : null, name ?? null, config.defaultTz, config.digestHour, qs, qe, channel],
  ))!;
  await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,$2,$3)`, [u.id, channel, externalId]);
  await schedule(db, { userId: u.id, kind: "digest", cron: `0 ${u.digest_hour} * * *`, tz: u.tz });
  await schedule(db, { userId: u.id, kind: "memory_review", cron: `0 18 * * 0`, tz: u.tz });
  return u;
}

export async function getUserById(db: Db, id: number): Promise<User | undefined> {
  return db.one<User>(`SELECT * FROM users WHERE id=$1`, [id]);
}

export async function identitiesOf(db: Db, userId: number): Promise<{ channel: Channel; external_id: string }[]> {
  return db.query(`SELECT channel, external_id FROM identities WHERE user_id=$1 AND verified`, [userId]);
}

/* ---------- linking other channels to an existing account ---------- */

export async function createLinkCode(db: Db, userId: number, channel?: Channel): Promise<string> {
  const code = randomBytes(3).toString("hex").toUpperCase(); // 6 chars
  await db.query(`INSERT INTO link_codes (code, user_id, channel, expires_at) VALUES ($1,$2,$3,$4)`, [code, userId, channel ?? null, new Date(Date.now() + 15 * 60_000)]);
  return code;
}

export async function redeemLinkCode(db: Db, code: string, channel: Channel, externalId: string): Promise<User | null> {
  const row = await db.one<{ user_id: number }>(`UPDATE link_codes SET used=true WHERE code=$1 AND NOT used AND expires_at > now() AND (channel IS NULL OR channel=$2) RETURNING user_id`, [code.toUpperCase(), channel]);
  if (!row) return null;
  await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,$2,$3) ON CONFLICT (channel, external_id) DO UPDATE SET user_id=EXCLUDED.user_id, verified=true`, [row.user_id, channel, externalId]);
  return getUserById(db, row.user_id) as Promise<User>;
}

/* ---------- messages ---------- */

export function renderDecision(d: Decision): Reply {
  switch (d.kind) {
    case "pending":
      return { text: `${d.echo}\n\nGo ahead? This waits ten minutes for a yes.`, buttons: [{ label: "Yes, go ahead", data: `confirm:${d.pendingId}` }, { label: "No", data: `cancel:${d.pendingId}` }] };
    case "ran":
      return d.undoId ? { ...d.extra, text: d.reply, buttons: [...(d.extra?.buttons ?? []), { label: "Undo", data: `undo:${d.undoId}` }] } : { ...d.extra, text: d.reply };
    default:
      return { text: d.reply };
  }
}

const YES = /^(?:yes|y|yes please|yep|yeah|yup|confirm|go ahead|go|do it|sure|ok go|okay go|send it|pay it)[.!]*$/i;
const NO = /^(?:no|n|nope|nah|cancel|never ?mind|don'?t|stop|forget it|leave it)[.!]*$/i;

/** Every message gets an answer in words, even when something underneath breaks. */
export async function handleMessage(db: Db, user: User, text: string, opts: { forwarded?: boolean; channel: Channel; now?: Date }): Promise<Reply> {
  try {
    return await answerMessage(db, user, text, opts);
  } catch (e: any) {
    log.error({ err: e?.message, user: user.id }, "message failed");
    return { text: BROKE };
  }
}

async function answerMessage(db: Db, user: User, text: string, opts: { forwarded?: boolean; channel: Channel; now?: Date }): Promise<Reply> {
  const now = opts.now ?? new Date();
  const ctx: Ctx = { db, user, now, sourceMessage: `[${opts.channel}] ${text}` };
  const t = text.trim();
  await db.query(`INSERT INTO messages (user_id, role, content) VALUES ($1,'user',$2)`, [user.id, text]);

  // 1. About the last thing we said.
  if (YES.test(t)) {
    const pid = await latestPending(ctx);
    if (pid) return finish(db, user, renderDecision(await confirmPending(ctx, pid)));
  }
  if (NO.test(t)) {
    const pid = await latestPending(ctx);
    if (pid) return finish(db, user, { text: await cancelPending(ctx, pid) });
    if (openThread(user, now)) { await setThread(db, user, null); return finish(db, user, { text: "Dropped it." }); }
  }
  if (/^undo$/i.test(t)) {
    const row = await db.one<{ id: number }>(`SELECT id FROM undo_stack WHERE user_id=$1 AND NOT used ORDER BY id DESC LIMIT 1`, [user.id]);
    return finish(db, user, { text: row ? await undo(ctx, row.id) : "There's nothing to undo." });
  }
  if (/^(?:pending|what'?s pending|what'?s waiting(?: on me)?|anything waiting)\??$/i.test(t)) {
    const rows = await db.query<{ id: number; echo: string }>(`SELECT id, echo FROM pending_actions WHERE user_id=$1 AND resolved IS NULL AND expires_at > $2 ORDER BY id DESC LIMIT 5`, [user.id, now]);
    if (!rows.length) return finish(db, user, { text: "Nothing is waiting on your yes." });
    const [last, ...rest] = rows;
    const more = rest.length ? `\n\nAlso waiting:\n${rest.map((r) => `- ${r.echo}`).join("\n")}` : "";
    return finish(db, user, { text: `${last.echo}\n\nGo ahead?${more}`, buttons: [{ label: "Yes, go ahead", data: `confirm:${last.id}` }, { label: "No", data: `cancel:${last.id}` }] });
  }
  if (/^link$/i.test(t)) {
    const code = await createLinkCode(db, user.id);
    return finish(db, user, { text: `Your link code is \`${code}\`. It works for fifteen minutes.\n\n${waysIn(code)}\n\nOnce it's linked, everything you've told me is there too.` });
  }

  // 2. An open follow-up: read the message as the answer first.
  const thread = opts.forwarded ? null : openThread(user, now);
  if (thread) {
    const answered = await answerThread(ctx, thread, t);
    if (answered) return finish(db, user, answered);
  }

  // 2a. The whole menu, from any channel.
  if (/^\/?(?:everything|all features|features|menu)$/i.test(t)) return finish(db, user, { text: everythingIndex().replace(", or open a drawer below", "") });

  // 2b. An answer to a riddle or quiz that's still open.
  const played = opts.forwarded ? null : await gameAnswer(db, user, t);
  if (played) return finish(db, user, played);

  // 3. "Can you track meds?"
  if (!opts.forwarded && isCapabilityQuestion(t)) {
    const a = answerCapability(t, user.name);
    if (a) { if (thread) await setThread(db, user, null); return finish(db, user, { text: a }); }
  }

  // 4. Intent.
  const intent = await resolveIntent(text, { ...ctx, thread }, { forwarded: opts.forwarded });
  if (intent.kind === "reply") {
    // Still waiting on the follow-up and the user said something unrelated and unparseable: ask once more, briefly.
    if (thread && intent.source !== "model" && !intent.clearThread) return finish(db, user, { text: `${intent.text}\n\n(Still waiting on: ${thread.question.toLowerCase()} Say skip to carry on without it.)` });
    if (thread) await setThread(db, user, null);
    return finish(db, user, { text: intent.text });
  }
  if (thread) await setThread(db, user, null);
  return finish(db, user, await decide(ctx, intent.intent.action, intent.intent.args));
}

/** Propose, and if the action asks a question, remember it. */
async function decide(ctx: Ctx, action: string, args: unknown): Promise<Reply> {
  const d = await propose(ctx, action, args);
  if (d.kind === "ask") { await setThread(ctx.db, ctx.user, d.thread); return { text: d.reply }; }
  return renderDecision(d);
}

/** Try to read `text` as the answer to an open follow-up. Null means: not an answer, read it fresh. */
async function answerThread(ctx: Ctx, thread: Thread, text: string): Promise<Reply | null> {
  const action = getAction(thread.action);
  if (!action) { await setThread(ctx.db, ctx.user, null); return null; }
  if (SKIP.test(text)) {
    await setThread(ctx.db, ctx.user, null);
    return decide({ ...ctx, skipAsk: true }, thread.action, thread.args);
  }
  const filled = action.fill ? action.fill(thread.need, text, thread.args as any, ctx) : defaultFill(thread.need, text, ctx);
  if (!filled) return null;
  await setThread(ctx.db, ctx.user, null);
  return decide(ctx, thread.action, { ...thread.args, ...filled });
}

/** Generic slot filling for the common slot names. */
function defaultFill(need: string, text: string, ctx: Ctx): Record<string, unknown> | null {
  switch (need) {
    case "when": return parseWhen(text, ctx.user.tz, ctx.now) ? { when: text } : null;
    case "dates": { const r = parseRange(text, ctx.user.tz, ctx.now); return r ? { start: r.start.toISOString(), end: r.end?.toISOString() } : null; }
    case "budget": { const m = parseMoney(text); return m ? { budget: m.amount, currency: m.currency } : null; }
    case "amount": { const m = parseMoney(text) ?? (/^\d/.test(text) ? { amount: Number(text.replace(/[^\d.]/g, "")), currency: undefined } : null); return m ? { amount: m.amount, ...(m.currency ? { currency: m.currency } : {}) } : null; }
    default: return text.length < 200 ? { [need]: text } : null;
  }
}

async function finish(db: Db, user: User, r: Reply): Promise<Reply> {
  const out = { ...r, text: polish(r.text, { persona: personaOf(user.prefs) }) };
  await db.query(`INSERT INTO messages (user_id, role, content) VALUES ($1,'assistant',$2)`, [user.id, out.text.slice(0, 2000)]);
  return out;
}

/** Button presses (Telegram callback_data, web button, or "1"/"2" on SMS). */
export async function handleCallback(db: Db, user: User, data: string, now = new Date()): Promise<Reply> {
  try {
    return await answerButton(db, user, data, now);
  } catch (e: any) {
    log.error({ err: e?.message, user: user.id, data }, "button failed");
    return { text: BROKE };
  }
}

async function answerButton(db: Db, user: User, data: string, now: Date): Promise<Reply> {
  const ctx: Ctx = { db, user, now, sourceMessage: `[button ${data}]` };
  const [kind, a, b] = data.split(":");
  const say = (text: string, buttons?: Reply["buttons"]): Reply => ({ text: polish(text, { persona: personaOf(user.prefs) }), buttons });
  switch (kind) {
    case "confirm": { const r = renderDecision(await confirmPending(ctx, Number(a))); return say(r.text, r.buttons); }
    case "cancel": return say(await cancelPending(ctx, Number(a)));
    case "undo": return say(await undo(ctx, Number(a)));
    case "rem":
      if (a === "done") { await markDone(db, user.id, Number(b)); return say("Done. Off the list."); }
      await snooze(db, user.id, Number(b)); return say("Snoozed. I'll bring it back in an hour.");
    case "med": {
      const ok = await resolveLog(db, user.id, Number(b), a === "taken" ? "taken" : "skipped");
      return say(ok ? (a === "taken" ? "Logged as taken." : "Logged as skipped.") : "I couldn't find that dose any more.");
    }
    case "mem":
      if (a === "keep") await db.query(`UPDATE memories SET confirmed=true WHERE id=$1 AND user_id=$2`, [Number(b), user.id]);
      else await db.query(`DELETE FROM memories WHERE id=$1 AND user_id=$2`, [Number(b), user.id]);
      return say(a === "keep" ? "Kept." : "Dropped.");
    case "persona": { const r = renderDecision(await propose(ctx, "persona.set", { preset: a })); return say(r.text, r.buttons); }
    case "g": { const r = await answerGame(db, user, data.slice(2)); return finish(db, user, r); }
    case "photo": {
      const list = (Array.isArray(user.prefs.photoSuggestions) ? user.prefs.photoSuggestions : []) as PhotoOffer[];
      const sug = list.find((p) => p.id === a);
      if (!sug || Date.now() - sug.at > 24 * 3_600_000) return say("That picture's moved on. Send it again if you want me to keep something from it.");
      await db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [user.id, JSON.stringify({ photoSuggestions: list.filter((p) => p.id !== a) })]);
      return finish(db, user, await keepFromPhoto(ctx, sug.text));
    }
    default: return say("That button doesn't do anything any more.");
  }
}

/** For text-only channels: map "1"/"2" replies to the last message's buttons. */
export function buttonsAsText(r: Reply): string {
  const text = toPlain(r.text);
  if (!r.buttons?.length) return text;
  return `${text}\n${r.buttons.map((b, i) => `${i + 1}) ${b.label}`).join("  ")}`;
}


/**
 * A picture someone sent, with whatever they wrote under it. I say what I see, answer their question,
 * search when they ask where to buy or what it costs, and offer to keep anything useful in it.
 */
export async function handlePhoto(db: Db, user: User, image: Buffer, mime: string, caption: string, channel: Channel): Promise<Reply> {
  try {
    const cap = caption.trim();
    await db.query(`INSERT INTO messages (user_id, role, content) VALUES ($1,'user',$2)`, [user.id, `[picture]${cap ? ` ${cap}` : ""}`]);
    if (!mediaAbilities().see) return finish(db, user, { text: "I can't look at pictures on this server yet. It needs a Gemini or Groq key." });
    if (!allow("see", user.id)) return finish(db, user, { text: "That's a lot of pictures for one day; I'll be able to look again tomorrow." });
    const seen = await see(image, mime, cap);
    if (!seen) return finish(db, user, { text: "I couldn't make that picture out just now. Try again in a minute, or tell me what's in it." });
    let text = seen.reply;
    if (cap && /\b(?:where (?:can|do|to)|buy|price|cost|how much|search|look (?:it )?up|find (?:it|this|me)|similar|who (?:makes|made|sells))\b/i.test(cap) && mediaAbilities().search && allow("search", user.id)) {
      const f = await search(`${cap}. The picture shows: ${seen.reply.slice(0, 400)}`, user.tz);
      if (f) text += `\n\n${f.answer}${f.sources.length ? `\n\nSources: ${f.sources.map((x) => `[${(x.title ?? new URL(x.uri).hostname).replace(/[[\]]/g, "")}](${x.uri})`).join(", ")}` : ""}`;
    }
    if (seen.suggestion && /^(?:please )?(?:log|add|save|keep|track|remind|put|note|set)\b/i.test(cap)) {
      const done = await keepFromPhoto({ db, user, now: new Date(), sourceMessage: `[${channel} picture]` }, seen.suggestion);
      return finish(db, user, { ...done, text: `${text}\n\n${done.text}` });
    }
    if (seen.suggestion) {
      const id = Date.now().toString(36);
      const list = ((Array.isArray(user.prefs.photoSuggestions) ? user.prefs.photoSuggestions : []) as PhotoOffer[]).slice(-4);
      await db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [user.id, JSON.stringify({ photoSuggestions: [...list, { id, text: seen.suggestion, at: Date.now() }] })]);
      return finish(db, user, { text, buttons: [{ label: seen.label ?? "Keep it", data: `photo:${id}` }] });
    }
    return finish(db, user, { text });
  } catch (e: any) {
    log.error({ err: e?.message, user: user.id }, "photo failed");
    return { text: BROKE };
  }
}

interface PhotoOffer { id: string; text: string; at: number }

/** What a photo may turn into on its own: things that only add to your own records. Never settings, email, money or a yes. */
const FROM_PHOTO = /^(?:spend\.log|calendar\.add|medication\.add|list\.add|note\.add|reminder\.create|date\.add|trip\.(?:create|add_item)|assignment\.add|class\.add|measure\.log|habit\.checkin|cycle\.log)$/;

/**
 * Keep the useful thing a picture showed. The sentence came from a model reading the image, so it is
 * treated like forwarded text: no yes/no/undo/link shortcuts, and only actions that add to your own records.
 */
async function keepFromPhoto(ctx: Ctx, suggestion: string): Promise<Reply> {
  let intent = parseByRules(suggestion) ?? parseLoose(suggestion, ctx.now);
  if (!intent) {
    const r = await resolveIntent(suggestion, ctx, { forwarded: true });
    intent = r.kind === "action" ? r.intent : null;
  }
  if (!intent || !FROM_PHOTO.test(intent.action) || getAction(intent.action)?.tier !== 1) {
    return { text: `I'd keep it as: "${suggestion}". Say that, or your own version, and I'll do it.` };
  }
  const r = await decide(ctx, intent.action, intent.args);
  return { ...r, text: r.text };
}
