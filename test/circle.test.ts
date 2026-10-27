/** Open entry with a cap: anyone with the link joins until the circle is full; members and owners always get in. */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { ensureUser } from "../src/core/handler.js";
import { admit, circleSummary } from "../src/core/circle.js";
import { config } from "../src/core/config.js";
import { createWeb } from "../src/web/server.js";

let db: Db;
const saved = { maxUsers: config.maxUsers, allowedUserIds: [...config.allowedUserIds] };
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());
afterEach(() => { config.maxUsers = saved.maxUsers; config.allowedUserIds = [...saved.allowedUserIds]; });

describe("the circle", () => {
  it("lets anyone in until it's full, then only members and owners", async () => {
    config.maxUsers = 3; config.allowedUserIds = [999];
    for (const id of [101, 102]) { expect(await admit(db, id)).toBe("room"); await ensureUser(db, "telegram", String(id), `P${id}`); }
    expect(await admit(db, 103)).toBe("room");
    await ensureUser(db, "telegram", "103", "P103");
    expect(await admit(db, 104)).toBe("full");
    expect(await admit(db, 102)).toBe("member");
    expect(await admit(db, 999)).toBe("member");
    expect(await circleSummary(db)).toMatch(/^3 of 3 places taken, the circle is full\./);
  });

  it("the website's Telegram sign-in is refused politely when full", async () => {
    config.maxUsers = 3; config.allowedUserIds = [];
    const { createHash, createHmac } = await import("node:crypto");
    const fields: Record<string, string> = { id: "555", first_name: "New", auth_date: String(Math.floor(Date.now() / 1000)) };
    const check = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
    const hash = createHmac("sha256", createHash("sha256").update(config.telegramToken).digest()).update(check).digest("hex");
    const r = await createWeb(db, "lifeline_bot").request("/auth/telegram", { method: "POST", body: JSON.stringify({ ...fields, hash }), headers: { "content-type": "application/json" } });
    expect(r.status).toBe(403);
    expect((await r.json()).text).toMatch(/small circle of 3/);
  });

  it("the landing can read the whole catalogue and the places left without signing in", async () => {
    config.maxUsers = 15;
    const web = createWeb(db, "lifeline_bot");
    const caps = await (await web.request("/api/capabilities")).json();
    expect(caps.groups.map((g: [string]) => g[0])).toEqual(["Your day", "Body and health", "Money", "Work and growth", "Me"]);
    expect(caps.capabilities.length).toBeGreaterThan(15);
    const pub = await (await web.request("/api/public")).json();
    expect(pub.places).toEqual({ taken: 3, max: 15 });
  });
});
