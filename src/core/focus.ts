/**
 * What the conversation is about right now, so "the second one", "that", "cancel it" and "6am instead" point at
 * something. A list lifeline just showed is remembered in order; the thing it just set is remembered as `last`.
 * Kept in prefs.focus for half an hour, then forgotten, because after that "the second one" means nothing.
 */
import type { Db } from "./db.js";
import type { User } from "../policy/types.js";

export type Thing = { kind: "reminder" | "date"; id: number };
export interface Focus { list?: Thing[]; last?: Thing; at: number }

const TTL_MS = 30 * 60_000;

export function focusOf(user: Pick<User, "prefs">, now: Date): Focus | null {
  const f = user.prefs?.focus as Focus | undefined;
  return f && now.getTime() - f.at < TTL_MS ? f : null;
}

export async function setFocus(db: Db, user: User, patch: Partial<Omit<Focus, "at">>, now: Date): Promise<void> {
  const prev = focusOf(user, now) ?? { at: now.getTime() };
  const next: Focus = { ...prev, ...patch, at: now.getTime() };
  user.prefs = { ...user.prefs, focus: next };
  await db.query(`UPDATE users SET prefs = prefs || jsonb_build_object('focus', $2::jsonb) WHERE id=$1`, [user.id, JSON.stringify(next)]).catch(() => {});
}

/** "the second one" → 2; "the last one" → the list's length. Null when it isn't an ordinal. */
export function ordinal(word: string, length: number): number | null {
  const w = word.toLowerCase().replace(/^#/, "").replace(/^number\s+/, "");
  const words: Record<string, number> = { first: 1, "1st": 1, one: 1, second: 2, "2nd": 2, two: 2, third: 3, "3rd": 3, three: 3, fourth: 4, "4th": 4, four: 4, fifth: 5, "5th": 5, five: 5, sixth: 6, "6th": 6, seventh: 7, "7th": 7 };
  if (w === "last" || w === "final" || w === "bottom") return length || null;
  if (w === "top") return 1;
  const n = words[w] ?? (/^\d{1,2}$/.test(w) ? Number(w) : NaN);
  return Number.isFinite(n) && n >= 1 ? n : null;
}
