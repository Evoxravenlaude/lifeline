/** Creative and NFTs, end to end: words in, records kept, floors and mints read through mocked APIs, reminders through the scheduler. No network. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { ensureUser, getUserById, handleCallback, handleMessage } from "../src/core/handler.js";
import { runDue, schedule, type SchedulerDeps } from "../src/core/scheduler.js";
import { briefExtras } from "../src/core/plugins.js";
import { creativeSweep } from "../src/modules/features/creative/shared.js";
import { parseMint, slugGuesses } from "../src/modules/features/creative/nft.js";
import { ckeyOf } from "../src/modules/features/creative/chains.js";
import { parseQuote } from "../src/modules/features/creative/work.js";
import { minutesOf } from "../src/modules/features/creative/release.js";
import { SPARKS } from "../src/modules/features/creative/ideas.js";
import type { User } from "../src/policy/types.js";

let db: Db;
const saved = { ...config };
const savedEnv = { ...process.env };
const T0 = new Date("2026-10-29T10:00:00Z"); // a Thursday
const noKeys = { anthropicKey: "", geminiKey: "", openaiCompatKey: "", openaiKey: "" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type Route = (url: string, init: RequestInit | undefined, body: any) => Response | Promise<Response> | undefined | null;
/** Answers by URL (and JSON-RPC method) and records every call. An unexpected call fails the test. */
function mockFetch(...routes: Route[]) {
  const calls: { url: string; init?: RequestInit; body: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input?.url ?? input);
    let body: any;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = init?.body; }
    calls.push({ url, init, body });
    for (const r of routes) { const res = await r(url, init, body); if (res) return res; }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return calls;
}
const on = (re: RegExp, fn: (url: string, init?: RequestInit) => Response): Route => (url, init) => (re.test(url) ? fn(url, init) : undefined);
const header = (init: RequestInit | undefined, k: string) => (init?.headers as Record<string, string> | undefined)?.[k];

const sent: { userId: number; text: string; buttons?: { label: string; data: string }[] }[] = [];
let deps: SchedulerDeps;
let n = 77_000;
async function person(tz = "Africa/Lagos", prefs: Record<string, unknown> = {}, name = "Ada Obi"): Promise<User> {
  const u = await ensureUser(db, "telegram", String(n++), name);
  await db.query(`UPDATE users SET tz=$2, quiet_start=0, quiet_end=0, prefs = prefs || $3::jsonb WHERE id=$1`, [u.id, tz, JSON.stringify(prefs)]);
  await db.query(`UPDATE jobs SET active=false WHERE user_id=$1`, [u.id]);
  return (await getUserById(db, u.id))!;
}
const fresh = async (u: User) => (await getUserById(db, u.id))!;
const say = async (u: User, text: string, now = new Date()) => handleMessage(db, await fresh(u), text, { channel: "telegram", now });
const press = async (u: User, data: string, now = new Date()) => handleCallback(db, await fresh(u), data, now);
const mine = (u: User) => sent.filter((s) => s.userId === u.id);
async function runJobs(at: Date) {
  vi.setSystemTime(at);
  await runDue(deps, at);
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  db = await openTestDb();
  deps = { db, getUser: (id) => getUserById(db, id), send: async (u, r) => { sent.push({ userId: u.id, text: r.text, buttons: r.buttons }); return true; } };
});
afterAll(async () => { vi.useRealTimers(); await db.close(); });
beforeEach(async () => {
  vi.setSystemTime(T0);
  Object.assign(config, noKeys);
  delete process.env.OPENSEA_API_KEY; delete process.env.ETHERSCAN_API_KEY; delete process.env.MAGICEDEN_API_KEY;
  await db.query(`UPDATE jobs SET active=false`);
  await db.query(`DELETE FROM wallets`);
  await db.query(`DELETE FROM crt_cache`);
  mockFetch();
});
afterEach(() => { Object.assign(config, saved); process.env = { ...savedEnv }; vi.unstubAllGlobals(); });

/* ===================================================================== */

describe("reading mint sentences", () => {
  it("pulls out quantity, price each or total, token, chain, wallet, ids and tx", () => {
    expect(parseMint("2 Pudgy Penguins at 0.05 ETH")).toEqual({ collection: "Pudgy Penguins", quantity: 2, price: 0.05, token: "ETH" });
    expect(parseMint("Chromie Squiggle #1234 on ethereum for 0.1")).toEqual({ collection: "Chromie Squiggle", token_ids: ["1234"], total: 0.1, chain: "ethereum" });
    expect(parseMint("3 Mad Lads on solana at 2 SOL with wallet 2")).toMatchObject({ collection: "Mad Lads", quantity: 3, price: 2, token: "SOL", chain: "solana", wallet: "wallet 2" });
    const tx = `0x${"ab".repeat(32)}`;
    expect(parseMint(`a Zorb on zora for 0.000777 eth tx ${tx}`)).toMatchObject({ collection: "Zorb", quantity: 1, total: 0.000777, chain: "zora", tx });
    expect(ckeyOf("Pudgy Penguins")).toBe(ckeyOf("pudgy penguin"));
    expect(slugGuesses("Pudgy Penguins", false)).toEqual(["pudgypenguins", "pudgy-penguins"]);
    expect(slugGuesses("Mad Lads", true)).toEqual(["mad_lads", "madlads"]);
  });
});

describe("the mint log", () => {
  it("logs mints in plain words and says what it kept", async () => {
    const u = await person();
    const r = await say(u, "minted 2 Pudgy Penguins at 0.05 ETH");
    expect(r.text).toBe(`2 Pudgy Penguins on Ethereum, 0.05 ETH each. It's in your mints. Say "sold 1 Pudgy Penguin for 0.2 ETH" when you sell, or "my mints" to see them all.`);
    expect(r.buttons?.some((b) => /^undo:/.test(b.data))).toBe(true);
    expect((await say(u, "minted Chromie Squiggle #1234 on ethereum for 0.1")).text).toMatch(/^Chromie Squiggle #1234 on Ethereum, 0\.1 ETH\./);
    expect((await say(u, "free mint of Base Day on base")).text).toMatch(/^Base Day on Base, a free mint\./);
    expect((await say(u, "minted 3 Mad Lads on solana at 2 SOL")).text).toMatch(/^3 Mad Lads on Solana, 2 SOL each\./);
    const rows = await db.query<any>(`SELECT collection, qty, price::float AS price, token, chain, token_ids FROM crt_mints WHERE user_id=$1 ORDER BY id`, [u.id]);
    expect(rows).toEqual([
      { collection: "Pudgy Penguins", qty: 2, price: 0.05, token: "ETH", chain: "ethereum", token_ids: null },
      { collection: "Chromie Squiggle", qty: 1, price: 0.1, token: "ETH", chain: "ethereum", token_ids: "1234" },
      { collection: "Base Day", qty: 1, price: 0, token: "ETH", chain: "base", token_ids: null },
      { collection: "Mad Lads", qty: 3, price: 2, token: "SOL", chain: "solana", token_ids: null },
    ]);
  });

  it("marks sales, listings and transfers, with undo", async () => {
    const u = await person();
    await say(u, "minted 2 Pudgy Penguins at 0.05 ETH");
    await say(u, "minted 3 Mad Lads on solana at 2 SOL");
    expect((await say(u, "listed 2 Pudgy Penguins at 0.5")).text).toMatch(/^2 Pudgy Penguins listed at 0\.5 ETH each\. I only keep the note/);
    const sold = await say(u, "sold 1 Pudgy Penguin for 0.2 ETH");
    expect(sold.text).toBe("Sold 1 Pudgy Penguin for 0.2 ETH. That's about 0.15 ETH over what you paid, before fees. You still hold 1.");
    let row = (await db.one<any>(`SELECT sold, listed, proceeds::float AS p FROM crt_mints WHERE user_id=$1 AND chain='ethereum'`, [u.id]))!;
    expect(row).toEqual({ sold: 1, listed: 1, p: 0.2 });
    const undo = sold.buttons!.find((b) => /^undo:/.test(b.data))!.data;
    expect((await press(u, undo)).text).toMatch(/Back how it was/);
    row = (await db.one<any>(`SELECT sold, listed, proceeds::float AS p FROM crt_mints WHERE user_id=$1 AND chain='ethereum'`, [u.id]))!;
    expect(row).toEqual({ sold: 0, listed: 2, p: 0 });
    expect((await say(u, "sold 2 Mad Lads at 45 SOL each")).text).toMatch(/^Sold 2 Mad Lads for 90 SOL\. That's about 86 SOL over what you paid/);
    expect((await say(u, "transferred 1 Pudgy Penguin to my vault")).text).toMatch(/^1 Pudgy Penguin moved to vault\. I count it as gone from this log, not sold\. You still hold 1\./);
    expect((await say(u, "sold 1 Bored Ape for 10 ETH")).text).toMatch(/^I don't have Bored Ape in your mints/);
  });

  it("shows mints by chain with floors from OpenSea and Magic Eden, cached for an hour", async () => {
    process.env.OPENSEA_API_KEY = "os-key";
    const u = await person();
    await say(u, "minted 2 Pudgy Penguins at 0.05 ETH");
    await say(u, "minted Chromie Squiggle #1234 on ethereum for 0.1");
    await say(u, "minted 3 Mad Lads on solana at 2 SOL");
    const calls = mockFetch(
      on(/api\.opensea\.io\/api\/v2\/collections\/pudgypenguins\/stats$/, () => json({ total: { volume: 1, sales: 2, num_owners: 3, floor_price: 9.8, floor_price_symbol: "ETH" }, intervals: [] })),
      on(/api\.opensea\.io\/api\/v2\/collections\/(?:chromiesquiggle|chromie-squiggle)\/stats$/, () => json({ errors: ["not found"] }, 404)),
      on(/api-mainnet\.magiceden\.dev\/v2\/collections\/mad_lads\/stats$/, () => json({ symbol: "mad_lads", floorPrice: 40_500_000_000, listedCount: 100, volumeAll: 1 })),
    );
    const r = await say(u, "my mints");
    expect(r.text).toContain("3 collections, 6 pieces still held.");
    expect(r.text).toContain("**Ethereum**\n- Pudgy Penguins: 2 held, cost 0.05 ETH each, floor 9.8 ETH, +19.5 ETH on paper");
    expect(r.text).toContain("- Chromie Squiggle #1234: 1 held, cost 0.1 ETH");
    expect(r.text).toContain("**Solana**\n- Mad Lads: 3 held, cost 2 SOL each, floor 40.5 SOL, +115.5 SOL on paper");
    expect(r.text).toContain(`I couldn't find a floor for Chromie Squiggle. Send its OpenSea or Magic Eden link`);
    expect(calls.find((c) => /pudgypenguins/.test(c.url))!.init?.headers).toMatchObject({ "x-api-key": "os-key" });
    expect(calls.map((c) => c.url).filter((x) => /chromie/.test(x))).toEqual([
      "https://api.opensea.io/api/v2/collections/chromiesquiggle/stats", "https://api.opensea.io/api/v2/collections/chromie-squiggle/stats",
    ]);

    // Within the hour: no new calls, and the slug question is asked only once.
    const before = calls.length;
    const again = await say(u, "my mints", new Date(T0.getTime() + 30 * 60_000));
    expect(calls.length).toBe(before);
    expect(again.text).not.toContain("I couldn't find a floor");

    // Told the slug: remembered, and its floor read from there.
    mockFetch(on(/collections\/chromie-squiggle-by-snowfro\/stats$/, () => json({ total: { floor_price: 0.4, floor_price_symbol: "WETH" } })), on(/opensea|magiceden/, () => json({}, 500)));
    expect((await say(u, "Chromie Squiggle is https://opensea.io/collection/chromie-squiggle-by-snowfro")).text).toBe("Chromie Squiggle is `chromie-squiggle-by-snowfro` on OpenSea. I'll read its floor from there.");
    const third = await say(u, "my mints", new Date(T0.getTime() + 40 * 60_000));
    expect(third.text).toContain("- Chromie Squiggle #1234: 1 held, cost 0.1 ETH, floor 0.4 ETH, +0.3 ETH on paper");
  });

  it("says plainly when EVM floors need a key, and totals P&L per token, never in money", async () => {
    const u = await person();
    await say(u, "minted 2 Pudgy Penguins at 0.05 ETH");
    await say(u, "sold 1 Pudgy Penguin for 0.2 ETH");
    await say(u, "minted 3 Mad Lads on solana at 2 SOL");
    mockFetch(on(/magiceden\.dev\/v2\/collections\/mad_lads\/stats$/, () => json({ symbol: "mad_lads", floorPrice: 1_000_000_000 })));
    const list = await say(u, "my mints");
    expect(list.text).toContain("Floors on Ethereum and the other EVM chains need an OpenSea key on this server");
    const p = await say(u, "my nft pnl");
    expect(p.text).toContain("- ETH: spent 0.1, sold for 0.2, 1 held worth about 0.05. Rough P&L +0.15 ETH.");
    expect(p.text).toContain("- SOL: spent 6, 3 held worth about 3. Rough P&L -3 SOL.");
    expect(p.text).toContain("Pieces with no floor are counted at what you paid.");
    expect(p.text).not.toMatch(/₦|\$|USD|NGN/);
  });

  it("starts empty with a way in", async () => {
    const u = await person();
    expect((await say(u, "my mints")).text).toMatch(/^No mints logged yet\. Say "minted 2 Pudgy Penguins at 0\.05 ETH"/);
  });
});

describe("mints spotted on watched wallets", () => {
  const A = "0x1111111111111111111111111111111111111111";
  const C = "0xbd3531da5cf5857e7cfaa92426877b022e612cf8";
  const H = `0x${"cd".repeat(32)}`;
  const ZERO = "0x0000000000000000000000000000000000000000";
  it("sets a baseline, then offers new mints in one line and adds them only after a yes", async () => {
    process.env.ETHERSCAN_API_KEY = "ek";
    const u = await person("Europe/Berlin");
    await db.query(`DELETE FROM crt_scan`);
    await db.query(`INSERT INTO wallets (user_id, chain, address, label) VALUES ($1,'ethereum',$2,'main')`, [u.id, A]);
    let calls = mockFetch(
      on(/action=tokennfttx/, () => json({ status: "1", message: "OK", result: [{ blockNumber: "100", hash: `0x${"ee".repeat(32)}`, from: ZERO, to: A, contractAddress: C, tokenID: "1", tokenName: "Old", tokenSymbol: "OLD" }] })),
      on(/action=token1155tx/, () => json({ status: "0", message: "No transactions found", result: [] })),
    );
    await schedule(db, { kind: "crt_mintscan", runAt: new Date(T0.getTime() - 1000) });
    await runJobs(T0);
    expect(calls.map((c) => c.url)).toEqual([
      `https://api.etherscan.io/v2/api?chainid=1&module=account&action=tokennfttx&address=${A}&startblock=0&endblock=99999999&page=1&offset=100&sort=desc&apikey=ek`,
      `https://api.etherscan.io/v2/api?chainid=1&module=account&action=token1155tx&address=${A}&startblock=0&endblock=99999999&page=1&offset=100&sort=desc&apikey=ek`,
    ]);
    expect(mine(u)).toEqual([]);
    expect((await db.query(`SELECT 1 FROM crt_offers WHERE user_id=$1`, [u.id])).length).toBe(0);

    calls = mockFetch(
      on(/action=tokennfttx/, () => json({ status: "1", message: "OK", result: [
        { blockNumber: "120", hash: H, from: ZERO, to: A, contractAddress: C, tokenID: "7", tokenName: "PudgyPenguins", tokenSymbol: "PPG" },
        { blockNumber: "120", hash: H, from: ZERO, to: A, contractAddress: C, tokenID: "8", tokenName: "PudgyPenguins", tokenSymbol: "PPG" },
        { blockNumber: "121", hash: `0x${"aa".repeat(32)}`, from: A, to: "0x2222222222222222222222222222222222222222", contractAddress: C, tokenID: "9", tokenName: "PudgyPenguins" },
      ] })),
      on(/action=token1155tx/, () => json({ status: "0", message: "No transactions found", result: [] })),
      (url, _i, body) => (body?.method === "eth_getTransactionByHash" ? json({ jsonrpc: "2.0", id: 1, result: { hash: H, value: "0x16345785d8a0000" } }) : undefined),
    );
    const t1 = new Date(T0.getTime() + 30 * 60_000);
    await schedule(db, { kind: "crt_mintscan", runAt: new Date(t1.getTime() - 1000) });
    await runJobs(t1);
    expect(calls[0].url).toContain("startblock=101&endblock=99999999&page=1&offset=100&sort=asc");
    const ping = mine(u).at(-1)!;
    expect(ping.text).toBe(`Looks like you minted 2 from PudgyPenguins on Ethereum. Add to your mints? Say "stop mint detection" to stop these.`);
    expect(ping.buttons!.map((b) => b.label)).toEqual(["Yes, add", "No"]);
    expect(ping.buttons!.every((b) => Buffer.byteLength(b.data) < 64)).toBe(true);
    expect((await db.query(`SELECT 1 FROM crt_mints WHERE user_id=$1`, [u.id])).length).toBe(0);
    expect(await briefExtras(db, await fresh(u), t1, 6, { peek: true })).toContain(`Possible new mints: 2 from PudgyPenguins on Ethereum. Say "add the detected mints" or "ignore the detected mints".`);

    expect((await press(u, ping.buttons![0].data)).text).toBe("Added 2 from PudgyPenguins on Ethereum to your mints.");
    const row = (await db.one<any>(`SELECT qty, price::float AS price, token, chain, wallet, tx, contract FROM crt_mints WHERE user_id=$1`, [u.id]))!;
    expect(row).toEqual({ qty: 2, price: 0.05, token: "ETH", chain: "ethereum", wallet: "main", tx: H, contract: C });
    expect((await press(u, ping.buttons![0].data)).text).toMatch(/^Nothing waiting there any more/);

    // The same mint is never offered twice, and "stop mint detection" ends the scans for this person.
    expect((await say(u, "stop mint detection")).text).toMatch(/^Mint spotting is off\./);
    calls = mockFetch();
    await schedule(db, { kind: "crt_mintscan", runAt: new Date(t1.getTime() + 1000) });
    await runJobs(new Date(t1.getTime() + 2000));
    expect(calls).toEqual([]);
  });

  it("does nothing without an Etherscan key, and words answer offers too", async () => {
    const u = await person();
    await db.query(`INSERT INTO wallets (user_id, chain, address) VALUES ($1,'base',$2)`, [u.id, A]);
    const calls = mockFetch();
    await schedule(db, { kind: "crt_mintscan", runAt: new Date(T0.getTime() - 1000) });
    await runJobs(T0);
    expect(calls).toEqual([]);
    await db.query(`INSERT INTO crt_offers (user_id, chain, address, contract, collection, qty, token, tx) VALUES ($1,'base',$2,$3,'Base Day',1,'ETH',$4)`, [u.id, A, C, H]);
    expect((await say(u, "ignore the detected mints")).text).toBe("Left out. I won't ask about those again.");
    expect((await say(u, "turn on mint detection")).text).toMatch(/this server doesn't have an Etherscan key yet/);
  });
});

describe("mint calendar and allowlists", () => {
  it("keeps a UTC mint in the person's own zone, says both, and reminds an hour and 10 minutes before even in calm mode", async () => {
    const u = await person("Asia/Seoul", { calm: true }, "Ji-woo Park");
    await db.query(`UPDATE users SET quiet_start=22, quiet_end=8 WHERE id=$1`, [u.id]);
    const r = await say(u, "Azuki Elementals mint opens 3 Nov 18:00 UTC, allowlist, 0.08 ETH");
    expect(r.text).toBe(`Azuki Elementals allowlist mint, Wednesday at 03:00 your time (Tue 3 Nov 18:00 UTC), 0.08 ETH. I'll remind you an hour before and 10 minutes before. Say "cancel the Azuki Elementals mint" to drop it.`);
    const jobs = await db.query<{ run_at: string }>(`SELECT run_at FROM jobs WHERE user_id=$1 AND kind='crt_drop' AND active ORDER BY run_at`, [u.id]);
    expect(jobs.map((j) => new Date(j.run_at).toISOString())).toEqual(["2026-11-03T17:00:00.000Z", "2026-11-03T17:50:00.000Z"]);
    expect((await say(u, "I'm on the allowlist for Azuki Elementals with wallet 2")).text).toBe("You're on the allowlist for Azuki Elementals with wallet 2. It opens Wednesday at 03:00 your time (Tue 3 Nov 18:00 UTC), and I'll remind you before.");

    await runJobs(new Date("2026-11-03T17:00:30Z"));
    expect(mine(u).at(-1)!.text).toBe("Azuki Elementals allowlist mint opens in an hour, at 03:00 (18:00 UTC). 0.08 ETH, you're on the allowlist with wallet 2. Use only the project's official link, and never sign anything you don't understand.");
    await runJobs(new Date("2026-11-03T17:50:30Z"));
    expect(mine(u).at(-1)!.text).toMatch(/^Azuki Elementals allowlist mint opens in 10 minutes\./);
    const kinds = await db.query<{ kind: string }>(`SELECT kind FROM pushes WHERE user_id=$1`, [u.id]);
    expect(kinds.every((k) => k.kind === "reminder")).toBe(true);
  });

  it("takes local times, reveals with only a day, lists and cancels with the reminders", async () => {
    const u = await person("Africa/Lagos");
    expect((await say(u, "public mint for Lagos Nights Pass at 5pm my time")).text).toMatch(/^Lagos Nights Pass public mint, today at 17:00\. I'll remind you an hour before and 10 minutes before\./);
    expect((await say(u, "reveal for Lagos Nights Pass on Friday")).text).toBe(`The Lagos Nights Pass reveal, tomorrow. I'll put it in your brief that morning; tell me the time if you want a reminder. Say "cancel the Lagos Nights Pass reveal" to drop it.`);
    expect((await say(u, "Seoul Souls free mint starts tomorrow at 15:00 on base")).text).toMatch(/^Seoul Souls free mint, tomorrow at 15:00, free, on Base\./);
    const list = (await say(u, "my upcoming mints")).text;
    expect(list).toBe([
      "3 things on your mint calendar:",
      "- Today at 17:00: Lagos Nights Pass public mint",
      "- Tomorrow: the Lagos Nights Pass reveal",
      "- Tomorrow at 15:00: Seoul Souls free mint, free, on Base",
    ].join("\n"));
    // The morning of: one brief line, and the person's time.
    const brief = await briefExtras(db, await fresh(u), new Date("2026-10-29T07:00:00Z"), 6, { peek: true });
    expect(brief[0]).toBe("Lagos Nights Pass public mint today at 17:00.");
    const c = await say(u, "cancel the Seoul Souls mint");
    expect(c.text).toBe("Seoul Souls free mint, off your calendar, with its reminders.");
    expect((await db.query(`SELECT 1 FROM jobs WHERE user_id=$1 AND kind='crt_drop' AND active`, [u.id])).length).toBe(2);
    expect((await press(u, c.buttons!.find((b) => /^undo:/.test(b.data))!.data)).text).toBe("Back on your calendar.");
    expect((await db.query(`SELECT 1 FROM jobs WHERE user_id=$1 AND kind='crt_drop' AND active`, [u.id])).length).toBe(4);
  });

  it("asks when a mint has no time, and a later time joins the allowlist note", async () => {
    const u = await person("Europe/Berlin");
    expect((await say(u, "got WL for Berlin Blocks")).text).toMatch(/^You're on the allowlist for Berlin Blocks\. When does it open\?/);
    expect((await say(u, "Berlin Blocks mint opens 5 Nov at 19:00")).text).toMatch(/^Berlin Blocks allowlist mint, Thu 5 Nov at 19:00, you're on the allowlist\./);
    expect((await db.query(`SELECT 1 FROM crt_drops WHERE user_id=$1`, [u.id])).length).toBe(1);
  });
});

describe("read only and safe", () => {
  it("refuses a seed phrase and keeps nothing", async () => {
    const u = await person();
    const r = await say(u, "my seed phrase is apple river stone cloud house tiger lemon paper glass night ocean bread");
    expect(r.text).toMatch(/^Please don't send that\. A seed phrase or private key is the whole wallet/);
    expect((await db.query(`SELECT 1 FROM crt_mints WHERE user_id=$1`, [u.id])).length).toBe(0);
    expect((await say(u, "minted 2 Zorbs with wallet apple river stone cloud house tiger lemon paper glass night ocean bread")).text).toMatch(/haven't kept it/);
  });

  it("checks a mint link through the safety area's scam check and adds mint advice", async () => {
    const u = await person();
    const r = await say(u, "check this mint link https://azuki-elementals-claim.xyz/mint");
    expect(r.text).toMatch(/^No red flags found\./); // the safety area's own scam check ran
    expect(r.text).toMatch(/never sign a "setApprovalForAll"/);
    expect(r.text).toMatch(/I can't mint or sign for you/);
    expect(r.text.length).toBeGreaterThan(200);
  });
});

describe("commissions", () => {
  it("keeps the deal, revisions, delivery and payment, and drafts a balance note to send yourself", async () => {
    const u = await person("Africa/Lagos");
    const r = await say(u, "commission: portrait for Tolu, 150, due 20 Nov, 50 deposit paid");
    expect(r.text).toBe(`Tolu's portrait: ₦150, ₦50 deposit paid, ₦100 to go, due 20 November. I'll remind you 3 days and 1 day before. Say "revision 2 sent for Tolu's portrait" or "delivered Tolu's portrait" as it goes.`);
    expect((await db.one(`SELECT 1 FROM jobs WHERE user_id=$1 AND kind='crt_daily' AND active`, [u.id]))).toBeTruthy();
    expect((await say(u, "revision 2 sent for Tolu's portrait")).text).toBe("Revision 2 sent for Tolu's portrait.");
    expect((await say(u, "my commissions")).text).toBe("1 open commission, ₦100 still to come:\n- Tolu's portrait: ₦100 of ₦150 to come, due Fri 20 Nov, revision 2");
    expect((await say(u, "delivered Tolu's portrait")).text).toBe(`Tolu's portrait, delivered. ₦100 still to come; say "draft a balance reminder for Tolu" when you want a note to send.`);
    const n = await say(u, "draft a balance reminder for Tolu");
    expect(n.text).toBe("A gentle one to send Tolu yourself:\n\n```\nHi Tolu, I hope you're enjoying the portrait. A gentle reminder that the balance of ₦100 is still open. Could you send it when you get a chance? Thank you so much for the commission.\n```\nAdd how they can pay. I never send these for you.");
    expect((await say(u, "Tolu paid the rest")).text).toBe("Tolu paid the rest. Tolu's portrait is paid in full: ₦150.");
    expect((await say(u, "my commissions")).text).toMatch(/^No open commissions\./);
  });

  it("uses the currency typed, and part payments", async () => {
    const u = await person("Asia/Seoul");
    expect((await say(u, "new commission from Ji-woo: album cover, 300000 KRW, due 5 Dec")).text).toMatch(/^Ji-woo's album cover: ₩300,000, due 5 December\./);
    expect((await say(u, "Ji-woo paid the 100000 KRW deposit")).text).toBe("₩100,000 in for Ji-woo's album cover. ₩200,000 to go.");
  });
});

describe("open calls and submissions", () => {
  it("keeps calls, results without shame, and one merged daily ping with the commission due", async () => {
    const u = await person("Europe/Berlin");
    expect((await say(u, "open call: Lagos Photo Festival closes 5 Nov")).text).toBe(`Lagos Photo Festival, closes 5 November (in 7 days). I'll remind you 7 days and 1 day before. Say "submitted to Lagos Photo Festival" when it's in.`);
    await say(u, "commission: mural for Café Lisboa, €1,200, due 1 Nov, deposit 400");
    const s = await creativeSweep(deps, await fresh(u), T0);
    expect(s).toBe(`A few creative things today:\n- Café Lisboa's mural is due Sunday (in 3 days).\n- Lagos Photo Festival closes 5 November (in 7 days).\n\nSay "stop creative pings" to keep these to your morning brief.`);
    expect(await creativeSweep(deps, await fresh(u), new Date(T0.getTime() + 3_600_000))).toBeNull();
    expect(await creativeSweep(deps, await fresh(u), new Date(T0.getTime() + 86_400_000))).toBeNull();
    expect(await creativeSweep(deps, await fresh(u), new Date(T0.getTime() + 2 * 86_400_000))).toBe(`Café Lisboa's mural is due tomorrow.\n\nSay "stop creative pings" to keep these to your morning brief.`);
    const brief = await briefExtras(db, await fresh(u), T0, 6, { peek: true });
    expect(brief).toContain("Café Lisboa's mural is due Sunday.");

    expect((await say(u, "stop creative pings")).text).toMatch(/^No more creative pings\./);
    await say(u, "open call: Seoul Illustration Prize closes 30 Oct");
    expect(await creativeSweep(deps, await fresh(u), new Date(T0.getTime() + 3 * 86_400_000))).toBeNull();

    expect((await say(u, "submitted to Lagos Photo Festival")).text).toMatch(/^Submitted to Lagos Photo Festival\. That's the hard part done\./);
    expect((await say(u, "rejected by Lagos Photo Festival")).text).toBe(`Logged. Every working artist has a long list of these; it means you're putting work out. Say "find open calls" whenever you want the next one.`);
    expect((await say(u, "accepted into the Gasworks residency")).text).toBe("Accepted into Gasworks residency. Congratulations, that's a real one.");
    const list = (await say(u, "my open calls")).text;
    expect(list).toContain("**Open**\n- Seoul Illustration Prize: closes Fri 30 Oct");
    expect(list).not.toContain("Waiting to hear");
    expect(list).toMatch(/1 submission this year, 1 accepted\. Every one counts\.$/);
  });

  it("never files a personal rejection as an open call", async () => {
    const { parseByRules } = await import("../src/intent/rules.js");
    for (const s of ["my mum rejected me", "he rejected me", "the bank rejected me", "I got rejected by my landlord", "I was rejected by the bank", "I didn't get into university", "I was rejected by the embassy", "my girlfriend turned down me"]) {
      expect(parseByRules(s)?.action, s).not.toBe("opencall.update");
    }
    for (const s of ["rejected by Lagos Photo Festival", "Ars Electronica rejected me", "I didn't get into the Gasworks residency"]) expect(parseByRules(s)?.action, s).toBe("opencall.update");
    const u = await person();
    await say(u, "my mum rejected me");
    expect(await db.query(`SELECT 1 FROM crt_calls WHERE user_id=$1`, [u.id])).toHaveLength(0);
  });

  it("finds open calls only with real links, and says so when search isn't set up", async () => {
    const u = await person();
    expect((await say(u, "find open calls for illustrators this month")).text).toMatch(/^Web search isn't set up on this server, so I can't look right now\. Places worth checking yourself: CaFE/);
    Object.assign(config, { openaiCompatKey: "gk", openaiCompatBaseUrl: "https://api.groq.com/openai/v1" });
    const calls = mockFetch(on(/api\.groq\.com\/openai\/v1\/chat\/completions$/, () => json({ choices: [{ message: { content: "- Lagos Illustration Award, closes 30 Nov, apply at https://made-up-award.example/apply" } }] })));
    const r = await say(u, "find open calls for illustrators this month");
    expect(calls).toHaveLength(1);
    expect(calls[0].body.messages[1].content).toMatch(/^Current open calls for artists for illustrators this month:/);
    expect(r.text).not.toContain("made-up-award.example");
    expect(r.text).toContain("I couldn't get source links for these, so find each one on the organiser's own site before you apply.");
  });
});

describe("release planner", () => {
  it("plans a single backwards from its date, ticks steps, and puts due steps in the brief with a Done button", async () => {
    const u = await person("America/Sao_Paulo");
    const r = await say(u, "releasing my single Lagos Nights on 12 Dec");
    expect(r.text.split("\n").slice(0, 4)).toEqual([
      "Lagos Nights, out 12 December. Your plan:",
      "- Sat 7 Nov: artwork done",
      "- Sat 14 Nov: upload to your distributor (4 weeks ahead leaves time for editorial pitching)",
      "- Sat 21 Nov: pitch to playlist editors",
    ]);
    expect(r.text).toContain("- Sat 12 Dec: release day: share the link everywhere");
    expect((await say(u, "tick artwork for Lagos Nights")).text).toBe("Lagos Nights: artwork done, ticked. Next: upload to your distributor, by Sat 14 Nov.");
    const day = new Date("2026-11-14T12:00:00Z");
    expect(await briefExtras(db, await fresh(u), day, 6, { peek: true })).toContain("Lagos Nights: upload to your distributor due today.");
    const s = await creativeSweep(deps, await fresh(u), day);
    expect(s).toMatch(/^Lagos Nights: upload to your distributor is due today\./);
    const btn = mine(u).at(-1)!.buttons![0];
    expect(btn.data).toMatch(/^cr:rs:\d+$/);
    expect((await press(u, btn.data, day)).text).toBe("Lagos Nights: upload to your distributor, ticked. Next: pitch to playlist editors, by Sat 21 Nov.");
  });

  it("squeezes a close date into today, and plans books and NFT drops", async () => {
    const u = await person("Europe/Berlin");
    expect((await say(u, "my book launches 3 March")).text).toMatch(/^Your book, out 3 March 2027\. Your plan:\n- Sat 2 Jan: cover final/);
    const d = await say(u, "dropping my NFT collection on 5 Nov");
    expect(d.text).toMatch(/^Your NFT collection, out 5 November\. Your plan:\n- Thu 29 Oct: art final\n- Thu 29 Oct: contract and metadata checked on a testnet/);
    expect(d.text).toMatch(/3 steps are already due, so they're set for today; do what fits and skip the rest\./);
    expect((await say(u, "my releases")).text).toMatch(/^\*\*Your NFT collection\*\*, out 5 November: 8 of 8 steps to go/);
  });
});

describe("ideas, sparks and the daily prompt", () => {
  it("keeps ideas privately, sparks without a model, and an opt-in prompt with an off switch", async () => {
    const u = await person();
    expect((await say(u, "idea: a zine about Lagos danfo drivers")).text).toBe(`Saved, just for you. That's 1 idea in your inbox; say "my ideas" to see them.`);
    await say(u, "idea for a song: the last bus out of São Paulo");
    expect((await say(u, "my ideas")).text).toBe("2 ideas:\n- the last bus out of São Paulo (song)\n- a zine about Lagos danfo drivers");
    const b0 = await briefExtras(db, await fresh(u), T0, 6, { peek: true });
    expect(b0.join(" ")).not.toContain("danfo");
    const s = await say(u, "give me a spark");
    expect(SPARKS.some((x) => s.text.startsWith(x))).toBe(true);
    expect(s.text).toMatch(/Want one every morning\? Say "a creative prompt every morning"\./);
    expect((await say(u, "a creative prompt every morning")).text).toMatch(/Say "stop the prompts" whenever you've had enough\./);
    const b1 = await briefExtras(db, await fresh(u), T0, 6, { peek: true });
    expect(b1.some((l) => /^Creative prompt: .+ \(Say "stop the prompts" to end these\.\)$/.test(l))).toBe(true);
    expect((await say(u, "stop the prompts")).text).toMatch(/^No more daily prompts\./);
    expect((await briefExtras(db, await fresh(u), T0, 6, { peek: true })).some((l) => /^Creative prompt/.test(l))).toBe(false);
    expect((await say(u, "delete my ideas")).text).toBe("Deleted 2 ideas. They're gone for good.");
  });
});

describe("practice time", () => {
  it("totals the week and keeps a kind run where a rest day doesn't break it", async () => {
    const u = await person("Europe/Berlin");
    await db.query(`INSERT INTO crt_practice (user_id, activity, minutes, day) VALUES ($1,'drawing',30,'2026-10-26'), ($1,'drawing',20,'2026-10-27')`, [u.id]);
    // 28 Oct is a rest day.
    const r = await say(u, "drew for 45 minutes");
    expect(r.text).toBe("45 minutes of drawing, logged. This week: 1 hour 35 minutes across 3 days. 3 days running. Yesterday was a rest day; one a week keeps the run going.");
    expect((await say(u, "wrote 800 words")).text).toBe("800 words of writing, logged. This week: 1 hour 35 minutes and 800 words across 3 days. 3 days running. Yesterday was a rest day; one a week keeps the run going.");
    expect((await say(u, "practised guitar for 30 min")).text).toMatch(/^30 minutes of guitar, logged\. This week: 2 hours 5 minutes and 800 words/);
    expect((await say(u, "my practice this week")).text).toBe("This week: 2 hours 5 minutes and 800 words across 3 days. 3 days running. Yesterday was a rest day; one a week keeps the run going.\n- Drawing: 1 hour 35 minutes\n- Guitar: 30 minutes\n- Writing: 800 words");
    expect(minutesOf("1h30")).toBe(90);
    expect(minutesOf("an hour and a half")).toBe(90);
  });

  it("never mentions a broken run", async () => {
    const u = await person();
    await db.query(`INSERT INTO crt_practice (user_id, activity, minutes, day) VALUES ($1,'painting',60,'2026-10-20'), ($1,'painting',60,'2026-10-21')`, [u.id]);
    const r = await say(u, "painted for 2 hours");
    expect(r.text).toBe("2 hours of painting, logged. This week: 2 hours across 1 day.");
    expect(r.text).not.toMatch(/broke|lost|missed|again/i);
  });
});

describe("quotes", () => {
  it("makes a copyable quote in the person's currency, or the one they name", async () => {
    const u = await person("Africa/Lagos");
    const r = await say(u, "quote for a logo, 12 hours at 40 an hour plus 2 revisions");
    expect(r.text).toBe("₦480 for the logo. Here it is to copy:\n\n```\nQuote: Logo\n\n12 hours at ₦40 an hour   ₦480\n2 rounds of revisions     included\nTotal                     ₦480\n\nValid for 30 days.\n```\nSay it again with \"in EUR\" or \"50% deposit\" to change it.");
    const m = await say(u, "make a quote for a mural, 3000 flat plus 400 for materials, 50% deposit, in EUR");
    expect(m.text).toContain("Mural                    €3,000\nMaterials                €400\nTotal                    €3,400\nDeposit to start (50%)   €1,700");
    expect(parseQuote("wedding shoot, 8 hours at 150 an hour, in EUR")).toEqual({ item: "wedding shoot", quantity: 8, unit: "hour", rate: 150, currency: "EUR" });
  });
});

describe("portfolio shelf", () => {
  it("keeps links and a bio line to copy", async () => {
    const u = await person();
    expect((await say(u, "my portfolio is https://adaobi.art")).text).toBe(`Portfolio: \`adaobi.art\`, on your shelf. Say "my links" for all of them and a bio line to copy.`);
    expect((await say(u, "my instagram is @adaobi.draws")).text).toMatch(/^Instagram: `instagram\.com\/adaobi\.draws`/);
    await say(u, "add link https://foundation.app/@adaobi");
    await say(u, "bio: illustrator in Lagos drawing city life");
    const r = await say(u, "my links");
    expect(r.text).toBe("- Portfolio: https://adaobi.art\n- Instagram: https://instagram.com/adaobi.draws\n- Foundation: https://foundation.app/@adaobi\n\nA line to copy:\n\n```\nAda Obi, illustrator in Lagos drawing city life. adaobi.art · instagram.com/adaobi.draws · foundation.app/@adaobi\n```");
    expect((await say(u, "remove my instagram link")).text).toBe("Instagram link removed.");
    expect((await say(u, "my portfolio")).text).not.toMatch(/shelf|Portfolio:/);
  });
});
