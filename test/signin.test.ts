/**
 * More ways into the website: Google and Apple ID tokens (checked against our own keys, never the network),
 * codes by text, iMessage and email, linking a new way to the signed-in account, the no-merge rule, the
 * circle's cap, the first-run step, and the CSRF guard on every sign-in route.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createWeb } from "../src/web/server.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { log } from "../src/core/log.js";
import { ensureUser, findUserByIdentity, getUserById, identitiesOf } from "../src/core/handler.js";
import { adoptTelegram, checkCode, issueAppleNonce, normaliseTarget, resetAuthLimits, startCode, useCodeSender, useJwks, verifyApple, verifyGoogle } from "../src/core/auth.js";

const GOOGLE_ID = "lifeline-test.apps.googleusercontent.com";
const APPLE_ID = "com.example.lifeline.web";
let db: Db;
let web: ReturnType<typeof createWeb>;
let key: CryptoKey, otherKey: CryptoKey;
const sent: { via: string; to: string; text: string }[] = [];
const saved = { maxUsers: config.maxUsers, google: config.googleClientId, apple: config.appleClientId, allowed: [...config.allowedUserIds] };

async function token(claims: JWTPayload, o: { iss: string; aud: string; exp?: number; iat?: number; signWith?: CryptoKey }) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer(o.iss).setAudience(o.aud)
    .setIssuedAt(o.iat ?? now).setExpirationTime(o.exp ?? now + 3600).sign(o.signWith ?? key);
}
const googleToken = (sub: string, extra: JWTPayload = {}, o: Partial<{ iss: string; aud: string; exp: number; iat: number; signWith: CryptoKey }> = {}) =>
  token({ sub, email: `${sub}@gmail.com`, email_verified: true, name: "Ada Lovelace", nonce: issueAppleNonce(), ...extra }, { iss: "https://accounts.google.com", aud: GOOGLE_ID, ...o });
const appleToken = (sub: string, nonce: string, o: Partial<{ iss: string; aud: string; exp: number; iat: number }> = {}) =>
  token({ sub, nonce, email: "x@privaterelay.appleid.com", email_verified: "true" }, { iss: "https://appleid.apple.com", aud: APPLE_ID, ...o });

/** A request the way the page sends it: JSON, from our own origin, maybe signed in. */
async function call(path: string, body?: unknown, o: { cookie?: string; origin?: string; ip?: string; method?: string; type?: string } = {}) {
  const headers: Record<string, string> = { "content-type": o.type ?? "application/json", "x-forwarded-for": o.ip ?? "203.0.113.9" };
  if (o.cookie) headers.cookie = o.cookie;
  if (o.origin) headers.origin = o.origin;
  const r = await web.request(path, { method: o.method ?? (body === undefined ? "GET" : "POST"), headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const cookie = /ll_session=[0-9a-f]{64}/.exec(r.headers.get("set-cookie") ?? "")?.[0];
  return { status: r.status, json: (await r.json()) as any, cookie };
}
const codeFrom = (to: string) => /\b(\d{6})\b/.exec([...sent].reverse().find((s) => s.to === to)?.text ?? "")?.[1] ?? "";

beforeAll(async () => {
  db = await openTestDb();
  web = createWeb(db, "lifeline_bot");
  const a = await generateKeyPair("RS256", { extractable: true });
  const b = await generateKeyPair("RS256", { extractable: true });
  key = a.privateKey; otherKey = b.privateKey;
  const jwk = { ...(await exportJWK(a.publicKey)), kid: "test-key", alg: "RS256", use: "sig" };
  const jwks = createLocalJWKSet({ keys: [jwk] });
  useJwks("google", jwks); useJwks("apple", jwks);
  for (const via of ["sms", "imessage", "email"] as const) useCodeSender(via, async (to, text) => { sent.push({ via, to, text }); });
});
beforeEach(() => { config.googleClientId = GOOGLE_ID; config.appleClientId = APPLE_ID; resetAuthLimits(); });
afterEach(() => { config.maxUsers = saved.maxUsers; config.allowedUserIds = [...saved.allowed]; vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  config.googleClientId = saved.google; config.appleClientId = saved.apple;
  useJwks("google", null); useJwks("apple", null);
  for (const via of ["sms", "imessage", "email"] as const) useCodeSender(via, null);
  await db.close();
});

describe("Google ID tokens", () => {
  it("accepts a good one and refuses the wrong audience, issuer, expiry, key or unverified email", async () => {
    const ok = await verifyGoogle(await googleToken("g-1"));
    expect(ok).toMatchObject({ sub: "g-1", email: "g-1@gmail.com", name: "Ada Lovelace" });
    expect(await verifyGoogle(await googleToken("g-1", {}, { iss: "accounts.google.com" }))).not.toBeNull(); // both issuer spellings
    expect(await verifyGoogle(await googleToken("g-1", {}, { aud: "someone-else.apps.googleusercontent.com" }))).toBeNull();
    expect(await verifyGoogle(await googleToken("g-1", {}, { iss: "https://evil.example" }))).toBeNull();
    const past = Math.floor(Date.now() / 1000) - 7200;
    expect(await verifyGoogle(await googleToken("g-1", {}, { iat: past, exp: past + 3600 }))).toBeNull();
    expect(await verifyGoogle(await googleToken("g-1", {}, { signWith: otherKey }))).toBeNull();
    expect(await verifyGoogle(await googleToken("g-1", { email_verified: false }))).toBeNull();
    expect(await verifyGoogle("not.a.token")).toBeNull();
  });
});

describe("Apple ID tokens", () => {
  it("needs the nonce we issued, once, and Apple's issuer and our audience", async () => {
    const n = issueAppleNonce();
    const good = await verifyApple(await appleToken("a-1", n), n);
    expect(good?.sub).toBe("a-1");
    expect(good?.email).toBeNull(); // private relay addresses aren't kept as anyone's email
    expect(await verifyApple(await appleToken("a-1", n), n)).toBeNull(); // used up

    const n2 = issueAppleNonce();
    expect(await verifyApple(await appleToken("a-1", "some-other-nonce"), n2)).toBeNull(); // token carries a different nonce
    expect(await verifyApple(await appleToken("a-1", "never-issued"), "never-issued")).toBeNull();
    const n3 = issueAppleNonce();
    expect(await verifyApple(await appleToken("a-1", n3, { aud: "com.other.app" }), n3)).toBeNull();
    const n4 = issueAppleNonce();
    expect(await verifyApple(await appleToken("a-1", n4, { iss: "https://accounts.google.com" }), n4)).toBeNull();
    const n5 = issueAppleNonce(), past = Math.floor(Date.now() / 1000) - 7200;
    expect(await verifyApple(await appleToken("a-1", n5, { iat: past, exp: past + 3600 }), n5)).toBeNull();
    const n6 = issueAppleNonce(Date.now() - 11 * 60_000); // issued eleven minutes ago: gone
    expect(await verifyApple(await appleToken("a-1", n6), n6)).toBeNull();
  });

  it("signs in through the route and keeps the name Apple sends the first time", async () => {
    const { json: start } = await call("/auth/apple/start", {});
    const r = await call("/auth/apple", { id_token: await appleToken("apple-person", start.nonce), nonce: start.nonce, name: { firstName: "Grace", lastName: "Hopper" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, created: true, firstRun: true });
    expect(r.cookie).toBeTruthy();
    expect((await findUserByIdentity(db, "apple", "apple-person"))?.name).toBe("Grace Hopper");
    // Second time: no name from Apple, same person.
    const { json: s2 } = await call("/auth/apple/start", {});
    const again = await call("/auth/apple", { id_token: await appleToken("apple-person", s2.nonce), nonce: s2.nonce });
    expect(again.json).toMatchObject({ ok: true, created: false });
    expect((await findUserByIdentity(db, "apple", "apple-person"))?.name).toBe("Grace Hopper");
  });
});

describe("signing in with Google on the website", () => {
  it("creates a person once, keeps the verified email if they have none, and signs them in after", async () => {
    const r = await call("/auth/google", { credential: await googleToken("g-new") });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, created: true, firstRun: true });
    const u = (await findUserByIdentity(db, "google", "g-new"))!;
    expect(u.name).toBe("Ada Lovelace");
    expect(u.email).toBe("g-new@gmail.com");
    expect(u.prefs.emailVerified).toBe("g-new@gmail.com");
    expect(u.preferred_channel).toBe("web"); // Google never carries messages
    const me = await call("/api/me", undefined, { cookie: r.cookie });
    expect(me.json).toMatchObject({ id: u.id, firstRun: true });

    const back = await call("/auth/google", { credential: await googleToken("g-new") });
    expect(back.json).toMatchObject({ ok: true, created: false });
    expect(await db.one(`SELECT count(*)::int AS n FROM identities WHERE channel='google' AND external_id='g-new'`)).toEqual({ n: 1 });
  });

  it("refuses a bad token in a sentence and creates nobody", async () => {
    const before = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM users`);
    const r = await call("/auth/google", { credential: await googleToken("g-bad", {}, { aud: "nope" }) });
    expect(r.status).toBe(401);
    expect(r.json.text).toMatch(/didn't check out/);
    expect(await db.one(`SELECT count(*)::int AS n FROM users`)).toEqual(before);
  });

  it("is off when GOOGLE_CLIENT_ID isn't set", async () => {
    config.googleClientId = "";
    expect((await call("/auth/google", { credential: "x.y.z" })).status).toBe(400);
    expect((await call("/api/public")).json.signin.google).toBeNull();
  });
});

describe("CSRF: sign-in routes only take JSON from lifeline's own pages", () => {
  it("refuses another site's origin and form posts, and accepts our own", async () => {
    const credential = await googleToken("g-csrf");
    expect((await call("/auth/google", { credential }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/auth/code/start", { via: "sms", to: "+15550001111" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await call("/auth/logout", {}, { type: "text/plain" })).status).toBe(415);
    expect((await call("/auth/google", { credential }, { type: "application/x-www-form-urlencoded" })).status).toBe(415);
    const sameSite = await call("/auth/google", { credential }, { origin: "http://localhost" });
    expect(sameSite.status).toBe(200);
    // The same Google token twice: its one-time nonce is spent, so a replay is refused.
    expect((await call("/auth/google", { credential }, { origin: "http://localhost" })).status).toBe(401);
    const r = await web.request("/auth/google", { method: "POST", headers: { "content-type": "application/json", origin: "https://lifeline.example.com", "x-forwarded-host": "lifeline.example.com" }, body: JSON.stringify({ credential: await googleToken("g-csrf") }) });
    expect(r.status).toBe(200); // the Vercel front, proxied
    const cross = await web.request("/auth/logout", { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: "{}" });
    expect(cross.status).toBe(403);
  });
});

describe("codes by text, iMessage and email", () => {
  it("normalises numbers that come with their country code and refuses the rest", () => {
    expect(normaliseTarget("sms", "+44 7700 900123")).toBe("+447700900123");
    expect(normaliseTarget("sms", "00234 801 234 5678")).toBe("+2348012345678");
    expect(normaliseTarget("sms", "0801 234 5678")).toBeNull(); // no country code
    expect(normaliseTarget("sms", "+44 abc")).toBeNull();
    expect(normaliseTarget("email", " Ada@Example.COM ")).toBe("ada@example.com");
    expect(normaliseTarget("email", "not an email")).toBeNull();
  });

  it("sends one plain sentence, signs in with the right code, and creates the person with that number", async () => {
    const to = "+447700900001";
    const start = await call("/auth/code/start", { via: "sms", to: "+44 7700 900001" });
    expect(start.json).toEqual({ ok: true, text: "If that number can get texts, a code is on its way. It works for ten minutes." });
    const msg = sent[sent.length - 1];
    expect(msg).toMatchObject({ via: "sms", to });
    expect(msg.text).toMatch(/^Your lifeline code is \d{6}, and it works for ten minutes\.$/);
    // Stored only as a hash.
    const rows = await db.query<{ code_hash: string; target_hash: string }>(`SELECT code_hash, target_hash FROM signin_codes`);
    expect(JSON.stringify(rows)).not.toContain(codeFrom(to));
    expect(JSON.stringify(rows)).not.toContain("7700900001");

    const wrong = await call("/auth/code/verify", { via: "sms", to, code: codeFrom(to) === "000000" ? "111111" : "000000" });
    expect(wrong.status).toBe(400);
    expect(wrong.json.text).toBe("That code didn't match. Check the six digits and try again. Four tries left.");
    const ok = await call("/auth/code/verify", { via: "sms", to: "+44 7700 900001", code: codeFrom(to) });
    expect(ok.json).toMatchObject({ ok: true, created: true, firstRun: true });
    expect(ok.cookie).toBeTruthy();
    const u = (await findUserByIdentity(db, "sms", to))!;
    expect(u.preferred_channel).toBe("sms");
    // Spent: the same code can't be used twice.
    expect((await call("/auth/code/verify", { via: "sms", to, code: codeFrom(to) })).json.error).toBe("expired");
  });

  it("signs in the person whose number it already is", async () => {
    const tg = await ensureUser(db, "telegram", "7001", "Bola");
    await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,'imessage','+14155550100')`, [tg.id]);
    await call("/auth/code/start", { via: "imessage", to: "+1 415 555 0100" });
    expect(sent[sent.length - 1].text).toMatch(/^Your lifeline code is \d{6}/);
    const r = await call("/auth/code/verify", { via: "imessage", to: "+14155550100", code: codeFrom("+14155550100") });
    expect(r.json).toMatchObject({ ok: true, created: false });
    expect((await call("/api/me", undefined, { cookie: r.cookie })).json.id).toBe(tg.id);
  });

  it("matches email by identity or by an address someone already confirmed, and creates otherwise", async () => {
    const tg = await ensureUser(db, "telegram", "7002", "Chi");
    await db.query(`UPDATE users SET prefs = prefs || '{"emailVerified":"Chi@Example.com"}'::jsonb WHERE id=$1`, [tg.id]);
    const s = await call("/auth/code/start", { via: "email", to: "chi@example.com" });
    expect(s.json.text).toBe("If that address can get email, a code is on its way. It works for ten minutes.");
    const r = await call("/auth/code/verify", { via: "email", to: "chi@example.com", code: codeFrom("chi@example.com") });
    expect(r.json).toMatchObject({ ok: true, created: false });
    expect((await findUserByIdentity(db, "email", "chi@example.com"))?.id).toBe(tg.id);

    await call("/auth/code/start", { via: "email", to: "dami@example.com" });
    const n = await call("/auth/code/verify", { via: "email", to: "dami@example.com", code: codeFrom("dami@example.com") });
    expect(n.json).toMatchObject({ ok: true, created: true });
    const dami = (await findUserByIdentity(db, "email", "dami@example.com"))!;
    expect(dami.prefs.emailVerified).toBe("dami@example.com");
  });

  it("gives the same answer whether or not the number has an account", async () => {
    const known = await ensureUser(db, "telegram", "7003", "Efe");
    await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,'sms','+447700900111')`, [known.id]);
    const a = await call("/auth/code/start", { via: "sms", to: "+447700900111" }, { ip: "198.51.100.1" });
    const b = await call("/auth/code/start", { via: "sms", to: "+447700900222" }, { ip: "198.51.100.2" });
    expect(a.status).toBe(b.status);
    expect(a.json).toEqual(b.json);
    // And a wrong code reads the same for both.
    const wa = await call("/auth/code/verify", { via: "sms", to: "+447700900111", code: "000001" === codeFrom("+447700900111") ? "000002" : "000001" });
    const wb = await call("/auth/code/verify", { via: "sms", to: "+447700900222", code: "000001" === codeFrom("+447700900222") ? "000002" : "000001" });
    expect(wa.json).toEqual(wb.json);
    // A number with no code at all reads like an expired one.
    const none = await call("/auth/code/verify", { via: "sms", to: "+447700900333", code: "123456" });
    expect(none.json.error).toBe("expired");
  });

  it("allows five tries, then the code is gone even if the sixth is right", async () => {
    const to = "+447700900444";
    await call("/auth/code/start", { via: "sms", to });
    const right = codeFrom(to);
    const bad = right === "999999" ? "888888" : "999999";
    for (let i = 0; i < 5; i++) expect((await call("/auth/code/verify", { via: "sms", to, code: bad })).json.error).toBe("wrong");
    const late = await call("/auth/code/verify", { via: "sms", to, code: right });
    expect(late.json.ok).toBe(false);
    expect(late.json.error).toBe("expired");
  });

  it("counts every try before comparing, so a burst of guesses sent at once gets five and no more", async () => {
    const to = "+447700900445";
    await call("/auth/code/start", { via: "sms", to });
    const right = codeFrom(to);
    const wrong = Array.from({ length: 19 }, (_, i) => String((Number(right) + 1 + i) % 1_000_000).padStart(6, "0"));
    // All twenty arrive together, the right one last: only the first five are ever compared.
    const all = await Promise.all([...wrong, right].map((code, i) => checkCode(db, "sms", to, code, `198.51.100.${i}`)));
    expect(all.filter((r) => r.error === "wrong")).toHaveLength(5);
    expect(all[19].ok).toBe(false);
    expect((await checkCode(db, "sms", to, right, "198.51.100.200")).ok).toBe(false);
  });

  it("spends a right code once, even when it's sent twice at the same moment", async () => {
    const to = "+447700900446";
    await call("/auth/code/start", { via: "sms", to });
    const right = codeFrom(to);
    const both = await Promise.all([checkCode(db, "sms", to, right, "198.51.100.1"), checkCode(db, "sms", to, right, "198.51.100.2")]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
  });

  it("limits wrong link codes per IP and across the server, and never counts a right one", async () => {
    const tries = async (n: number, ip: string) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push((await call("/auth/link", { code: "ZZZZZZ" }, { ip })).status); return out; };
    expect(await tries(10, "192.0.2.150")).toEqual(Array(10).fill(401));
    expect((await call("/auth/link", { code: "ZZZZZZ" }, { ip: "192.0.2.150" })).status).toBe(429);
    // A right code from another address still works, and many addresses together still hit the server-wide cap.
    const { createLinkCode } = await import("../src/core/handler.js");
    const u = await ensureUser(db, "telegram", "777001", "Linker");
    expect((await call("/auth/link", { code: await createLinkCode(db, u.id) }, { ip: "192.0.2.151" })).status).toBe(200);
    for (let i = 0; i < 29; i++) await tries(10, `198.18.${i}.1`);
    expect((await call("/auth/link", { code: "ZZZZZZ" }, { ip: "198.18.200.1" })).status).toBe(429);
    resetAuthLimits();
  });

  it("codes last ten minutes", async () => {
    const t0 = new Date("2026-10-29T10:00:00Z");
    await startCode(db, "sms", "+447700900555", "192.0.2.10", t0);
    const code = codeFrom("+447700900555");
    expect((await checkCode(db, "sms", "+447700900555", code, "192.0.2.10", new Date(t0.getTime() + 11 * 60_000))).error).toBe("expired");
    await startCode(db, "sms", "+447700900556", "192.0.2.10", t0);
    expect((await checkCode(db, "sms", "+447700900556", codeFrom("+447700900556"), "192.0.2.10", new Date(t0.getTime() + 9 * 60_000))).ok).toBe(true);
  });

  it("rate limits three codes an hour per number and ten per IP", async () => {
    for (let i = 0; i < 3; i++) expect((await call("/auth/code/start", { via: "sms", to: "+447700900666" }, { ip: `192.0.2.${20 + i}` })).status).toBe(200);
    const fourth = await call("/auth/code/start", { via: "sms", to: "+447700900666" }, { ip: "192.0.2.30" });
    expect(fourth.status).toBe(429);
    expect(fourth.json.text).toMatch(/three codes in the last hour/);
    // The number limit holds across routes too: iMessage to the same number counts.
    expect((await call("/auth/code/start", { via: "imessage", to: "+447700900666" }, { ip: "192.0.2.31" })).status).toBe(429);
    resetAuthLimits();
    for (let i = 0; i < 10; i++) expect((await call("/auth/code/start", { via: "sms", to: `+44770091${String(i).padStart(4, "0")}` }, { ip: "192.0.2.99" })).status).toBe(200);
    expect((await call("/auth/code/start", { via: "sms", to: "+447700919999" }, { ip: "192.0.2.99" })).status).toBe(429);
  });

  it("never writes a code to the log, even when sending fails", async () => {
    const warn = vi.spyOn(log, "warn");
    let code = "";
    useCodeSender("sms", async (_to, text) => { code = /\d{6}/.exec(text)![0]; throw new Error(`gateway refused: ${text}`); });
    const r = await call("/auth/code/start", { via: "sms", to: "+447700900777" });
    expect(r.json.ok).toBe(true); // the page can't tell
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(code);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("7700900777");
    useCodeSender("sms", async (to, text) => { sent.push({ via: "sms", to, text }); });
  });

  it("says plainly when a route isn't switched on", async () => {
    useCodeSender("imessage", null);
    const prev = config.imessageProvider; config.imessageProvider = "";
    const r = await call("/auth/code/start", { via: "imessage", to: "+447700900888" });
    expect(r.status).toBe(400);
    expect(r.json.text).toMatch(/aren't switched on/);
    config.imessageProvider = prev;
    useCodeSender("imessage", async (to, text) => { sent.push({ via: "imessage", to, text }); });
  });
});

describe("linking a new way to the signed-in account", () => {
  it("adds a number or a Google account to the account you're in, never merging someone else's", async () => {
    const first = await call("/auth/google", { credential: await googleToken("g-link-owner") });
    const me = (await findUserByIdentity(db, "google", "g-link-owner"))!;
    await call("/auth/code/start", { via: "sms", to: "+447700901001" });
    const linked = await call("/auth/code/verify", { via: "sms", to: "+447700901001", code: codeFrom("+447700901001") }, { cookie: first.cookie });
    expect(linked.json).toMatchObject({ ok: true, linked: true });
    expect(linked.json.text).toBe("That number is now a way into your account.");
    expect(linked.cookie).toBeUndefined(); // no new session
    expect((await findUserByIdentity(db, "sms", "+447700901001"))?.id).toBe(me.id);

    // Someone else's Google account: said plainly, nothing moves.
    await call("/auth/google", { credential: await googleToken("g-someone-else") });
    const other = (await findUserByIdentity(db, "google", "g-someone-else"))!;
    const taken = await call("/auth/google", { credential: await googleToken("g-someone-else") }, { cookie: first.cookie });
    expect(taken.status).toBe(409);
    expect(taken.json.text).toMatch(/already belongs to another lifeline account\. I won't merge the two/);
    expect((await findUserByIdentity(db, "google", "g-someone-else"))?.id).toBe(other.id);

    // And someone else can't take my number.
    await call("/auth/code/start", { via: "sms", to: "+447700901001" });
    const steal = await call("/auth/code/verify", { via: "sms", to: "+447700901001", code: codeFrom("+447700901001") }, { cookie: (await call("/auth/google", { credential: await googleToken("g-someone-else") })).cookie });
    expect(steal.status).toBe(409);
    expect((await findUserByIdentity(db, "sms", "+447700901001"))?.id).toBe(me.id);

    // Linking what's already yours is fine and says so.
    const again = await call("/auth/google", { credential: await googleToken("g-link-owner") }, { cookie: first.cookie });
    expect(again.json.text).toBe("That Google account is already one of your ways in.");
  });

  it("adds Telegram from the login widget while signed in", async () => {
    const { createHash, createHmac } = await import("node:crypto");
    const token = config.telegramToken; config.telegramToken = token || "123456:test-token";
    const s = await call("/auth/google", { credential: await googleToken("g-wants-telegram") });
    const me = (await findUserByIdentity(db, "google", "g-wants-telegram"))!;
    const fields: Record<string, string> = { id: "88001", first_name: "Ife", auth_date: String(Math.floor(Date.now() / 1000)) };
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const hash = createHmac("sha256", createHash("sha256").update(config.telegramToken).digest()).update(check).digest("hex");
    const r = await call("/auth/telegram", { ...fields, hash }, { cookie: s.cookie });
    expect(r.json).toMatchObject({ ok: true, linked: true });
    expect((await findUserByIdentity(db, "telegram", "88001"))?.id).toBe(me.id);
    expect(Number((await getUserById(db, me.id))?.telegram_id)).toBe(88001); // so the bot knows them too
    const forged = await call("/auth/telegram", { ...fields, first_name: "Someone", hash }, { cookie: s.cookie });
    expect(forged.status).toBe(401);
    config.telegramToken = token;
  });

  it("folds in the empty account the bot made a moment ago, but never a real one", async () => {
    const s = await call("/auth/google", { credential: await googleToken("g-bot-flow") });
    const me = (await findUserByIdentity(db, "google", "g-bot-flow"))!;
    const stub = await ensureUser(db, "telegram", "88002", "Ife");
    const r = await adoptTelegram(db, me, stub.id);
    expect(r.kind).toBe("linked");
    expect((await findUserByIdentity(db, "telegram", "88002"))?.id).toBe(me.id);
    expect(await getUserById(db, stub.id)).toBeUndefined();
    expect(s.cookie).toBeTruthy();

    const real = await ensureUser(db, "telegram", "88003", "Real");
    await db.query(`INSERT INTO messages (user_id, role, content) VALUES ($1,'user','hello')`, [real.id]);
    const other = (await findUserByIdentity(db, "google", "g-link-owner"))!;
    expect((await adoptTelegram(db, other, real.id)).kind).toBe("taken");
    expect((await findUserByIdentity(db, "telegram", "88003"))?.id).toBe(real.id);
  });
});

describe("ways to sign in, in settings", () => {
  it("lists them and never removes the last one", async () => {
    const s = await call("/auth/google", { credential: await googleToken("g-ways") });
    let ways = (await call("/api/ways", undefined, { cookie: s.cookie })).json;
    expect(ways.ways).toEqual([expect.objectContaining({ channel: "google", label: "g-ways@gmail.com" })]);
    expect(ways.methods).toMatchObject({ google: GOOGLE_ID, sms: true, email: true });
    const last = await call("/auth/ways/remove", { id: ways.ways[0].id }, { cookie: s.cookie });
    expect(last.status).toBe(400);
    expect(last.json.text).toMatch(/only way in, so it stays/);

    await call("/auth/code/start", { via: "email", to: "ways@example.com" });
    await call("/auth/code/verify", { via: "email", to: "ways@example.com", code: codeFrom("ways@example.com") }, { cookie: s.cookie });
    ways = (await call("/api/ways", undefined, { cookie: s.cookie })).json;
    expect(ways.ways.map((w: any) => w.channel)).toEqual(["google", "email"]);
    const gone = await call("/auth/ways/remove", { id: ways.ways[0].id }, { cookie: s.cookie });
    expect(gone.json).toMatchObject({ ok: true, text: "Google is no longer a way into your account." });
    expect(gone.json.ways.map((w: any) => w.channel)).toEqual(["email"]);
    // Someone else's identity can't be removed from here.
    const other = await db.one<{ id: number }>(`SELECT id FROM identities WHERE channel='google' AND external_id='g-link-owner'`);
    expect((await call("/auth/ways/remove", { id: other!.id }, { cookie: s.cookie })).status).toBe(404);
  });
});

describe("the circle's cap", () => {
  it("counts new web sign-ups, and people already in still get in", async () => {
    const n = (await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM users`))!.n;
    config.maxUsers = n;
    const r = await call("/auth/google", { credential: await googleToken("g-too-many") });
    expect(r.status).toBe(403);
    expect(r.json.text).toMatch(new RegExp(`small circle of ${n}`));
    expect(await findUserByIdentity(db, "google", "g-too-many")).toBeUndefined();
    await call("/auth/code/start", { via: "sms", to: "+447700902002" });
    const full = await call("/auth/code/verify", { via: "sms", to: "+447700902002", code: codeFrom("+447700902002") });
    expect(full.json.error).toBe("full");
    expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM users`))!.n).toBe(n);
    expect((await call("/auth/google", { credential: await googleToken("g-new") })).json).toMatchObject({ ok: true, created: false });
  });
});

describe("the first-run step", () => {
  it("takes a name and a time zone, then never asks again", async () => {
    const s = await call("/auth/google", { credential: await googleToken("g-first", { name: "Kemi Ade" }) });
    const r = await call("/api/welcome", { name: "Kemi", place: "Europe/Lisbon" }, { cookie: s.cookie });
    expect(r.json.ok).toBe(true);
    expect(r.json.text).toMatch(/^Kemi, you're in\./);
    const u = (await findUserByIdentity(db, "google", "g-first"))!;
    expect(u).toMatchObject({ name: "Kemi", tz: "Europe/Lisbon" });
    expect(u.prefs.firstRun).toBeUndefined();
    expect((await call("/api/me", undefined, { cookie: s.cookie })).json.firstRun).toBe(false);
    const digest = await db.one<{ tz: string }>(`SELECT tz FROM jobs WHERE user_id=$1 AND kind='digest'`, [u.id]);
    expect(digest?.tz).toBe("Europe/Lisbon");
  });

  it("finds a city by name, and says so kindly when it can't", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const found = /name=Nairobi/.test(String(url));
      return new Response(JSON.stringify({ results: found ? [{ name: "Nairobi", country_code: "KE", country: "Kenya", timezone: "Africa/Nairobi", latitude: -1.28, longitude: 36.82 }] : [] }), { headers: { "content-type": "application/json" } });
    }));
    const s = await call("/auth/google", { credential: await googleToken("g-city") });
    const nope = await call("/api/welcome", { name: "Wanjiru", place: "Atlantis" }, { cookie: s.cookie });
    expect(nope.status).toBe(400);
    expect(nope.json.text).toMatch(/couldn't find that place/);
    const ok = await call("/api/welcome", { name: "Wanjiru", place: "Nairobi" }, { cookie: s.cookie });
    expect(ok.json.ok).toBe(true);
    const u = (await findUserByIdentity(db, "google", "g-city"))!;
    expect(u.tz).toBe("Africa/Nairobi");
    expect(u.prefs.country).toBe("KE");
  });

  it("isn't shown to people who came from Telegram", async () => {
    const tg = await ensureUser(db, "telegram", "7099", "Tunde");
    expect(tg.prefs.firstRun).toBeUndefined();
    expect((await identitiesOf(db, tg.id)).map((i) => i.channel)).toEqual(["telegram"]);
  });
});

describe("what the landing page learns from /api/public", () => {
  it("shows which ways in are on", async () => {
    const p = (await call("/api/public")).json;
    expect(p.signin).toMatchObject({ google: GOOGLE_ID, apple: { clientId: APPLE_ID, redirectUri: null }, sms: true, imessage: true, email: true });
    expect(p.push).toHaveProperty("on");
  });
});
