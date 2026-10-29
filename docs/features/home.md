# Home and the world

Code: `src/modules/features/home/` (one file per feature, `index.ts` imports them in rule order and owns the `hm:` buttons). Tests: `test/features-home.test.ts`. Tables start with `home_`.

Every outside service is optional. When one can't be reached the person gets a plain sentence ("I couldn't reach the sports listings just now. Try again in a few minutes."), and the brief sections only read the database, never the network.

## Features

| Feature | Say | Drawer | Pings |
| --- | --- | --- | --- |
| Utilities and refills | "refilled the gas 12.5kg for 15000", "topped up 50 kWh of electricity", "power units at 20", "filled the generator with 10 litres", "ran the generator 4 hours", "water delivery today", "power cut from 6pm to 11pm", "power is out" / "power is back", "my utilities", "power this week" | Home and paperwork | Brief line when gas, power units or water may run out within 3 days; one ping per refill about 2 days out (09:00 to 20:00 local). "stop the gas reminders". |
| Home maintenance | "service the AC every 6 months", "clean the water tank every 3 months, last done in august", "generator service every 100 hours", "fumigate yearly", "serviced the AC", "my home jobs", "stop the AC job" | Home and paperwork | Brief line from 3 days before to 7 days after it's due; one ping on the due day. |
| Outages near you (circle) | "alert me about outages in Rumuola", "power is out in Rumuola", "water cut in Akanda", "internet down in Kilimani", "light is back in Rumuola", "stop outage alerts" | Home and paperwork | Reports are tier 2 (they reach other people): the reporter sees who will be told and says yes. Followers get one merged line, at most 2 a day; the all-clear goes in the brief only. |
| Your teams | "follow Arsenal", "follow the Lakers", "follow Super Eagles", "when do Barcelona play", "my teams", "stop following Arsenal" | Your day | One kickoff ping a day per person, about an hour before (merged if several teams play); results in the brief. |
| Faith rhythms | "prayer times today", "Fajr and Maghrib reminders", "suhoor and iftar reminders", "Sunday service at 10", "Shabbat candle lighting Friday sunset", "daily devotional at 6am", "my faith reminders", "stop the prayer reminders" | Your day | Only what the person set: each reminder at its time (exempt, like their own reminders). The first one says how to stop them. Never offered unasked. |
| Holidays and long weekends | "next public holiday", "long weekends this year", "public holidays this year in Kenya" | Your day | Brief line a week before and the day before a holiday, only when the country is known for sure. |
| Flight status | "status of BA75 tomorrow", "is ET900 on time", "is my flight on time", "stop flight checks" | Your day | One automatic check (and ping) 0 to 5 hours before each flight saved in a trip with its number. |
| Your year, wrapped | "my year wrapped", "2026 wrapped", "compare my year with the circle", "stop comparing my year", "no year wrapped" | Fun | One message between 28 and 31 December (10:00 to 19:00 local, through push so calm mode and quiet days apply). |

Notes per feature:

- **Learning how long things last.** The average of the last four gaps between refills of the same kind (1 to 400 days). For prepaid power, meter readings ("power units at 60") give a burn rate (units before, plus top-ups between, minus units after, over the days), which wins over gaps. Costs are stored in the currency said or `userCurrency(user)`; "my utilities" shows this month and the monthly average of the six months before, per currency.
- **Supply evidence.** "power this week" gives hours off, cuts, % of hours supplied and the longest cut; the "Copy the log" button returns a dated, provider-neutral log in a code block. Cuts are personal and never shared.
- **Generator hours** come from "ran the generator N hours" and "generator on" / "generator off". Home jobs counted in hours use the same log.
- **Neighbourhoods, never addresses.** Area names with house numbers, street or flat words, or long numbers are refused before anything is kept. Reports keep the neighbourhood name, kind and times only, and alerts never name the reporter. A report is "open" for 12 hours. Five followed areas at most per person.
- **Teams.** TheSportsDB finds every team (nicknames like Super Eagles, Black Stars, Springboks are mapped). With a football-data.org key, football teams in its free competitions are matched by name (cached team lists, learned two competitions per poll run) and their fixtures come from there instead. A shared poll every 15 minutes (`4,19,34,49 * * * *`) sends kickoffs and refreshes at most four teams a run (listings older than 6 hours, or a game that should have finished).
- **Faith.** Never assumes a religion: everything starts from the person asking. Location is `prefs.city` (set by "my city is ...") or a city named in the request, looked up once and kept in `prefs.home.place`. Ramadan reminders (45 minutes before Fajr, and at Maghrib) only run while Aladhan's Hijri month is 9. Practices: clock times use the person's time zone; sunrise and sunset use their city; "candle lighting" at sunset is 18 minutes before; services, mass, church, synagogue, temple and candle lighting get a 30-minute heads-up. A shared hourly job (`11 * * * *`) plans each person's day once.
- **Holidays.** Country is `prefs.country`, else a guess from the time zone (`countryOf`), else asked once (and saved). Replies say when it's a guess. "my country is Kenya" is handled by the money area's `tax.country`, which also sets `prefs.country`. Long weekends use the country's own weekend (Friday and Saturday in much of the Middle East, for example) and look for one or two working days that join a holiday to a weekend. A daily job (`37 3 * * *`) keeps each member country's list cached.
- **Flights.** The flight number is read from the trip item's title (two characters and a number, like `BA75` or `KQ 532`, upper case). Requests are counted per month in `home_cache`; automatic checks stop at 80 so 20 stay for asking; each flight is checked at most once a day.
- **Year wrapped.** Cards: you and me (messages, busiest month), things done (reminders, list items), money (per currency, top category), rest and steps (average sleep, total steps), habits (check-ins, longest daily run), out in the world (trips started this year and places), home (refills, home jobs done). Never mood, weight, blood pressure, cycle or medication. The circle comparison needs the person to ask (that opts them in), uses only others who opted in, waits for at least three people, and shows medians of four counts: trips, places, longest habit run, reminders done.

## Env vars

| Var | Needed for | Without it |
| --- | --- | --- |
| `FOOTBALL_DATA_KEY` | football-data.org fixtures for football teams in its 12 free competitions | TheSportsDB is used for every sport. |
| `THESPORTSDB_KEY` | A paid TheSportsDB key (optional) | The free test key `3` (non-commercial use). |
| `AVIATIONSTACK_KEY` | Flight status, on request and automatic | Replies say what's needed; no request is made. |
| `AVIATIONSTACK_BASE` | Override the API base (default `https://api.aviationstack.com/v1`) | If the plan refuses https (`https_access_restricted`), it switches to http once and remembers. |

## Data sources

Direct fetches to these sites were blocked from the build sandbox, so endpoints were checked through the docs pages and mirrors listed here; every URL the code calls is asserted in the tests.

- **TheSportsDB v1** (https://www.thesportsdb.com/api.php): `GET /api/v1/json/{key}/searchteams.php?t=`, `eventsnext.php?id=`, `eventslast.php?id=`. Free key `3`, non-commercial, about 30 requests a minute, search returns only a couple of results on the free key. Field names (`idTeam`, `strTeam`, `strSport`, `strLeague`, `idEvent`, `strHomeTeam`, `strAwayTeam`, `strTimestamp`, `dateEvent`, `strTime`, `intHomeScore`, `intAwayScore`, `strStatus`) and the wrapper keys (`events` for next, `results` for last) could not be confirmed against a live response; the code accepts either wrapper key and falls back from `strTimestamp` to `dateEvent` + `strTime`.
- **football-data.org v4** (https://docs.football-data.org/general/v4/): base `https://api.football-data.org/v4`, header `X-Auth-Token`. `GET /teams/{id}/matches?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD` (verified on the team resource page) and `GET /competitions/{code}/teams`. Match fields `id`, `utcDate`, `status`, `competition.name`, `homeTeam.shortName`, `awayTeam.shortName`, `score.fullTime.home/away` verified from the match resource page. Free plan: 10 requests a minute (verified on the policies page), 12 competitions (`PL ELC PD SA BL1 FL1 DED PPL BSA CL EC WC`, from the free-tier listing; the docs page itself doesn't list the codes). There's no team-name search, hence the cached competition lists.
- **Aladhan** (https://aladhan.com/prayer-times-api): `GET https://api.aladhan.com/v1/timings/{DD-MM-YYYY}?latitude=&longitude=` (optional `method=` from `prefs.home.prayerMethod`). Uses `data.timings.{Imsak,Fajr,Sunrise,Dhuhr,Asr,Sunset,Maghrib,Isha}`, `data.date.hijri.month.number`, `data.meta.timezone`. Checked against a documented example and the field list of a client library. Free, no key. Times are a calculation, so a local mosque's timetable can differ by minutes.
- **Open-Meteo** (https://open-meteo.com/en/docs): `GET https://api.open-meteo.com/v1/forecast?latitude=&longitude=&daily=sunrise,sunset&timezone=auto&forecast_days=7` (local ISO times in `daily.sunrise/sunset`); geocoding through `findCity` in `src/core/geo.ts`. Free, no key. `timezone=auto` (local times for the coordinates) and the ISO 8601 default were checked against a copy of the docs; the docs page itself was blocked here, so `sunrise`/`sunset` as daily variables and `forecast_days` are from Open-Meteo's published variable list, and the code accepts a missing day without failing.
- **Nager.Date v3** (https://date.nager.at/Api): `GET https://date.nager.at/api/v3/AvailableCountries` (cached 30 days) and `GET /api/v3/PublicHolidays/{year}/{countryCode}` (cached 7 days). Fields `date`, `localName`, `name`, `global`, `counties`, `types`; only `Public` types are used. About 120 countries; no key and no published rate limit. Countries not in `AvailableCountries` get a plain "doesn't cover ... yet".
- **AviationStack** (https://aviationstack.com/documentation): `GET /v1/flights?access_key=&flight_iata=`. The free plan has live data only (`flight_date` filtering is a paid, historical feature), so the code filters the response by `flight_date` itself. Fields `flight_date`, `flight_status`, `departure.{airport,scheduled,estimated,actual,delay,terminal,gate}`, `arrival.*`, `airline.name`, `flight.iata`. Times arrive as airport-local clock times marked `+00:00`, so only the clock part is shown, as "local time". Free plan: 100 requests a month.

## Tables

`home_cache`, `home_pings` (one ping per feature per day), `home_refills`, `home_outages`, `home_jobs`, `home_job_log`, `home_area_subs`, `home_area_reports`, `home_area_sent`, `home_teams`, `home_follows`, `home_matches`, `home_match_sent`, `home_faith`, `home_faith_plans`, `home_flight_checks`. Per-person settings live under `prefs.home` (place, quiet kinds, faith hint, year-wrapped and comparison opt-ins, flight checks).

## Known overlaps with core sentences

The core's strict rules run before plugin rules, so these go elsewhere today:

- "bought a 12.5kg gas cylinder" and "got a water delivery" are read as ticking off a shopping item ("bought ..." / "got ..."). "refilled the gas", "new gas cylinder 12.5kg" and "gas refill ..." work.
- "done the AC" is read as a habit check-in. "serviced the AC" and "AC service done" work.
- "remind me of Fajr and Maghrib" becomes an ordinary reminder. "Fajr and Maghrib reminders" works.
- "unfollow Arsenal" goes to copy-trading's unfollow. "stop following Arsenal" works.
