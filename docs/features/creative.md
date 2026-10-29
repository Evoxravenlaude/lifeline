# Creative and NFTs

Code: `src/modules/features/creative/` (`index.ts` imports the rest; import order is rule order). Tests: `test/features-creative.test.ts`. Tables start with `crt_`, buttons with `cr:`. Drawer: "Creative and NFTs".

For collectors, everything is read only: nothing here mints, signs, lists, sells or trades, and nothing asks for or keeps a seed phrase or private key. For artists, nothing reaches a client: drafts are for the person to send themselves.

## Files

| File | What's in it |
| --- | --- |
| `shared.ts` | Dates in the person's zone (`parseDay`, `parseMoment`, `sayMoment`), a small fetch and cache (`crt_cache`), secret refusal (uses the safety area's `looksSecret`), the daily sweep (`addPinger`, `creativeSweep`, job `crt_daily`), the brief section (`addBriefItems`), the `cr:` buttons, a small model helper, and `creative.quiet` |
| `chains.ts` | Chains and tokens collectors talk about, `nftChain`, `tokenOf`, `ckeyOf` (a collection's matching key). No rules, so it can be imported without changing rule order |
| `drops.ts` | Mint calendar, allowlists and reveals, with the 60 and 10 minute reminders (job `crt_drop`) |
| `nft.ts` | Mint log, sales, listings, transfers, floors, P&L, slugs, mint spotting on watched wallets (system job `crt_mintscan`), mint-link check, seed phrase refusal |
| `work.ts` | Commissions, open calls and submissions, quotes |
| `release.ts` | Release and drop planner, practice time |
| `ideas.ts` | Idea inbox, sparks, the daily prompt, portfolio links and bio |

## Features and how to say them

| Action | Say | Notes |
| --- | --- | --- |
| `mint.add` | "minted 2 Pudgy Penguins at 0.05 ETH", "minted Chromie Squiggle #1234 on ethereum for 0.1", "free mint of Base Day on base", "minted 3 Mad Lads on solana at 2 SOL", "... with wallet 2", "... tx 0x..." | "at" means each, "for" means total unless "each" is said. No chain: from the token (SOL is Solana, POL Polygon, APE ApeChain...), else Ethereum. No token: the chain's native one. Day defaults to today ("yesterday", "on Monday" go back, never forward). |
| `mint.update` | "sold 1 Pudgy Penguin for 0.2 ETH", "sold 2 Mad Lads at 45 SOL each", "listed 2 Squiggles at 0.5", "delisted my Squiggles", "transferred 1 Pudgy Penguin to my vault" | Sold and listed need a token or a decimal price, so "sold my car for 2000 dollars" isn't caught. Transfers need a wallet-like destination ("vault", "cold wallet", "ledger"), and an amount followed by "to" is left for money. Sales are applied oldest mint first. Undo restores every row touched. |
| `mint.list` | "my mints", "my nfts", "what have I minted" | Grouped by chain: held of minted, cost, sales, listings, transfers, floor and a paper gain or loss in the same token. Ten collections' floors per look at most, three at a time. |
| `mint.pnl` | "my nft pnl", "nft p&l", "how are my mints doing" | Per token, never converted to money: spent, sold for, held at floor (or at cost, said so, when there's no floor). Gas and fees aren't counted, and the reply says so. |
| `mint.slug` | "Chromie Squiggle is https://opensea.io/collection/chromie-squiggle-by-snowfro", "slug for Mad Lads is mad_lads" | When a floor can't be found from the name, "my mints" asks once (`crt_slugs.asked`) and remembers the answer. |
| `mint.detected`, `mint.detect` | "add the detected mints", "ignore the detected mints", "stop mint detection", "turn on mint detection" | See "Mints spotted on watched wallets". |
| `mint.checklink` | "check this mint link https://...", "is https://... the real mint?" | Proposes the safety area's `scam.check` with the link (no duplicate checker) and adds mint advice: official link only, read the domain, never sign `setApprovalForAll` blind, a real mint never needs a seed phrase. |
| `nft.secret` | "my seed phrase is ..." | Refuses plainly and keeps nothing (the action takes no arguments, so the words never reach a table). Every free-text field in this area (collection, wallet label, commission, bio, idea) is also checked with the safety area's `looksSecret`. |
| `drop.add` | "Azuki Elementals mint opens 3 Nov 18:00 UTC, allowlist, 0.08 ETH", "public mint for X at 5pm my time", "reveal for X on Friday", "Seoul Souls free mint starts tomorrow at 15:00 on base" | Stored as an instant; said in the person's zone, with UTC alongside when they gave UTC ("Wednesday at 03:00 your time (Tue 3 Nov 18:00 UTC)"). Reminders an hour and 10 minutes before (`crt_drop` jobs, `push` with `exempt`, kind `reminder`, so quiet hours and calm mode don't hold them, as with any reminder the person set). A day without a time gets a brief line that morning and no ping. Asks "When does it open?" when no time was given. Saying it again moves it and reschedules. |
| `drop.allowlist` | "I'm on the allowlist for X with wallet 2", "got WL for X", "I'm on the X allowlist" | Joins the drop if it's on the calendar, or keeps a note and asks for the time. |
| `drop.list`, `drop.cancel` | "my upcoming mints", "mint calendar", "cancel the X mint", "remove the X reveal" | Cancel takes the reminder jobs with it; undo puts both back. |
| `commission.add` | "commission: portrait for Tolu, 150, due 20 Nov, 50 deposit paid", "new commission from Ji-woo: album cover, 300000 KRW, due 5 Dec" | Amounts in the person's currency (`userCurrency`) unless typed with one (money area's `amt` / `normCur`). |
| `commission.update` | "revision 2 sent for Tolu's portrait", "delivered Tolu's portrait", "Tolu paid the rest", "Ji-woo paid the deposit", "Marta paid 200 more towards the mural", "cancel the mural commission" | "I paid ..." and "we paid ..." are never read as a client paying. Revisions past the number included are pointed out once, gently. |
| `commission.list`, `commission.nudge` | "my commissions", "draft a balance reminder for Tolu", "nudge Tolu about the balance" | The nudge is a fenced draft to copy; nothing is sent. |
| `opencall.add`, `opencall.update`, `opencall.list` | "open call: Lagos Photo Festival closes 15 Dec", "residency: X deadline 1 Feb https://...", "submitted to X", "I sent my demo to Mavin Records", "accepted into X", "rejected by X", "shortlisted for X", "my open calls" | "submitted to X" with no call by that name but a hackathon entry that matches hands off to `hackathon.update`. A rejection is logged without fuss and points at the next one. |
| `opencall.find` | "find open calls for illustrators this month", "any residencies in Berlin" | `search()` from `src/core/media.ts`. Only links that came back from the search itself are shown; any other URL in the answer is stripped. No sources: it says to find each on the organiser's own site. No search configured: it says so and names a few real places to look. |
| `quote.make` | "quote for a logo, 12 hours at 40 an hour plus 2 revisions", "make a quote for a mural, 3000 flat plus 400 for materials, 50% deposit, in EUR" | A fenced, aligned block to copy, in `userCurrency` unless another is named. |
| `release.add`, `release.tick`, `release.list` | "releasing my single Lagos Nights on 12 Dec", "my book launches 3 March", "dropping my NFT collection on 20 Jan", "tick artwork for Lagos Nights", "upload done for Lagos Nights", "my releases" | Plans: music (artwork -35d, distributor upload -28d for editorial pitching, playlist pitch and pre-save -21d, teaser -10d, announce -7d, release day, thank-you +2d), book (cover -60d, advance copies -45d, pre-orders -30d, announce -21d, event -14d, reminder -3d, launch, thank-you +3d), NFT (art -21d, contract and metadata on a testnet -14d, allowlist open -10d, announce -7d, allowlist closes -3d, official link -1d, mint day, reveal +2d), everything else (work done -21d, announce -14d, teaser -7d, reminder -1d, launch, thank-you +2d). Steps already past are set for today, and the reply says so. A step due today can carry a Done button (`cr:rs:<id>`). |
| `practice.log`, `practice.show` | "drew for 45 minutes", "wrote 800 words", "practised guitar for 30 min", "played the kora for an hour", "painted for 2 hours yesterday", "my practice this week" | Weekly total (last 7 days) and a run using `streakOf` from `src/modules/life.ts`, so one rest day a week keeps it. A run under 2 days isn't mentioned, and a broken one never is. |
| `idea.add`, `idea.list`, `idea.forget` | "idea: a zine about Lagos danfo drivers", "idea for a song: ...", "my ideas", "delete my ideas" | Private: never in the brief or any shared view. |
| `spark.get`, `spark.daily` | "give me a spark", "writing prompt", "I'm creatively stuck", "a creative prompt every morning", "stop the prompts" | The model when one is configured and within budget; otherwise 30 built-in prompts. The daily prompt is opt in and appears as a brief line (section `creative_prompt`, order 85) with its off switch. |
| `links.add`, `links.show`, `links.bio`, `links.remove` | "my portfolio is https://...", "my behance is behance.net/ada", "my instagram is @ada.draws", "add link https://foundation.app/@ada", "bio: illustrator in Lagos drawing city life", "my links", "remove my behance link" | Labels from the site (Behance, Instagram, Foundation, objkt, Bandcamp, SoundCloud and more). Handles become links for sites that have them. "my links" ends with a fenced bio line to copy. "my portfolio" on its own is still the crypto portfolio. |
| `creative.quiet` | "stop creative pings", "creative pings on" | Turns off the daily sweep; the brief still carries everything. |

## How it stays calm

- **One sweep a day, merged.** `crt_daily` (09:17 local, created the first time something with a date is kept) collects commissions due in 3 days or 1 day, open calls closing in 7 days or 1 day, and release steps due today into one message through `push()` (not exempt), ending with "Say "stop creative pings" to keep these to your morning brief." Keys in `crt_pings` make sure each item and each day goes out once.
- **Spotted mints** ping at most once a day (`offers:<day>`), merged into one line, and always say "Say "stop mint detection" to stop these." Anything not sent waits in the brief.
- **The brief** (section `creative`, order 22) shows at most two lines: the most pressing one on its own (a mint today, a commission due), then "Also: ..." for the rest.
- **Drop reminders** are the only exempt pushes: the person set them, and an allowlist window can't wait. They're recorded as kind `reminder`, so they don't use up the daily cap.
- Calm mode drops the small flourishes ("Nice work.", "that's a real one").

## Mints spotted on watched wallets

Wallets come read only from the core `wallets` table and `tech_wallets` (neither is changed). EVM chains Etherscan covers (Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain), twenty wallets a run, oldest checked first, one at a time. Each look calls `tokennfttx` and `token1155tx`; transfers from the zero address to the wallet, grouped by transaction and contract (ERC-1155 counts `tokenValue`), become `crt_offers`. The first look only sets a baseline (`crt_scan.last_block`), so old history is never offered as new; a failed first look sets no baseline. The price each is the transaction's value (public RPC `eth_getTransactionByHash`) divided by the pieces minted in it; ERC-20 priced mints show no price. Nothing is added without a yes (button `cr:of:y:<ids>` or "add the detected mints").

Solana isn't included: I couldn't verify a free, keyless endpoint that reliably reports mints to a wallet, so it's left out rather than guessed.

## Environment

| Variable | Used for |
| --- | --- |
| `OPENSEA_API_KEY` | Floors on EVM chains. Without it, "my mints" says floors there need a key on this server and shows cost only. |
| `ETHERSCAN_API_KEY` | Mint spotting on watched EVM wallets. Already used by the tech area. |
| `MAGICEDEN_API_KEY` | Optional; sent as a Bearer token to Magic Eden. Solana floors work without it. |

Search for open calls uses whatever `src/core/media.ts` has (Gemini or Groq keys). The spark uses the configured model, if any.

## Data sources and what I verified

- **OpenSea API v2, collection stats**: `GET https://api.opensea.io/api/v2/collections/{slug}/stats` with header `x-api-key`. Response `total.floor_price` and `total.floor_price_symbol` (plus `volume`, `sales`, `num_owners`, and `intervals[]`). WETH is read as ETH. Verified the path and header on docs.opensea.io ("Query analytics and events") and the response fields from a published copy of OpenSea's endpoint reference (the docs site itself wouldn't load here). 404 and 400 mean no such collection.
- **OpenSea API v2, contract**: `GET https://api.opensea.io/api/v2/chain/{chain}/contract/{address}` returns `collection` (the slug). Used for spotted mints, which come with a contract. Chain names used: `ethereum`, `base`, `arbitrum`, `optimism`, `matic` (Polygon), `zora`, `blast`, `ape_chain`, `abstract`, `avalanche`, `bsc`, `ronin`. These names are from OpenSea's chain list as I know it, not checked live here (`matic` for Polygon is the one most likely to change); a wrong name only means a spotted mint's floor falls back to guessing the slug from its name.
- **Magic Eden, Solana collection stats**: `GET https://api-mainnet.magiceden.dev/v2/collections/{symbol}/stats`, public. `floorPrice` is in lamports (divided by 1e9). Verified the endpoint in Magic Eden's API reference index ("Get stats of a collection") and the lamports unit from published client code; I couldn't fetch a live response from this sandbox.
- **Etherscan API v2**: `GET https://api.etherscan.io/v2/api?chainid=<id>&module=account&action=tokennfttx|token1155tx&address=...&startblock=...&endblock=99999999&page=1&offset=100&sort=asc|desc&apikey=...`. Fields used: `blockNumber`, `hash`, `from`, `to`, `contractAddress`, `tokenID`, `tokenName`, `tokenSymbol`, and `tokenValue` for ERC-1155. Verified on docs.etherscan.io (tokennfttx, token1155tx). Etherscan's free plan no longer covers every chain (reports name Base, BNB Chain and Avalanche among those moved to paid plans); on those, a free key gets an error, the scan logs it and stays quiet.
- Floors are cached in `crt_cache` for an hour (a "not found" too); contract to slug for 30 days.

## Tables

`crt_mints`, `crt_slugs`, `crt_scan`, `crt_offers`, `crt_drops`, `crt_commissions`, `crt_calls`, `crt_releases`, `crt_release_steps`, `crt_practice`, `crt_ideas`, `crt_links`, `crt_pings`, `crt_cache`. Prefs: `crtQuiet`, `crtDetect`, `crtPrompts`, `crtBio`.

## Jobs

| Kind | When | What |
| --- | --- | --- |
| `crt_mintscan` | system, `13,43 * * * *` | Mint spotting, twenty wallets a run |
| `crt_daily` | per person, `17 9 * * *` in their zone | The merged daily sweep |
| `crt_drop` | per drop, one-shot | The 60 and 10 minute reminders; skipped if the drop moved or was cancelled |
