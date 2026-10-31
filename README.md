# lifeline

An assistant for everyday life, for anyone: it remembers what you tell it and brings it back at the right time. Reminders, calendar, lists, medication, periods and the cycle, sleep, weight, water, mood and anything else you track, trips, spending, birthdays; and for people who build or job-hunt, jobs, companies and the people behind them, hackathons and grants, crypto prices. One memory, five channels: **Telegram, web (installable, with notifications), SMS, iMessage and email**. Anything irreversible stops at a policy gate until you confirm. Every user gets their own timezone, quiet hours, morning note, memory, voice and model budget.

```
src/
  core/       config · db (Postgres/Supabase or embedded) · migrations · scheduler · handler (shared brain) · dispatch (multi-channel send) · budget · stt · email · time
  policy/     the three-tier gate: registry · engine (pending / confirm / undo / audit)
  intent/     rules (no model needed) · providers (Anthropic + Gemini) · model · personas
  modules/    reminders · calendar · medications · classes · trips · life · extras (lists, dates, weather, fx, summarize)
              hackathons · prices/portfolio · jobs · launches · scout · bills · trading (shadow) · digest
  pollers/    HackathonRadar · Devpost · Superteam Earn · ETHGlobal · Colosseum · Hack Club
  telegram/   grammY: text, voice, .ics, buttons, /persona, Business connection drafts
  channels/   sms (Twilio) · imessage (BlueBubbles / Sendblue)
  web/        Hono server + webhooks (the web app itself lives in web/ at the repo root, also a Vercel project)
test/         1,381 tests on a real Postgres engine: gate, modules, channels, web, NL coverage (150 sentences), load
```

## Running it on Railway (with Doppler + Supabase)

1. **Supabase** → New project → Project Settings → Database → copy the **Session pooler** URI (port 5432). That's `DATABASE_URL`. Tables are created on first boot (`npm run schema` prints the SQL if you'd rather run it in the SQL editor first; it's also in `supabase/migrations.sql`).
2. **Telegram** → @BotFather `/newbot` → `TELEGRAM_BOT_TOKEN`. Anyone with the bot's link or the website joins until the circle is full (`MAX_USERS`, default 55); put your own Telegram id in `ALLOWED_USER_IDS` to be the owner, who always gets in and can send `/circle`. In BotFather `/setdomain` → the web app's domain (your Vercel domain, or the Railway one), so the web app's Telegram login works.
3. **Doppler** → `doppler setup` (project `lifeline`, config `prd`) → paste every secret from `.env.example` → Doppler dashboard → Integrations → Railway → sync to your service. Railway's env then stays empty of secrets.
4. **Railway** → New project → Deploy from repo (this folder; `railway.json` picks the Dockerfile) → Settings → Networking → Generate domain → put it in `PUBLIC_URL`. Health check is `/health`. Railway sets `PORT`.
5. **Model** → `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY`. Gemini also powers the grounded scout. `DAILY_MODEL_BUDGET_USD` caps each friend.
6. **Optional** → `OPENAI_API_KEY` (voice notes), `SMTP_URL` + `EMAIL_FROM` (email fallback), `HACKATHONRADAR_API_KEY`, `GITHUB_TOKEN` (higher rate limit), `FLUTTERWAVE_SECRET_KEY` (bills, after KYC).
7. **SMS** → Twilio number → Messaging webhook `POST https://<domain>/webhooks/twilio`. Set the three `TWILIO_*` vars.
8. **iMessage** → there's no Apple API. Either run [BlueBubbles](https://bluebubbles.app) on a Mac you own (free; set `IMESSAGE_PROVIDER=bluebubbles`, its URL/password, and its webhook to `https://<domain>/webhooks/imessage?secret=<WEBHOOK_SECRET>`), or use Sendblue (hosted, paid per message; `IMESSAGE_PROVIDER=sendblue`).

Local:

```bash
cp .env.example .env         # DATABASE_URL empty = embedded DB in ./data
npm install && npm test      # 1,381 tests
npm start                    # Telegram polling + web on :3000
npx tsx src/cli.ts chat      # the brain with no channel
npx tsx src/cli.ts poll      # hackathon pollers once
npx tsx src/cli.ts scout "solana perps" "partnerships"
```

Day one for each friend: `/start` on Telegram → `timezone Europe/London` → `/persona` → `interests: solana, ai` → `link` (gives a 6-char code) → open the web app and paste it, or text `link <code>` to the SMS/iMessage number.

## The product surface

**Web app** (`web/`, served by Railway at `/` and deployable to Vercel on its own domain; see `web/README.md` and `docs/DESIGN.md`). It opens on **the path**: today as a landscape drawn from your real data. The sky follows the real hour where you are (dawn, day, dusk, stars), every reminder, event, class and dose is a lantern beside the lane, ticked behind Pip and lit ahead of him, and Pip walks at the position of now, stopping with his watch up when something waits on your yes. Everything else is letterpress cards with a flat plate in the colour of their kind. Five palettes (Manor, Claret, Riviera, Tobacco, Ivory), each by day and by night, changed with a circle that opens from the button you pressed. ⌘K or / opens "say anything" from any page. Views: Today, Chat, Lists, Health, Trips, Money, and for people who build or job-hunt, Hackathons and Scout (in the bar if you use them, otherwise under More), plus What I do and Settings. Fonts are self-hosted (Libre Caslon Display and EB Garamond, both OFL). A Health page holds the cycle strip, doses, habits and anything measured. Installs to a phone home screen.

**Themes**: five palettes, each with a day and a night version, switchable in Settings and remembered per account and per device: **Manor** (linen, bottle green, brass), **Claret** (bone, oxblood, gold), **Riviera** (sand, navy, brass), **Tobacco** (leaf, amber, cream) and **Ivory** (paper, ink, a little brass). Type is Libre Caslon Display for headings and EB Garamond for text.

**How it talks** is a design decision, written down in `docs/VOICE.md` and enforced in code: every reply passes through `src/core/voice.ts` (no emoji, no em dashes, no ids, no robotic residue), every module is written in that voice, and a persona changes register only. The bot can explain itself: ask "can you track my meds?" or "what can you do" and `src/intent/capabilities.ts` answers with what, an example sentence, and what happens next; the same catalogue feeds the model's prompt and the web app's "What I do" page. When something essential is missing, an action asks one question and remembers it (`needs`/`fill` hooks, `src/intent/thread.ts`): "plan a trip to Accra" gets "When are you going?", and the next message is read as the answer, "skip" carries on without it.

**Pip, the mascot** is a tortoise with spectacles and a pocket watch (`src/core/pip.ts`, `web/mascot.js`). Slow on purpose: he reads everything before he moves, never puts down what he carries, and is still there in the morning. Every state he shows is a real state of your day: thinking while a message is with the brain, sitting up with the watch out when something waits on your yes, a nod when you tick something, lids half down in quiet hours, straight at you when nothing is kept yet. His lines come from a book of lines per state, or from the model in your voice. Original SVG, no image assets.

**Telegram** — HTML formatting (bold section labels, clickable links), a menu picture of the day with drawer buttons under it (no keyboard taking over the chat), typing indicator, and the same inline Confirm/Cancel/Undo buttons as before.

**Plain sentences, not command syntax.** Three layers: strict command phrases (fast, exact) → the loose natural-language layer (`src/intent/loose.ts`: politeness stripped, the time expression lifted out with chrono, cue words mapped to the action registry) → the model when a key is set. "can you remind me to call Ada tomorrow at 9am", "I need to buy milk, eggs and bread", "who's building perps on solana", "let me know when sol goes above 250", "I'm going to Accra on dec 20 until dec 27 with a budget of 600 usd", "be more formal" all work with no model. `test/coverage.test.ts` holds 150 such sentences and fails if any registered action becomes unreachable.

## Channels

| Channel | In | Out | Buttons | Notes |
|---|---|---|---|---|
| Telegram | text, voice notes, video notes, photos, .ics, Business messages | text, voice notes, pictures, Pip stickers, animated dice, coloured inline buttons, Copy buttons | tap | `/menu` (one message that changes in place: Today, Lists, Health, Money, Trips, Play, Settings, with ‹ Back and OK), `/everything`, `/play`, `/settings`, `/link`, `/doctor` |
| Web | chat box, mic, photos | chat, voice replies, pictures + live sidebar | click | sign in through the bot or a link code; sessions 30 days |
| SMS | Android gateway or Twilio webhook | gateway or Twilio REST | `1) Yes 2) No`, reply with the number | links by texting `link <code>`; strangers get silence unless they mention lifeline |
| iMessage | BlueBubbles / Sendblue webhook | relay REST | same as SMS | see docs/IMESSAGE.md |
| Email | Resend inbound webhook (signed, SPF/DKIM checked) | Gmail SMTP or Resend | same as SMS | forward bookings and invites; see docs/EMAIL.md |

Outbound pushes go to the user's preferred channel and fall back down the chain (Telegram → iMessage → SMS → web → email). Every channel calls the same `handleMessage`/`handleCallback`, so a confirmation started on Telegram can be finished by texting `1`.

## What it does

| Area | Say | Behaviour |
|---|---|---|
| Chat | anything | With a model key: free conversation, any topic, opinions, the voice you picked (`/persona` or `voice <describe it>`) |
| Voice | send a voice note · `voice replies always` · `use a calm voice` · `read that to me` | Heard with Groq Whisper (or OpenAI/Gemini), answered like text; talks back with Gemini TTS as a real voice note |
| Photos | send a receipt, flyer, medicine box or screenshot, optionally with "log this" or a question | Says what's in it, answers the caption, searches "where can I buy these", offers to keep the spend/event/doses |
| Drawing | `draw a lion in agbada` · `draw yourself as an astronaut` | Cloudflare Workers AI (free), Gemini image if billed, Pollinations fallback |
| Search | `search who won last night` · or just ask something current | Gemini with Google Search grounding, sources linked |
| Email | `email me my shopping list` · `email ada@x.com saying I'll be late` | To yourself straight away; to others after a yes |
| Fun | `/play` · `quiz me on football` · `riddle` · `would you rather` · `roll a dice` · `jollof or fried rice, pick for me` · `roast me` · `hype me up for my exam` · `my week wrapped` | Scores and streaks kept; hype comes as a voice note; the week wrapped is in Sunday's brief |
| Reminders | `remind me to call Ada tomorrow 9am` · `… every weekday at 7` | Done / Snooze |
| Calendar | `add dentist on friday 3pm` · `what's on this week` · send `.ics` | 30-min alert, overlap warning |
| Medications | `med Vitamin D at 8am and 8pm` | Taken / Skip, 90-min nudge, adherence, supply countdown. Reminds, never prescribes |
| Classes | `class Algorithms on tue 10:00-12:00 at Room 4` · `assignment Lab 3 due next monday` | 15-min class alerts; 2-day + morning-of assignment alerts |
| Trips | `plan a trip to Accra from dec 20 to dec 27 budget 600 usd` · `add flight … to trip` · `packed charger` · `trip` | Checklist, itinerary, budget, 7/1-day nudges |
| Lists | `todo: taxes, call bank` · `shopping: eggs, bread` · `bought eggs` · `lists` | Any number of named lists |
| Dates | `Ada's birthday is march 14` · `countdown visa appointment dec 3` · `dates` | 7-day, 1-day, day-of alerts; birthdays repeat yearly |
| Habits / spend / notes / memory | `did gym` · `spent 12 euros on lunch` · `note: …` · `remember I'm vegetarian` · `/memory` | Streaks, summaries, provenance-tagged memory with Sunday review |
| Weather / FX / summarise | `weather Lisbon tomorrow` · `100 usd to inr` · `2 sol to usd` · `tldr https://…` | Open-Meteo, ECB rates + CoinGecko, model summary |
| Hackathons | `hackathons solana` · `track Colosseum Frontier due nov 30` · `submitted/won Frontier` · `ledger` | 6 sources deduped, odds-style rank, 72h/24h/6h alerts, payout chase, win rate |
| **Scout** | `scout solana perps for partnerships` · `scout ai agents to apply` · `watch scout fintech africa` · `outreach Perpz: want to integrate your SDK` | New/upcoming projects by niche across web3, crypto, AI, tech, web2 with official site/X/Telegram/Discord/GitHub and founders'/handlers' public handles; Gemini-grounded with citations when a key is set; outreach drafted, you send |
| Prices / portfolio | `alert when sol above 250` · `alert me if eth moves 10% in 6h` · `price btc eth` · `watch wallet <addr> on solana` · `portfolio` | 5-min polling; refuses keys/seeds |
| Jobs | `watch jobs lever dorahacks for growth` · `watch jobs remoteok for solana` · `jobs` | Greenhouse/Lever/Ashby/RemoteOK/Remotive; matches in the digest; never applies |
| Launches | `launches` · `contact <github user>` | Show HN, GitHub, DexScreener + GoPlus (flagged tokens hidden) |
| Bills (Nigeria only) | `billers airtime` · `pay 2000 to BIL099 for 08012345678` | Flutterwave Bills v3, Tier 2 echo-and-confirm |
| Trading | `follow <wallet> on polymarket max 10/trade 50/day` · `shadow report` | Shadow only; blocked-country users refused; no execution |
| Business | connect the bot under Telegram → Business → Chatbots | Drafts replies to messages in the chats you chose and sends the draft to you; never auto-replies |
| Calm | `quiet day` · `calm mode on` · `pause for 3 hours` · `I'm back` | Holds every nudge except what you set yourself; calm mode keeps replies gentle and lets things wait for the brief |
| Safety | `is this legit: …` · forward a suspicious message · `check on me: walking home, 25 min` · `show my emergency card` · `log incident: …` | Scam red flags (never says "safe"), check-ins that alert only contacts who said yes, an emergency card, a tamper-evident incident log, a careful "if something happens to me" plan. See docs/features/safety.md |
| Money and paperwork | `Ana owes me 40` · `Netflix 15.49 monthly renews on the 3rd` · `my passport expires 3 March 2027` · `rent 1200 due on the 1st` · `I want to buy AirPods for 249` · `add debt: card 2400 at 24%` · `invoice 1500 to Acme due 30 Nov` · `start a savings circle` · `I'm moving to Canada` | IOUs, subscriptions, document expiry, rent, warranties, a cool-off for impulse buys, debt plans, invoice chasing, tax year, savings circles (ajo, chama, tanda, tontine), relocation checklist. See docs/features/money.md |
| Wellbeing and people | `call Mum every Sunday` · `check on my mood every evening` · `ask me for three good things at 9pm` · `I quit smoking on 1 Oct` · `help me do my taxes` · `buddy up on running with @ana` · `teach me Spanish` | All opt-in and private; crisis messages point to findahelpline.com and the local emergency number. See docs/features/wellbeing.md |
| Home and the world | `refilled the gas` · `power cut from 6pm to 11pm` · `service the AC every 6 months` · `follow Arsenal` · `prayer times` · `next public holiday` · `status of BA75` · `my year wrapped` | Utilities and outages, home jobs, sports, faith rhythms, holidays and long weekends, flights, the year wrapped. See docs/features/home.md |
| Work, code and crypto | `watch https://mysite.com` · `watch releases of vercel/next.js` · `decode jwt …` · `explain cron 0 9 * * 1-5` · `gas now` · `explain tx 0x…` · `is this token safe 0x… on base` · `funding on ETH` | Uptime with TLS and domain expiry, GitHub and packages, status pages, dev tools, gas, wallet activity, tx explainer, token and approval checks, claims, funding, Polymarket, ENS/SNS. Read-only. See docs/features/tech.md |
| Creative and NFTs | `minted 2 Pudgy Penguins at 0.05 ETH` · `my mints` · `Azuki mint opens 3 Nov 18:00 UTC` · `commission: portrait for Tolu, 150, due 20 Nov` · `open call: Lagos Photo closes 15 Dec` · `releasing my single on 12 Dec` · `idea: …` · `quote for a logo, 12 hours at 40` | Mint log with floors and rough P&L, mints spotted in watched wallets (asks first), mint calendar, commissions, open calls, release planner, ideas, practice time, quotes, portfolio links. See docs/features/creative.md |
| Trip plans | `help me plan a trip to Liechtenstein` · `my plans` | Asks when and from where, researches visa, routes, stays, days and food with live search, publishes a shareable page. See docs/TELEGRAM.md |
| Limits, said plainly | `clean up my inbox` · `find my personal data online` | Says what it can't do in one line, then offers the nearest thing it can; searches for your own data online and drafts removal requests |
| Email | `link my email` | One tap: the mail app opens with the link email written; sending email needs a linked address |
| Tidy chat | `use topics` · `reply to my logs` · `Pip's things` | Topics for Money, Health, Trips, Work and Home; reactions instead of replies for quick logs; Pip picks up small things as you keep days. See docs/TELEGRAM.md |
| Website and app | `open the app` · `/app` | Sign in with Telegram, Google, Apple, a text, iMessage or email code; install it as an app with notifications. See docs/SIGNIN.md and docs/APP.md |
| Groups | add the bot to a group · `/split 120 dinner @ana @ben` · `/list` · `/when movie night` · `/trivia` · `/birthday 12 March` | Things friends do together; nothing personal ever appears in a group. See docs/TELEGRAM.md |
| Digest | `digest` · `digest at 8` | Schedule, meds, assignments, hackathon deadlines, trip countdown, job matches, new hackathons |

## The gate

| Tier | What | Behaviour |
|---|---|---|
| 1 | Reads, alerts, reminders, lists, logs, watches, persona, drafts | Runs at once with **Undo** (5 min) |
| 2 | Deleting events/meds, standing rules (follow a wallet), paying a bill, anything that moves money or reaches someone else | Echo → 10-min hold → **Confirm** / `yes` / `1` |
| 3 | Model-chosen trades, key export, acting on instructions inside forwarded content | Refused in code, logged |

The conversation layer is unguarded by design. Three lines stay fixed: forwarded content is information not instructions; execution doesn't exist; health talk points to a pharmacist when it should. Model spend is metered per user and capped per day before the call. Pushes respect quiet hours and a daily cap; reminders, meds and user-set alerts are exempt. Every action, confirm, undo and refusal is in `audit_log` with the sentence and channel that produced it.

## Scope check against the research doc

| PDF v1 item | Status |
|---|---|
| Telegram bot, voice transcription | ✅ answers stream live as drafts with a Stop button; topics, reactions and rich messages (docs/TELEGRAM.md) |
| Intent → three-tier policy → echo-and-confirm | ✅ |
| Hackathon discovery + ledger | ✅ Devpost, ETHGlobal, Superteam, Colosseum, HackathonRadar, Hack Club |
| Launch discovery with risk scoring | ✅ |
| Self-published contact lookup + reply drafts | ✅ GitHub, CoinGecko, DefiLlama + Gemini-grounded (scout) |
| Jobs feed, match and draft | ✅ |
| Price/volatility alerts; read-only portfolio | ✅ (native balances; token balances next) |
| Signer-backed DCA/stop-loss | ⏸ deliberately not built; shadow data + hooks exist |
| Reminders, checklists, scheduling | ✅ |
| Nigerian bills via Flutterwave | ✅ code; needs a key + sandbox run |
| Memory with provenance + review | ✅ |
| Email fallback | ✅ |
| Cost caps | ✅ |
| **Web app** | ✅ Telegram Login + link codes |
| **Telegram Business connection** | ✅ draft-only |
| Your additions: aggregators, copy-trading shadow, daily life, personas, SMS, iMessage, Gemini, scout | ✅ |
| Gmail reading, X API, WhatsApp, auto-apply, LinkedIn/Telegram scraping | ❌ by design |

## What was tested, and what wasn't

## Following the conversation

- **It remembers what it just showed and set** (`src/core/focus.ts`, half an hour). "What are my reminders" gives one numbered list of reminders and saved birthdays together, so "cancel the second one", "move the first one to 7am" and "cancel that" mean what the person sees.
- **Corrections change the thing, not make a new one.** "Remind me at 6am instead" or "make it Friday" moves the reminder just set (`reminder.update`); a repeating one keeps its pattern and only its time changes.
- **Two asks in one sentence run in order.** "Cancel the second one and remind me of Bunmi's birthday in 2 days" does both. It only splits where the second part is clearly its own ask, so "remind me to buy bread and milk" stays one reminder.
- **Names come out tidy:** "bunmis birthday" is saved as Bunmi's birthday.
- **Models get the history clean.** Replies go to the model exactly as they were said; what each reply did goes in a short log in the system prompt. Models used to copy a "[did web.search]" tag into new replies, sometimes without searching at all. Now any such tag is stripped, and a reply that pretends to have searched becomes a real search.
- **Search doesn't give up.** Gemini's search on the main model, then the lighter one (separate free quotas), then OpenAI or Groq if set, then a public results page read by whichever model is up. If all of that fails, lifeline says so, tries again a minute later and sends the answer itself.
- **Questions it can't do directly still get an answer.** "What matches are on today" works without following a team; "find me pictures of an Oxford shirt and a chore jacket" gives a picture search for each item, one tap away, and offers to draw one.
- `test/followup.test.ts` replays the 31 October screenshots word for word.

## Several steps for one message

`src/intent/agent.ts`. When a message needs more than one action ("delete the bank reminder and also put Bunmi's birthday down for 2 November"), the model calls a tool, sees what it did, and calls the next, up to four steps, then adds a last word only if something is left to say. Every step goes through the policy engine like any single action, so:

- anything that needs a yes stops the run there, after saying what's already done, and shows the usual Yes / No;
- a question back ("when should I...?") stops it and waits for the answer;
- the same call twice in a row is caught, so it can't go round in circles.

A single ask still costs one model call: the loop only asks again when the message has more than one ask in it, or when a step only looked (a list) and the message wants something done with what it found. Continuation steps use the stronger model. The person sees each change in order (with Undo on the last), never the scratch work.

**Scores** come from the sports listings first ("what's the score in the Chelsea match", "is Man United playing today"): live and full-time numbers, refreshed while a game is on, with a web search only when the team isn't listed.

## Delivery and the owner's numbers

- **Each reminder fires once.** The scheduler claims due jobs in one statement (`FOR UPDATE SKIP LOCKED`, with a three-minute lease). Two servers overlapping during a Railway redeploy can't both send the same reminder, and a crash mid-run frees the job after the lease.
- **A failed one-off is retried, not lost.** It's tried again after one minute, then five, then given up (`jobs.attempts`). Cron jobs carry on at their next time either way.
- **On time is measured.** Every timed run (reminders, doses, class, event, trip and date alerts, safety check-ins, mint drops) is logged with how late it started (`job_runs`). Every app notification is logged as delivered or not (`push_log`), and every model reply as quick, stronger or rescued (`model_events`). These hold counts and kinds only, never content, and are pruned after 90 days.
- **`/stats`** (owner only, in Telegram) shows the six numbers against their targets: reminders on time within a minute (99%), app notifications delivered (95%), new people with a first win in 10 minutes (70%), web people with notifications on (70%), week-4 people still keeping things (40%), and thinking cost per active person per day (under $0.05), with the share of replies the stronger model had to rescue (under 10%).
- **Busy chats don't hold up others.** Telegram updates run through grammY's runner: chats are handled side by side, each chat in order. A Telegram rate limit (429) waits and retries (auto-retry).
- **Late runs are honest.** After an outage, a morning brief more than three hours late is skipped, and a dose that fires over 30 minutes late says when it was due. A dose that wasn't delivered is followed up in ten minutes, not ninety.
- **Clock changes.** Times said in words ("Tuesday at 9am") are built on the wall clock in the person's zone, so they stay right across a daylight-saving change. Changing city or brief hour moves every repeating job's next run at once.
- Anyone can ask "what did you do for me this week?" for their own counts, which also appear in Sunday's morning brief.

Tested here (1,381 tests, real Postgres engine, plus a headless-Chromium walkthrough of every web view in light and dark themes): the gate in every tier, undo, expiry, scheduler re-arming, push caps, every module's happy path, ICS parsing, the shared handler across every channel, link codes, SMS numbered replies, iMessage payload parsing for both relays, dispatch fallback, the web app's auth (signed Telegram payload, bad signature, link code, logout), chat and button endpoints, webhook signature refusal, Gemini schema cleaning, load (2,000 due jobs drained in claims of one, 50 to a tick, with none sent twice; 200 users messaging concurrently in 245 ms with no cross-talk), and a cold boot of the web server.

Not testable from this sandbox (no outbound network, no keys): live Telegram, Twilio, BlueBubbles/Sendblue, the model providers, CoinGecko/Open-Meteo/frankfurter, and every poller against its live site. They're written against current documented shapes; each one fails soft and logs. First thing after deploy: `npx tsx src/cli.ts poll`, `scout "ai agents"`, send one voice note, and text the Twilio number `link <code>`.

## Next

1. Token balances (Alchemy/Helius free tiers) in `portfolio`.
2. Read-only Google Calendar and Gmail in the brief (see the audit doc's plan).
3. Circle features: shared trips with cost splits, shared hackathon teams, "who's free Friday" across linked calendars, a group digest channel.
4. Document extraction with echo-back (bills, syllabi, booking confirmations → dates and amounts).
5. Google Calendar two-way sync (sensitive scope, no CASA).
6. Signer-backed rules for your own wallet only, after two weeks of shadow data.
7. WhatsApp as a business-own bot if the circle wants it, never as the general assistant.

## Privacy note for the circle

Medication names, class times, spend logs, wallets, scouted contacts and chat history live in your Supabase project and, with a model key, in the vendor's short-term logs. Telegram cloud chats are server-readable; SMS is plaintext in transit; iMessage relays see every message. Tell the people in your circle before they join, keep Doppler as the only place secrets live, and never paste keys or seed phrases into any channel — the bot refuses to store them, but the message still exists.
