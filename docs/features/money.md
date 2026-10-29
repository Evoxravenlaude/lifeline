# Money and paperwork

Folder `src/modules/features/money/`, tests `test/features-money.test.ts`, tables `money_*`, buttons `mn:`.

## Files

| File | What's in it |
| --- | --- |
| `common.ts` | Amount and currency parsing (`AMT`, `amt`, `normCur`, `fmt`), local dates (`parseDay`, `sayDate`, `nextMonthly`, `addPeriod`), the daily sweep (`moneySweep`, `addPinger`), brief collectors (`addBrief`), the `mn:` button router, `money.quiet` (the off switch), a small `think()` model helper. |
| `people.ts` | IOUs (`iou.*`), freelance invoices (`invoice.*`, `invoice.send` is tier 2), savings circles (`savings.*`). |
| `paperwork.ts` | Documents and ID expiry (`doc.*`), warranties and returns (`warranty.*`), relocation checklist (`relocation.*`). |
| `recurring.ts` | Subscriptions (`sub.*`), rent and home payments (`rent.*`), tax year (`tax.*`). |
| `spending.ts` | Impulse cool-off (`cooloff.*`), debt payoff planner (`debt.*`). |

`index.ts` imports them in rule order: people, paperwork (warranties before documents), recurring (rent before subscriptions), spending. The "Netflix renews on the 3rd" rule is added last so "car insurance renews 1 Jan" stays a document.

## How it speaks

- **Brief first.** Two brief sections: `money_paperwork` (order 15: documents, passport-vs-trip, returns, warranties, rent) and `money_money` (order 25: renewals, tax deadline, IOUs due, overdue invoices, cool-offs, savings rounds). Each gives its two most urgent lines.
- **One ping a day at most, combined.** Each person gets a `money_daily` job (cron `41 9 * * *` in their zone, created the first time they keep something with a date). It asks every feature's pinger, drops anything already pinged (`money_pings` keys) and any feature already pinged today, and sends one message: a single line, or "A few money things today:" with one line per feature. Every ping ends with how to stop it.
- **When it pings:** subscriptions 1 to 3 days before renewal; documents at 30 and 7 days; passport under six months on an upcoming trip (within 90 days of the trip); monthly rent 3 days before, yearly at 30 and 7; returns 2 days before and on the day; warranties 30 days before; invoices 1, 7 and 21 days overdue; tax deadline 30 and 7 days; savings circle 2 days into a round if someone isn't marked paid.
- **Cool-off** has its own one-shot job (`money_cooloff`) at the end of the wait, with Still want it / Skip it buttons, and shares the one-per-day rule.
- **Off switch:** "stop money pings" (everything) or "stop the subscription reminders", "no more rent reminders", and so on. Muted features still appear in the brief. "money pings on" undoes it.

## Safety

- Nothing here moves money or contacts anyone, except `invoice.send` (tier 2): it echoes the exact email and waits for a yes. It needs `canEmail()` and the person's verified address (`prefs.emailVerified` or a linked email identity), which becomes the reply-to. Without one, the person gets the draft to send themselves.
- IOU reminders are drafts only. Savings circles are a ledger only.
- Documents keep only a name and a date. Long ID-like tokens (`idsIn`) are stripped, the person is told, and the number is also scrubbed from their stored message.
- Card-number-like digits are never kept in an IOU note.
- Rent, tax and debt are information and arithmetic only; each card says so in `limits`, and the debt plan says it once.

## Worldwide

- Amounts with no currency use `userCurrency(user)`. Typed currencies are read in context: "dollars" for a Canadian is CAD, "rupees" in Pakistan is PKR, "cfa" in Senegal is XOF. Symbols, ISO codes and crypto (ETH, SOL, BTC, USDT, USDC) all work.
- Totals in different currencies are listed per currency, never converted.
- Tax: the person sets their own deadline and tax-year start. Their country (asked once, "I file taxes in Kenya") picks the authority named in words; any country is recognised by name via `Intl.DisplayNames`.

## Env vars

None of its own. Optional: `GEMINI_API_KEY` or a Groq key for web search ("cancel Netflix" steps; plain general steps without it), `SMTP_URL` or `RESEND_API_KEY` plus `EMAIL_FROM` for `invoice.send`, and any model key for one tailored line on a relocation checklist.

## Known edges

- "add debt: ..." is caught by the core `calendar.add` rule (`^add ... at ...`) before this module sees it. Use "debt: ..." or "new debt ...". A core fix is to add `debt` to that rule's negative lookahead.
- "How do I cancel my gym membership?" is answered by the core capability layer before rules run. "cancel my gym membership" works.
- "my country is X" belongs to the home area's holiday setting; it sets the same `prefs.country`, so tax picks it up too.
