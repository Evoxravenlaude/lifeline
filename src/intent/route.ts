/**
 * Which model thinks about a message, and how the conversation stays one conversation whichever model answers.
 *
 * Tiers: a quick model for quick things (a log, a hello, a short fact), a stronger one for thinking (explaining,
 * planning, comparing, drafting, anything long or multi-part). A quick answer that falls short is asked again of
 * the stronger model before the person sees it. A short follow-up to something that needed the stronger model stays
 * with it, so the quality doesn't drop mid-thread.
 *
 * Continuity: every model gets the same instructions, persona, memories, the last turns (with what each turn DID,
 * not only what it said, and what was in any picture), and a running summary of everything older. Switching tier
 * changes who's thinking, never what they know.
 */
import type { Db } from "../core/db.js";
import type { Ctx, User } from "../policy/types.js";
import { addSchema } from "../core/plugins.js";
import type { Completion, Msg, Tier } from "./providers.js";
import { log } from "../core/log.js";

addSchema(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta JSONB`);

const THINKING = /\b(?:why|explain|compare|versus|vs\.?|plan|planning|strategy|should i|which is better|pros and cons|trade-?offs?|analy[sz]e|analysis|break (?:it|this) down|step by step|write|draft|rewrite|essay|letter|proposal|pitch|summari[sz]e|translate|code|debug|bug|error|function|regex|sql|calculate|work out|figure out|how (?:do|can|should|would) i|help me (?:decide|think|understand|plan|write)|what do you think|advice|recommend|research|review)\b/i;
const QUICK = /^(?:hi|hey|hello|yo|gm|gn|good (?:morning|afternoon|evening|night)|thanks?(?: you)?|thx|ok(?:ay)?|cool|nice|lol|haha|yes|no|yeah|nope|sure|done|great|perfect|got it)\b[\s!.?]*$/i;
const FOLLOW_UP = /^(?:and|but|so|why|how|what about|go on|continue|more|elaborate|explain|really|ok and|then)\b/i;

export interface Route { tier: Tier; why: string }

/** The tier for this message. Pure apart from the person's last tier (kept in prefs). */
export function tierFor(text: string, user: Pick<User, "prefs">, now: Date, opts: { forwarded?: boolean; thread?: boolean } = {}): Route {
  const t = text.trim();
  const last = user.prefs.lastTier as { tier?: Tier; at?: number } | undefined;
  const recentSmart = last?.tier === "smart" && typeof last.at === "number" && now.getTime() - last.at < 10 * 60_000;
  if (opts.forwarded) return { tier: "smart", why: "forwarded content" };
  if (/\[picture/.test(t)) return { tier: "smart", why: "a picture" };
  if (QUICK.test(t)) return { tier: "fast", why: "small talk" };
  if (recentSmart && (t.length <= 80 || FOLLOW_UP.test(t))) return { tier: "smart", why: "follow-up to a thinking turn" };
  if (t.length > 280) return { tier: "smart", why: "long message" };
  if ((t.match(/\?/g) ?? []).length >= 2) return { tier: "smart", why: "several questions" };
  if (THINKING.test(t)) return { tier: "smart", why: "needs thinking" };
  if (opts.thread) return { tier: "fast", why: "answering a follow-up question" };
  return { tier: "fast", why: "quick" };
}

const SHORTFALL = /\b(?:i'?m not sure|i don'?t know|i can'?t (?:help|answer|do) (?:that|this|with)|i'?m unable to|i do not have (?:enough|the) information|as an ai)\b/i;
/**
 * Did the quick model fall short? Then the stronger one answers instead, with the same context. Checked before the
 * person sees anything (a streamed draft is simply replaced).
 */
export function fellShort(res: Completion | null, text: string, toolNames: string[]): boolean {
  if (!res) return true;
  if (res.stopped) return false;
  if (res.toolCall) return !toolNames.includes(res.toolCall.name);
  const out = res.text.trim();
  if (!out) return true;
  if (SHORTFALL.test(out)) return true;
  const asked = /\?\s*$/.test(text.trim()) || /^(?:what|why|how|when|where|who|which|can|could|should|is|are|do|does)\b/i.test(text.trim());
  return asked && text.trim().length > 60 && out.length < 40;
}

export async function rememberTier(db: Db, user: User, tier: Tier, now: Date): Promise<void> {
  user.prefs = { ...user.prefs, lastTier: { tier, at: now.getTime() } };
  await db.query(`UPDATE users SET prefs = prefs || jsonb_build_object('lastTier', $2::jsonb) WHERE id=$1`, [user.id, JSON.stringify({ tier, at: now.getTime() })]).catch(() => {});
}

/* ---------------- one conversation, whoever answers ---------------- */

export const HISTORY_TURNS = 14;

/**
 * The last turns as the model sees them. A reply that came from an action says which ("[did reminder.create]"), and
 * a picture says what was in it, so a model picking up mid-thread knows what already happened, not just what was said.
 */
export async function historyFor(db: Db, userId: number, limit = HISTORY_TURNS): Promise<Msg[]> {
  const rows = await db.query<{ role: "user" | "assistant"; content: string; meta: Record<string, unknown> | null }>(
    `SELECT role, content, meta FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT $2`, [userId, limit]);
  return rows.reverse().map((r) => {
    const m = r.meta ?? {};
    const tags = [m.action ? `did ${m.action}` : "", m.voice ? "said in a voice note" : ""].filter(Boolean);
    return { role: r.role, content: tags.length ? `[${tags.join("; ")}] ${r.content}` : r.content };
  });
}

/** What an assistant turn did, kept with it (the action, and the tier that thought about it). */
export async function tagLastTurn(db: Db, userId: number, role: "user" | "assistant", meta: Record<string, unknown>): Promise<void> {
  if (!Object.keys(meta).length) return;
  await db.query(`UPDATE messages SET meta = COALESCE(meta, '{}'::jsonb) || $3::jsonb WHERE id = (SELECT max(id) FROM messages WHERE user_id=$1 AND role=$2)`, [userId, role, JSON.stringify(meta)]).catch(() => {});
}

/** The running summary of everything older than the last turns, for the system prompt. */
export function summaryOf(user: Pick<User, "prefs">): string | null {
  const c = user.prefs.convo as { summary?: string } | undefined;
  return c?.summary ? c.summary : null;
}

/**
 * Fold older turns into the running summary once enough have piled up beyond the window. Uses the quick model, runs
 * after the reply has gone out, and never blocks anything. `summarize` is the model call (injected, so tests can stub it).
 */
export async function rollSummary(db: Db, user: User, summarize: (prompt: string) => Promise<string | null>): Promise<boolean> {
  const c = (user.prefs.convo as { summary?: string; upto?: number } | undefined) ?? {};
  const upto = c.upto ?? 0;
  const newest = await db.query<{ id: number }>(`SELECT id FROM messages WHERE user_id=$1 ORDER BY id DESC LIMIT $2`, [user.id, HISTORY_TURNS]);
  const cut = newest.length === HISTORY_TURNS ? newest[newest.length - 1].id : 0;
  if (!cut) return false;
  const older = await db.query<{ id: number; role: string; content: string; meta: Record<string, unknown> | null }>(
    `SELECT id, role, content, meta FROM messages WHERE user_id=$1 AND id > $2 AND id < $3 ORDER BY id`, [user.id, upto, cut]);
  if (older.length < 10) return false;
  const transcript = older.map((m) => `${m.role === "user" ? "Them" : "lifeline"}${m.meta?.action ? ` (did ${m.meta.action})` : ""}: ${m.content.slice(0, 400)}`).join("\n");
  const prompt = `${c.summary ? `Summary so far:\n${c.summary}\n\n` : ""}Newer turns:\n${transcript}\n\nWrite the updated summary of this conversation for the assistant to carry forward: what the person is working on or going through, decisions made, things promised or pending, names, places and numbers that matter, and their tone. At most 140 words, plain sentences, no preamble.`;
  const s = await summarize(prompt).catch((e) => { log.warn({ err: e?.message }, "summary failed"); return null; });
  if (!s) return false;
  const convo = { summary: s.trim().slice(0, 1200), upto: older[older.length - 1].id };
  user.prefs = { ...user.prefs, convo };
  await db.query(`UPDATE users SET prefs = prefs || jsonb_build_object('convo', $2::jsonb) WHERE id=$1`, [user.id, JSON.stringify(convo)]);
  return true;
}

/** For a context passed around actions. */
export type { Ctx };
