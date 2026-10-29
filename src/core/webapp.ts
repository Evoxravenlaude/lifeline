/**
 * Telegram Mini App sign-in. When lifeline's website opens inside Telegram (the "Open the app" button),
 * Telegram hands the page a signed `initData` string. We check its signature with the bot token, as
 * Telegram describes at https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app,
 * and sign the person in without any login step.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { addSchema } from "./plugins.js";

/** Sessions made inside Telegram's app are marked: they can use lifeline, but not add or remove ways to sign in. */
addSchema(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tab_only BOOLEAN NOT NULL DEFAULT false`);

export interface WebAppUser { id: number; first_name?: string; last_name?: string; username?: string }

/** The Telegram user in `initData`, or null when the signature is wrong, it's older than `maxAgeSec`, or it has no user. */
export function verifyInitData(initData: string, botToken: string, nowMs = Date.now(), maxAgeSec = 86_400): WebAppUser | null {
  if (!initData || !botToken || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  const given = Buffer.from(hash, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const at = Number(params.get("auth_date"));
  if (!Number.isFinite(at) || nowMs / 1000 - at > maxAgeSec || at - nowMs / 1000 > 300) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null") as WebAppUser | null;
    return user && Number.isInteger(user.id) && user.id > 0 ? user : null;
  } catch { return null; }
}

/** Build a signed initData string (for tests, and nothing else). */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
