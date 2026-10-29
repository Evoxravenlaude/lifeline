/**
 * More ways into lifeline on the website, next to Telegram: Google, Apple, a code by text or iMessage,
 * and a code by email. See docs/SIGNIN.md for setting each one up.
 *
 *  Google  The page gets an ID token from Google Identity Services. We check it against Google's keys
 *          (issuer, audience = GOOGLE_CLIENT_ID, expiry, email_verified). Identity "google", id = sub.
 *  Apple   Sign in with Apple JS, popup mode. We issue a one-time nonce first; the id_token must carry it,
 *          be signed by Apple, and be for APPLE_CLIENT_ID. Identity "apple", id = sub. Apple sends the
 *          name only the first time, so it's kept if given.
 *  Codes   Six digits by SMS, iMessage or email, ten minutes, stored only as an HMAC, five tries, three
 *          codes an hour per number or address and a cap per IP. The answer is the same whether or not
 *          the number has an account, so nobody can use this to find out who is in the circle.
 *
 * Signed in already? The same flows add the new way to the current account. If that Google account,
 * Apple ID, number or address is already someone else's, we say so and never merge.
 * New people count against the circle's cap before anything is created.
 * Codes, tokens and full numbers never go to the log.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { addSchema } from "./plugins.js";
import { config } from "./config.js";
import { log } from "./log.js";
import { canEmail, sendEmail } from "./email.js";
import { FULL_MESSAGE } from "./circle.js";
import { ensureUser, findUserByIdentity, getUserById, type Channel } from "./handler.js";
import type { Db } from "./db.js";
import type { User } from "../policy/types.js";

addSchema(`
CREATE TABLE IF NOT EXISTS signin_codes (
  id SERIAL PRIMARY KEY,
  via TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  used BOOLEAN NOT NULL DEFAULT false,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signin_codes_target ON signin_codes (target_hash, created_at);
ALTER TABLE identities ADD COLUMN IF NOT EXISTS label TEXT
`);

/** The identities that sign someone in on the website. Web inbox and app identities don't count. */
export const SIGN_IN_WAYS: readonly Channel[] = ["telegram", "google", "apple", "sms", "imessage", "email"];

/* ---------------- small, careful helpers ---------------- */

const fallbackSecret = randomBytes(32).toString("hex");
const secret = () => config.sessionSecret || fallbackSecret;
const hmac = (s: string) => createHmac("sha256", secret()).update(s).digest("hex");
/** Constant-time string equality (lengths may differ; that comparison is the only early exit). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}
/** A sliding window per key: `hit` returns false once `max` hits fall inside `windowMs`. */
export function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    hit(key: string, now = Date.now()): boolean {
      const list = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (list.length >= max) { hits.set(key, list); return false; }
      list.push(now); hits.set(key, list);
      if (hits.size > 5000) hits.delete(hits.keys().next().value!);
      return true;
    },
    /** True once `max` hits fall inside the window, without counting this look as a hit. */
    full(key: string, now = Date.now()): boolean { return (hits.get(key) ?? []).filter((t) => now - t < windowMs).length >= max; },
    reset() { hits.clear(); },
  };
}
const startsPerIp = limiter(10, 3_600_000);
const checksPerIp = limiter(30, 3_600_000);
const tokensPerIp = limiter(30, 600_000);
/* Link codes (six hex characters, fifteen minutes): wrong ones are counted per IP and across the whole server,
   so nobody can work through the code space, even from many addresses. Right ones never count. */
const linkFailsPerIp = limiter(10, 3_600_000);
const linkFailsAll = limiter(300, 3_600_000);
/** Tests: forget every rate-limit window. */
export function resetAuthLimits() { startsPerIp.reset(); checksPerIp.reset(); tokensPerIp.reset(); linkFailsPerIp.reset(); linkFailsAll.reset(); appleNonces.clear(); }
export const allowTokenTry = (ip: string, now?: number) => tokensPerIp.hit(ip, now);
export const linkTryAllowed = (ip: string, now?: number) => !linkFailsPerIp.full(ip, now) && !linkFailsAll.full("all", now);
export const linkTryFailed = (ip: string, now?: number) => { linkFailsPerIp.hit(ip, now); linkFailsAll.hit("all", now); };

const clean = (s: unknown, max = 80) => (typeof s === "string" ? s.replace(/[\u0000-\u001f\u007f<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max) : "");
/** The last few characters, for the log and nothing else. */
const hint = (s: string) => (s.length > 4 ? `...${s.slice(-2)}` : "...");

/* ---------------- Google and Apple ID tokens ---------------- */

type Provider = "google" | "apple";
const JWKS_URL: Record<Provider, string> = { google: "https://www.googleapis.com/oauth2/v3/certs", apple: "https://appleid.apple.com/auth/keys" };
const remote: Partial<Record<Provider, JWTVerifyGetKey>> = {};
const injected: Partial<Record<Provider, JWTVerifyGetKey>> = {};
/** Tests: check tokens against these keys instead of fetching Google's or Apple's. Null goes back to the real ones. */
export function useJwks(p: Provider, getKey: JWTVerifyGetKey | null) { if (getKey) injected[p] = getKey; else delete injected[p]; }
const keysFor = (p: Provider): JWTVerifyGetKey => injected[p] ?? (remote[p] ??= createRemoteJWKSet(new URL(JWKS_URL[p]), { timeoutDuration: 8000, cooldownDuration: 60_000 }));

async function verifyIdToken(p: Provider, token: string, opts: { audience: string; issuer: string[]; now?: Date }): Promise<JWTPayload | null> {
  if (!opts.audience || typeof token !== "string" || token.length > 8192 || token.split(".").length !== 3) return null;
  try {
    const { payload } = await jwtVerify(token, keysFor(p), { issuer: opts.issuer, audience: opts.audience, algorithms: ["RS256", "ES256"], clockTolerance: 30, currentDate: opts.now, requiredClaims: ["sub", "exp", "iat"] });
    return typeof payload.sub === "string" && payload.sub ? payload : null;
  } catch (e: any) {
    log.info({ provider: p, why: e?.code ?? "invalid" }, "id token refused");
    return null;
  }
}

export interface ProviderPerson { sub: string; email: string | null; name: string | null; nonce?: string | null }
/** The same one-time nonces serve Google: the page asks for one first and Google puts it in the token, so a token can't be replayed. */
export const issueNonce = (now = Date.now()) => issueAppleNonce(now);
export const takeNonce = (n: unknown, now = Date.now()) => typeof n === "string" && n.length > 0 && takeAppleNonce(n, now);

/** A Google ID token from Google Identity Services, checked. Null when anything is off. */
export async function verifyGoogle(token: string, opts: { clientId?: string; now?: Date } = {}): Promise<ProviderPerson | null> {
  const p = await verifyIdToken("google", token, { audience: opts.clientId ?? config.googleClientId, issuer: ["accounts.google.com", "https://accounts.google.com"], now: opts.now });
  if (!p) return null;
  if (!(p.email_verified === true || p.email_verified === "true")) return null;
  const email = typeof p.email === "string" && p.email.includes("@") ? p.email.toLowerCase() : null;
  return { sub: String(p.sub), email, name: clean(p.name) || null, nonce: typeof p.nonce === "string" ? p.nonce : null };
}

const appleNonces = new Map<string, number>();
/** A nonce for one Sign in with Apple attempt, good for ten minutes and one use. */
export function issueAppleNonce(now = Date.now()): string {
  for (const [k, exp] of appleNonces) if (exp <= now) appleNonces.delete(k);
  if (appleNonces.size > 5000) appleNonces.delete(appleNonces.keys().next().value!);
  const n = randomBytes(18).toString("base64url");
  appleNonces.set(n, now + 10 * 60_000);
  return n;
}
function takeAppleNonce(n: string, now = Date.now()): boolean {
  if (typeof n !== "string" || !n) return false;
  const exp = appleNonces.get(n);
  appleNonces.delete(n);
  return Boolean(exp && exp > now);
}

/** An Apple id_token, checked against the nonce we issued for it. The name comes from the page (Apple's first sign-in only). */
export async function verifyApple(token: string, nonce: string, opts: { clientId?: string; now?: Date } = {}): Promise<ProviderPerson | null> {
  const nowMs = opts.now?.getTime() ?? Date.now();
  if (!takeAppleNonce(nonce, nowMs)) return null;
  const p = await verifyIdToken("apple", token, { audience: opts.clientId ?? config.appleClientId, issuer: ["https://appleid.apple.com"], now: opts.now });
  if (!p || typeof p.nonce !== "string" || !safeEqual(p.nonce, nonce)) return null;
  const verified = p.email_verified === true || p.email_verified === "true";
  const relay = typeof p.email === "string" && /@privaterelay\.appleid\.com$/i.test(p.email);
  const email = verified && !relay && typeof p.email === "string" ? p.email.toLowerCase() : null;
  return { sub: String(p.sub), email, name: null };
}

/* ---------------- one-time codes by text, iMessage or email ---------------- */

export type CodeVia = "sms" | "imessage" | "email";
export type CodeSender = (to: string, text: string) => Promise<void>;
const senders: Partial<Record<CodeVia, CodeSender>> = {};
/** Tests: catch codes instead of sending them. Null goes back to the real channel. */
export function useCodeSender(via: CodeVia, s: CodeSender | null) { if (s) senders[via] = s; else delete senders[via]; }

async function realSend(via: CodeVia, to: string, text: string) {
  if (via === "sms") { const { sendSms } = await import("../channels/sms.js"); return sendSms(to, text); }
  if (via === "imessage") { const { sendIMessage } = await import("../channels/imessage.js"); return sendIMessage(to, text); }
  if (!(await sendEmail(to, "Your lifeline code", text))) throw new Error("email send failed");
}

/** Which code routes are switched on. A test sender counts as on. */
export async function codeMethods(): Promise<Record<CodeVia, boolean>> {
  const { smsProvider } = await import("../channels/sms.js");
  return { sms: Boolean(senders.sms) || smsProvider() !== null, imessage: Boolean(senders.imessage) || Boolean(config.imessageProvider), email: Boolean(senders.email) || canEmail() };
}

/** E.164 for phone routes (it must come with its country code), lowercase for email. Null when it can't be one. */
export function normaliseTarget(via: CodeVia, raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (via === "email") {
    const e = s.toLowerCase();
    return e.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/.test(e) ? e : null;
  }
  if (!/^(?:\+|00)/.test(s) || /[^\d\s()+.-]/.test(s)) return null;
  const digits = s.replace(/\D/g, "").replace(/^00/, "");
  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
}

export interface Said { ok: boolean; status: number; text: string; error?: string }

const SENT: Record<CodeVia, string> = {
  sms: "If that number can get texts, a code is on its way. It works for ten minutes.",
  imessage: "If that number can get iMessages, a code is on its way. It works for ten minutes.",
  email: "If that address can get email, a code is on its way. It works for ten minutes.",
};
const OFF: Record<CodeVia, string> = {
  sms: "Codes by text aren't switched on here. Try another way in.",
  imessage: "Codes by iMessage aren't switched on here. Try another way in.",
  email: "Codes by email aren't switched on here. Try another way in.",
};
const SHAPE: Record<CodeVia, string> = {
  sms: "That doesn't look like a number with its country code. Write it like +44 7700 900123.",
  imessage: "That doesn't look like a number with its country code. Write it like +1 415 555 0100.",
  email: "That doesn't look like an email address. Check it and try again.",
};

/** Make and send a code. The reply is the same whether or not anyone has that number. */
export async function startCode(db: Db, via: CodeVia, raw: unknown, ip: string, now = new Date()): Promise<Said> {
  if (!["sms", "imessage", "email"].includes(via)) return { ok: false, status: 400, error: "method", text: "I don't know that way in." };
  if (!(await codeMethods())[via]) return { ok: false, status: 400, error: "off", text: OFF[via] };
  const target = normaliseTarget(via, raw);
  if (!target) return { ok: false, status: 400, error: "shape", text: SHAPE[via] };
  if (!startsPerIp.hit(ip, now.getTime())) return { ok: false, status: 429, error: "limit", text: "That's a lot of codes from here in one hour. Wait a while, then try again." };
  // A cap for the whole server too: per-address limits lean on a header a direct caller can fake, and texts cost money.
  const all = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM signin_codes WHERE via=$1 AND created_at > $2`, [via, new Date(now.getTime() - 3_600_000)]);
  if (Number(all?.n ?? 0) >= (via === "email" ? 120 : 40)) return { ok: false, status: 429, error: "busy", text: "A lot of codes have gone out in the last hour. Try another way in, or again a little later." };
  const th = hmac(`t:${target}`);
  const recent = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM signin_codes WHERE target_hash=$1 AND created_at > $2`, [th, new Date(now.getTime() - 3_600_000)]);
  if (Number(recent?.n ?? 0) >= 3) return { ok: false, status: 429, error: "limit", text: "That's three codes in the last hour. Wait a while, then ask again." };
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.query(`UPDATE signin_codes SET used=true WHERE target_hash=$1 AND NOT used`, [th]);
  await db.query(`INSERT INTO signin_codes (via, target_hash, code_hash, expires_at, created_at) VALUES ($1,$2,$3,$4,$5)`, [via, th, hmac(`c:${th}:${code}`), new Date(now.getTime() + 10 * 60_000), now]);
  const text = `Your lifeline code is ${code}, and it works for ten minutes.`;
  try { await (senders[via] ?? ((to: string, t: string) => realSend(via, to, t)))(target, text); }
  catch (e: any) { log.warn({ via, to: hint(target), err: String(e?.message ?? "").replace(/\d{6}/g, "[code]").slice(0, 120) }, "sign-in code not sent"); }
  return { ok: true, status: 200, text: SENT[via] };
}

/** Check a code. On success the code is spent and the normalised number or address comes back. */
export async function checkCode(db: Db, via: CodeVia, raw: unknown, code: unknown, ip: string, now = new Date()): Promise<Said & { target?: string }> {
  const target = normaliseTarget(via, raw);
  if (!target) return { ok: false, status: 400, error: "shape", text: SHAPE[via] ?? "That doesn't look right. Check it and try again." };
  if (!checksPerIp.hit(ip, now.getTime())) return { ok: false, status: 429, error: "limit", text: "That's a lot of tries from here. Wait a while, then try again." };
  const digits = String(code ?? "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return { ok: false, status: 400, error: "shape", text: "The code is six digits. Check it and try again." };
  const th = hmac(`t:${target}`);
  const row = await db.one<{ id: number; code_hash: string; attempts: number; expires_at: string }>(
    `SELECT id, code_hash, attempts, expires_at FROM signin_codes WHERE target_hash=$1 AND via=$2 AND NOT used ORDER BY id DESC LIMIT 1`, [th, via]);
  if (!row || new Date(row.expires_at).getTime() <= now.getTime()) return { ok: false, status: 400, error: "expired", text: "That code has run out, or there isn't one for this. Ask for a new one." };
  // Claim a try in the same statement that checks the count, so a burst of guesses sent at once can't all
  // read "no tries yet" before any of them is counted. Only the first five ever get compared.
  const claimed = await db.one<{ attempts: number }>(`UPDATE signin_codes SET attempts=attempts+1 WHERE id=$1 AND NOT used AND attempts < 5 RETURNING attempts`, [row.id]);
  if (!claimed) { await db.query(`UPDATE signin_codes SET used=true WHERE id=$1`, [row.id]); return { ok: false, status: 400, error: "expired", text: "That code has had too many tries. Ask for a new one." }; }
  if (!safeEqual(row.code_hash, hmac(`c:${th}:${digits}`))) {
    const left = 5 - claimed.attempts;
    if (left <= 0) await db.query(`UPDATE signin_codes SET used=true WHERE id=$1`, [row.id]);
    return { ok: false, status: 400, error: "wrong", text: left > 0 ? `That code didn't match. Check the six digits and try again. ${["", "One try", "Two tries", "Three tries", "Four tries"][left]} left.` : "That code didn't match, and it's had too many tries. Ask for a new one." };
  }
  // Spend it once: of two right answers sent together, only one signs in.
  if (!(await db.one(`UPDATE signin_codes SET used=true WHERE id=$1 AND NOT used RETURNING id`, [row.id]))) return { ok: false, status: 400, error: "expired", text: "That code has already been used. Ask for a new one." };
  await db.query(`UPDATE signin_codes SET used=true WHERE target_hash=$1 AND NOT used`, [th]);
  return { ok: true, status: 200, text: "That's the one.", target };
}

/* ---------------- who that is: sign in, create, or link ---------------- */

export type WayResult =
  | { kind: "signed-in"; user: User; created: boolean }
  | { kind: "linked"; user: User }
  | { kind: "already"; user: User }
  | { kind: "taken" }
  | { kind: "full" };

export async function hasRoom(db: Db): Promise<boolean> {
  const n = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM users`);
  return Number(n?.n ?? 0) < config.maxUsers;
}

/** A verified email goes on file only if the person has none yet. */
async function keepEmail(db: Db, user: User, email: string | null) {
  if (!email) return;
  if (!user.email) await db.query(`UPDATE users SET email=$2 WHERE id=$1 AND email IS NULL`, [user.id, email]);
  if (typeof user.prefs?.emailVerified !== "string") await db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [user.id, JSON.stringify({ emailVerified: email })]);
}

async function addIdentity(db: Db, userId: number, channel: Channel, externalId: string, label: string | null) {
  await db.query(`INSERT INTO identities (user_id, channel, external_id, label) VALUES ($1,$2,$3,$4) ON CONFLICT (channel, external_id) DO NOTHING`, [userId, channel, externalId, label]);
}

/**
 * The person behind a checked identity. With `current` (already signed in) the identity joins that
 * account, unless it's someone else's. Without it, they're signed in, or a new person is made if there's room.
 */
export async function signInOrLink(db: Db, w: { channel: Channel; externalId: string; name?: string | null; email?: string | null; label?: string | null; current?: User | null }): Promise<WayResult> {
  const { channel, externalId } = w;
  let owner = await findUserByIdentity(db, channel, externalId);
  if (!owner && channel === "telegram") owner = await db.one<User>(`SELECT * FROM users WHERE telegram_id=$1`, [Number(externalId)]);
  // An address someone confirmed in settings counts as theirs, even before it was an identity.
  if (!owner && channel === "email") owner = await db.one<User>(`SELECT * FROM users WHERE lower(prefs->>'emailVerified') = $1 ORDER BY id LIMIT 1`, [externalId]);
  const label = w.label ?? null;
  if (w.current) {
    if (owner && owner.id !== w.current.id) return { kind: "taken" };
    await addIdentity(db, w.current.id, channel, externalId, label);
    if (channel === "telegram") await db.query(`UPDATE users SET telegram_id=$2 WHERE id=$1 AND telegram_id IS NULL`, [w.current.id, Number(externalId)]);
    await keepEmail(db, w.current, channel === "email" ? externalId : w.email ?? null);
    const user = (await getUserById(db, w.current.id))!;
    return owner ? { kind: "already", user } : { kind: "linked", user };
  }
  if (owner) {
    await addIdentity(db, owner.id, channel, externalId, label);
    await keepEmail(db, owner, w.email ?? null);
    return { kind: "signed-in", user: (await getUserById(db, owner.id))!, created: false };
  }
  if (!(await hasRoom(db))) return { kind: "full" };
  const email = channel === "email" ? externalId : w.email ?? null;
  const created = await ensureUser(db, channel, externalId, w.name ? clean(w.name) : undefined, {
    prefs: { firstRun: true, ...(email ? { emailVerified: email } : {}) },
    email,
  });
  if (label) await db.query(`UPDATE identities SET label=$3 WHERE channel=$1 AND external_id=$2`, [channel, externalId, label]);
  log.info({ user: created.id, via: channel }, "new person from the website");
  return { kind: "signed-in", user: created, created: true };
}

/**
 * Adding Telegram through the bot: the bot makes an account the moment someone presses Start, so a
 * person who was already signed in here may find a brand-new, empty one waiting. That one (made in the
 * last fifteen minutes, nothing said, no other way in) is folded into theirs. Anything older is a real
 * account and stays separate.
 */
export async function adoptTelegram(db: Db, current: User, botUserId: number): Promise<WayResult> {
  if (botUserId === current.id) return { kind: "already", user: current };
  const stub = await db.one<{ id: number; telegram_id: string | null; fresh: boolean }>(`SELECT id, telegram_id::text, (created_at > now() - interval '15 minutes') AS fresh FROM users WHERE id=$1`, [botUserId]);
  if (!stub) return { kind: "taken" };
  const ways = await db.query<{ channel: string; external_id: string }>(`SELECT channel, external_id FROM identities WHERE user_id=$1`, [stub.id]);
  const tg = ways.find((w) => w.channel === "telegram")?.external_id ?? stub.telegram_id;
  const spoke = await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE user_id=$1 AND role='user'`, [stub.id]);
  const onlyTelegram = ways.every((w) => w.channel === "telegram" || w.channel === "web");
  if (!tg || !stub.fresh || Number(spoke?.n ?? 0) > 0 || !onlyTelegram) return { kind: "taken" };
  const mine = await db.one(`SELECT 1 FROM identities WHERE user_id=$1 AND channel='telegram'`, [current.id]);
  if (mine) return { kind: "taken" };
  await db.query(`UPDATE users SET telegram_id=NULL WHERE id=$1`, [stub.id]);
  await db.query(`UPDATE identities SET user_id=$2 WHERE user_id=$1 AND channel='telegram'`, [stub.id, current.id]);
  await addIdentity(db, current.id, "telegram", String(tg), null);
  await db.query(`UPDATE users SET telegram_id=$2 WHERE id=$1 AND telegram_id IS NULL`, [current.id, Number(tg)]);
  try {
    for (const t of ["jobs", "sessions", "messages", "pushes", "push_subscriptions", "identities", "link_codes", "audit_log"]) {
      await db.query(`DELETE FROM ${t} WHERE user_id=$1`, [stub.id]).catch(() => undefined);
    }
    await db.query(`DELETE FROM users WHERE id=$1`, [stub.id]);
  } catch (e: any) { log.warn({ stub: stub.id, err: e?.message }, "empty Telegram account left in place"); }
  return { kind: "linked", user: (await getUserById(db, current.id))! };
}

/* ---------------- the "Ways to sign in" list ---------------- */

export interface Way { id: number; channel: Channel; label: string }
const NAMES: Record<string, string> = { telegram: "Telegram", google: "Google", apple: "Apple", sms: "Text messages", imessage: "iMessage", email: "Email" };

export async function waysOf(db: Db, userId: number): Promise<Way[]> {
  const rows = await db.query<{ id: number; channel: Channel; external_id: string; label: string | null }>(
    `SELECT id, channel, external_id, label FROM identities WHERE user_id=$1 AND verified AND channel = ANY($2::text[]) ORDER BY id`, [userId, [...SIGN_IN_WAYS]]);
  return rows.map((r) => ({
    id: r.id, channel: r.channel,
    label: r.channel === "sms" || r.channel === "imessage" || r.channel === "email" ? r.external_id : r.label || (r.channel === "telegram" ? "Your Telegram account" : `Your ${NAMES[r.channel]} account`),
  }));
}

export const wayName = (ch: string) => NAMES[ch] ?? ch;

/** Take one way off. Never the last one, so nobody can lock themselves out. */
export async function removeWay(db: Db, user: User, identityId: number): Promise<"removed" | "last" | "missing"> {
  const ways = await waysOf(db, user.id);
  const w = ways.find((x) => x.id === identityId);
  if (!w) return "missing";
  if (ways.length <= 1) return "last";
  const row = await db.one<{ external_id: string }>(`DELETE FROM identities WHERE id=$1 AND user_id=$2 RETURNING external_id`, [identityId, user.id]);
  if (!row) return "missing";
  if (w.channel === "telegram") await db.query(`UPDATE users SET telegram_id=NULL WHERE id=$1 AND telegram_id=$2`, [user.id, Number(row.external_id)]);
  if (w.channel === "email" && String(user.prefs?.emailVerified ?? "").toLowerCase() === row.external_id) await db.query(`UPDATE users SET prefs = prefs - 'emailVerified' WHERE id=$1`, [user.id]);
  return "removed";
}

/** What each sign-in method needs on the page. Ids here are public by design. */
export async function signInMethods(botUsername: string): Promise<Record<string, unknown>> {
  const codes = await codeMethods();
  return {
    telegram: Boolean(botUsername),
    google: config.googleClientId || null,
    apple: config.appleClientId ? { clientId: config.appleClientId, redirectUri: config.appleRedirectUri || null } : null,
    sms: codes.sms, imessage: codes.imessage, email: codes.email,
  };
}

/** The words for each outcome, shared by every route. */
export function sayResult(r: WayResult, what: string): Said {
  switch (r.kind) {
    case "full": return { ok: false, status: 403, error: "full", text: FULL_MESSAGE() };
    case "taken": return { ok: false, status: 409, error: "taken", text: `${cap(what)} already belongs to another lifeline account. I won't merge the two. Sign out and sign in with it to use that one.` };
    case "already": return { ok: true, status: 200, text: `${cap(what)} is already one of your ways in.` };
    case "linked": return { ok: true, status: 200, text: `${cap(what)} is now a way into your account.` };
    default: return { ok: true, status: 200, text: r.created ? "Welcome in." : "Welcome back." };
  }
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
