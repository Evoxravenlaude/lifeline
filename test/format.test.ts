/** Replies read cleanly on every channel: no raw markdown, copyable things are copyable, errors are sentences. */
import { describe, expect, it } from "vitest";
import { copyButton, copyables, toPlain, toTelegramHtml } from "../src/core/format.js";
import { polish } from "../src/core/voice.js";
import { humanError, isHuman } from "../src/core/humanize.js";
import { answerCapability } from "../src/intent/capabilities.js";

const ADDR = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("formatting", () => {
  it("turns a model's markdown into Telegram HTML, with nothing raw left", () => {
    const html = toTelegramHtml("**Gym routine**\n\n## Day 1\n- Bench press 4×8\n* Rows 3×10\n| Day | Focus |\n|---|---|\n| Mon | Push |\nSee [the guide](https://x.io/a?b=1&c=2), *slowly*.");
    expect(html).toContain("<b>Gym routine</b>");
    expect(html).toContain("<b>Day 1</b>");
    expect(html).toContain("├ Bench press 4×8\n└ Rows 3×10"); // lists read as a small tree
    expect(html).toContain("Mon · Push");
    expect(html).toContain('<a href="https://x.io/a?b=1&amp;c=2">the guide</a>');
    expect(html).toContain("<i>slowly</i>");
    expect(html).not.toMatch(/\*\*|##|\|---/);
  });

  it("escapes everything that isn't its own tag, and leaves snake_case and maths alone", () => {
    expect(toTelegramHtml("1 < 2 & a_b_c is 3*4*5")).toBe("1 &lt; 2 &amp; a_b_c is 3*4*5");
  });

  it("makes codes, addresses and drafts tap-to-copy on Telegram", () => {
    expect(toTelegramHtml("Your code is `7KQ2XM`.")).toBe("Your code is <code>7KQ2XM</code>.");
    expect(toTelegramHtml(`Watching ${ADDR} now`)).toContain(`<code>${ADDR}</code>`);
    expect(toTelegramHtml(`[explorer](https://basescan.org/address/${ADDR})`)).not.toContain("<code>");
    expect(toTelegramHtml("Send this:\n```\nHi Ada, quick one.\n  - keep this indent\n```")).toContain("<pre>Hi Ada, quick one.\n  - keep this indent</pre>");
  });

  it("gives SMS and iMessage clean plain text", () => {
    expect(toPlain("**Day 1**\n* Bench `4×8`\nSee [docs](https://x.io)")).toBe("Day 1\n- Bench 4×8\nSee docs (https://x.io)");
  });

  it("offers one Copy button when there's one thing to copy", () => {
    expect(copyButton("Your link code is `7KQ2XM`.\nText `link 7KQ2XM` to +234 801.")).toEqual({ label: "Copy code", text: "link 7KQ2XM" });
    expect(copyButton(`Watching \`${ADDR}\` on Base.`)).toEqual({ label: "Copy address", text: ADDR });
    expect(copyButton("Here it is:\n```\nHi Ada, saw your launch and had one question about the API.\n```")?.label).toBe("Copy message");
    expect(copyButton("Nothing to copy here.")).toBeNull();
    expect(copyables("`a` and `b`")).toEqual(["a", "b"]);
  });
});

describe("the voice pass", () => {
  it("keeps ranges as ranges instead of turning them into lists", () => {
    expect(polish("Rest 1–2 min between sets, 60–90 sec for core.")).toBe("Rest 1 to 2 min between sets, 60 to 90 sec for core.");
    expect(polish("The Lagos–Accra flight — it's early.")).toBe("The Lagos-Accra flight, it's early.");
  });
  it("never touches code or drafts", () => {
    const md = "Paste this:\n```\nHi — two  spaces\n   indented\n```";
    expect(polish(md)).toBe(md);
  });
});

describe("errors in words", () => {
  it("translates codes and dumps, keeps sentences a module wrote on purpose", () => {
    expect(humanError(new Error("coingecko 429"), "prices.quote")).toBe("The price service is busy and asked me to slow down. Try again in a few minutes.");
    expect(humanError(new Error("https://boards.greenhouse.io/x → 404"), "jobs.watch")).toMatch(/^That job board doesn't have that/);
    expect(humanError(new Error("fetch failed"), "tools.weather")).toBe("I couldn't reach the weather service just now. Try again in a minute.");
    expect(humanError({ name: "ZodError", issues: [{ path: ["when"] }] }, "reminder.create")).toBe("I didn't get when from that. Say it again with that in?");
    expect(humanError(new Error('duplicate key value violates unique constraint "x"'))).toMatch(/^That didn't work on my side/);
    expect(humanError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toMatch(/^That didn't work on my side/);
    const mine = 'I couldn\'t read "blah" as a time. Try 08:00 or 8am.';
    expect(humanError(new Error(mine))).toBe(mine);
    expect(isHuman("Flutterwave turned that down: Invalid customer.")).toBe(true);
  });
});

describe("where lifeline lives", () => {
  it("says plainly when it isn't somewhere, and points to the website and app that do exist", () => {
    const a = answerCapability("can you work on whatsapp")!;
    expect(a).toMatch(/^Not WhatsApp, no\./);
    expect(a).toMatch(/works as an app you can install/);
    const b = answerCapability("how do I use you on imessage")!;
    expect(b).toMatch(/On iMessage:/);
    expect(b).not.toMatch(/install the app|log in with/i);
  });
});
