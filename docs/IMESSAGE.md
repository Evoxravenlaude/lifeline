# Turning on iMessage

Apple has no public way for a bot to send or receive iMessages, so lifeline uses a relay. There are two:

| | BlueBubbles | Sendblue |
|---|---|---|
| Cost | Free | Paid, per message |
| Needs | A Mac that stays on and online | Nothing of yours |
| Setup | 20 minutes | 10 minutes |

## BlueBubbles (free, on a Mac)

1. **Use a separate Apple ID if you can.** Whatever Apple ID the Mac's Messages app is signed into becomes lifeline's iMessage address. If it's your own, lifeline sees every iMessage you get. It stays silent with anyone who isn't linked unless they mention lifeline or send a link code, but a separate Apple ID keeps your own messages out of it entirely.
2. On the Mac, sign into Messages with that Apple ID and send yourself one message to check it works.
3. Install **BlueBubbles Server** from bluebubbles.app and open it. Set a server password.
4. In BlueBubbles, under **Connection**, turn on a proxy service (the Cloudflare option is free). It gives you a public address like `https://something.trycloudflare.com`. Use a dynamic DNS or Cloudflare's named tunnel if you want it to stay the same after restarts.
5. Under **API & Webhooks**, add a webhook:
   - URL: `https://lifeline-production.up.railway.app/webhooks/imessage?secret=YOUR_WEBHOOK_SECRET` (the same `WEBHOOK_SECRET` that's already in Doppler)
   - Event: **New Messages**
6. Keep the Mac awake: System Settings, Energy, "Prevent automatic sleeping", and tick BlueBubbles' own "Keep Mac awake" option.
7. In Doppler (lifeline / prd), add:
   - `IMESSAGE_PROVIDER` = `bluebubbles`
   - `BLUEBUBBLES_URL` = the public address from step 4, no trailing slash
   - `BLUEBUBBLES_PASSWORD` = the server password
   - `IMESSAGE_ADDRESS` = the phone number or email of that Apple ID, so the bot can tell people where to message
8. Railway redeploys. Send `/doctor` to the bot: iMessage should show as on.
9. To link yourself: say `link` to the bot on Telegram, then iMessage `link CODE` to the address.

lifeline sends with AppleScript by default, which works on any Mac. If you've installed BlueBubbles' Private API helper (it needs System Integrity Protection turned off), set `BLUEBUBBLES_METHOD=private-api` for faster, more reliable sends.

If the Mac sleeps, loses internet or BlueBubbles quits, iMessage stops until it's back. Telegram and everything else keep working.

## Sendblue (paid, hosted)

1. Make an account at sendblue.co and get an API key and secret.
2. In Sendblue's dashboard, set the inbound webhook to `https://lifeline-production.up.railway.app/webhooks/imessage?secret=YOUR_WEBHOOK_SECRET`.
3. In Doppler: `IMESSAGE_PROVIDER=sendblue`, `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, and `IMESSAGE_ADDRESS` (your Sendblue number).

## What works on iMessage

Everything text does: reminders, lists, questions, games (type the letter or the answer), and replies of 1 or 2 where Telegram shows buttons. Photos and voice notes sent over iMessage aren't read yet; send those on Telegram or the website.
