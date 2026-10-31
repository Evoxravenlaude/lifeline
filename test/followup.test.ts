/** The conversations from the 31 October screenshots, replayed: lifeline follows what was just said. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { ensureUser, handleMessage } from "../src/core/handler.js";
import { propose } from "../src/policy/engine.js";
import { parseByRules } from "../src/intent/rules.js";
import { cleanLabel, splitAsks } from "../src/modules/followup.js";
import { itemsOf } from "../src/modules/senses.js";
import { fellShort, stripTags } from "../src/intent/route.js";
import { parseResults } from "../src/core/media.js";
import type { User } from "../src/policy/types.js";

let db: Db;
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());

const NOW = new Date("2026-10-31T17:10:00Z"); // Saturday, 18:10 in Lagos
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);
async function person(id: string, name: string): Promise<User> {
  const u = await ensureUser(db, "telegram", id, name);
  await db.query(`UPDATE users SET tz='Africa/Lagos' WHERE id=$1`, [u.id]);
  return (await db.one<User>(`SELECT * FROM users WHERE id=$1`, [u.id]))!;
}
const fresh = async (u: User) => (await db.one<User>(`SELECT * FROM users WHERE id=$1`, [u.id]))!;
const say = async (u: User, text: string, min: number) => handleMessage(db, await fresh(u), text, { channel: "telegram", now: at(min) });

describe("the reminder thread from the screenshots", () => {
  it("moves the reminder it just set when told \"6am instead\", instead of making one called \"at 6am instead\"", async () => {
    const u = await person("9101", "Sage");
    await propose({ db, user: u, now: at(0), sourceMessage: "t" }, "reminder.create", { text: "Evelyn's birthday", when: "5 November at 9am", repeat: "0 9 5 11 *" });
    const r = await say(u, "Remind me at 6am instead", 1);
    expect(r.text).toMatch(/^Moved\. Evelyn's birthday, repeating, next .*06:00\.$/);
    expect(await db.query(`SELECT 1 FROM reminders WHERE user_id=$1 AND text ILIKE '%instead%'`, [u.id])).toHaveLength(0);
    expect((await db.one<{ cron: string }>(`SELECT cron FROM reminders WHERE user_id=$1`, [u.id]))!.cron).toBe("0 6 5 11 *");
  });

  it("lists every way it's asked, numbered, and \"cancel the second one and remind me of bunmis birthday in 2 days\" does both", async () => {
    const u = await person("9102", "Sage");
    await propose({ db, user: u, now: at(0), sourceMessage: "t" }, "reminder.create", { text: "Evelyn's birthday", when: "5 November at 9am", repeat: "0 9 5 11 *" });
    await propose({ db, user: u, now: at(0), sourceMessage: "t" }, "reminder.create", { text: "call the bank", when: "5 November at 10am" });
    const list = await say(u, "What are the reminders I've given you", 4);
    expect(list.text).toMatch(/^2 things coming up\.\n1\. .*Evelyn's birthday\n2\. .*call the bank/);

    const both = await say(u, "Cancel the second one and remind me of bunmis birthday in 2 days", 5);
    expect(both.text).toMatch(/Dropped the reminder to call the bank\./);
    expect(both.text).toMatch(/Bunmi's birthday, Mon 2 Nov, every year\./);

    // Asking again lists, it never creates anything.
    const again = await say(u, "What are the reminders I've given you", 6);
    expect(again.text).toMatch(/^2 things coming up\.\n1\. Mon 2 Nov \(every year\): Bunmi's birthday\n2\. .*Evelyn's birthday/);
    expect(again.text).not.toMatch(/call the bank/);
    expect(await db.query(`SELECT 1 FROM reminders WHERE user_id=$1 AND NOT deleted`, [u.id])).toHaveLength(1);
  });

  it("drops \"that\", and moves \"the first one\" to a new time", async () => {
    const u = await person("9103", "Ada");
    await say(u, "remind me to stretch tomorrow at 5pm", 0);
    await say(u, "remind me to buy bread on Monday at 9am", 1);
    const gone = await say(u, "cancel that", 2);
    expect(gone.text).toMatch(/Dropped the reminder to buy bread/);
    await say(u, "my reminders", 3);
    const moved = await say(u, "move the first one to 7am", 4);
    expect(moved.text).toMatch(/^Moved\. Stretch, tomorrow at 07:00\.$/);
  });
});

describe("words", () => {
  it("tidies birthday names", () => {
    expect(cleanLabel("remind me of bunmis birthday")).toBe("Bunmi's birthday");
    expect(cleanLabel("evelyns bday")).toBe("Evelyn's birthday");
    expect(cleanLabel("james birthday")).toBe("James's birthday");
    expect(cleanLabel("Ada's birthday")).toBe("Ada's birthday");
  });
  it("splits two asks, but never one reminder with \"and\" in it", () => {
    expect(splitAsks("Cancel the second one and remind me of bunmis birthday in 2 days")).toEqual(["Cancel the second one", "remind me of bunmis birthday in 2 days"]);
    expect(splitAsks("remind me to buy bread and milk tomorrow")).toBeNull();
    expect(splitAsks("remind me to call mum and dad at 6")).toBeNull();
  });
  it("reads the list question many ways", () => {
    for (const q of ["What are the reminders I've given you", "what reminders do I have?", "show me my reminders", "any reminders", "what have I asked you to remind me about", "what are my reminders"])
      expect(parseByRules(q)?.action, q).toBe("reminder.list");
  });
  it("answers \"what matches are on today\" and finds pictures as links", () => {
    expect(parseByRules("What matches are on today")?.action).toBe("sports.next");
    const i = parseByRules("Help generate or search the net images of a Oxford Shirt, a railway chore jacket, a field trousers, a jean, a Gingham day dress");
    expect(i?.action).toBe("images.find");
    expect((i!.args as any).items).toEqual(["Oxford Shirt", "railway chore jacket", "field trousers", "jean", "Gingham day dress"]);
    expect(itemsOf("show me pictures of linen shirts")).toEqual(["linen shirts"]);
  });
});

describe("one conversation, no stray tags", () => {
  it("takes \"[did web.search]\" off a reply, and treats writing it as falling short", () => {
    expect(stripTags("[did web.search] Premier League fixtures today")).toBe("Premier League fixtures today");
    expect(stripTags("[did web.search; said in a voice note] Hi")).toBe("Hi");
    expect(fellShort({ text: "[did web.search] No, Manchester United aren't playing today.", usage: { input: 0, output: 0 } } as any, "Is Manchester United playing today", ["web__search"])).toBe(true);
  });
  it("reads a results page for search when no search key is set", () => {
    const html = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.premierleague.com%2Ffixtures&amp;rut=x">Premier League Fixtures</a><a class="result__snippet" href="#">Chelsea v West Ham, <b>15:00</b></a></div>`;
    expect(parseResults(html)).toEqual([{ title: "Premier League Fixtures", snippet: "Chelsea v West Ham, 15:00", url: "https://www.premierleague.com/fixtures" }]);
  });
});
