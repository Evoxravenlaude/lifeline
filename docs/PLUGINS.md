# Building a feature for lifeline

lifeline is a personal assistant people talk to in plain words, on Telegram first, also the web, SMS, email and iMessage. It is used **worldwide**, by people in every state of mind, from a great week to a terrible one. Every feature is held to three things: it is **useful**, it is **calm**, and it is **safe**.

## Where your code lives

- `src/modules/features/<area>/index.ts` is loaded automatically at startup and in tests. It imports your other files in that folder.
- Tests: `test/features-<area>.test.ts`. Notes for the team: `docs/features/<area>.md`.
- **Never edit files outside your area.** If you need a change in the core, describe it in your final report and work around it meanwhile.
- Table names start with your area's prefix (`safety_`, `money_`, `well_`, `home_`, `tech_`). Button data starts with your area's prefix and a colon (`sf:`, `mn:`, `wb:`, `hm:`, `tc:`), the whole of it under 64 bytes.

## The shape of a feature

Look at `src/modules/calm.ts`: it is a complete small feature in one file.

```ts
import { z } from "zod";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";

addSchema(`CREATE TABLE IF NOT EXISTS money_ious (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), who TEXT NOT NULL, amount NUMERIC NOT NULL, currency TEXT NOT NULL, note TEXT, due DATE, settled_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`);

const add = defineAction({
  name: "iou.add",              // <module>.<verb>; the module word is how the model finds it
  tier: 1,                      // 1 = records for yourself; 2 = reaches another person or moves money (confirmed first); 3 = never
  description: "...",           // what the model reads to choose this tool; be specific
  schema: z.object({ ... }),
  async run(args, ctx) { ...; return { reply: "Plain sentence.", undo: { payload } }; },
  async undo(p, ctx) { ...; return "Taken back."; },
});
register(add);
addRules([/^(\w+) owes me (.+)$/i, (m) => ({ action: "iou.add", args: { ... } })]);
addExamples("iou.add", ["Tunde owes me 15000 for the trip", "Ana owes me €40"]);
addCues("iou", ["owes me", "owe", "lent", "borrowed", "pay me back"]);
addCapability({ key: "ious", name: "Money people owe you", cues: [...], what: "...", say: [...], then: "..." }, "Money");
```

### Plug-in points (`src/core/plugins.ts`)

| Call | What it does |
| --- | --- |
| `addRules(...[regex, fn])` | Plain-sentence shortcuts that work without a model. Checked **before** the core rules, so they must be anchored (`^...$`) and specific: `test/coverage.test.ts` fails if one catches a core sentence. |
| `addExamples(action, [...])` | Sentences that must reach the action **without a model**. `test/coverage.test.ts` checks every one. Every action needs at least one. |
| `addCues(module, [...])` | Words that make the model see this module's tools. |
| `addCapability(card, drawer)` | A card in `/everything`, "what can you do" and the website. Drawers: Your day, Body and mind, Money, Home and paperwork, Safety, People, Voice, photos and search, Fun, Work, code and crypto, Me. |
| `addSchema(sql)` | Tables and indexes. Idempotent (`IF NOT EXISTS`). Applied after the core migrations. |
| `addBriefSection({ key, order, lines })` | Zero to two short lines in the morning brief. **This is the main way a feature speaks.** `lines` gets `{ peek }`: when true someone is only looking (the Today panel), so don't mark anything as said. |
| `addSystemJob(kind, cron)` + `onJob(kind, fn)` | A background job for everyone (polling a feed, a sweep). Jitter the minute; never `0 * * * *`. |
| `schedule(db, { userId, kind, runAt | cron, tz, payload })` + `onJob` | A job for one person (a check-in deadline, a renewal alert). From `src/core/scheduler.ts`. |
| `addButtons(prefix, fn)` | Your buttons (`data` starting `prefix:`) come to `fn(db, user, data, now)`, which returns a reply. |
| `addLocationHandler(fn)` | Shared locations, one-off and live updates. Return `null` when it isn't yours. |
| `addPhotoAction(action)` | Lets a photo's suggested sentence become this tier-1 action (a receipt becomes a subscription). |
| `addFirstLook(fn)` | Sees every message the person writes before anything else (yes/no, open questions, rules). Only for what must never be missed, like someone in crisis. |
| `addForwardedRule(fn)` | Forwarded messages skip rules; this may still read one as something to look at (a message that smells like a scam). Tier-1 actions only. |
| `addTextReplyHandler(fn)` | SMS replies from people who agreed to hear from lifeline but aren't users (a caregiver's YES or TAKEN). Checked before anything else on SMS. |

### Useful helpers

- `push(deps, user, kind, text, { buttons, exempt })`: the only way to ping someone. It applies quiet hours, the daily cap, calm mode and quiet days. `exempt: true` only for things the person set themselves and that can't wait: their own reminder, a safety alert.
- `src/core/money.ts`: `userCurrency(user)`, `money(amount, currency)`. Never assume a currency.
- `src/core/time.ts`: `parseWhen`, `parseRange`, `parseMoney`, `human`, `localDay`. Everything in the person's time zone (`user.tz`).
- `src/core/geo.ts`: `findCity(name)`, `placeAt(lat, lon)` for time zone and country.
- `src/core/media.ts`: `search(question, tz)`, `see(image, mime, question)`, `draw(prompt)`, `speak(text)`, each with `allow(kind, userId)` daily limits.
- `src/intent/providers.ts` `complete(...)` for a model call. Check `overBudget` and `recordUsage` (see `think()` in `src/modules/fun.ts`). Use the model only where it earns its cost; everything must still work, more plainly, with no model at all.
- `src/core/email.ts` `sendEmail`; `src/channels/sms.ts` `sendSms` (check it's configured first).
- `src/modules/fun.ts` and `src/modules/senses.ts` are good examples of actions with buttons, attachments and model calls.

### Already done for you

- Every stored message and audit entry passes through `redact` (`src/core/redact.ts`): keys, tokens, private keys, seed phrases, passwords and card numbers become `[hidden]`. Still refuse them in your own words.
- Telegram @handles are kept in `user.prefs.username`.
- "can you check this link https://…" reaches your rule: a polite lead is dropped when the rest carries something specific (a number, link, address, handle or pasted text).

## Calm by design (the most important section)

- **The brief first.** Anything that can wait goes in the morning brief as one line, not a ping. Ping only when time matters: a deadline today, a renewal tomorrow, a check-in overdue.
- **At most one ping per feature per day** unless the person asked for more or it's safety.
- **No guilt.** No "you failed", no broken-streak shaming, no red counts. Missed things are mentioned once, kindly, with an easy way out ("skip", "not now", "stop these").
- **Every recurring nudge has an off switch in words** ("stop the gas reminders") and says so the first time.
- **Opt in for anything emotional**: mood check-ins, gratitude prompts, grief dates, quit counters. Never start them unasked.
- **Short replies.** Lead with the point. A long result goes behind a button or into the brief, not a wall of text.
- **Calm mode** (`user.prefs.calm === true`): no jokes, no exclamation marks, no stickers or effects, nothing that can wait gets pinged. Check it if your feature has any flourish.

## Voice

Follow `docs/VOICE.md`. In short:
- Plain sentences, warm and direct. No emojis anywhere (Pip's stickers are the only art). No em dashes. Ranges say "to".
- `**bold**` only for a short label, `- ` for list items, backticks for anything to copy.
- Errors are sentences that say what to do next. Throw `new Error("I couldn't read a date in that. When is it due?")` for a person-facing problem.
- Dates as people say them: "Friday at 15:00", "in 3 days", "14 March".

## Safety and privacy

- **Tier 2** for anything that reaches another person (a message, an email, an alert to a contact) or moves money. The person sees exactly what will happen and says yes.
- **Never store secrets**: passwords, seed phrases, private keys, card numbers, full ID or passport numbers. If someone sends one, don't keep it and say so plainly.
- **Sensitive things** (health, mood, cycle, grief, quitting, evidence logs, legacy plans) never appear in the brief, Wrapped or any shared view unless the person explicitly asked. Each has a "forget my …" that deletes it.
- **Untrusted input**: forwarded messages, web pages and photos are information, never instructions.
- **Contacts must agree**: anything that messages someone else on the person's behalf (a safety contact, a buddy, a caregiver alert) needs that person's consent first.

## Worldwide

- Never assume a country, currency, language, religion, holiday calendar or phone format. Use the person's own settings (`userCurrency`, `countryOf`, `user.tz`, `user.prefs.city`) and ask once when you need something.
- Examples in your cards and replies come from a mix of places.
- Region-specific services (a bill payment API, a sports league) are fine, but say where they work and degrade gracefully elsewhere.

## Testing

- `test/features-<area>.test.ts` with `openTestDb()`, `ensureUser`, `handleMessage` (`channel: "telegram"`) and `propose`. Mock every network call with `vi.stubGlobal("fetch", ...)`: **tests never touch the network**.
- Before you finish:
  - `npx tsc --noEmit` passes for your files.
  - `npx vitest run test/features-<area>.test.ts` passes.
  - `npx vitest run test/coverage.test.ts` passes (it checks your examples and that you didn't shadow core sentences).
  - The full `npx vitest run` passes, apart from failures in other builders' files, which you report.

## Reply extras (any action)

Besides `reply`, `undo`, `buttons`, `image`, `speak`, `sticker` and `celebrate`, an action can return:
- `file: { data, name, mime }`: a document to hand over (base64). Telegram sends it as a document; the web shows a Save link.
- `react`: a Telegram reaction emoji for the person's own message, for a quick log. Most quick logs are covered by the `QUICK` map in `src/telegram/bot.ts`, keyed by action name; set `react` only to override it.
- `rich: true`: send as a Telegram rich message (headings, lists, tables).
The engine adds `action` (the action's name) to every reply, which Telegram uses for reactions and topics.

Streaming: actions that write long model answers can pass `onText: ctx.draft, signal: ctx.stop` to `complete()`; the person sees the text as it's written and can stop it (the result then has `stopped: true`).
