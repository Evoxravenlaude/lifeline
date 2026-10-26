import { beforeAll, afterAll, describe, expect, it } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { ensureUser, handleMessage, handleCallback, createLinkCode, redeemLinkCode, buttonsAsText } from "../src/core/handler.js";
import { dispatch, registerSender } from "../src/core/dispatch.js";
import { handleTextChannel } from "../src/channels/sms.js";
import { parseInbound } from "../src/channels/imessage.js";
import { createWeb } from "../src/web/server.js";
import { runDue, schedule } from "../src/core/scheduler.js";
import { propose } from "../src/policy/engine.js";
import { parseByRules } from "../src/intent/rules.js";
import { fmtHit } from "../src/modules/scout.js";
import { config } from "../src/core/config.js";
import { createHash, createHmac } from "node:crypto";

let db: Db;
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());

describe("shared handler across channels", () => {
  it("one identity per channel, same user, same pending action", async () => {
    const u = await ensureUser(db, "telegram", "1001", "Sage");
    const code = await createLinkCode(db, u.id);
    const linked = await redeemLinkCode(db, code, "sms", "+2348012345678");
    expect(linked?.id).toBe(u.id);
    expect(await redeemLinkCode(db, code, "sms", "+1")).toBeNull(); // single use

    const r = await handleMessage(db, u, "add dentist on friday 3pm", { channel: "telegram" });
    expect(r.buttons?.[0].label).toBe("Undo");
    const ev = await db.one<{ id: number }>(`SELECT id FROM events WHERE user_id=$1`, [u.id]);
    const d = await handleMessage(db, u, `delete event #${ev!.id}`, { channel: "web" });
    expect(d.buttons?.map((b) => b.label)).toEqual(["✅ Confirm", "✖ Cancel"]);
    // confirm from SMS by number
    const sms = await handleTextChannel(db, "sms", "+2348012345678", "1"); // "1" = confirm latest pending on a text channel
    expect(sms).toContain("Deleted");
    expect((await db.one<any>(`SELECT deleted FROM events WHERE id=$1`, [ev!.id])).deleted).toBe(true);
  });

  it("unlinked phone gets instructions, nothing else", async () => {
    expect(await handleTextChannel(db, "sms", "+15550000000", "remind me to x")).toContain("isn't linked");
    expect(await db.query(`SELECT * FROM reminders`)).toHaveLength(0);
  });

  it("text channels render buttons as numbered options and map replies back", async () => {
    const u = await ensureUser(db, "telegram", "1002", "Ada");
    const code = await createLinkCode(db, u.id);
    expect(await handleTextChannel(db, "imessage", "ada@icloud.com", `link ${code}`)).toContain("Linked");
    const t = await handleTextChannel(db, "imessage", "ada@icloud.com", "med Vitamin D at 8am");
    expect(t).toContain("1) Undo");
    const undo = await handleTextChannel(db, "imessage", "ada@icloud.com", "1");
    expect(undo).toBe("Medication reminder removed.");
    expect(buttonsAsText({ text: "x", buttons: [{ label: "✅ Confirm", data: "a" }, { label: "✖ Cancel", data: "b" }] })).toBe("x\n1) Confirm  2) Cancel");
  });

  it("iMessage inbound parsing for both relays, ignores own messages", () => {
    expect(parseInbound({ type: "new-message", data: { text: "hi", handle: { address: "+1" }, isFromMe: false } })).toEqual({ from: "+1", text: "hi" });
    expect(parseInbound({ type: "new-message", data: { text: "hi", handle: { address: "+1" }, isFromMe: true } })).toBeNull();
    expect(parseInbound({ number: "+2", content: "yo", is_outbound: false })).toEqual({ from: "+2", text: "yo" });
    expect(parseInbound({ number: "+2", content: "yo", is_outbound: true })).toBeNull();
  });

  it("dispatch falls back down the channel chain", async () => {
    const u = await ensureUser(db, "telegram", "1003", "Tee");
    await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,'sms','+3')`, [u.id]);
    const got: string[] = [];
    registerSender("telegram", async () => { throw new Error("blocked"); });
    registerSender("sms", async (id, r) => { got.push(`${id}:${r.text}`); });
    expect(await dispatch(db, u, { text: "hello" })).toBe(true);
    expect(got).toEqual(["+3:hello"]);
  });
});

describe("web app", () => {
  const app = () => createWeb(db, "lifeline_bot");
  const tgPayload = (id: number) => {
    const rest: Record<string, string> = { id: String(id), first_name: "Web", auth_date: String(Math.floor(Date.now() / 1000)) };
    const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("\n");
    const hash = createHmac("sha256", createHash("sha256").update(config.telegramToken).digest()).update(check).digest("hex");
    return { ...rest, hash };
  };

  it("serves the app, rejects unauthenticated API, accepts a valid Telegram login", async () => {
    const a = app();
    expect((await a.request("/")).status).toBe(200);
    expect((await a.request("/api/me")).status).toBe(401);
    const bad = await a.request("/auth/telegram", { method: "POST", body: JSON.stringify({ ...tgPayload(5), hash: "00" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(401);
    const ok = await a.request("/auth/telegram", { method: "POST", body: JSON.stringify(tgPayload(5)), headers: { "content-type": "application/json" } });
    expect(ok.status).toBe(200);
    const cookie = ok.headers.get("set-cookie")!.split(";")[0];
    const me = await (await a.request("/api/me", { headers: { cookie } })).json();
    expect(me.name).toBe("Web");
    const chat = await (await a.request("/api/chat", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ text: "todo: taxes, call bank" }) })).json();
    expect(chat.text).toContain("Added to todo");
    const btn = await (await a.request("/api/button", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ data: chat.buttons[0].data }) })).json();
    expect(btn.text).toBe("Removed.");
    const state = await (await a.request("/api/state", { headers: { cookie } })).json();
    expect(state.lists).toHaveLength(0);
    expect((await a.request("/api/messages", { headers: { cookie } })).status).toBe(200);
  });

  it("link-code login and logout", async () => {
    const a = app();
    const u = await ensureUser(db, "telegram", "1004", "Lin");
    const code = await createLinkCode(db, u.id);
    const r = await a.request("/auth/link", { method: "POST", body: JSON.stringify({ code }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    expect((await (await a.request("/api/me", { headers: { cookie } })).json()).name).toBe("Lin");
    await a.request("/auth/logout", { method: "POST", headers: { cookie } });
    expect((await a.request("/api/me", { headers: { cookie } })).status).toBe(401);
  });

  it("webhooks refuse unsigned requests", async () => {
    const a = app();
    expect((await a.request("/webhooks/twilio", { method: "POST", body: new URLSearchParams({ From: "+1", Body: "hi" }) })).status).toBe(403);
    expect((await a.request("/webhooks/imessage", { method: "POST", body: "{}", headers: { "content-type": "application/json" } })).status).toBe(403);
  });
});

describe("extras + scout", () => {
  it("lists, dates and rule parsing", async () => {
    const u = await ensureUser(db, "telegram", "1005", "Ex");
    const ctx = { db, user: u, now: new Date("2026-10-26T10:00:00Z") };
    await propose(ctx, "list.add", { list: "shopping", items: ["milk", "rice"] });
    const done = await propose(ctx, "list.done", { match: "milk" });
    expect(done.kind === "ran" && done.reply).toContain("✅ milk");
    const show = await propose(ctx, "list.show", {});
    expect(show.kind === "ran" && show.reply).toBe("SHOPPING\n▫️ rice");
    const b = await propose(ctx, "date.add", { label: "Ada's birthday", on: "march 14" });
    expect(b.kind === "ran" && b.reply).toContain("(yearly)");
    const alerts = await db.query(`SELECT * FROM jobs WHERE kind='date_alert' AND user_id=$1`, [u.id]);
    expect(alerts).toHaveLength(3);
    const l = await propose(ctx, "date.list", {});
    expect(l.kind === "ran" && l.reply).toMatch(/^\d+d — Ada's birthday \(14 Mar\)/);
    expect(parseByRules("shopping: eggs, bread")?.args).toEqual({ list: "shopping", items: ["eggs", "bread"] });
    expect(parseByRules("Ada's birthday is march 14")?.args).toEqual({ label: "Ada's birthday", on: "march 14" });
    expect(parseByRules("100 usd to ngn")?.args).toEqual({ amount: 100, from: "usd", to: "ngn" });
    expect(parseByRules("scout solana perps for partnerships")?.args).toEqual({ niche: "solana perps", objective: "partnerships" });
    expect(parseByRules("weather in Lagos tomorrow")?.args).toEqual({ city: "Lagos", day: "tomorrow" });
  });

  it("scout result formatting dedupes people and shows sources", () => {
    const line = fmtHit({ name: "Perpz", objective: "beta · perps on solana", url: "https://perpz.xyz", twitter: "@perpz", founders: [{ name: "Jo", handle: "@jo", role: "founder" }, { name: "Jo", handle: "@jo" }, { handle: "gh:bob" }] });
    expect(line).toContain("• Perpz — beta · perps on solana");
    expect(line).toContain("https://perpz.xyz · @perpz");
    expect(line).toContain("people: Jo @jo (founder), gh:bob");
  });

  it("gemini schema cleaner strips unsupported keys", async () => {
    const { z } = await import("zod");
    const mod: any = await import("../src/intent/providers.js");
    expect(mod.providerName()).toBeNull(); // no keys in test
    const schema = z.toJSONSchema(z.object({ a: z.string().default("x"), b: z.number().int().optional() }), { io: "input" });
    const cleaned = JSON.stringify(mod.geminiSchema(schema));
    expect(JSON.stringify(schema)).toContain("$schema");
    expect(cleaned).not.toContain("$schema");
    expect(cleaned).not.toContain("default");
    expect(cleaned).toContain('"b":{"type":"integer"');
  });
});

describe("load", () => {
  it("drains 2,000 due jobs in well under a second each batch and 200 concurrent messages without cross-talk", async () => {
    const u = await ensureUser(db, "telegram", "2000", "Load");
    const now = new Date("2026-10-26T10:00:00Z");
    for (let i = 0; i < 2000; i++) {
      const r = await db.one<{ id: number }>(`INSERT INTO reminders (user_id, text, due_at) VALUES ($1,$2,$3) RETURNING id`, [u.id, `r${i}`, now]);
      await schedule(db, { userId: u.id, kind: "reminder", payload: { reminderId: r!.id }, runAt: now });
    }
    let sent = 0;
    const deps = { db, send: async () => { sent++; return true; }, getUser: async (id: number) => db.one<any>(`SELECT * FROM users WHERE id=$1`, [id]) };
    const t0 = Date.now();
    let total = 0, batches = 0;
    while (true) { const n = await runDue(deps, now); if (!n) break; total += n; batches++; }
    const ms = Date.now() - t0;
    expect(total).toBe(2000);
    expect(sent).toBe(2000);
    expect(ms / batches).toBeLessThan(1000);
    expect(await db.query(`SELECT 1 FROM jobs WHERE kind='reminder' AND active AND user_id=$1`, [u.id])).toHaveLength(0);

    const users = await Promise.all(Array.from({ length: 200 }, (_, i) => ensureUser(db, "telegram", String(3000 + i), `u${i}`)));
    const t1 = Date.now();
    const replies = await Promise.all(users.map((usr, i) => handleMessage(db, usr, `note: secret ${i}`, { channel: "web" })));
    const ms2 = Date.now() - t1;
    expect(replies.every((r) => r.text.startsWith("Noted"))).toBe(true);
    for (let i = 0; i < 200; i += 37) {
      const notes = await db.query<{ text: string }>(`SELECT text FROM notes WHERE user_id=$1`, [users[i].id]);
      expect(notes).toEqual([{ text: `secret ${i}` }]);
    }
    expect(ms2).toBeLessThan(10_000);
    console.log(`load: 2000 jobs in ${ms}ms (${batches} batches); 200 concurrent messages in ${ms2}ms`);
  });
});

describe("web static + telegram html", () => {
  it("serves the app shell, styles, scripts and new endpoints", async () => {
    const a = createWeb(db, "lifeline_bot");
    for (const p of ["/", "/styles.css", "/app.js", "/mascot.js"]) expect((await a.request(p)).status, p).toBe(200);
    const html = await (await a.request("/")).text();
    expect(html).toContain('data-theme="manor"');
    expect(html).toContain("mascot.js");
    const css = await (await a.request("/styles.css")).text();
    for (const t of ["manor", "library", "riviera", "tobacco"]) expect(css).toContain(`[data-theme="${t}"]`);
    expect((await (await a.request("/api/public")).json()).botUsername).toBe("lifeline_bot");
    const u = await ensureUser(db, "telegram", "1010", "Web2");
    const code = await createLinkCode(db, u.id);
    const r = await a.request("/auth/link", { method: "POST", body: JSON.stringify({ code }), headers: { "content-type": "application/json" } });
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    for (const p of ["/api/state", "/api/hackathons", "/api/scout", "/api/money", "/api/trips", "/api/settings", "/api/digest"]) expect((await a.request(p, { headers: { cookie } })).status, p).toBe(200);
    const st = await (await a.request("/api/settings", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ theme: "library" }) })).json();
    expect(st.ok).toBe(true);
    const me = await (await a.request("/api/me", { headers: { cookie } })).json();
    expect(me.theme).toBe("library");
    const tz = await (await a.request("/api/settings", { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ tz: "Europe/London", digest_hour: 8 }) })).json();
    expect(tz.ok).toBe(true);
    const s2 = await (await a.request("/api/settings", { headers: { cookie } })).json();
    expect(s2.tz).toBe("Europe/London");
    expect(Object.keys(s2.personas)).toContain("pidgin");
  });
  it("renders Telegram HTML safely", async () => {
    const { toHtml } = await import("../src/telegram/bot.js");
    expect(toHtml("Outcomes:\n1 < 2 & more\n🐢 Mon 26 Oct")).toBe("<b>Outcomes:</b>\n1 &lt; 2 &amp; more\n<b>🐢 Mon 26 Oct</b>");
  });
});
