# Wellbeing and people

Folder: `src/modules/features/wellbeing/`. Tests: `test/features-wellbeing.test.ts`. Tables `well_*`, buttons `wb:*`, per-person settings under `users.prefs.wb`.

Every feature here is opt-in, private and calm. Pings go through `push()`, so quiet hours, the daily cap, calm mode and quiet days all apply. The exceptions, marked `exempt`, are things the person set up themselves and that can't wait: a time capsule on its day, a 25-minute task check-in they tapped for, and caregiver alerts. Nothing sensitive (mood, symptoms, good things, counters, remembrance) goes in the brief unless the person turned that feature on. None of it goes in Wrapped. Wrapped reads only `weekStats`, which never touches these tables.

## Files

| File | What |
| --- | --- |
| `shared.ts` | `prefs.wb` helpers, `rx()` for polite anchored rules, past-tense dates, `think()` (a gentle model call with a plain fallback), the `CRISIS` words and `crisisReply()`, `tell()` (a message to another person in the circle, through `push()`), button routing, first-time stop hints |
| `mind.ts` | 3 mood check-ins, the burnout radar, the crisis path; 4 three good things; 11 life patterns |
| `people.ts` | 1 keep in touch; 7 caregiver mode (with `handleCareSms`); 12 accountability buddies |
| `health.ts` | 2 checkups, the symptom log, the doctor summary |
| `change.ts` | 5 quit and no-contact counters; 8 the dreaded-task breaker |
| `remember.ts` | 6 remembrance dates; 9 time capsule; 10 on this day |
| `lessons.ts` | 13 language drops: with a model, about five words or phrases built from the person's last 7 days (list items, calendar titles, trip destinations, spending categories; never health, cycle, mood or medication data, and anything that reads like health is filtered out of those too), one example sentence and a recall question for tomorrow, answered at the top of the next day's drop. Without a model (or over budget), the built-in starters for Spanish, French, Portuguese, German and Italian, with a recall question from their own words. Uses `think()` (budget checked, usage recorded); one call a day, cached in `prefs.wb.lang.cache` |
| `privacy.ts` | `wellbeing.forget`: "delete my symptom log / good things / quit counters / remembrance dates / time capsules / keep in touch list / checkups / caregiver reminders / buddies" (tier 2) |

## Jobs

Per person: `well_mood`, `well_radar` (weekly), `well_good`, `well_touch` (only for people who asked for a ping), `well_quit` (daily milestone sweep), `well_lesson` (ping mode only), `well_remember` (one-shot, re-armed yearly), `well_capsule` (one-shot), `well_task_check` (one-shot), `well_care_dose` (daily cron, starts only after a YES), `well_care_check` (two hours after each dose text), `well_send` (a message to someone else in the circle).

## Brief sections

`well_remembrance` (15, calm mode only, on the day, only if asked), `well_radar` (20, only a radar note that push held back), `well_checkups` (30: a week before, on the day, then monthly while open), `well_touch` (40), `well_buddies` (50), `well_quit` (55, only after "show my counters in the brief"), `well_lesson` (60, brief mode), `well_insight` (70, Mondays, opted in), `well_otd` (80, on by default, off with "stop on this day").

## Caregiver mode: SMS reply hook (core change needed)

Inbound SMS reaches `handleTextChannel` in `src/channels/sms.ts`, which this area can't change. Until the core calls the hook, Mum's YES, NO, STOP and TAKEN replies are dropped (her number isn't linked, so the channel stays silent). The hook:

```ts
import { handleCareSms } from "../modules/features/wellbeing/index.js";
// in handleTextChannel, for channel "sms", before the link/stranger checks:
if (channel === "sms") { const care = await handleCareSms(db, from, t); if (care) return care; }
```

`handleCareSms(db, from, text)` returns the reply text, or `null` when the message isn't a caregiver reply. In that case the core carries on as usual, so a linked user's own texts are unaffected. It handles YES and NO (only while a consent request is open), STOP (any time) and TAKEN (an open dose in the last 18 hours). It tells the person who set things up through `tell()`.

## Phrasings and the core's rules

The core's rules run before the plugins' rules, so a few natural sentences go to core actions:
- "remind me to call Mum every Sunday" creates a core reminder. For keep in touch, say "call Mum every Sunday".
- "remember Grandma's birthday 12 August" goes to memory. Say "remembrance: 12 August, Grandma's birthday".
- "send this to me on my birthday next year: ..." goes to `date.add`, because the core's birthday rule matches any "...birthday <more>". Say "time capsule for my birthday: ...".
- "forget my good things" goes to `memory.forget`. Say "delete my good things".

## Crisis path

`CRISIS` in `shared.ts` matches specific phrases about self-harm or not wanting to be alive. Everyday phrases ("I cut myself cooking", "this is killing me") don't match. The reply is warm and short. It points to https://findahelpline.com (international, finds free local lines) and to the local emergency number: we name the number only for countries we're sure of, otherwise we say "your local emergency number". It never names a single country's helpline and never lectures. Nothing is stored. The crisis rule is this area's first rule, and mood notes and good things check it too.

## Their clock, not yours (caregiver texts)

The daily text goes out at the time you said in the other person's time zone. It's worked out from their number's country code (`src/core/phonezone.ts`) when that country keeps one clock. For countries with several (the US and Canada on +1, Brazil, Mexico, Australia, Russia, Indonesia and a few others), lifeline asks which city they're in, unless it's your own country, when your clock is used. You can also say it up front: "remind Grandpa to take his pill at 9am by text on +1 416 555 0100, he's in Toronto". Messages to you say "08:00 their time (Lagos)" whenever the clocks differ.
