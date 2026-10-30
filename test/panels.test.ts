/** The Telegram menu: panels render from real data, buttons change things in place, and every page has a way back. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { ensureUser, getUserById, handleMessage } from "../src/core/handler.js";
import { panel, shapeAnswer, ASKS, type Panel } from "../src/telegram/panels.js";
import { styleOf } from "../src/telegram/bot.js";
import { POSES } from "../src/telegram/stickers.js";
import fs from "node:fs";

let db: Db;
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());
const NOW = new Date("2026-10-29T09:00:00Z");
const datas = (p: Panel) => p.rows.flat().map((b) => b.data);

describe("the menu", () => {
  it("home greets by name, says what's next, and opens every section", async () => {
    const u = await ensureUser(db, "telegram", "8001", "Sage Rav3n");
    await handleMessage(db, u, "remind me to call mum at 4pm", { channel: "telegram", now: NOW });
    const r = await panel(db, (await getUserById(db, u.id))!, "home", NOW);
    expect(r.panel!.text).toMatch(/^\*\*Good morning, Sage\.\*\*/);
    expect(r.panel!.text).toMatch(/Still to come today\*\*\n└ 16:00 Call mum/);
    expect(r.panel!.card).toBe("home");
    expect(datas(r.panel!)).toEqual(["p:today", "p:lists", "p:health", "p:money", "p:trips", "p:play", "p:settings", "ev:home", "p:home", "p:ok"]);
  });

  it("every page except home has Back and OK", async () => {
    const u = await ensureUser(db, "telegram", "8002", "Ada");
    for (const k of ["today", "lists", "health", "money", "money:month", "trips", "play", "settings", "persona"]) {
      const p = (await panel(db, u, k, NOW)).panel!;
      expect(datas(p), k).toContain("p:ok");
      expect(datas(p).some((d) => /^p:(home|settings|lists)$/.test(d)), k).toBe(true);
    }
  });

  it("lists open, and tapping an item ticks it off in place", async () => {
    const u = await ensureUser(db, "telegram", "8003", "Bisi");
    await handleMessage(db, u, "shopping: rice, eggs, bread", { channel: "telegram", now: NOW });
    const l = (await panel(db, u, "lists", NOW)).panel!;
    expect(l.rows[0][0].label).toBe("Shopping · 3 ›");
    const one = (await panel(db, u, "list:0", NOW)).panel!;
    const tick = one.rows[0][0];
    expect(tick.label).toMatch(/^○ {2}rice$/);
    const after = await panel(db, u, tick.data.slice(2), NOW);
    expect(after.toast).toBe("Ticked: rice");
    expect(after.panel!.text).toMatch(/2 open/);
  });

  it("settings change in place: voice replies cycle, the brief moves, personality picks", async () => {
    const u = await ensureUser(db, "telegram", "8004", "Chi");
    let r = await panel(db, u, "set:vr", NOW);
    expect(r.toast).toBe("Voice replies: always");
    r = await panel(db, (await getUserById(db, u.id))!, "set:brief:1", NOW);
    expect(r.panel!.text).toMatch(/Morning brief: 08:00/);
    r = await panel(db, (await getUserById(db, u.id))!, "persona:butler", NOW);
    expect(r.panel!.text).toMatch(/Personality: Butler/);
  });

  it("OK closes, and buttons that need words ask with a prompt", async () => {
    const u = await ensureUser(db, "telegram", "8005", "Dayo");
    expect((await panel(db, u, "ok", NOW)).close).toBe(true);
    expect((await panel(db, u, "ask:spend", NOW)).ask).toBe("spend");
    expect(shapeAnswer(ASKS.spend.prompt, "4500 naira on data")).toBe("I spent 4500 naira on data");
    expect(shapeAnswer(ASKS.rem.prompt, "call mum sunday at 5")).toBe("remind me to call mum sunday at 5");
    expect(shapeAnswer(ASKS.list.prompt, "shopping: rice")).toBe("shopping: rice");
    expect(shapeAnswer(undefined, "hello")).toBe("hello");
  });

  it("the Today page doesn't use up 'new since yesterday'", async () => {
    const u = await ensureUser(db, "telegram", "8006", "Efe");
    await panel(db, u, "today", NOW);
    expect(await db.query(`SELECT * FROM hackathon_seen WHERE user_id=$1`, [u.id])).toHaveLength(0);
  });
});

describe("how buttons look", () => {
  it("yes is green, no is red, OK is blue, the rest plain", () => {
    expect(styleOf("confirm:3", "Yes, go ahead")).toBe("success");
    expect(styleOf("cancel:3", "No")).toBe("danger");
    expect(styleOf("p:ok", "OK")).toBe("primary");
    expect(styleOf("p:lists", "Lists ›")).toBeUndefined();
  });
  it("every sticker pose has its picture", () => {
    for (const p of POSES) expect(fs.existsSync(`assets/pip/${p}.png`), p).toBe(true);
  });
});
