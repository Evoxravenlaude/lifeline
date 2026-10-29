# Work, code and crypto

Code: `src/modules/features/tech/` (`index.ts` imports the rest). Tests: `test/features-tech.test.ts`. Tables start with `tech_`, buttons with `tc:`.

Everything here is read only. Nothing trades, signs, revokes or moves money, and nothing asks for or keeps a seed phrase, private key, API key or token.

## Files

| File | What's in it |
| --- | --- |
| `shared.ts` | HTTP and JSON-RPC helpers, ETag cache, chain table, address and secret detection, the alert outbox (`queue`, `flush`) and the brief section |
| `watch.ts` | Uptime monitor with TLS certificate and domain expiry, GitHub watch, package releases, service status |
| `devtools.ts` | Instant developer tools, secret rotation reminders, the `tc:` buttons, the outbox retry job |
| `crypto.ts` | Gas and fees, wallet activity, transaction explainer, token and approval safety, ENS / SNS lookups |
| `markets.ts` | Claims and unlocks, perps funding and price moves, Polymarket |
| `manage.ts` | "my watches" and the one off switch, "stop watching ..." |

## Features and how to say them

| Action | Say | Notes |
| --- | --- | --- |
| `monitor.watch` | "watch https://mysite.com", "monitor example.org", "tell me when mysite.com goes down" | Checked every 5 minutes: HEAD, then GET if HEAD fails or is refused, 10 s timeout each. Up = status below 400, or 401/403/429 (it answered). Alerts once after 2 failures in a row and once on recovery with the downtime. TLS expiry (Node `tls.connect`, `valid_to`) warned at 14 and 3 days; domain expiry (RDAP) at 30 and 7 days. |
| `github.watch` | "watch releases of vercel/next.js", "tell me when CI fails on myorg/myrepo", "watch issues mentioning me in owner/repo" | Mentions need `GITHUB_TOKEN`. Polls: releases every 2 h, CI every 10 min with a token (30 min without), mentions every 15 min. |
| `package.watch` | "watch npm react", "watch pypi fastapi", "watch crates tokio", "watch @types/node on npm" | Every 3 h. Minor and patch versions go to the brief; a new major (first number up) may ping. |
| `status.watch`, `status.now` | "watch status of GitHub, Vercel, Cloudflare, OpenAI", "is github down" | Major or critical incidents ping now; minor ones at most once a day; resolutions go to the brief. Any Statuspage host works: "watch status of status.example.com". |
| `devtool.run` | "format this json {...}", "base64 decode ...", "url encode ...", "unix time 1730000000", "timestamp now", "uuid", "generate 3 uuids", "explain cron 0 9 * * 1-5", "test regex /a+b/ against aab", "sha256 of ...", "md5 of ...", "decode jwt ..." | No network. Output in code blocks. Cron next runs in the person's zone (croner). Regex runs in a `vm` context with a 200 ms timeout, so catastrophic patterns are stopped. JWTs: header and payload only, and the reply says the signature is NOT verified. |
| `rotation.add`, `rotation.done` | "rotate the Stripe key every 90 days", "rotation reminder for the AWS keys every 3 months", "rotated the Stripe key" | Stores the name only. Anything that looks like a key, token, private key or seed phrase is refused in a plain sentence and not stored. Reminder on the due day from 09:00 local, with a Rotated button. |
| `gas.now`, `gas.alert` | "gas now", "gas on base", "eth gas", "solana fees", "tell me when ETH gas is under 5 gwei" | `eth_gasPrice` on Ethereum, Base, Arbitrum, Optimism, Polygon (BNB Chain on request), `eth_feeHistory` for Ethereum's base fee and tip, Solana `getRecentPrioritizationFees`. The alert fires once and stops. Bare "gas" is not taken, since for most people it means cooking gas or petrol. |
| `walletwatch.add` | "wallet alerts for 0x... on base as treasury", "watch activity on 7xKX...", "tell me when 0x... moves" | Portfolio wallets (the core `wallets` table, read only) are covered automatically; "stop wallet alerts" mutes them with a `tech_wallets` row and leaves the portfolio alone. Every 15 minutes, merged, through `push()` (quiet hours, calm mode and the daily cap apply). The first look sets a baseline, so old history is never replayed. |
| `tx.explain` | "explain tx 0x...", "explain tx 0x... on base", "explain <solana signature>" | EVM: tries Ethereum, Base, Arbitrum, Optimism, Polygon, BNB Chain until it finds the hash; decodes transfer and approve (flags unlimited approvals), other selectors through 4byte; lists ERC-20 Transfer logs; fee includes the OP-stack `l1Fee`. Solana: status, signer, SOL and token balance changes, fee. |
| `token.check` | "is this token safe 0x... on base", "check token 0x... on bsc", "is <solana mint> a rug" | GoPlus. Never says "safe": either "No red flags found by GoPlus ... That isn't a guarantee" or the list of flags. Asks for the chain when an EVM address comes without one. |
| `approvals.check` | "check my approvals 0x...", "check approvals 0x... on arbitrum" | GoPlus approval security v2. Lists unlimited, flagged and unverified spenders, then a revoke.cash link for the person to revoke themselves. |
| `claim.add`, `claim.done` | "claim window for Jupiter closes 15 Dec", "token unlock for Arbitrum on 1 Feb", "ZRO unlock on 20 June", "claimed Jupiter" | Manual entries only, no scraping. Reminders 7 days before (may ping, once a day per feature), the day before and on the day (treated as the person's own reminders), from 09:00 local. A late entry skips stages already past. |
| `funding.check`, `funding.alert` | "funding on ETH", "BTC funding", "alert me when BTC funding goes above 0.05%", "alert me if the SOL perp moves 5%" | Thresholds are read per 8 hours (how most exchanges quote funding); Hyperliquid's hourly rate is multiplied by 8 and the reply says so. Funding alerts fire, then wait until funding has come back past the line (10% hysteresis) and at least 12 hours. Move alerts measure from the last alert, at most one an hour. |
| `market.watch`, `market.alert` | "watch the market 'Will X happen'", "watch the market Bitcoin above 150k and alert me if it moves 10 points", "alert me if it moves 15 points" | Polymarket Gamma search, then the market by id every 15 minutes. Default move is 10 percentage points; re-arms from the new price; closed markets go out once. |
| `ens.lookup` | "who is vitalik.eth", "resolve toly.sol", "who is 0x..." | ENS through ensdata.net, SNS through Bonfida's SDK proxy, both directions. |
| `tech.watches` | "my watches", "what are you watching for me", "my monitors", "my claims", "my rotations", "my alerts" | `only` narrows to sites, github, packages, status, wallets, alerts, rotations or claims. "my alerts" also shows the core price alerts, read only. |
| `tech.unwatch` | "stop watching mysite.com", "unwatch react", "stop gas alerts", "stop the funding alerts", "stop wallet alerts" | By name across every table, or by kind. Undo for five minutes. |

## How alerts stay calm

Everything any poller finds goes into `tech_outbox` with a level, and `flush()` sends at most one merged message per person ("From your watches:" and a line each, six at most, three buttons at most):

- `brief`: never pings (minor package versions, resolved incidents).
- `daily`: may ping, but only once per feature per local day (`tech_pings`); the rest waits for the brief.
- `live`: wallet activity; goes through `push()` like any nudge, so quiet hours, quiet days, calm mode and the daily cap all hold it.
- `urgent`: things the person explicitly asked to hear about straight away (site down and back, CI failed, a major outage, gas / funding / market thresholds, a perp move) and their own reminders (rotation due, a claim tomorrow or today). These are held during quiet hours, a quiet day and calm mode (`holding()`), and only skip the daily cap (`push(..., { exempt: true })`).

Anything held is retried by every poller and by `tech_flush` (every 10 minutes) for 18 hours. The brief (section `tech`, order 35) shows what didn't go out as at most two lines, "Work: ..." and "Crypto: ...", and marks them so they're never sent afterwards. Section `tech_due` (order 12) shows claims and unlocks within a week and rotations due within three days.

Every watch reply says how to stop it ("Say \"stop watching mysite.com\" to end it.").

## Jobs (system, minutes jittered)

| Kind | Cron (UTC) | Batch |
| --- | --- | --- |
| `tech_uptime` | `2,7,...,57 * * * *` (every 5 min) | 300 monitors, one probe per URL, 8 at a time |
| `tech_expiry` | `19 5 * * *` | 100 monitors not checked in 20 h |
| `tech_github` | `6,16,...,56 * * * *` | 60 watches, per-kind intervals, same path fetched once per run |
| `tech_packages` | `29 */3 * * *` | 500 watches, one lookup per package, 5 at a time |
| `tech_status` | `4,14,...,54 * * * *` | one fetch per page, 5 at a time |
| `tech_gas` | `1,6,...,56 * * * *` | one `eth_gasPrice` per chain with an active alert |
| `tech_wallets` | `9,24,39,54 * * * *` | 40 wallets, oldest check first, one at a time (Etherscan's 3 calls/s) |
| `tech_perps` | `3,13,...,53 * * * *` | one Hyperliquid call for every alert |
| `tech_markets` | `8,23,38,53 * * * *` | one Gamma call per market |
| `tech_hourly` | `37 * * * *` | claims and rotations, fired from 09:00 local |
| `tech_flush` | `5,15,...,55 * * * *` | retries held alerts |

## Environment

| Variable | Used for | Without it |
| --- | --- | --- |
| `GITHUB_TOKEN` (already in core config) | GitHub watch: 5,000 calls/h instead of 60, 304s don't count, private repos, mentions | Public releases and CI work; CI is polled every 30 min; mentions are refused with a sentence |
| `ETHERSCAN_API_KEY` | EVM wallet activity (Etherscan API v2) | Solana activity still works; EVM watches are kept and the reply and "my watches" say they're waiting for a key |
| `RPC_ETHEREUM`, `RPC_BASE`, `RPC_ARBITRUM`, `RPC_POLYGON`, `RPC_BSC`, `RPC_SOLANA` (shared with `prices.ts`), `RPC_OPTIMISM` (new) | Gas, transactions, token metadata, Solana activity | PublicNode endpoints and `api.mainnet-beta.solana.com` |

Every external API is optional: a failure becomes a plain sentence ("I couldn't reach GoPlus just now. Try again in a minute.") and pollers log and carry on.

## Data sources, what I verified, and limits

Live access from the build machine was blocked for most hosts, so shapes were checked against the providers' documentation (and the npm and PyPI registries live). Parsers are defensive where a field wasn't confirmed.

| Source | Endpoint | Verified | Limits |
| --- | --- | --- | --- |
| RDAP via [rdap.org](https://rdap.org) | `GET https://rdap.org/domain/<domain>` (redirects to the registry) | `events[]` with `eventAction: "expiration"` and `eventDate` ([domaindetails RDAP guide](https://domaindetails.com/kb/technical-guides/querying-rdap-programmatically)) | Bootstrap services may rate limit harder; we check once a day per domain. Some ccTLDs have no RDAP: no warning then. |
| TLS | Node `tls.connect({ servername, rejectUnauthorized: false })`, `getPeerCertificate().valid_to` | Node API | 10 s timeout. |
| GitHub REST | `/repos/{o}/{r}`, `/repos/{o}/{r}/releases?per_page=5`, `/repos/{o}/{r}/actions/runs?status=failure&per_page=10`, `/repos/{o}/{r}/issues?mentioned=<login>&state=all&sort=updated&since=...`, `/user` | Runs list: `status` accepts `failure`, `workflow_runs[].id/name/head_branch/html_url` ([docs](https://docs.github.com/en/enterprise-server@3.7/rest/actions/workflow-runs)); issues: `since`, `state=all`, `sort=updated`, PRs included ([docs](https://docs.github.com/en/enterprise-server@3.14/rest/issues/issues)); conditional requests with `etag` / `if-none-match`, a 304 doesn't count against the primary limit when authorised ([best practices](https://docs.github.com/en/enterprise-server@3.19/rest/using-the-rest-api/best-practices-for-using-the-rest-api)) | 60/h unauthenticated, 5,000/h with a token. We pause when `x-ratelimit-remaining` drops under 5 (until `x-ratelimit-reset`) or after a rate-limit 403/429. |
| npm | `GET https://registry.npmjs.org/<name>/latest` (scoped: `@scope%2Fname`) | Live: `version` field; `dist-tags.latest` agrees | None published for reads at this volume. |
| PyPI | `GET https://pypi.org/pypi/<name>/json` | Live: `info.version` | |
| crates.io | `GET https://crates.io/api/v1/crates/<name>` | `crate.max_stable_version`, falling back to `crate.newest_version`; a User-Agent is required by policy (seen in client code using the API) | Their crawler policy asks for 1 request/s; we batch 5 at a time every 3 h, deduplicated. |
| Atlassian Statuspage | `GET <page>/api/v2/summary.json` | `status.indicator` (none, minor, major, critical), `incidents[]` with `id`, `name`, `status`, `impact`, `shortlink` ([Bitbucket status API](https://bitbucket.status.atlassian.com/api)). Confirmed Statuspage: Bitbucket, Cloudflare (statuspage.io), Anthropic at `status.claude.com`. GitHub (`www.githubstatus.com`), Vercel (`www.vercel-status.com`), Discord, npm, Netlify, DigitalOcean, Twilio, Supabase, CircleCI and Coinbase are listed from known Statuspage hosts and not fetched here. | |
| incident.io (OpenAI) | `GET https://status.openai.com/api/v1/summary`, falling back to `/api/v2/summary.json` on 404 | Widget API: `ongoing_incidents[]` with `id`, `name`, `status`, `url`, `current_worst_impact` ([incident.io docs](https://docs.incident.io/status-pages/api.md)). Whether OpenAI keeps the widget API on is not confirmed. | Returns 404 if a page turns the widget API off. |
| EVM JSON-RPC (PublicNode) | `eth_gasPrice`, `eth_feeHistory ["0x5","latest",[50]]`, `eth_getTransactionByHash`, `eth_getTransactionReceipt`, `eth_call` (`decimals()` `0x313ce567`, `symbol()` `0x95d89b41`) | Standard Ethereum JSON-RPC | Public endpoints rate limit; set `RPC_*` for your own. |
| Solana JSON-RPC | `getRecentPrioritizationFees []`, `getSignaturesForAddress [addr, { limit: 10, until }]`, `getTransaction [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]` | Method list ([solana.com RPC](https://solana.com/docs/rpc/http.md)); `prioritizationFee` in micro-lamports per compute unit ([Helius](https://www.helius.dev/docs/api-reference/rpc/http/getrecentprioritizationfees)) | `api.mainnet-beta.solana.com` is rate limited and keeps limited history; set `RPC_SOLANA` for production. |
| Etherscan API v2 | `GET https://api.etherscan.io/v2/api?chainid=<id>&module=account&action=txlist|tokentx&address=...&startblock=...&endblock=99999999&page=1&offset=10&sort=desc&apikey=...` | Parameters and `status` / `message` / `result[]` with `hash`, `from`, `to`, `value`, `blockNumber`, `isError`, `functionName` ([txlist](https://docs.etherscan.io/api-reference/endpoint/txlist.md)); free plan 3 calls/s and 100,000 a day ([rate limits](https://docs.etherscan.io/rate-limits.md)) | Since November 2025 the free plan covers about 90% of chains; news reports name Base, BNB Chain, Optimism and Avalanche as paid only ([Etherscan note](https://info.etherscan.com/whats-changing-in-the-free-api-tier-coverage-and-why)). On those chains Etherscan answers with an error string, which "my watches" shows. `tokentx` field names follow the same family and weren't confirmed separately. |
| 4byte.directory | `GET https://www.4byte.directory/api/v1/signatures/?hex_signature=0x<8 hex>` | `results[].text_signature`, `id`; we take the lowest id. The site asks for limited concurrency. Cached forever in `tech_cache`. | A small built-in table covers transfer, approve, swaps, multicall and friends first. |
| GoPlus token security | EVM `GET https://api.gopluslabs.io/api/v1/token_security/<chainId>?contract_addresses=<addr>`; Solana `GET .../api/v1/solana/token_security?contract_addresses=<mint>` | `{ code, message, result: { <address>: {...} } }`, flags as `"0"`/`"1"` strings, taxes as fractions (`"0.01"` is 1%) ([Dedaub migration notes](https://docs.dedaub.com/docs/token_safety/AGENTS)). Solana `mintable.status` / `freezable.status` as used by `launches.ts`. | Keyless with a modest rate limit. |
| GoPlus approval security v2 | `GET https://api.gopluslabs.io/api/v2/token_approval_security/<chainId>?addresses=<wallet>` | Path and parameter ([GoPlus reference](https://docs.gopluslabs.io/reference/approval-security-api-v2)). The response fields we read (`result[].token_symbol`, `approved_list[].approved_contract`, `approved_amount`, `address_info.contract_name / is_open_source / malicious_behavior / doubt_list`) weren't shown on that page; the parser tolerates missing ones. | |
| Hyperliquid | `POST https://api.hyperliquid.xyz/info {"type":"metaAndAssetCtxs"}` | `[ { universe: [{ name, ... }] }, [ { funding, markPx, prevDayPx, openInterest, ... } ] ]`, same order ([Hyperliquid docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals)). Funding is hourly. | Weight-based limits; one call per run covers every alert. |
| Binance USD-M futures | `GET https://fapi.binance.com/fapi/v1/premiumIndex?symbol=<COIN>USDT` | `lastFundingRate`, `nextFundingTime`, `markPrice`; weight 1 with a symbol ([Binance docs](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price)) | Only for "funding on X", as a second opinion. Binance blocks some regions (HTTP 451); the reply then shows Hyperliquid alone. |
| Polymarket Gamma | `GET https://gamma-api.polymarket.com/public-search?q=...`, `GET .../markets/<id>` | Base URL, `/public-search?q=`, `/markets/<id>` ([Polymarket docs](https://docs.polymarket.com/market-data/discover-markets.md)); `events[].markets[]`, and `outcomes` / `outcomePrices` as JSON strings ([endpoint reference](https://download.hermesedi.duckdns.org/.hermes/hermes-agent/skills/research/polymarket/references/api-endpoints.md)) | Read only, so it works wherever Polymarket's site can be viewed. |
| ENS | `GET https://ensdata.net/<name or address>` | Name and address lookups, keyless ([ensdata.net](https://ensdata.net/)). The fields we read (`address`, `ens_primary`, `ens`) weren't shown there. | No published rate limits; the author asks heavy users to get in touch. |
| SNS (Bonfida) | `GET https://sns-sdk-proxy.bonfida.workers.dev/resolve/<name>`, `/favorite-domain/<owner>` | `{ "s": "ok", "result": "<owner>" }` for resolve ([SNS SDK README](https://github.com/unstoppablefi/sns-sdk)); favorite-domain's `result.reverse` read defensively | |
| CoinGecko | `prices.ts` `fetchPrices(["ethereum"])` | Reused, only for the "a transfer costs about $X" line | Optional. |

## Known gaps and core requests

- "remind me to rotate the Stripe key every 90 days" is taken by the core reminder rule before plugin rules run, so without a model it becomes a plain reminder. "rotate the Stripe key every 90 days" works. Core fix: skip `reminder.create` when the text matches `rotate ... (key|token|secret|password|credentials)`, or check plugin rules first for that shape.
- `isCapabilityQuestion` reads "is this token safe 0x..." without a chain word, and "can you explain tx 0x...", as questions about abilities, because a hex address doesn't count as a concrete argument. Core fix: treat an address, hash or URL as concrete. With "on base" it works.
- The core stores every message in `messages` (and `audit_log.source_message`) before any feature sees it, so a pasted key or JWT is still in those tables even though this area refuses to keep it. Core fix: redact secret-looking strings before insert (the patterns in `shared.ts` `looksSecret` would do).
- "alert me if it moves 10%" (a Polymarket market) is caught by the core `price.alert` rule as a coin called "it". "10 points" works. Core fix: don't take pronouns as coins.
- Safety's `scam.check` rule takes "is 0x... a scam / safe" before this area sees it. "is this token safe 0x... on base" and "check token 0x..." reach `token.check`. Worth agreeing that a contract address with a chain goes to `token.check`.
- The core portfolio (`prices.ts`) has no Optimism; activity alerts here do.
- Wallet activity covers native transfers and ERC-20 transfers (`txlist` + `tokentx`); NFT transfers and internal transactions aren't included.
