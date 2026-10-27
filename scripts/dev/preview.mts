import "../../src/modules/index.js";
import { openTestDb } from "../../src/core/db.js";
import { createWeb } from "../../src/web/server.js";
import { ensureUser, createLinkCode, handleMessage } from "../../src/core/handler.js";
import { serve } from "@hono/node-server";
const db = await openTestDb();
const u = await ensureUser(db, "telegram", "777", "Sage Rav3n");
const now = new Date();
for (const t of ["remind me to call Ada tomorrow at 9", "I take vitamin D at 8am and 8pm", "plan a trip to accra", "dec 20 to dec 27, budget 600 usd", "I need to buy milk and eggs", "I'm entering the NEAR hackathon due nov 14", "can you track my meds?", "I spent 4500 naira on data", "delete event tomorrow"]) {
  const uu = (await db.one<any>(`SELECT * FROM users WHERE id=$1`, [u.id]))!;
  await handleMessage(db, uu, t, { channel: "web", now });
}
const code = await createLinkCode(db, u.id);
console.log("CODE " + code);
const app = createWeb(db, "lifeline_bot");
serve({ fetch: app.fetch, port: 4567 }, () => console.log("up"));
