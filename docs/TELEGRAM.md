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

- `/menu` opens a home screen with a picture card above it, drawn in the website's paper and ink: a greeting, the date, Pip in a pose that fits the hour, and three plates (what's next, what's open or waiting, this week's spending). Each section (Today, Lists, Money...) has its own card. Underneath, the facts read as a small tree, the way a dashboard does.
- The card is a picture at a signed address that expires in two days (`/card/<kind>.png`, drawn by `src/core/cards.ts`, served by `src/web/extras.ts`). Telegram fetches it, so it needs `PUBLIC_URL` set to the server's https address. Without it the menu is text only, which still works. "plain menu" turns the picture off for one person.
- Lists in any reply are drawn the same way: `├` for each item, `└` for the last.
- The command list behind the Menu button is six commands: menu, today, everything, app, settings, help. The old ones still work if typed.
- Long work (researching a trip plan) shows its steps in one small message that updates as it goes, then settles to "Completed N steps", with the answer below.

## Trip plans

"help me plan a trip to Liechtenstein" asks when and from where, then researches visas for the person's passport, getting there, where to stay, what to do and where to eat with live web search, and writes it up as a page at `/plan/<id>` on the server (unlisted, not indexed, taken down with "delete my Liechtenstein plan"). The reply leads with the one thing to start first, usually the visa. "plan a trip to Accra from dec 20 to dec 27" still makes a quick trip with dates and a packing list.
