/** Several steps for one message (src/intent/agent.ts), with a scripted model standing in for a real one. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import "../src/modules/index.js";
import { openTestDb, type Db } from "../src/core/db.js";
import { config } from "../src/core/config.js";
import { ensureUser, handleMessage } from "../src/core/handler.js";
import { propose } from "../src/policy/engine.js";
import { parseByRules } from "../src/intent/rules.js";
import { assemble, wantsMore } from "../src/intent/agent.js";
import { _resting } from "../src/intent/providers.js";
import type { User } from "../src/policy/types.js";

let db: Db;
const saved = { ...config };
beforeAll(async () => { db = await openTestDb(); });
afterAll(() => db.close());
afterEach(() => { Object.assign(config, saved); vi.unstubAllGlobals(); _resting.clear(); });

const NOW = new Date("2026-10-31T17:10:00Z");

/** A model that answers from a script, one entry per call, and remembers what it was asked. */
function scriptedModel(script: ({ tool: string; args: Record<string, unknown> } | { text: string })[]) {
  Object.assign(config, { anthropicKey: "", geminiKey: "", openaiKey: "", openaiCompatKey: "k", openaiCompatBaseUrl: "https://llm.example.test/v1", openaiCompatModel: "m", openaiCompatFastModel: "", modelProvider: "openai" });
  const asked: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m" }] }), { headers: { "content-type": "application/json" } });
    const body = JSON.parse(init.body);
    asked.push(body);
    const next = script.shift() ?? { text: "DONE" };
    const message = "tool" in next
      ? { role: "assistant", content: null, tool_calls: [{ id: `c${asked.length}`, type: "function", function: { name: next.tool, arguments: JSON.stringify(next.args) } }] }
      : { role: "assistant", content: next.text };
    return new Response(JSON.stringify({ choices: [{ message, finish_reason: "tool_calls" in message ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { headers: { "content-type": "application/json" } });
  }));
  return asked;
}

async function person(id: string): Promise<User> {
  const u = await ensureUser(db, "telegram", id, "Sage");
  await db.query(`UPDATE users SET tz='Africa/Lagos' WHERE id=$1`, [u.id]);
  return (await db.one<User>(`SELECT * FROM users WHERE id=$1`, [u.id]))!;
}

describe("several steps for one message", () => {
  it("does both asks, in order, and shows each change without repeating itself", async () => {
    const u = await person("9301");
    await propose({ db, user: u, now: NOW, sourceMessage: "t" }, "reminder.create", { text: "call the bank", when: "5 November at 10am" });
    const said = "Delete the bank reminder and also put Bunmi's birthday down for 2 November";
    expect(parseByRules(said)).toBeNull(); // this one is for the model
    const asked = scriptedModel([
      { tool: "reminder__delete", args: { match: "bank" } },
      { tool: "date__add", args: { label: "Bunmi's birthday", on: "2 November" } },
      { text: "DONE" },
    ]);
    const r = await handleMessage(db, u, said, { channel: "telegram", now: NOW });
    expect(r.text).toMatch(/^Dropped the reminder to call the bank\.\n\nBunmi's birthday, Mon 2 Nov, every year\./);
    expect(r.text).not.toMatch(/DONE/);
    expect(asked).toHaveLength(3);
    // The second step saw what the first did, as information on the person's own turn.
    expect(asked[1].messages.at(-1).content).toMatch(/What you've already done for this message[\s\S]*1\. reminder\.delete: Dropped the reminder to call the bank/);
    expect(await db.query(`SELECT 1 FROM reminders WHERE user_id=$1 AND NOT deleted`, [u.id])).toHaveLength(0);
    expect(await db.query(`SELECT 1 FROM dates WHERE user_id=$1 AND label='Bunmi''s birthday'`, [u.id])).toHaveLength(1);
  });

  it("stops at anything that needs a yes, after saying what it already did", async () => {
    const u = await person("9302");
    await propose({ db, user: u, now: NOW, sourceMessage: "t" }, "reminder.create", { text: "call the bank", when: "5 November at 10am" });
    const asked = scriptedModel([
      { tool: "reminder__delete", args: { match: "bank" } },
      { tool: "account__delete", args: {} },
      { tool: "date__add", args: { label: "never reached", on: "3 November" } },
    ]);
    const r = await handleMessage(db, u, "Drop the bank reminder, and then delete my account please", { channel: "telegram", now: NOW });
    expect(r.text).toMatch(/^Dropped the reminder to call the bank\.\n\n[\s\S]*Go ahead\?/);
    expect(r.buttons?.map((b) => b.label)).toEqual(["Yes, go ahead", "No"]);
    expect(asked).toHaveLength(2);
    expect(await db.query(`SELECT 1 FROM jobs WHERE kind='account_erase'`)).toHaveLength(0);
    expect(await db.query(`SELECT 1 FROM dates WHERE label='never reached'`)).toHaveLength(0);
  });

  it("asks the model once for a single ask, and never loops on the same call", async () => {
    const u = await person("9303");
    let asked = scriptedModel([{ tool: "reminder__create", args: { text: "pay the gas bill", when: "tomorrow at 6pm" } }]);
    const one = await handleMessage(db, u, "the gas bill thing, nudge me about it tomorrow evening", { channel: "telegram", now: NOW });
    expect(one.text).toMatch(/^Pay the gas bill, tomorrow at 18:00\./);
    expect(asked).toHaveLength(1);

    asked = scriptedModel([
      { tool: "reminder__list", args: {} },
      { tool: "reminder__list", args: {} },
      { tool: "reminder__list", args: {} },
    ]);
    const looped = await handleMessage(db, u, "check my reminders and then tell me which is soonest", { channel: "telegram", now: NOW });
    expect(asked).toHaveLength(2); // the repeat is caught before it runs again
    expect(looped.text).toMatch(/pay the gas bill/i);
  });
});

describe("pieces", () => {
  it("only keeps going when the message has more to do", () => {
    expect(wantsMore("reminder.create", "remind me to call mum at 6")).toBe(false);
    expect(wantsMore("reminder.delete", "cancel the bank one and remind me about rent")).toBe(true);
    expect(wantsMore("reminder.list", "what are my reminders")).toBe(false);
    expect(wantsMore("reminder.list", "move the earliest reminder to 7am")).toBe(true);
  });
  it("shows changes, then the model's last word, and never the word DONE", () => {
    const steps = [
      { action: "reminder.list", reply: { text: "1. call the bank" }, changed: false },
      { action: "reminder.delete", reply: { text: "Dropped the reminder to call the bank.", buttons: [{ label: "Undo", data: "undo:1" }] }, changed: true },
    ];
    expect(assemble(steps, "DONE")).toMatchObject({ text: "Dropped the reminder to call the bank.", buttons: [{ label: "Undo", data: "undo:1" }] });
    expect(assemble(steps, "Your next one is the dentist on Friday.").text).toBe("Dropped the reminder to call the bank.\n\nYour next one is the dentist on Friday.");
    expect(assemble([steps[0]], "DONE").text).toBe("1. call the bank");
  });
});
