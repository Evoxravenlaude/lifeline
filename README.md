# lifeline

A personal agent for a private circle, built to *Personal Telegram agent for daily life* (26 Oct 2026). One brain, four channels: **Telegram, web, SMS, iMessage**. It watches, reminds, drafts, scouts and chats on its own; anything irreversible stops at a policy gate until you confirm. Every user gets their own timezone, quiet hours, digest, ledger, memory, voice and model budget.

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
test/         192 tests on a real Postgres engine: gate, modules, channels, web, NL coverage (150 sentences), load
```

## Running it on Railway (with Doppler + Supabase)

1. **Supabase** → New project → Project Settings → Database → copy the **Session pooler** URI (port 5432). That's `DATABASE_URL`. Tables are created on first boot (`npm run schema` prints the SQL if you'd rather run it in the SQL editor first; it's also in `supabase/migrations.sql`).
2. **Telegram** → @BotFather `/newbot` → `TELEGRAM_BOT_TOKEN`. Friends message @userinfobot once → `ALLOWED_USER_IDS`. In BotFather `/setdomain` → the web app's domain (your Vercel domain, or the Railway one), so the web app's Telegram login works.
3. **Doppler** → `doppler setup` (project `lifeline`, config `prd`) → paste every secret from `.env.example` → Doppler dashboard → Integrations → Railway → sync to your service. Railway's env then stays empty of secrets.
4. **Railway** → New project → Deploy from repo (this folder; `railway.json` picks the Dockerfile) → Settings → Networking → Generate domain → put it in `PUBLIC_URL`. Health check is `/health`. Railway sets `PORT`.
5. **Model** → `ANTHROPIC_API_KEY` and/or `GEMINI_API_KEY`. Gemini also powers the grounded scout. `DAILY_MODEL_BUDGET_USD` caps each friend.
6. **Optional** → `OPENAI_API_KEY` (voice notes), `SMTP_URL` + `EMAIL_FROM` (email fallback), `HACKATHONRADAR_API_KEY`, `GITHUB_TOKEN` (higher rate limit), `FLUTTERWAVE_SECRET_KEY` (bills, after KYC).
7. **SMS** → Twilio number → Messaging webhook `POST https://<domain>/webhooks/twilio`. Set the three `TWILIO_*` vars.
8. **iMessage** → there's no Apple API. Either run [BlueBubbles](https://bluebubbles.app) on a Mac you own (free; set `IMESSAGE_PROVIDER=bluebubbles`, its URL/password, and its webhook to `https://<domain>/webhooks/imessage?secret=<WEBHOOK_SECRET>`), or use Sendblue (hosted, paid per message; `IMESSAGE_PROVIDER=sendblue`).

Local:

```bash
cp .env.example .env         # DATABASE_URL empty = embedded DB in ./data
npm install && npm test      # 192 tests
npm start                    # Telegram polling + web on :3000
npx tsx src/cli.ts chat      # the brain with no channel
npx tsx src/cli.ts poll      # hackathon pollers once
npx tsx src/cli.ts scout "solana perps" "partnerships"
```

Day one for each friend: `/start` on Telegram → `timezone Europe/London` → `/persona` → `interests: solana, ai` → `link` (gives a 6-char code) → open the web app and paste it, or text `link <code>` to the SMS/iMessage number.

## The product surface

**Web app** (`web/`, served by Railway at `/` and deployable to Vercel on its own domain; see `web/README.md`): a real multi-view product, no build step. Chat · Today (timeline, stats, habits) · Hackathons (ranked feed + ledger with status select) · Scout (niche + objective → projects, socials, people, outreach) · Lists · Money (spend, alerts, wallets, shadow follows, bills) · Trips · Settings (theme, voice, rhythm, channels, model budget). The right rail is always live: pending confirmations, up next, meds, deadlines, memory.

**Themes** — four old-money palettes, switchable at will in Settings and remembered per account and per device: **Manor** (cream · camel · oxblood · forest, light), **Library** (espresso · parchment · brass · moss, dark), **Riviera** (ivory · navy · coral, light), **Tobacco** (leather · cognac · burgundy, dark). Type is Cormorant Garamond for display, Inter for body.

**How it talks** is a design decision, written down in `docs/VOICE.md` and enforced in code: every reply passes through `src/core/voice.ts` (no emoji, no em dashes, no ids, no robotic residue), every module is written in that voice, and a persona changes register only. The bot can explain itself: ask "can you track my meds?" or "what can you do" and `src/intent/capabilities.ts` answers with what, an example sentence, and what happens next; the same catalogue feeds the model's prompt and the web app's "What I do" page. When something essential is missing, an action asks one question and remembers it (`needs`/`fill` hooks, `src/intent/thread.ts`): "plan a trip to Accra" gets "When are you going?", and the next message is read as the answer, "skip" carries on without it.

**Pip, the mascot** is a tortoise with spectacles and a pocket watch (`src/core/pip.ts`, `web/mascot.js`). Slow on purpose: he reads everything before he moves, never puts down what he carries, and is still there in the morning. Every state he shows is a real state of your day: thinking while a message is with the brain, sitting up with the watch out when something waits on your yes, a nod when you tick something, lids half down in quiet hours, straight at you when nothing is kept yet. His lines come from a book of lines per state, or from the model in your voice. Original SVG, no image assets.

**Telegram** — HTML formatting (bold section labels, clickable links), a persistent quick keyboard (☼ Today · ⚑ Hackathons · ◎ Scout · ☐ Lists · ¤ Money · 🐢 Pip), typing indicator, and the same inline Confirm/Cancel/Undo buttons as before.

**Plain sentences, not command syntax.** Three layers: strict command phrases (fast, exact) → the loose natural-language layer (`src/intent/loose.ts`: politeness stripped, the time expression lifted out with chrono, cue words mapped to the action registry) → the model when a key is set. "can you remind me to call Ada tomorrow at 9am", "I need to buy milk, eggs and bread", "who's building perps on solana", "let me know when sol goes above 250", "I'm going to Accra on dec 20 until dec 27 with a budget of 600 usd", "be more formal" all work with no model. `test/coverage.test.ts` holds 150 such sentences and fails if any registered action becomes unreachable.

## Channels

| Channel | In | Out | Buttons | Notes |
|---|---|---|---|---|
| Telegram | text, voice, .ics, Business messages | inline keyboards | tap | auto-creates allow-listed users; `/persona`, `/link`, `/usage` |
| Web | chat box | chat + live sidebar (pending, reminders, calendar, meds, lists, ledger, trips/dates, memory, spend) | click | Telegram Login Widget or link code; sessions 30 days |
| SMS | Twilio webhook | Twilio REST | `1) Confirm 2) Cancel`, reply with the number | links by texting `link <code>`; unlinked numbers get one instruction |
| iMessage | BlueBubbles / Sendblue webhook | relay REST | same as SMS | identity = phone or Apple ID email |
| Email | — | send-only fallback | — | last hop if every channel fails |

Outbound pushes go to the user's preferred channel and fall back down the chain (Telegram → iMessage → SMS → web → email). Every channel calls the same `handleMessage`/`handleCallback`, so a confirmation started on Telegram can be finished by texting `1`.

## What it does

| Area | Say | Behaviour |
|---|---|---|
| Chat | anything | With a model key: free conversation, any topic, opinions, the voice you picked (`/persona` or `voice <describe it>`) |
| Reminders | `remind me to call Ada tomorrow 9am` · `… every weekday at 7` | Done / Snooze |
| Calendar | `add dentist on friday 3pm` · `what's on this week` · send `.ics` | 30-min alert, overlap warning |
| Medications | `med Vitamin D at 8am and 8pm` | Taken / Skip, 90-min nudge, adherence, supply countdown. Reminds, never prescribes |
| Classes | `class Algorithms on tue 10:00-12:00 at Room 4` · `assignment Lab 3 due next monday` | 15-min class alerts; 2-day + morning-of assignment alerts |
| Trips | `plan a trip to Accra from dec 20 to dec 27 budget 600 usd` · `add flight … to trip` · `packed charger` · `trip` | Checklist, itinerary, budget, 7/1-day nudges |
| Lists | `todo: taxes, call bank` · `shopping: eggs, bread` · `bought eggs` · `lists` | Any number of named lists |
| Dates | `Ada's birthday is march 14` · `countdown visa appointment dec 3` · `dates` | 7-day, 1-day, day-of alerts; birthdays repeat yearly |
| Habits / spend / notes / memory | `did gym` · `spent 4500 naira on data` · `note: …` · `remember I'm vegetarian` · `/memory` | Streaks, summaries, provenance-tagged memory with Sunday review |
| Weather / FX / summarise | `weather Lagos tomorrow` · `100 usd to ngn` · `2 sol to usd` · `tldr https://…` | Open-Meteo, ECB rates + CoinGecko, model summary |
| Hackathons | `hackathons solana` · `track Colosseum Frontier due nov 30` · `submitted/won Frontier` · `ledger` | 6 sources deduped, odds-style rank, 72h/24h/6h alerts, payout chase, win rate |
| **Scout** | `scout solana perps for partnerships` · `scout ai agents to apply` · `watch scout fintech africa` · `outreach Perpz: want to integrate your SDK` | New/upcoming projects by niche across web3, crypto, AI, tech, web2 with official site/X/Telegram/Discord/GitHub and founders'/handlers' public handles; Gemini-grounded with citations when a key is set; outreach drafted, you send |
| Prices / portfolio | `alert when sol above 250` · `alert me if eth moves 10% in 6h` · `price btc eth` · `watch wallet <addr> on solana` · `portfolio` | 5-min polling; refuses keys/seeds |
| Jobs | `watch jobs lever dorahacks for growth` · `watch jobs remoteok for solana` · `jobs` | Greenhouse/Lever/Ashby/RemoteOK/Remotive; matches in the digest; never applies |
| Launches | `launches` · `contact <github user>` | Show HN, GitHub, DexScreener + GoPlus (flagged tokens hidden) |
| Bills (NG) | `billers airtime` · `pay 2000 to BIL099 for 08012345678` | Flutterwave Bills v3, Tier 2 echo-and-confirm |
| Trading | `follow <wallet> on polymarket max 10/trade 50/day` · `shadow report` | Shadow only; blocked-country users refused; no execution |
| Business | connect the bot under Telegram → Business → Chatbots | Drafts replies to messages in the chats you chose and sends the draft to you; never auto-replies |
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
| Telegram bot, voice transcription | ✅ (streaming via `sendMessageDraft` still pending grammY support) |
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

Tested here (192 tests, real Postgres engine, plus a headless-Chromium walkthrough of every web view in light and dark themes): the gate in every tier, undo, expiry, scheduler re-arming, push caps, every module's happy path, ICS parsing, the shared handler across four channels, link codes, SMS numbered replies, iMessage payload parsing for both relays, dispatch fallback, the web app's auth (signed Telegram payload, bad signature, link code, logout), chat and button endpoints, webhook signature refusal, Gemini schema cleaning, load (2,000 due jobs drained in 2.3 s across 40 batches; 200 users messaging concurrently in 245 ms with no cross-talk), and a cold boot of the web server.

Not testable from this sandbox (no outbound network, no keys): live Telegram, Twilio, BlueBubbles/Sendblue, the model providers, CoinGecko/Open-Meteo/frankfurter, and every poller against its live site. They're written against current documented shapes; each one fails soft and logs. First thing after deploy: `npx tsx src/cli.ts poll`, `scout "ai agents"`, send one voice note, and text the Twilio number `link <code>`.

## Next

1. Token balances (Alchemy/Helius free tiers) in `portfolio`.
2. Streaming replies once grammY exposes `sendMessageDraft`.
3. Circle features: shared trips with cost splits, shared hackathon teams, "who's free Friday" across linked calendars, a group digest channel.
4. Document extraction with echo-back (bills, syllabi, booking confirmations → dates and amounts).
5. Google Calendar two-way sync (sensitive scope, no CASA).
6. Signer-backed rules for your own wallet only, after two weeks of shadow data.
7. WhatsApp as a business-own bot if the circle wants it, never as the general assistant.

## Privacy note for the circle

Medication names, class times, spend logs, wallets, scouted contacts and chat history live in your Supabase project and, with a model key, in the vendor's short-term logs. Telegram cloud chats are server-readable; SMS is plaintext in transit; iMessage relays see every message. Tell the 17 before onboarding, keep Doppler as the only place secrets live, and never paste keys or seed phrases into any channel — the bot refuses to store them, but the message still exists.
