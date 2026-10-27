/**
 * Follow-up questions. When an action is missing one essential thing, the
 * bot asks once and remembers what it asked. The next message is read as the
 * answer first, as a change of subject second.
 */
import type { Db } from "../core/db.js";
import type { Thread, User } from "../policy/types.js";
import { THREAD_TTL_MS } from "../policy/engine.js";

export const SKIP = /^(?:skip|no idea|not sure|dunno|don'?t know|whenever|later|leave it|no dates?|none|nothing|n\/?a|doesn'?t matter|just (?:create|make|add) it|without)\b/i;

export function openThread(user: User, now = new Date()): Thread | null {
  const t = user.prefs?.thread as Thread | undefined;
  if (!t || typeof t !== "object" || !t.action) return null;
  if (now.getTime() - t.askedAt > THREAD_TTL_MS) return null;
  return t;
}

export async function setThread(db: Db, user: User, thread: Thread | null): Promise<void> {
  const prefs = { ...user.prefs };
  if (thread) prefs.thread = thread; else delete prefs.thread;
  user.prefs = prefs;
  await db.query(`UPDATE users SET prefs=$2 WHERE id=$1`, [user.id, JSON.stringify(prefs)]);
}
