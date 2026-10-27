/** Eyeball the voice: runs a scripted conversation through the shared handler with no model and prints both sides. */
import "../../src/modules/index.js";
import { openTestDb } from "../../src/core/db.js";
import { ensureUser, handleMessage, getUserById } from "../../src/core/handler.js";
const db = await openTestDb();
const u0 = await ensureUser(db, "telegram", "1", "Sage");
const lines = process.argv.slice(2).length ? process.argv.slice(2) : ["hi", "what can you do", "can you plan trips?", "plan a trip to accra", "dec 20 to 27, budget 600 dollars", "add flight LOS to ACC on dec 20 at 7am to the trip", "packed charger", "trip", "remind me to call Ada", "tomorrow at 9", "my reminders", "I take vitamin D at 8am and 8pm", "I need to buy milk and eggs", "done with milk", "I spent 4500 naira on data", "how much did I spend this week", "Ada's birthday is march 14", "I'm entering the NEAR hackathon due nov 14", "ledger", "delete the reminder about Ada", "yes", "undo", "can we talk about this later", "thanks", "asdkjh qwe"];
for (const t of lines) {
  const u = (await getUserById(db, u0.id))!;
  const r = await handleMessage(db, u, t, { channel: "telegram", now: new Date("2026-10-27T10:00:00Z") });
  console.log(`\n> ${t}\n${r.text}${r.buttons ? `\n[${r.buttons.map((b) => b.label).join(" | ")}]` : ""}`);
}
await db.close();
