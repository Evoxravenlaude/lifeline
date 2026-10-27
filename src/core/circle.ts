/**
 * Who gets in. Anyone with the bot's link or the website can join, until the
 * circle is full (MAX_USERS, 15 by default). People already in always get in.
 * ALLOWED_USER_IDS is optional: those Telegram ids are the owners. They always
 * get in, even when the circle is full, and can ask /circle to see who's in.
 */
import type { Db } from "./db.js";
import { config } from "./config.js";

export type Admission = "member" | "room" | "full";

export async function admit(db: Db, telegramId: number): Promise<Admission> {
  if (config.allowedUserIds.includes(telegramId)) return "member";
  const known = await db.one<{ id: number }>(
    `SELECT u.id FROM users u LEFT JOIN identities i ON i.user_id=u.id AND i.channel='telegram' WHERE u.telegram_id=$1 OR i.external_id=$2 LIMIT 1`,
    [telegramId, String(telegramId)],
  );
  if (known) return "member";
  const n = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
  return Number(n?.n ?? 0) < config.maxUsers ? "room" : "full";
}

export const FULL_MESSAGE = () => `lifeline is a small circle of ${config.maxUsers}, and every place is taken right now. Ask whoever sent you the link to make room, then try again.`;

export function isOwner(telegramId: number, userId: number, firstUserId: number | undefined): boolean {
  return config.allowedUserIds.length ? config.allowedUserIds.includes(telegramId) : userId === firstUserId;
}

export async function circleSummary(db: Db): Promise<string> {
  const rows = await db.query<{ name: string | null; created_at: string }>(`SELECT name, created_at FROM users ORDER BY id`);
  const names = rows.map((r) => (r.name ? r.name.split(" ")[0] : "someone")).join(", ");
  const left = Math.max(0, config.maxUsers - rows.length);
  return `${rows.length} of ${config.maxUsers} places taken${left ? `, ${left} free` : ", the circle is full"}.${rows.length ? `\n${names}.` : ""}\nTo change the size, set MAX_USERS in Doppler.`;
}
