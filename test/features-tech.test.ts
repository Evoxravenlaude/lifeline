/** Work, code and crypto: every feature end to end with every outside call mocked, plus the alert outbox through runDue. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { ensureUser, getUserById, handleCallback, handleMessage } from "../src/core/handler.js";
import { propose } from "../src/policy/engine.js";
import { runDue, schedule, type SchedulerDeps } from "../src/core/scheduler.js";
import { briefExtras } from "../src/core/plugins.js";
import { describeCron, runTool } from "../src/modules/features/tech/devtools.js";
import { probes, registrable, resetGithubPause } from "../src/modules/features/tech/watch.js";
import { looksSecret } from "../src/modules/features/tech/shared.js";
import { tokenFlags } from "../src/modules/features/tech/crypto.js";
import { yesPrice as yesPriceForTest } from "../src/modules/features/tech/markets.js";
import type { User } from "../src/policy/types.js";
import { checkPublic, isPublicIp, resolver } from "../src/core/safefetch.js";

let db: Db;
const saved = { ...config };
const savedEnv = { ...process.env };
const T0 = new Date("2026-10-29T10:00:00Z"); // a Thursday; UTC users, quiet hours 22 to 7

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
type Route = (url: string, init: RequestInit | undefined, body: any) => Response | Promise<Response> | undefined | null;
/** Answers by URL (and JSON-RPC method), records every call. An unexpected call fails the test. */
function mockFetch(...routes: Route[]) {
  const calls: { url: string; init?: RequestInit; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input?.url ?? input);
    let body: any = undefined;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init?.body; }
    calls.push({ url, init, body });
    for (const r of routes) { const res = await r(url, init, body); if (res) return res; }
    throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url} ${body?.method ?? ""}`);
  }));
  return calls;
}
const on = (re: RegExp, fn: (url: string, init: RequestInit | undefined, body: any) => Response | Promise<Response>): Route => (url, init, body) => (re.test(url) ? fn(url, init, body) : undefined);
const rpcOn = (re: RegExp, method: string, result: (params: any[]) => unknown): Route => (url, _i, body) => (re.test(url) && body?.method === method ? json({ jsonrpc: "2.0", id: 1, result: result(body.params) }) : undefined);

const sent: { userId: number; text: string; buttons?: { label: string; data: string }[] }[] = [];
let deps: SchedulerDeps;
async function tick(kind: string, at: Date) {
  vi.setSystemTime(at);
  await schedule(db, { kind, runAt: new Date(at.getTime() - 1000) });
  await runDue(deps, at);
}
let n = 9000;
async function fresh(name = "Ada", tz = "UTC"): Promise<User> {
  const u = await ensureUser(db, "telegram", String(n++), name);
  await db.query(`UPDATE users SET tz=$2 WHERE id=$1`, [u.id, tz]);
  // Keep the core's morning jobs out of the way of these clocks.
  await db.query(`UPDATE jobs SET active=false WHERE user_id=$1`, [u.id]);
  return (await getUserById(db, u.id))!;
}
const say = async (u: User, text: string, now = new Date()) => handleMessage(db, (await getUserById(db, u.id))!, text, { channel: "telegram", now });
const mine = (u: User) => sent.filter((s) => s.userId === u.id);
const H = (h: number) => h * 3_600_000;
const M = (m: number) => m * 60_000;
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  db = await openTestDb();
  deps = { db, getUser: (id) => getUserById(db, id), send: async (u, r) => { sent.push({ userId: u.id, text: r.text, buttons: r.buttons }); return true; } };
});
afterAll(async () => { resolver.lookup = realLookup; vi.useRealTimers(); await db.close(); });
const realLookup = resolver.lookup;
beforeEach(async () => {
  vi.setSystemTime(T0);
  // No real DNS in tests: names resolve to a public documentation-free address, except the "private" ones below.
  resolver.lookup = async (h) => (/^(?:intranet|status\.corp)\./.test(h) ? ["10.0.0.5"] : /^rebind\./.test(h) ? ["93.184.216.34", "127.0.0.1"] : ["93.184.216.34"]);
  // Every test starts with a clean queue: old one-shot jobs from earlier tests never re-run.
  await db.query(`UPDATE jobs SET active=false WHERE user_id IS NULL`);
  for (const t of ["tech_monitors", "tech_gh", "tech_pkgs", "tech_status", "tech_gas_alerts", "tech_perp_alerts", "tech_markets", "tech_rotations"]) await db.query(`UPDATE ${t} SET active=false`);
  await db.query(`UPDATE tech_wallets SET alerts=false`);
  await db.query(`UPDATE tech_claims SET done=true`);
  await db.query(`DELETE FROM wallets`);
});
afterEach(() => { Object.assign(config, saved); process.env = { ...savedEnv }; vi.unstubAllGlobals(); resetGithubPause(); });

/* ===================================================================== */

describe("dev tools, no network", () => {
  it("formats, encodes, decodes and hashes real inputs", async () => {
    mockFetch(); // nothing may be fetched
    const u = await fresh();
    expect((await say(u, `format this json {"a":1,"b":[1,2]}`)).text).toBe('```json\n{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}\n```');
    expect((await say(u, "format this json {a:1}")).text).toMatch(/^That isn't valid JSON/);
    expect((await say(u, "base64 decode aGVsbG8gd29ybGQ=")).text).toBe("```\nhello world\n```");
    expect((await say(u, "base64 encode hello world")).text).toBe("```\naGVsbG8gd29ybGQ=\n```");
    expect((await say(u, "url encode a b&c=d")).text).toBe("```\na%20b%26c%3Dd\n```");
    expect((await say(u, "url decode a%20b%26c")).text).toBe("```\na b&c\n```");
    expect((await say(u, "sha256 of hello")).text).toContain("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    expect((await say(u, "md5 of hello")).text).toContain("5d41402abc4b2a76b9719d911017c592");
    expect((await say(u, "uuid")).text).toMatch(/^```\n[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n```$/);
    expect((await say(u, "generate 3 uuids")).text.split("\n").length).toBe(5);
  });

  it("reads unix time both ways in the person's time zone", async () => {
    mockFetch();
    const u = await fresh("Kemi", "Africa/Lagos");
    const r = (await say(u, "unix time 1730000000")).text;
    expect(r).toContain("Sunday 27 October 2024, 04:33:20 your time (Africa/Lagos)");
    expect(r).toContain("2024-10-27T03:33:20.000Z");
    expect((await say(u, "timestamp 1730000000000")).text).toContain("2024-10-27T03:33:20.000Z");
    const now = (await say(u, "timestamp now", T0)).text;
    expect(now).toContain(String(Math.floor(T0.getTime() / 1000)));
    expect(now).toContain(String(T0.getTime()));
  });

  it("explains cron in plain words with the next runs in the person's zone", async () => {
    mockFetch();
    const u = await fresh("Yuki", "Asia/Tokyo");
    const r = (await say(u, "explain cron 0 9 * * 1-5", T0)).text;
    expect(r).toContain("At 09:00, Monday to Friday.");
    expect(r).toContain("Next, your time (Asia/Tokyo): Fri 30 Oct, 09:00; Mon 2 Nov, 09:00; Tue 3 Nov, 09:00.");
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes, every day.");
    expect(describeCron("30 2 1 * *")).toBe("At 02:30, on the 1st of the month.");
    expect(describeCron("0 * * * 0,6")).toBe("Every hour, on the hour, on Saturday and Sunday.");
    expect(describeCron("0 8,20 * 1 *")).toBe("At 08:00 and 20:00, every day in January.");
    expect((await say(u, "explain cron 0 9 *")).text).toMatch(/five parts/);
  });

  it("tests regexes safely and decodes JWTs without trusting them", async () => {
    mockFetch();
    const u = await fresh();
    expect((await say(u, "test regex /a+b/ against aab")).text).toBe('One match:\n```\n"aab" at 0\n```');
    expect((await say(u, "test regex /(\\d+)-(\\d+)/ against 10-20 and 3-4")).text).toContain('"10-20" at 0, groups: "10", "20"');
    expect((await say(u, "test regex /z/ against aab")).text).toBe("/z/ doesn't match that text.");
    expect(runTool.bind(null, "regex", `/(a+)+$/ against ${"a".repeat(32)}!`, "UTC", T0)).toThrow(/took too long/);
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: "123", exp: Math.floor(T0.getTime() / 1000) + 7200 })).toString("base64url")}.c2ln`;
    const r = (await say(u, `decode jwt ${jwt}`, T0)).text;
    expect(r).toContain("The signature is NOT verified");
    expect(r).toContain('"alg": "HS256"');
    expect(r).toContain('"sub": "123"');
    expect(r).toContain("in 2 hours");
    expect(r).toContain("treat it like a password");
  });
});

describe("secrets are refused, rotation reminders keep only a name", () => {
  it("spots keys, tokens and seed phrases", () => {
    expect(looksSecret("sk_" + "live_51Habcdefghijklmnopqrstuv")).toBe("a Stripe key");
    expect(looksSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789")).toBe("a GitHub token");
    expect(looksSecret("AKIAIOSFODNN7EXAMPLE")).toBe("an AWS key");
    expect(looksSecret("abandon ability able about above absent absorb abstract absurd abuse access accident")).toBe("a seed phrase");
    expect(looksSecret(`0x${"a1".repeat(32)}`)).toBe("a private key");
    expect(looksSecret("Stripe key")).toBeNull();
    expect(looksSecret("the AWS keys for prod")).toBeNull();
  });

  it("refuses a pasted key in plain words and stores nothing", async () => {
    mockFetch();
    const u = await fresh();
    const r = await say(u, "rotate sk_" + "live_51Habcdefghijklmnopqrstuv every 90 days");
    expect(r.text).toBe(`That looks like a Stripe key, so I haven't kept it. I only ever keep a name, like "the Stripe key". If it's live, rotate it now, since it's been in a chat.`);
    expect(await db.query(`SELECT * FROM tech_rotations WHERE user_id=$1`, [u.id])).toEqual([]);
    const seed = await propose({ db, user: u, now: new Date() }, "walletwatch.add", { address: `0x${"a1".repeat(32)}` });
    expect(seed.kind).toBe("error");
    expect((seed as any).reply).toMatch(/private key or seed phrase, so I haven't kept it/);
  });

  it("reminds on the due day from 09:00, once, and restarts the clock", async () => {
    mockFetch();
    const u = await fresh();
    const r = await say(u, "rotate the Stripe key every 90 days", T0);
    expect(r.text).toBe(`I'll remind you to rotate the Stripe key every 90 days, next on Wed 27 Jan. I keep only the name, never the key. Say "rotated the Stripe key" when you do it and I'll restart the clock.`);
    expect(r.buttons?.[0].label).toBe("Undo");
    await tick("tech_hourly", new Date("2027-01-27T08:37:00Z"));
    expect(mine(u)).toHaveLength(0);
    await tick("tech_hourly", new Date("2027-01-27T09:37:00Z"));
    await tick("tech_hourly", new Date("2027-01-27T10:37:00Z"));
    expect(mine(u)).toHaveLength(1);
    expect(mine(u)[0].text).toBe(`Time to rotate the Stripe key (every 90 days). Say "rotated the Stripe key" when it's done.`);
    expect(mine(u)[0].buttons?.[0]).toEqual({ label: "Rotated", data: expect.stringMatching(/^tc:rot:\d+$/) });
    expect((await handleCallback(db, u, mine(u)[0].buttons![0].data, new Date("2027-01-27T11:00:00Z"))).text).toBe("Noted. Next rotation of the Stripe key on Tue 27 Apr.");
    expect((await say(u, "rotated the Stripe key", new Date("2027-01-28T11:00:00Z"))).text).toBe("Noted that the Stripe key is fresh. Next rotation Wed 28 Apr.");
  });
});

/* ===================================================================== */

describe("addresses people give: public internet only", () => {
  it("knows private, loopback, link-local and mapped addresses from public ones", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd12:3456::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:a9fe:a9fe"]) expect(isPublicIp(ip)).toBe(false);
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) expect(isPublicIp(ip)).toBe(true);
  });

  it("refuses to watch metadata, loopback, private names and other schemes, without fetching", async () => {
    const calls = mockFetch();
    const u = await fresh();
    for (const s of ["watch http://169.254.169.254/latest/meta-data/", "watch http://127.0.0.1:6379", "watch https://intranet.example.com", "watch http://localhost.localdomain:8080", "watch https://rebind.example.com"]) {
      expect((await say(u, s)).text).toMatch(/isn't on the public internet/);
    }
    await expect(checkPublic("file:///etc/passwd")).rejects.toThrow(/http and https/);
    await expect(checkPublic("http://2130706433/")).rejects.toThrow(/public internet/); // 127.0.0.1 written as a number
    expect(calls).toHaveLength(0);
    expect(await db.one(`SELECT count(*)::int AS n FROM tech_monitors WHERE user_id=$1`, [u.id])).toEqual({ n: 0 });
  });

  it("checks every redirect hop, so a public site can't bounce the check to a private address", async () => {
    const calls = mockFetch(on(/^https:\/\/bouncy\.example\.com\/$/, () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:8080/admin" } })));
    const u = await fresh();
    expect((await say(u, "watch https://bouncy.example.com")).text).toMatch(/It isn't answering right now \(it isn't on the public internet\)/);
    expect(calls.every((c) => !c.url.includes("127.0.0.1"))).toBe(true);
  });

  it("won't read a typed status page on a private host, and won't summarise a private link", async () => {
    const calls = mockFetch();
    const u = await fresh();
    expect((await say(u, "watch status of status.corp.example")).text).toMatch(/isn't on the public internet/);
    const d = await propose({ db, user: u, now: T0, sourceMessage: "[test]" }, "summarize", { url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/" });
    expect("reply" in d ? d.reply : "").toMatch(/isn't on the public internet/);
    expect(calls).toHaveLength(0);
  });
});

describe("uptime, certificates and domains", () => {
  it("alerts once after two failures, once on recovery with the downtime, merged and through push", async () => {
    let up = true;
    const calls = mockFetch(on(/^https:\/\/mysite\.com\/$/, (_u, init) => { if (!up) throw new TypeError("fetch failed"); return new Response(init?.method === "HEAD" ? null : "ok", { status: 200 }); }));
    const u = await fresh();
    const w = await say(u, "watch https://mysite.com");
    expect(w.text).toMatch(/^Watching mysite\.com every 5 minutes\. It's up now \(200 in \d+ ms\)\. I'll also warn you before its certificate or domain expires\. Say "stop watching mysite\.com" to end it\.$/);
    expect(calls[0].init?.method).toBe("HEAD");
    up = false;
    const t1 = at(T0, M(2));
    await tick("tech_uptime", t1);
    expect(mine(u)).toHaveLength(0); // one failure is not an outage
    expect(calls.slice(-2).map((c) => c.init?.method)).toEqual(["HEAD", "GET"]); // HEAD, then the GET fallback
    await tick("tech_uptime", at(t1, M(5)));
    expect(mine(u)).toHaveLength(1);
    expect(mine(u)[0].text).toBe("mysite.com looks down: the connection failed, twice in a row. I'll tell you when it's back.");
    expect(mine(u)[0].buttons?.[0]).toEqual({ label: "Stop watching", data: expect.stringMatching(/^tc:mon:off:\d+$/) });
    await tick("tech_uptime", at(t1, M(10)));
    expect(mine(u)).toHaveLength(1); // still down: no repeat
    up = true;
    await tick("tech_uptime", at(t1, M(15)));
    expect(mine(u)).toHaveLength(2);
    expect(mine(u)[1].text).toBe("mysite.com is back up after 15 minutes down.");
    expect(await db.one(`SELECT kind FROM pushes WHERE user_id=$1 ORDER BY id DESC LIMIT 1`, [u.id])).toEqual({ kind: "tech" });
  });

  it("holds an outage alert through quiet hours and sends it after", async () => {
    let up = true;
    mockFetch(on(/night\.example\.com/, () => { if (!up) throw new TypeError("fetch failed"); return new Response(null, { status: 200 }); }));
    const u = await fresh();
    await say(u, "watch night.example.com");
    up = false;
    const night = new Date("2026-10-29T23:00:00Z");
    await tick("tech_uptime", night);
    await tick("tech_uptime", at(night, M(5)));
    expect(mine(u)).toHaveLength(0);
    await tick("tech_flush", new Date("2026-10-30T07:05:00Z"));
    expect(mine(u)).toHaveLength(1);
    expect(mine(u)[0].text).toMatch(/night\.example\.com looks down/);
  });

  it("warns before the certificate (14 and 3 days) and the domain (30 and 7 days) expire, merged", async () => {
    let cert = at(T0, H(24 * 10)), domain = at(T0, H(24 * 25));
    probes.tls = async (host) => { expect(host).toBe("shop.example.co.uk"); return cert; };
    const calls = mockFetch(
      on(/^https:\/\/shop\.example\.co\.uk\/$/, () => new Response(null, { status: 200 })),
      on(/^https:\/\/rdap\.org\/domain\/example\.co\.uk$/, () => json({ objectClassName: "domain", events: [{ eventAction: "registration", eventDate: "2001-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: domain.toISOString() }] })),
    );
    expect(registrable("www.shop.example.co.uk")).toBe("example.co.uk");
    expect(registrable("api.mysite.com")).toBe("mysite.com");
    const u = await fresh();
    await say(u, "uptime monitor for shop.example.co.uk");
    await tick("tech_expiry", at(T0, H(1)));
    expect(calls.some((c) => c.url === "https://rdap.org/domain/example.co.uk")).toBe(true);
    expect(mine(u)).toHaveLength(1);
    expect(mine(u)[0].text).toBe([
      "From your watches:",
      "- The certificate for shop.example.co.uk expires in 9 days, on Sun 8 Nov. Renew it before visitors see a warning.",
      "- The domain example.co.uk expires in 24 days, on Mon 23 Nov. Check auto-renew with your registrar.",
    ].join("\n"));
    await tick("tech_expiry", at(T0, H(25)));
    expect(mine(u)).toHaveLength(1); // same stage, no repeat
    await tick("tech_expiry", at(T0, H(24 * 8 + 1)));
    expect(mine(u)).toHaveLength(2);
    expect(mine(u)[1].text).toMatch(/^The certificate for shop\.example\.co\.uk expires in 1 day/);
    cert = at(T0, H(24 * 100)); // renewed
    await tick("tech_expiry", at(T0, H(24 * 9 + 2)));
    expect((await db.one(`SELECT cert_warned FROM tech_monitors WHERE user_id=$1`, [u.id])).cert_warned).toBeNull();
    void domain;
  });
});

describe("GitHub", () => {
  it("watches releases with ETags, merges new ones, and doesn't repeat", async () => {
    Object.assign(config, { githubToken: "" });
    let releases = [{ id: 100, tag_name: "v15.0.0", name: "v15.0.0", html_url: "https://github.com/vercel/next.js/releases/tag/v15.0.0", draft: false, prerelease: false }];
    const calls = mockFetch(
      on(/^https:\/\/api\.github\.com\/repos\/vercel\/next\.js$/, () => json({ full_name: "vercel/next.js" }, 200, { etag: '"r1"', "x-ratelimit-remaining": "55" })),
      on(/^https:\/\/api\.github\.com\/repos\/vercel\/next\.js\/releases\?per_page=5$/, (_u, init) => {
        const tag = `"rel-${releases[0].id}"`;
        if ((init?.headers as any)?.["if-none-match"] === tag) return new Response(null, { status: 304, headers: { etag: tag } });
        return json(releases, 200, { etag: tag });
      }),
    );
    const u = await fresh();
    const r = await say(u, "watch releases of vercel/next.js");
    expect(r.text).toBe(`Watching releases of vercel/next.js. The latest is v15.0.0. New ones come in one message, at most once a day; the rest wait for your morning note. Say "stop watching vercel/next.js" to end it.`);
    const h = calls[0].init?.headers as Record<string, string>;
    expect(h.accept).toBe("application/vnd.github+json");
    expect(h["x-github-api-version"]).toBe("2022-11-28");
    expect(h.authorization).toBeUndefined();
    await tick("tech_github", at(T0, H(3)));
    expect((calls.at(-1)!.init?.headers as any)["if-none-match"]).toBe('"rel-100"'); // conditional request
    expect(mine(u)).toHaveLength(0);
    releases = [{ id: 102, tag_name: "v15.1.0", name: "v15.1.0", html_url: "https://github.com/vercel/next.js/releases/tag/v15.1.0", draft: false, prerelease: false }, { id: 101, tag_name: "v15.1.0-canary.1", name: "", html_url: "https://github.com/x", draft: false, prerelease: true }, ...releases];
    await tick("tech_github", at(T0, H(6)));
    expect(mine(u)).toHaveLength(1);
    expect(mine(u)[0].text).toBe("From your watches:\n- vercel/next.js released v15.1.0-canary.1 (a pre-release).\nhttps://github.com/x\n- vercel/next.js released v15.1.0.\nhttps://github.com/vercel/next.js/releases/tag/v15.1.0");
    await tick("tech_github", at(T0, H(9)));
    expect(mine(u)).toHaveLength(1);
  });

  it("tells you when CI fails, several runs in one message, with the token when set", async () => {
    Object.assign(config, { githubToken: "ghp_test" });
    let runs: any[] = [{ id: 5, name: "build", head_branch: "main", html_url: "https://github.com/myorg/myrepo/actions/runs/5" }];
    const calls = mockFetch(
      on(/\/repos\/myorg\/myrepo$/, () => json({ full_name: "myorg/myrepo" })),
      on(/\/repos\/myorg\/myrepo\/actions\/runs\?status=failure&per_page=\d+$/, () => json({ total_count: runs.length, workflow_runs: runs })),
    );
    const u = await fresh();
    expect((await say(u, "tell me when CI fails on myorg/myrepo")).text).toBe(`I'll tell you when CI fails on myorg/myrepo. I check every 10 minutes and put several failures in one message. Say "stop watching myorg/myrepo" to end it.`);
    expect((calls[0].init?.headers as any).authorization).toBe("Bearer ghp_test");
    runs = [{ id: 7, name: "test", head_branch: "fix/login", html_url: "https://github.com/myorg/myrepo/actions/runs/7" }, { id: 6, name: "build", head_branch: "main", html_url: "https://github.com/myorg/myrepo/actions/runs/6" }, ...runs];
    await tick("tech_github", at(T0, M(11)));
    expect(mine(u)).toHaveLength(1);
    expect(mine(u)[0].text).toBe("2 CI runs failed on myorg/myrepo, the latest test on fix/login.\nhttps://github.com/myorg/myrepo/actions/runs/7");
    await tick("tech_github", at(T0, M(22)));
    expect(mine(u)).toHaveLength(1);
  });

  it("only watches mentions with a token", async () => {
    Object.assign(config, { githubToken: "" });
    const calls = mockFetch(
      on(/\/repos\/owner\/repo$/, () => json({ full_name: "owner/repo" })),
      on(/api\.github\.com\/user$/, () => json({ login: "ada-dev" })),
      on(/\/repos\/owner\/repo\/issues\?mentioned=ada-dev&state=all&sort=updated&since=/, () => json([{ number: 9, title: "Login breaks on Safari", html_url: "https://github.com/owner/repo/issues/9", updated_at: "2026-10-29T10:30:00Z" }])),
    );
    const u = await fresh();
    Object.assign(config, { allowedUserIds: [Number(u.telegram_id)] }); // mentions use the server's account, so only its owner may watch them
    expect((await say(u, "watch issues mentioning me in owner/repo")).text).toMatch(/^Mentions need a GitHub token on the server \(GITHUB_TOKEN\)/);
    expect(calls).toHaveLength(0);
    Object.assign(config, { githubToken: "ghp_test" });
    expect((await say(u, "watch issues mentioning me in owner/repo")).text).toMatch(/^Watching owner\/repo for issues and pull requests that mention ada-dev\./);
    await tick("tech_github", at(T0, M(20)));
    expect(mine(u).map((s) => s.text)).toEqual([`"Login breaks on Safari" in owner/repo mentions you.\nhttps://github.com/owner/repo/issues/9`]);
  });

  it("says plainly when a repo doesn't exist", async () => {
    Object.assign(config, { githubToken: "" });
    mockFetch(on(/\/repos\/nobody\/nothing$/, () => json({ message: "Not Found" }, 404)));
    const u = await fresh();
    expect((await say(u, "watch releases of nobody/nothing")).text).toBe("I couldn't find nobody/nothing on GitHub. If it's private, the server's GITHUB_TOKEN needs access to it.");
  });
});

describe("package releases", () => {
  it("npm, PyPI and crates.io: minor versions wait for the brief, a major version pings", async () => {
    const v: Record<string, string> = { react: "19.3.1", fastapi: "0.120.0", tokio: "1.48.0" };
    const calls = mockFetch(
      on(/^https:\/\/registry\.npmjs\.org\/react\/latest$/, () => json({ name: "react", version: v.react })),
      on(/^https:\/\/registry\.npmjs\.org\/@types%2Fnode\/latest$/, () => json({ version: "24.1.0" })),
      on(/^https:\/\/pypi\.org\/pypi\/fastapi\/json$/, () => json({ info: { version: v.fastapi }, releases: {} })),
      on(/^https:\/\/crates\.io\/api\/v1\/crates\/tokio$/, (_u, init) => { expect((init?.headers as any)["user-agent"]).toMatch(/lifeline/); return json({ crate: { max_stable_version: v.tokio, newest_version: "1.49.0-rc.1" } }); }),
      on(/registry\.npmjs\.org\/no-such-pkg-xyz/, () => json({ error: "Not found" }, 404)),
    );
    const u = await fresh();
    expect((await say(u, "watch npm react")).text).toBe(`Watching react on npm, now at \`19.3.1\`. New versions go in your morning note; a new major version gets a ping. Say "stop watching react" to end it.`);
    expect((await say(u, "watch pypi fastapi")).text).toMatch(/^Watching fastapi on PyPI, now at `0\.120\.0`/);
    expect((await say(u, "watch crates tokio")).text).toMatch(/^Watching tokio on crates\.io, now at `1\.48\.0`/);
    expect((await say(u, "watch @types/node on npm")).text).toMatch(/^Watching @types\/node on npm/);
    expect((await say(u, "watch npm no-such-pkg-xyz")).text).toBe("I couldn't find no-such-pkg-xyz on npm. Check the spelling?");
    v.react = "19.3.2"; v.fastapi = "0.121.0";
    await tick("tech_packages", at(T0, H(3)));
    expect(mine(u)).toHaveLength(0);
    const brief = await briefExtras(db, u, at(T0, H(4)));
    expect(brief).toContain("Work: react 19.3.2 is out on npm; fastapi 0.121.0 is out on PyPI.");
    v.tokio = "2.0.0";
    await tick("tech_packages", at(T0, H(6)));
    expect(mine(u).map((s) => s.text)).toEqual(["tokio 2.0.0 is out on crates.io, a new major version (was 1.48.0).\nhttps://crates.io/crates/tokio"]);
    expect(calls.filter((c) => /registry\.npmjs\.org\/react\/latest/.test(c.url)).length).toBe(3);
  });
});

describe("service status", () => {
  const summary = (incidents: any[]) => json({ page: { name: "x" }, status: { indicator: incidents.length ? "major" : "none", description: incidents.length ? "Partial System Outage" : "All Systems Operational" }, components: [], incidents, scheduled_maintenances: [] });
  it("follows Statuspage and incident.io pages and merges new incidents", async () => {
    let gh: any[] = [], vercel: any[] = [];
    const calls = mockFetch(
      on(/^https:\/\/www\.githubstatus\.com\/api\/v2\/summary\.json$/, () => summary(gh)),
      on(/^https:\/\/www\.vercel-status\.com\/api\/v2\/summary\.json$/, () => summary(vercel)),
      on(/^https:\/\/www\.cloudflarestatus\.com\/api\/v2\/summary\.json$/, () => summary([])),
      on(/^https:\/\/status\.openai\.com\/api\/v1\/summary$/, () => json({ ongoing_incidents: [], in_progress_maintenances: [], scheduled_maintenances: [] })),
    );
    const u = await fresh();
    const r = await say(u, "watch status of GitHub, Vercel, Cloudflare, OpenAI");
    expect(r.text).toBe(`Following GitHub, Vercel, Cloudflare and OpenAI status. All normal right now. I'll tell you about new incidents, several in one message. Say "stop watching GitHub status" to end one.`);
    expect(calls.map((c) => c.url)).toEqual(["https://www.githubstatus.com/api/v2/summary.json", "https://www.vercel-status.com/api/v2/summary.json", "https://www.cloudflarestatus.com/api/v2/summary.json", "https://status.openai.com/api/v1/summary"]);
    gh = [{ id: "g1", name: "Degraded performance for Git operations", status: "investigating", impact: "major", shortlink: "https://stspg.io/g1" }];
    vercel = [{ id: "v1", name: "Delayed build logs", status: "identified", impact: "minor", shortlink: "https://stspg.io/v1" }];
    await tick("tech_status", at(T0, M(5)));
    expect(mine(u)).toHaveLength(1);
    expect(mine(u)[0].text).toBe("From your watches:\n- GitHub has a partial outage: Degraded performance for Git operations.\nhttps://stspg.io/g1\n- Vercel has minor trouble: Delayed build logs.\nhttps://stspg.io/v1");
    await tick("tech_status", at(T0, M(15)));
    expect(mine(u)).toHaveLength(1);
    gh = [];
    await tick("tech_status", at(T0, M(25)));
    expect(mine(u)).toHaveLength(1); // resolutions wait for the brief
    expect((await briefExtras(db, u, at(T0, M(30)))).join(" ")).toContain("GitHub: Degraded performance for Git operations is resolved");
  });

  it("answers is X down from the status page", async () => {
    mockFetch(on(/githubstatus\.com\/api\/v2\/summary\.json/, () => summary([{ id: "a", name: "Actions delayed", status: "monitoring", impact: "minor", shortlink: "https://stspg.io/a" }])));
    const u = await fresh();
    expect((await say(u, "is github down")).text).toBe("GitHub reports partial system outage. Actions delayed (monitoring).\nhttps://stspg.io/a");
  });
});

/* ===================================================================== */

const EVM_RPC = /publicnode\.com/;
describe("gas and fees", () => {
  const gas: Record<string, number> = { ethereum: 12e9, base: 5e6, arbitrum: 1e7, optimism: 1e6, polygon: 30e9 };
  const gasRoute: Route = (url, _i, body) => {
    const chain = Object.keys(gas).find((c) => url.includes(c === "arbitrum" ? "arbitrum-one" : c === "polygon" ? "polygon-bor" : c));
    if (!EVM_RPC.test(url) || !chain) return undefined;
    if (body.method === "eth_gasPrice") return json({ jsonrpc: "2.0", id: 1, result: `0x${gas[chain].toString(16)}` });
    if (body.method === "eth_feeHistory") return json({ jsonrpc: "2.0", id: 1, result: { baseFeePerGas: ["0x2540be400", "0x2540be400", "0x2540be400", "0x2540be400", "0x2540be400", "0x2540be400"], reward: [["0x3b9aca00"], ["0x3b9aca00"], ["0x77359400"], ["0x3b9aca00"], ["0x3b9aca00"]] } });
    return undefined;
  };
  it("reads every chain at once in plain words", async () => {
    const calls = mockFetch(gasRoute,
      rpcOn(/api\.mainnet-beta\.solana\.com/, "getRecentPrioritizationFees", () => [{ slot: 1, prioritizationFee: 0 }, { slot: 2, prioritizationFee: 1000 }, { slot: 3, prioritizationFee: 5000 }, { slot: 4, prioritizationFee: 3000 }]),
      on(/api\.coingecko\.com\/api\/v3\/simple\/price\?ids=ethereum/, () => json({ ethereum: { usd: 4000 } })),
    );
    const u = await fresh();
    expect((await say(u, "gas now")).text).toBe([
      "Gas right now:",
      "- Ethereum 12 gwei (base 10, tip 1.0)",
      "- Base 0.005 gwei",
      "- Arbitrum 0.01 gwei",
      "- Optimism 0.001 gwei",
      "- Polygon 30 gwei",
      "- Solana priority fees around 3,000 micro-lamports per compute unit",
      "A plain ETH transfer on Ethereum costs about $1.01 right now.",
    ].join("\n"));
    const fh = calls.find((c) => c.body?.method === "eth_feeHistory")!;
    expect(fh.body.params).toEqual(["0x5", "latest", [50]]);
    expect(calls.find((c) => c.body?.method === "getRecentPrioritizationFees")!.body).toEqual({ jsonrpc: "2.0", id: 1, method: "getRecentPrioritizationFees", params: [] });
    expect((await say(u, "gas on base")).text).toBe("Gas right now:\n- Base 0.005 gwei");
  });

  it("tells you once when ETH gas drops under your level, then stops", async () => {
    mockFetch(gasRoute);
    const u = await fresh();
    expect((await say(u, "tell me when ETH gas is under 5 gwei")).text).toBe("I'll tell you once when Ethereum gas drops under 5 gwei, then stop. It's 12 gwei now.");
    await tick("tech_gas", at(T0, M(5)));
    expect(mine(u)).toHaveLength(0);
    gas.ethereum = 4.2e9;
    await tick("tech_gas", at(T0, M(10)));
    await tick("tech_gas", at(T0, M(15)));
    expect(mine(u).map((s) => s.text)).toEqual(["Ethereum gas is down to 4.2 gwei, under your 5. That alert is done; set another any time."]);
    gas.ethereum = 12e9;
  });
});

describe("wallet activity", () => {
  const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
  const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  it("watches portfolio wallets on Solana for free, merged, quiet hours respected", async () => {
    let sigs = [{ signature: "sig1", slot: 1, err: null, blockTime: 1 }];
    const calls = mockFetch(
      rpcOn(/solana\.com/, "getSignaturesForAddress", (p) => { const until = p[1]?.until; const i = until ? sigs.findIndex((s) => s.signature === until) : sigs.length; return sigs.slice(0, i < 0 ? sigs.length : i); }),
      rpcOn(/solana\.com/, "getTransaction", (p) => ({ slot: 2, blockTime: 2, meta: { err: null, fee: 5000, preBalances: [10e9, 3e9], postBalances: [10e9 - 1.5e9 - 5000, 4.5e9], preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { accountKeys: [{ pubkey: OTHER, signer: true }, { pubkey: SOL, signer: false }] } }, _sig: p[0] })),
    );
    const u = await fresh();
    await say(u, `watch my wallet ${SOL} on solana as main`); // the core's portfolio watch
    await tick("tech_wallets", at(T0, M(9)));
    expect(mine(u)).toHaveLength(0); // the first look sets a baseline
    expect(calls[0].body).toEqual({ jsonrpc: "2.0", id: 1, method: "getSignaturesForAddress", params: [SOL, { limit: 10 }] });
    sigs = [{ signature: "sig2", slot: 2, err: null, blockTime: 2 }, ...sigs];
    await tick("tech_wallets", at(T0, M(24)));
    expect(calls.find((c) => c.body?.method === "getSignaturesForAddress" && c.body.params[1].until === "sig1")).toBeTruthy();
    expect(calls.find((c) => c.body?.method === "getTransaction")!.body.params).toEqual(["sig2", { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    expect(mine(u).map((s) => s.text)).toEqual([`main on Solana: received 1.5 SOL.\nhttps://solscan.io/account/${SOL}`]);
    // At night it waits, then comes in the morning.
    sigs = [{ signature: "sig3", slot: 3, err: null, blockTime: 3 }, ...sigs];
    await tick("tech_wallets", new Date("2026-10-29T23:09:00Z"));
    expect(mine(u)).toHaveLength(1);
    await tick("tech_flush", new Date("2026-10-30T07:05:00Z"));
    expect(mine(u)).toHaveLength(2);
    // "stop wallet alerts" mutes it without touching the portfolio.
    const s = await say(u, "stop wallet alerts", new Date("2026-10-30T08:00:00Z"));
    expect(s.text).toBe("Stopped watching main. Wallets stay in your portfolio; only their activity alerts stop.");
    expect(await db.query(`SELECT address FROM wallets WHERE user_id=$1`, [u.id])).toHaveLength(1);
  });

  it("uses Etherscan's v2 API for EVM wallets when there's a key, and says so when there isn't", async () => {
    const A = "0x1234567890abcdef1234567890abcdef12345678";
    mockFetch();
    const u = await fresh();
    expect((await say(u, `wallet alerts for ${A} on base as treasury`)).text).toBe(`I'll tell you when treasury (\`${A}\`) sends or receives on Base, a few transactions in one message, at most every 15 minutes, and never during your quiet hours. EVM activity comes from Etherscan, and this server doesn't have an Etherscan key yet (ETHERSCAN_API_KEY), so I'll start as soon as it does. Say "stop watching treasury" to end it.`);
    await tick("tech_wallets", at(T0, M(9))); // no key: no calls at all
    process.env.ETHERSCAN_API_KEY = "ek_test";
    let txs: any[] = [{ hash: "0xa", blockNumber: "100", from: "0xfeed000000000000000000000000000000000001", to: A, value: "0", isError: "0" }];
    let toks: any[] = [];
    const calls = mockFetch(on(/^https:\/\/api\.etherscan\.io\/v2\/api\?/, (url) => {
      const q = new URL(url).searchParams;
      const list = q.get("action") === "txlist" ? txs : toks;
      const fresh = list.filter((t) => Number(t.blockNumber) >= Number(q.get("startblock")));
      return json(fresh.length ? { status: "1", message: "OK", result: fresh } : { status: "0", message: "No transactions found", result: [] });
    }));
    await tick("tech_wallets", at(T0, M(24)));
    const q = new URL(calls[0].url).searchParams;
    expect(Object.fromEntries(q)).toEqual({ chainid: "8453", module: "account", address: A, startblock: "0", endblock: "99999999", page: "1", offset: "10", sort: "desc", apikey: "ek_test", action: "txlist" });
    expect(new URL(calls[1].url).searchParams.get("action")).toBe("tokentx");
    expect(mine(u)).toHaveLength(0);
    txs = [{ hash: "0xb", blockNumber: "105", from: "0xfeed000000000000000000000000000000000002", to: A, value: "500000000000000000", isError: "0" }, ...txs];
    toks = [{ hash: "0xc", blockNumber: "106", from: A, to: "0xbeef000000000000000000000000000000000003", value: "100000000", tokenSymbol: "USDC", tokenDecimal: "6" }];
    await tick("tech_wallets", at(T0, M(39)));
    expect(new URL(calls.at(-1)!.url).searchParams.get("startblock")).toBe("101");
    expect(mine(u).map((s) => s.text)).toEqual([`treasury on Base: sent 100 USDC to 0xbeef…0003, received 0.5 ETH from 0xfeed…0002.\nhttps://basescan.org/address/${A}`]);
  });
});

describe("transaction explainer", () => {
  const HASH = `0x${"ab".repeat(32)}`;
  const FROM = "0x1111111111111111111111111111111111111111", TO = "0x2222222222222222222222222222222222222222", USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const pad = (a: string) => a.replace(/^0x/, "").padStart(64, "0");
  it("finds the chain, decodes a token transfer, and reads it out plainly", async () => {
    const calls = mockFetch(
      rpcOn(/ethereum-rpc/, "eth_getTransactionByHash", () => null),
      rpcOn(/base-rpc/, "eth_getTransactionByHash", () => ({ hash: HASH, from: FROM, to: USDC, value: "0x0", input: `0xa9059cbb${pad(TO)}${(100_000_000).toString(16).padStart(64, "0")}`, gasPrice: "0x3b9aca00" })),
      rpcOn(/base-rpc/, "eth_getTransactionReceipt", () => ({ status: "0x1", gasUsed: "0xc350", effectiveGasPrice: "0x3b9aca00", l1Fee: "0x5af3107a4000", logs: [] })),
      (url, _i, body) => (/base-rpc/.test(url) && body?.method === "eth_call" ? json({ jsonrpc: "2.0", id: 1, result: body.params[0].data === "0x313ce567" ? `0x${"6".padStart(64, "0")}` : `0x${"20".padStart(64, "0")}${"4".padStart(64, "0")}${Buffer.from("USDC").toString("hex").padEnd(64, "0")}` }) : undefined),
    );
    const u = await fresh();
    expect((await say(u, `explain tx ${HASH}`)).text).toBe([
      "On Base, it worked.",
      "0x1111…1111 sent 100 USDC to 0x2222…2222.",
      "Fee: 0.00015 ETH.",
      `https://basescan.org/tx/${HASH}`,
    ].join("\n"));
    expect(calls.map((c) => c.body?.method)).toEqual(["eth_getTransactionByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_call", "eth_call"]);
    expect(calls[0].body.params).toEqual([HASH]);
  });

  it("looks up an unknown function on 4byte.directory and flags unlimited approvals", async () => {
    const SPENDER = "0x3333333333333333333333333333333333333333";
    const calls = mockFetch(
      rpcOn(/ethereum-rpc/, "eth_getTransactionByHash", (p) => (p[0].endsWith("cd") ? { from: FROM, to: TO, value: "0x16345785d8a0000", input: "0xdeadbeef0000", gasPrice: "0x1" } : { from: FROM, to: USDC, value: "0x0", input: `0x095ea7b3${pad(SPENDER)}${"f".repeat(64)}`, gasPrice: "0x1" })),
      rpcOn(/ethereum-rpc/, "eth_getTransactionReceipt", () => ({ status: "0x0", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00", logs: [] })),
      on(/^https:\/\/www\.4byte\.directory\/api\/v1\/signatures\/\?hex_signature=0xdeadbeef$/, () => json({ count: 2, results: [{ id: 9, text_signature: "stakeTokens(uint256)", hex_signature: "0xdeadbeef" }, { id: 3, text_signature: "depositFor(uint256)", hex_signature: "0xdeadbeef" }] })),
      (url, _i, body) => (body?.method === "eth_call" ? json({ jsonrpc: "2.0", id: 1, result: body.params[0].data === "0x313ce567" ? `0x${"6".padStart(64, "0")}` : `0x${Buffer.from("USDC").toString("hex").padEnd(64, "0")}` }) : undefined),
    );
    const u = await fresh();
    const r = (await say(u, `explain tx 0x${"cd".repeat(32)} on ethereum`)).text;
    expect(r).toBe([
      "On Ethereum, it failed, so nothing moved apart from the fee.",
      "0x1111…1111 made a deposit at 0x2222…2222, sending 0.1 ETH with it. Function: `depositFor(uint256)`.",
      "Fee: 0.000021 ETH.",
      `https://etherscan.io/tx/0x${"cd".repeat(32)}`,
    ].join("\n"));
    expect(calls.some((c) => c.url.includes("hex_signature=0xdeadbeef"))).toBe(true);
    const a = (await say(u, `explain tx 0x${"ef".repeat(32)}`)).text;
    expect(a).toContain("0x1111…1111 gave 0x3333…3333 permission to spend an unlimited amount of USDC.");
    expect(a).toContain("revoke.cash");
  });

  it("summarises a Solana transaction's transfers", async () => {
    const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
    const A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const calls = mockFetch(rpcOn(/solana\.com/, "getTransaction", () => ({
      slot: 1, blockTime: 1,
      meta: { err: null, fee: 5000, preBalances: [2e9, 0], postBalances: [2e9 - 5000, 0], preTokenBalances: [{ accountIndex: 1, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: A, uiTokenAmount: { uiAmountString: "200" } }, { accountIndex: 2, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: B, uiTokenAmount: { uiAmountString: "0" } }], postTokenBalances: [{ accountIndex: 1, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: A, uiTokenAmount: { uiAmountString: "50" } }, { accountIndex: 2, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", owner: B, uiTokenAmount: { uiAmountString: "150" } }] },
      transaction: { message: { accountKeys: [{ pubkey: A, signer: true, writable: true }, { pubkey: "Tok1111111111111111111111111111111111111111", signer: false }] } },
    })));
    const u = await fresh();
    expect((await say(u, `explain ${SIG}`)).text).toBe([
      "On Solana, it worked. Signed by 7xKXtg…gAsU.",
      "Tokens: 7xKXtg…gAsU sent 150 USDC; 9WzDXw…AWWM received 150 USDC.",
      "Fee: 0.000005 SOL.",
      `https://solscan.io/tx/${SIG}`,
    ].join("\n"));
    expect(calls[0].body.params).toEqual([SIG, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  });
});

describe("token and approval safety", () => {
  const T = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
  it("lists GoPlus red flags plainly and never calls a token safe", async () => {
    let s: any = { token_symbol: "PEPE2", is_honeypot: "1", is_mintable: "1", buy_tax: "0.15", sell_tax: "0.02", is_open_source: "1", is_in_dex: "1" };
    const calls = mockFetch(on(/^https:\/\/api\.gopluslabs\.io\/api\/v1\/token_security\/8453\?contract_addresses=0xAbCd/i, () => json({ code: 1, message: "OK", result: { [T.toLowerCase()]: s } })));
    const u = await fresh();
    expect((await say(u, `is this token safe ${T} on base`)).text).toBe([
      "GoPlus found 3 red flags on PEPE2 on Base:",
      "- it looks like a honeypot: you may be able to buy but not sell",
      "- the owner can mint more",
      "- buy tax is 15%",
      "I'd stay away unless you know exactly why these are there.",
    ].join("\n"));
    expect(calls[0].url).toBe(`https://api.gopluslabs.io/api/v1/token_security/8453?contract_addresses=${T}`);
    s = { token_symbol: "GOOD", is_open_source: "1", is_in_dex: "1", holder_count: "12000", buy_tax: "0", sell_tax: "0" };
    const clean = (await say(u, `check token ${T} on base`)).text;
    expect(clean).toBe("No red flags found by GoPlus for GOOD on Base. It has about 12,000 holders. That isn't a guarantee: scanners miss things, so only put in what you could lose.");
    expect(clean).not.toMatch(/\bsafe\b/i);
  });

  it("asks which chain for an EVM address, and reads Solana flags", async () => {
    mockFetch(
      on(/token_security\/56\?/, () => json({ code: 1, result: { [T.toLowerCase()]: { token_symbol: "X", is_open_source: "0" } } })),
      on(/\/api\/v1\/solana\/token_security\?contract_addresses=DezX/, () => json({ code: 1, result: { DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { metadata: { symbol: "BONK" }, mintable: { status: "0" }, freezable: { status: "1" } } } })),
    );
    const u = await fresh();
    expect((await say(u, `check token ${T}`)).text).toBe("Which chain is it on? Ethereum, Base, BNB Chain, Arbitrum, Optimism, Polygon or Solana.");
    expect((await say(u, "bnb chain")).text).toBe("GoPlus found a red flag on X on BNB Chain:\n- its code isn't verified\nI'd stay away unless you know exactly why these are there.");
    expect((await say(u, "is DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 a rug")).text).toContain("- someone can freeze your tokens");
    expect(tokenFlags({ is_honeypot: "0", is_open_source: "1", is_in_dex: "1" }, false)).toEqual([]);
  });

  it("lists risky approvals and links to revoke.cash to revoke them yourself", async () => {
    const W = "0x1234567890abcdef1234567890abcdef12345678";
    const calls = mockFetch(on(/^https:\/\/api\.gopluslabs\.io\/api\/v2\/token_approval_security\/42161\?addresses=0x1234/, () => json({ code: 1, message: "OK", result: [
      { token_address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", token_symbol: "USDC", approved_list: [
        { approved_contract: "0x000000000022d473030f116ddee9f6b43ac78ba3", approved_amount: "Unlimited", address_info: { contract_name: "Permit2", is_contract: 1, is_open_source: 1, malicious_behavior: [], doubt_list: 0 } },
        { approved_contract: "0x9999999999999999999999999999999999999999", approved_amount: "25", address_info: { is_contract: 1, is_open_source: 0, malicious_behavior: ["phishing_activities"], doubt_list: 1 } },
      ] },
      { token_address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", token_symbol: "USDT", approved_list: [{ approved_contract: "0x8888888888888888888888888888888888888888", approved_amount: "10", address_info: { contract_name: "Router", is_open_source: 1, malicious_behavior: [] } }] },
    ] })));
    const u = await fresh();
    expect((await say(u, `check approvals ${W} on arbitrum`)).text).toBe([
      "2 of 3 approvals on Arbitrum are worth a look:",
      "- USDC to 0x9999…9999: flagged as risky, unverified contract",
      "- USDC to Permit2: unlimited",
      `Revoke the ones you don't use at https://revoke.cash/address/${W}?chainId=42161 (connect that wallet there; I can't do it for you).`,
    ].join("\n"));
    expect(calls[0].url).toBe(`https://api.gopluslabs.io/api/v2/token_approval_security/42161?addresses=${W}`);
  });
});

describe("claims and unlocks", () => {
  it("reminds 7 days before, the day before and on the day, in the person's zone", async () => {
    mockFetch();
    const u = await fresh("Rin", "Asia/Tokyo");
    const r = await say(u, "claim window for Jupiter closes 15 Dec", T0);
    expect(r.text).toBe("Claim window for Jupiter closes Tue 15 Dec. I'll remind you 7 days before, the day before and on the day.");
    expect((await say(u, "token unlock for Arbitrum on 1 Feb", T0)).text).toBe("Token unlock for Arbitrum is on Mon 1 Feb. I'll remind you 7 days before, the day before and on the day.");
    expect((await say(u, "my claims", T0)).text).toBe("Coming up:\n- Claim: Jupiter, 15 Dec\n- Unlock: Arbitrum, 1 Feb\nSay \"stop watching\" and a name to end any of them.");
    await tick("tech_hourly", new Date("2026-12-07T23:37:00Z")); // 08:37 in Tokyo: too early
    expect(mine(u)).toHaveLength(0);
    await tick("tech_hourly", new Date("2026-12-08T00:37:00Z")); // 09:37 in Tokyo
    await tick("tech_hourly", new Date("2026-12-08T01:37:00Z"));
    expect(mine(u).map((s) => s.text)).toEqual(["Claim window for Jupiter closes Tue 15 Dec, in 7 days."]);
    expect((await briefExtras(db, u, new Date("2026-12-10T00:00:00Z")))[0]).toBe("Coming up: Jupiter closes in 5 days.");
    await tick("tech_hourly", new Date("2026-12-14T00:37:00Z"));
    await tick("tech_hourly", new Date("2026-12-15T00:37:00Z"));
    expect(mine(u).slice(1).map((s) => s.text)).toEqual(["Claim window for Jupiter closes tomorrow, Tue 15 Dec.", "Claim window for Jupiter closes today."]);
    expect(mine(u)[2].buttons?.[0].label).toBe("Done");
    expect((await say(u, "claimed Jupiter", new Date("2026-12-15T02:00:00Z"))).text).toBe("Nice. Jupiter is done, no more reminders.");
  });

  it("a date that's close skips the reminders already past", async () => {
    mockFetch();
    const u = await fresh();
    expect((await say(u, "ZRO unlock on 31 Oct", T0)).text).toBe("Token unlock for ZRO is on Sat 31 Oct. That's soon, so I'll remind you the day before and on the day.");
    await tick("tech_hourly", new Date("2026-10-30T09:37:00Z"));
    expect(mine(u).map((s) => s.text)).toEqual(["Token unlock for ZRO is tomorrow, Sat 31 Oct."]);
  });
});

describe("perps funding", () => {
  let funding = 0.00002;
  const hl: Route = (url, init, body) => (url === "https://api.hyperliquid.xyz/info" && init?.method === "POST" && body?.type === "metaAndAssetCtxs"
    ? json([{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "ETH", szDecimals: 4, maxLeverage: 25 }] }, [{ funding: String(funding), markPx: "100000.0", prevDayPx: "99000", openInterest: "1000" }, { funding: "0.0000125", markPx: "3950.5", prevDayPx: "3900", openInterest: "5000" }]])
    : undefined);
  it("reads funding from Hyperliquid with Binance as a second opinion", async () => {
    const calls = mockFetch(hl, on(/^https:\/\/fapi\.binance\.com\/fapi\/v1\/premiumIndex\?symbol=ETHUSDT$/, () => json({ symbol: "ETHUSDT", markPrice: "3951", lastFundingRate: "0.00010000", nextFundingTime: 1793260800000 })));
    const u = await fresh();
    expect((await say(u, "funding on ETH")).text).toBe("ETH funding on Hyperliquid is 0.0013% an hour (0.01% per 8 hours, about 11.0% a year); longs pay shorts. Mark $3,951.\nBinance: 0.01% per funding period, next 08:00 UTC.");
    expect(calls[0].body).toEqual({ type: "metaAndAssetCtxs" });
  });
  it("alerts when funding crosses your level, re-arms only after it comes back, at most every 12 hours", async () => {
    mockFetch(hl);
    const u = await fresh();
    funding = 0.00002;
    expect((await say(u, "alert me when BTC funding goes above 0.05%")).text).toMatch(/^I'll tell you when BTC funding goes above 0\.05% per 8 hours \(0\.0063% an hour on Hyperliquid\)\. It's 0\.016% per 8 hours now\./);
    funding = 0.0001;
    await tick("tech_perps", at(T0, M(3)));
    await tick("tech_perps", at(T0, M(13)));
    expect(mine(u).map((s) => s.text)).toEqual(["BTC funding is 0.08% per 8 hours on Hyperliquid, above your 0.05%. Longs are paying shorts."]);
    funding = 0.00002;
    await tick("tech_perps", at(T0, M(23))); // came back: re-armed
    funding = 0.0001;
    await tick("tech_perps", at(T0, M(33)));
    expect(mine(u)).toHaveLength(1); // within 12 hours
    await tick("tech_perps", at(T0, H(13))); // 12 hours on, but 23:00 is quiet hours: held
    expect(mine(u)).toHaveLength(1);
    await tick("tech_flush", new Date("2026-10-30T07:05:00Z"));
    expect(mine(u)).toHaveLength(2);
    funding = 0.00002;
  });
  it("alerts on a perp price move from where you set it", async () => {
    mockFetch(hl);
    const u = await fresh();
    expect((await say(u, "alert me if the ETH perp moves 5%")).text).toMatch(/^I'll tell you when the ETH perp moves 5% from \$3,951/);
    await db.query(`UPDATE tech_perp_alerts SET ref=3700 WHERE user_id=$1`, [u.id]);
    await tick("tech_perps", at(T0, M(3)));
    expect(mine(u).map((s) => s.text)).toEqual(["The ETH perp is up 6.8% to $3,951 (from $3,700)."]);
  });
});

describe("Polymarket", () => {
  let price = "0.34";
  const market = () => ({ id: "703257", slug: "will-x-happen", question: "Will X happen by 2027?", outcomes: '["Yes", "No"]', outcomePrices: JSON.stringify([price, String(1 - Number(price))]), active: true, closed: false, volume: "120000" });
  it("finds a market by search, then alerts when it moves your points, merged", async () => {
    const calls = mockFetch(
      on(/^https:\/\/gamma-api\.polymarket\.com\/public-search\?q=Will%20X%20happen$/, () => json({ events: [{ title: "X", markets: [{ ...market(), id: "1", question: "Will Y happen?", closed: true }, market()] }], pagination: { hasMore: false, totalResults: 2 } })),
      on(/^https:\/\/gamma-api\.polymarket\.com\/markets\/703257$/, () => json(market())),
    );
    const u = await fresh();
    expect((await say(u, "watch the market 'Will X happen'")).text).toBe(`Watching "Will X happen by 2027?" on Polymarket, Yes at 34% now. I'll tell you if it moves 10 points, and when it resolves. Say "alert me if it moves 5 points" to change that.`);
    expect(calls[0].url).toBe("https://gamma-api.polymarket.com/public-search?q=Will%20X%20happen");
    expect((await say(u, "alert me if it moves 15 points")).text).toBe(`I'll tell you if "Will X happen by 2027?" moves 15 points from 34%.`);
    price = "0.45";
    await tick("tech_markets", at(T0, M(8)));
    expect(mine(u)).toHaveLength(0);
    price = "0.50";
    await tick("tech_markets", at(T0, M(23)));
    expect(mine(u).map((s) => s.text)).toEqual([`"Will X happen by 2027?" moved up 16 points: Yes is 50%, from 34%.\nhttps://polymarket.com/market/will-x-happen`]);
    expect(yesPriceForTest({ outcomes: '["No","Yes"]', outcomePrices: '["0.7","0.3"]' })).toBe(0.3);
  });
});

describe("names", () => {
  it("resolves .eth and .sol names and reverse lookups", async () => {
    const V = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    mockFetch(
      on(/^https:\/\/ensdata\.net\/vitalik\.eth$/, () => json({ address: V, ens: "vitalik.eth", ens_primary: "vitalik.eth" })),
      on(/^https:\/\/ensdata\.net\/0xd8dA/i, () => json({ address: V, ens: "vitalik.eth", ens_primary: "vitalik.eth" })),
      on(/^https:\/\/sns-sdk-proxy\.bonfida\.workers\.dev\/resolve\/toly$/, () => json({ s: "ok", result: "HKKp49qGWXd639QsuH7JiLijfVW5UtCVY4s1n2HANwEA" })),
      on(/^https:\/\/sns-sdk-proxy\.bonfida\.workers\.dev\/favorite-domain\/HKKp/, () => json({ s: "ok", result: { domain: "Crf8hzfthWGbGbLTVCiqRqV5MVnbpHB1L9KQMd6gsinb", reverse: "toly", stale: false } })),
    );
    const u = await fresh();
    expect((await say(u, "who is vitalik.eth")).text).toBe(`The address for vitalik.eth is \`${V}\`.`);
    expect((await say(u, `who is ${V}`)).text).toBe(`\`${V}\` is vitalik.eth.`);
    expect((await say(u, "resolve toly.sol")).text).toBe("The owner of toly.sol is `HKKp49qGWXd639QsuH7JiLijfVW5UtCVY4s1n2HANwEA`.");
    expect((await say(u, "who is HKKp49qGWXd639QsuH7JiLijfVW5UtCVY4s1n2HANwEA")).text).toBe("`HKKp49…NwEA` is toly.sol.");
  });
});

/* ===================================================================== */

describe("one list, one off switch, one message", () => {
  it("lists everything and stops by name or kind, with undo", async () => {
    mockFetch(
      on(/^https:\/\/mysite\.com\/$/, () => new Response(null, { status: 200 })),
      on(/registry\.npmjs\.org\/react\/latest/, () => json({ version: "19.3.1" })),
      (url, _i, body) => (body?.method === "eth_gasPrice" ? json({ jsonrpc: "2.0", id: 1, result: "0x2540be400" }) : undefined),
    );
    const u = await fresh();
    await say(u, "watch https://mysite.com");
    await say(u, "watch npm react");
    await say(u, "tell me when ETH gas is under 5 gwei");
    expect((await say(u, "my watches")).text).toBe([
      "On watch:",
      "- mysite.com: up",
      "- Packages: react (npm, 19.3.1)",
      "- Ethereum gas under 5 gwei",
      "Say \"stop watching\" and a name to end any of them.",
    ].join("\n"));
    const s = await say(u, "stop watching mysite.com");
    expect(s.text).toBe("Stopped watching mysite.com.");
    expect((await say(u, "undo")).text).toBe("Back on watch.");
    expect((await db.one(`SELECT active FROM tech_monitors WHERE user_id=$1`, [u.id])).active).toBe(true);
    expect((await say(u, "stop gas alerts")).text).toBe("Stopped watching Ethereum gas.");
    expect((await say(u, "stop watching nothing-like-this")).text).toBe(`I'm not watching anything matching "nothing-like-this". Say "my watches" to see the list.`);
  });

  it("merges different features into one message, holds them in calm mode, and spills to the brief", async () => {
    let up = true;
    mockFetch(on(/^https:\/\/calm\.example\.com\/$/, () => { if (!up) throw new TypeError("fetch failed"); return new Response(null, { status: 200 }); }), (url, _i, body) => (body?.method === "eth_gasPrice" ? json({ jsonrpc: "2.0", id: 1, result: up ? "0x2540be400" : "0x3b9aca00" }) : undefined));
    const u = await fresh();
    await say(u, "watch calm.example.com");
    await say(u, "tell me when ETH gas is under 5 gwei");
    await db.query(`UPDATE users SET prefs = prefs || '{"calm":true}'::jsonb WHERE id=$1`, [u.id]);
    up = false;
    await tick("tech_uptime", at(T0, M(2)));
    await tick("tech_uptime", at(T0, M(7)));
    await tick("tech_gas", at(T0, M(8)));
    expect(mine(u)).toHaveLength(0); // calm mode holds even the urgent ones
    expect(await briefExtras(db, u, at(T0, M(30)))).toEqual(["Work: calm.example.com looks down: the connection failed, twice in a row. I'll tell you when it's back.", "Crypto: Ethereum gas is down to 1.0 gwei, under your 5. That alert is done; set another any time."]);
    await db.query(`UPDATE users SET prefs = prefs || '{"calm":false}'::jsonb WHERE id=$1`, [u.id]);
    await tick("tech_flush", at(T0, M(35)));
    expect(mine(u)).toHaveLength(0); // already in the brief: not sent twice
    // Out of calm mode, things from different features that pile up overnight arrive as one message.
    up = true;
    await tick("tech_uptime", at(T0, M(40)));
    expect(mine(u).map((s) => s.text)).toEqual(["calm.example.com is back up after 38 minutes down."]);
    await say(u, "tell me when ETH gas is under 5 gwei", at(T0, M(41)));
    up = false;
    const night = new Date("2026-10-29T23:00:00Z");
    await tick("tech_uptime", night);
    await tick("tech_uptime", at(night, M(5)));
    await tick("tech_gas", at(night, M(6)));
    expect(mine(u)).toHaveLength(1);
    await tick("tech_flush", new Date("2026-10-30T07:05:00Z"));
    expect(mine(u)).toHaveLength(2);
    // Its second fall today: still said, with a note that it's flapping and further changes wait for the brief.
    expect(mine(u)[1].text).toBe("From your watches:\n- calm.example.com looks down: the connection failed, twice in a row. It keeps going up and down today, so any more changes go in your morning note.\n- Ethereum gas is down to 1.0 gwei, under your 5. That alert is done; set another any time.");
  });

  it("keeps daily alerts to one ping per feature per day; the rest wait for the brief", async () => {
    Object.assign(config, { githubToken: "" });
    let tag = 1;
    mockFetch(
      on(/\/repos\/a\/b$/, () => json({ full_name: "a/b" })),
      on(/\/repos\/a\/b\/releases/, () => json([{ id: tag, tag_name: `v${tag}.0.0`, name: `v${tag}.0.0`, html_url: `https://github.com/a/b/releases/${tag}`, draft: false }])),
    );
    const u = await fresh();
    await say(u, "watch releases of a/b");
    tag = 2;
    await tick("tech_github", at(T0, H(2)));
    tag = 3;
    await tick("tech_github", at(T0, H(4)));
    expect(mine(u).map((s) => s.text)).toEqual(["a/b released v2.0.0.\nhttps://github.com/a/b/releases/2"]);
    expect(await briefExtras(db, u, at(T0, H(5)), 6, { peek: true })).toEqual(["Work: a/b released v3.0.0."]);
    expect(await briefExtras(db, u, at(T0, H(18)))).toEqual(["Work: a/b released v3.0.0."]); // a peek isn't a showing, so the 12 hours start now
    expect(await briefExtras(db, u, at(T0, H(31)))).toEqual([]);
  });
});
