/** Local preview with a lived-in account: run `npx tsx scripts/dev/preview.mts`, open http://localhost:4567 and paste the printed code. */
import "../../src/modules/index.js";
import { openTestDb } from "../../src/core/db.js";
import { createWeb } from "../../src/web/server.js";
import { ensureUser, createLinkCode, handleMessage, getUserById } from "../../src/core/handler.js";
import { serve } from "@hono/node-server";

const db = await openTestDb();
const u0 = await ensureUser(db, "telegram", "777", "Sage Rav3n");
const tz = process.env.PREVIEW_TZ ?? "Africa/Lagos";
await db.query(`UPDATE users SET tz=$2 WHERE id=$1`, [u0.id, tz]);
const say = async (t: string) => handleMessage(db, (await getUserById(db, u0.id))!, t, { channel: "web" });
const hh = (offsetMin: number) => new Date(Date.now() + offsetMin * 60000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz });

for (const t of [
  `bank call today at ${hh(-200)}`, `standup today at ${hh(-90)}`, `remind me to move the car today at ${hh(40)}`,
  `lunch with Ada today at ${hh(110)}`, `remind me to send the hood deck today at ${hh(200)}`, `gym today at ${hh(280)}`,
  "I take vitamin D at 8am and 8pm", "I need to buy milk, eggs and plantain", "todo: ship the hood deck, reply to Mario, renew passport",
  "plan a trip to accra", "dec 20 to dec 27, budget 600 usd", "add flight LOS to ACC on dec 20 at 7am to the trip", "packed charger",
  "I'm entering the NEAR hackathon due nov 14", "I'm entering Colosseum Frontier due nov 30", "submitted NEAR",
  "I spent 4500 naira on data", "I spent 12000 naira on food", "I spent 3000 naira on transport", "I spent 20 usd on figma",
  "Ada's birthday is march 14", "did gym", "remember that I'm vegetarian",
]) await say(t);
await db.query(`UPDATE memories SET confirmed=true WHERE user_id=$1`, [u0.id]);
await db
  .query(
    `INSERT INTO hackathons (source, external_id, title, url, deadline, prize_usd, registrations, online, tags, quality, canonical_url) VALUES
     ('devpost','a','Base Onchain Buildathon','https://example.com/a',now()+interval '9 days',50000,420,true,'{base,payments}',80,'https://example.com/a'),
     ('superteam','b','Agents in the Wild','https://example.com/b',now()+interval '16 days',25000,140,true,'{ai,agents}',75,'https://example.com/b'),
     ('ethglobal','c','ETHGlobal Bangkok','https://example.com/c',now()+interval '30 days',300000,2100,false,'{ethereum}',90,'https://example.com/c')
     ON CONFLICT DO NOTHING`,
  )
  .catch((e) => console.log("hackathon seed:", e.message));
for (let i = 0; i < 6; i++) console.log("CODE " + (await createLinkCode(db, u0.id)));
serve({ fetch: createWeb(db, "lifeline_bot").fetch, port: Number(process.env.PREVIEW_PORT ?? 4567) }, () => console.log("up"));
