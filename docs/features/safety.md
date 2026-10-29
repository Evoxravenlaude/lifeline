# Safety

Code: `src/modules/features/safety/` (`scam.ts`, `checkin.ts`, `card.ts`, `legacy.ts`, `incident.ts`, `shared.ts`). Tests: `test/features-safety.test.ts`. Tables start with `safety_`, buttons with `sf:`. All five cards sit in the **Safety** drawer.

## Scam and fake-alert check (`scam.check`, `scam.report`)

"scam check: <message>", "is this legit: …", "check this link https://…", "is +44 7700 900123 a scam number", "check this address 0x…". If someone forwards a message and then says "is this a scam" or "check it", the check reads their previous message from the last 15 minutes. With nothing to check, it asks them to paste it (the paste is read as the answer).

- **Red flags first, no keys needed**: pressure to hurry, "verify your account", one-time codes, gift cards, crypto doubling and wallet "validation", money up front (delivery, customs and processing fees), job fees and easy-money promises, prizes you didn't enter, fake payment alerts and "sent by mistake" reversals, too-good investment returns, family on a "new number", romance plus money, wire or crypto ATM payment, remote-access apps, secrecy, delivery or refund notices. Links: shorteners, bare IP addresses, punycode, look-alike brand domains (digit swaps like `paypa1`, one-letter typos, a brand's name inside someone else's domain), a brand named in the text while the link or sender goes elsewhere.
- **Outside checks, when available**: Google Safe Browsing v4 `threatMatches:find` for links (needs `SAFE_BROWSING_KEY`); GoPlus `address_security` and `token_security` for EVM addresses (free, no key; chain from the text: Ethereum by default, BSC, Polygon, Base, Arbitrum, Optimism, Avalanche). If they can't be reached the reply says so and the heuristics still answer.
- **The model** (optional): a two-sentence plain verdict when red flags were found, with the checked text marked as data. Its line is dropped if it calls anything safe or legit. Budget checked with `overBudget` and `recordUsage`.
- **Wording**: never "safe". Either "No red flags found. That isn't a guarantee…" or up to three red flags and two things to do (check the balance in your bank app, don't share the code, call the number on the official website). Phone numbers can't be looked up, and the reply says so.
- **Circle reports**: the "Report as a scam" button or "report this as a scam" stores the numbers, links and addresses of the last check in `safety_reports` (opt-in, undoable). Anyone in the circle who checks a match is told how many people reported it, never who.
- Heuristics are written in English. Messages in other languages get the link, address and report checks, and the model verdict when a model is configured.

## Safety contacts and check-ins (`safety.contact_*`, `checkin.*`)

- "add my safety contact @tunde" / "add Bisi as my safety contact" (someone in lifeline, matched by `prefs.username`, full name or first name), an email address, or a phone number with its country code (only when SMS is configured). Adding a contact is **tier 2**.
  - A lifeline user gets a message with **Yes / No** buttons (`sf:ct:y|n:<id>`); only a yes makes them alertable. They can leave with "stop being a safety contact", and the owner is told.
  - An email or phone contact gets **one notice** explaining what it is and how to opt out (the email's reply-to is the person's own confirmed address), and is marked `notified`.
- "check on me: walking home, 25 min", "I'm in a taxi to the airport, check on me in 40 minutes", "check in at 11pm". Up to 24 hours ahead. A job `safety_checkin_due` is scheduled at the deadline.
- Live location (`addLocationHandler`): while a check-in runs, only the latest point is kept. It is deleted when the check-in ends.
- At the deadline: a gentle exempt ping "Are you OK? Tap I'm safe…" with **I'm safe** and **15 more minutes**. After the grace period (10 minutes) `safety_checkin_alert` tells confirmed contacts what the person was doing, the deadline time and the last location (Google Maps link), by Telegram/web/SMS (whichever lifeline uses for them), email or SMS. Pending or declined contacts are never alerted. The person is told who was reached.
- If nobody answers at all, the check-in closes 48 hours after the alert and the location is deleted (`safety_checkin_expire`).
- "I'm safe" (or the button) ends it, deletes the location, and if contacts were already alerted, tells them the person is OK. "cancel the check-in" ends it with nothing sent. "give me 15 more minutes" moves the deadline.
- Every start, ping and alert says this doesn't replace emergency services. The number comes from a small map (911, 999, 000, 111, 112) only when the person's country is known, otherwise "your local emergency number".
- Brief: "Safety check-in running until 23:10." while one is active, nothing else.

## Emergency card (`emergency.card_*`)

"set up my emergency card" asks one question at a time: blood group, allergies, conditions, current medications ("from my list" uses the medications they track), emergency contacts, health plan or insurance name and member number. "next" leaves one off, "skip" stops and saves what's there. Single fields: "my blood group is O+", "emergency card allergies: penicillin", "add my meds to my emergency card". Government ID numbers (passport, national ID, SSN, BVN, NIN, Aadhaar, driving licence and similar) and anything that looks like a password or key are left off with a sentence saying why. "show my emergency card" returns the card in a code block (a Copy button on Telegram when it fits in 256 characters). "delete my emergency card" removes it (undoable for five minutes). Never in the brief.

## If something happens to me (`legacy.*`)

- "if something happens to me, tell ada@example.com: …", "legacy note for Tunde: the deed is in the blue folder". Recipients are email addresses or people in lifeline. Nothing is sent when it's written.
- **Never stored**: passwords ("my password is …", "PIN: …"), seed phrases (keyword or a bare run of twelve or more seed-like words), private keys (64 hex, WIF, Solana secret keys and keypair arrays). Refused with one plain sentence; where-to-find notes ("the passwords are in 1Password, the kit is in the safe") are fine.
- "turn on my legacy plan after 30 days" is **tier 2**: the confirmation lists every recipient and what they get, and only those items are confirmed. Minimum window 14 days, maximum 365. Items added later stay drafts until it's turned on again.
- System job `safety_legacy_sweep` (cron `37 * * * *`): after the window with no message at all, three exempt pings 48 hours apart with an **I'm here** button (`sf:lg:here`), then a final 72 hours. Only then are confirmed items sent (email via `sendEmail`, lifeline users via the scheduler's `send`). Any message from the person since the first ping resets everything, as does I'm here. The sweep reads the `messages` table, so every channel counts.
- "pause my legacy plan", "resume my legacy plan", "cancel my legacy plan" (deletes everything, undoable), "legacy status" ("Legacy plan: on, next check by Fri 27 Nov…"). Never in the brief.

## Incident log (`incident.*`)

"log incident: …" stores the text, the time and `sha256(seq \n loggedAtISO \n text \n prevHash)`, with the first entry chained to 64 zeros. Changing or deleting any entry breaks every hash after it. "show my incident log" lists the latest eight briefly. "export my incident log" (or "verify my incident log") checks the chain and returns the full timeline with hashes in a code block, and emails a copy when the person has a confirmed address (`prefs.emailVerified` or a linked email identity). "delete my incident log" is tier 2. Undo removes an entry only while it's still the newest. Never in the brief or Wrapped.

Photos: a photo captioned "log incident" goes through the core photo flow, which this area can't change, so photo evidence needs a core hook (see below). Text entries work everywhere.

## Env vars

- `SAFE_BROWSING_KEY`: optional, Google Safe Browsing v4 API key. Read at call time.
- Email (`SMTP_URL` or `RESEND_API_KEY`, `EMAIL_FROM`) for email contacts, alerts, legacy messages and the log export. SMS (`TWILIO_*` or `SMS_GATEWAY_*`) for phone contacts. Both optional; the replies say plainly when one is missing.

## Known limits and core changes wanted

- `forget my emergency card` / `forget my incident log` / `forget my legacy plan` are caught by the core `forget …` rule (memory.forget) before plugin rules. Use "delete my …". Core fix: add these to the negative lookahead in `src/intent/rules.ts`, as was done for cycle data.
- Forwarded messages skip rules and threads in `handleMessage`, so with no model a forwarded scam gets small talk. The person then says "check it". Core fix: offer forwarded text to a plugin hook, or run `scam.check` for forwarded text when nothing else matches.
- `isCapabilityQuestion` runs before rules, so a one-line "is this legit: <text>" whose first sentence has no time words and mentions a card cue can be answered with a capability card. Multi-line pastes and "scam check: …" are not affected. Core fix: check plugin rules before the capability question.
- Telegram usernames aren't stored anywhere, so "@tunde" matches by name. Core fix: save `from.username` into `prefs.username` in `src/telegram/bot.ts`.
- Photo evidence for the incident log needs a hook such as `addPhotoAction` for an action that takes the image (today it only receives the model's suggested sentence).
