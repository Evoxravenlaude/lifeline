# Telegram: groups, guest calls and the app

## In a group

Add the bot to a group (only someone already in the lifeline circle can; anyone else's add makes it say so and leave). In a group it does things people do together, and nothing personal:

- `/split 120 dinner @ana @ben` splits a bill equally between the people named and you. Add "not me" to leave yourself out, or "between 4" when not everyone is on Telegram. Each person taps **I've paid my share**; whoever paid can tap **Mark all paid**.
- `/tab` lists what's still owed in the group.
- `/list rice, eggs` adds to the group's one shared list; `/list` shows it with a tap to tick each thing.
- `/when movie night` posts a poll of the next few evenings, in the time zone of whoever brought the bot in.
- `/trivia` posts a quiz poll.
- `/birthday 12 March` and lifeline says happy birthday in that group on the day, after 09:00. `/birthday forget` takes it back.
- `/help` shows this, to the person who asked only.

Plain words work too when you mention the bot: "@lifeline split 60 pizza with @ben".

How it stays calm and private:
- A group message never reaches the personal assistant. Reminders, health, money and memories never appear in a group.
- Help and mistakes are sent as ephemeral messages, seen only by the person who asked. Where Telegram can't, they're posted normally.
- With privacy mode on (Telegram's default) the bot only sees commands, mentions and replies to it. Leave it on.

## Guest calls

Telegram lets people call a bot into a chat it isn't in by typing its @name. lifeline answers there with things meant for everyone in that chat: a split worked out ("@lifeline split 90 between 3"), a short answer to a general question for people in the circle, or a line on what lifeline is. It never answers from anyone's own records.

To switch it on, enable guest mode for the bot in @BotFather (look under the bot's settings; the exact menu name may change as Telegram rolls it out). `/doctor` says whether Telegram reports it as on. If it's off, nothing changes for anyone.

## The app inside Telegram

The menu (`/menu`) has **Open the app**: lifeline's website opens inside Telegram and signs in by itself, with no code to type. It uses Telegram's signed launch data, checked on the server (`POST /auth/webapp`).

It needs `WEB_URL` set to the https address of the website (the Vercel address). Without https the button doesn't show. `web/vercel.json` allows the page to open inside Telegram's desktop and web apps.

## Small touches

- A real milestone (a 7, 30, 100 or 365 day habit run) comes with Telegram's confetti effect, in a one-to-one chat only, and never in calm mode.
- Streaks are kinder: one missed day a week is a rest day and keeps the run going. A run that ends says what the best one was, never that it was broken.
- Live location updates now reach the bot (needed for safety check-ins).

## The menu, redesigned

- `/menu` sends a real photo: the dashboard, drawn in the website's paper and ink (`src/core/dashboard.ts`). It shows only what's real: what's still to come today with times (events, reminders, classes, doses), later this week when today is light, doses taken, this week's spending and where most of it went, what's coming (a trip, a birthday, a renewal, a document running out), and anything waiting on a yes. "updated 08:12" sits in the corner.
- The text under it is the photo's caption, written as a small tree, with the menu buttons below. Tapping the picture opens Telegram's photo viewer, where it can be saved. No outside link.
- Moving around the menu swaps the picture in place: each section (Today, Lists, Health, Money, Trips, Play, Settings) has its own picture with its real rows. A long page shows its start and a "Read it all" button.
- The home dashboard keeps itself current. When what it says changes (a dose taken, a reminder passed, a spend logged, something new waiting), it's redrawn where it is, quietly (edits never notify). It's checked every five minutes and right after anything you change. Telegram lets a bot edit a message for about two days; after that, `/menu` sends a fresh one.
- "plain menu" turns the pictures off for one person.
- Lists in any reply are drawn as a tree: `├` for each item, `└` for the last.
- The command list behind the Menu button is six commands: menu, today, everything, app, settings, help. The old ones still work if typed.

## Trip plans

"Plan a trip to Tunisia" (or "help me plan…", "itinerary for Kyoto") goes the way a person would do it:

1. A couple of anchors: when, and what kind of trip. If lifeline knows their city, it plans from there and says so.
2. "On it." with what it's about to do (visa rules for their passport first, since they set the clock).
3. One small message ticks through the steps as they finish, then settles to "Completed N steps".
4. "Your Tunisia plan is built. Publishing the full itinerary now."
5. The picture comes into the chat as a photo, with the plan under it: the link (on the website's own address), the one thing that sets the clock, where it would base them, and two questions to shape the next pass.

The page lives at `/plan/<id>` on the website (unlisted, not indexed; "delete my Tunisia plan" takes it down). With a date, the trip is also added to their trips with a packing list. "plan a trip to Accra from dec 20 to dec 27" still makes the quick version.
