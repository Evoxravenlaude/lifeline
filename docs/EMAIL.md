# Turning on email

Email does three things:

- **Send**: "email me my shopping list", the morning brief by email as a last resort, and emails to other people (always shown in full first, then sent only after a yes).
- **Receive**: anyone in the circle can email lifeline or forward it things. A flight booking becomes a trip, an invite becomes an event, a bill becomes a reminder. Forwarded mail is read as information, never as instructions.
- **Reply**: lifeline answers by email.

## Sending (Gmail, free)

Gmail is the simplest way to send to anyone. Resend can send too, but without your own domain it only delivers to its account owner.

1. On the Google account you'll send from, turn on 2-Step Verification.
2. Go to myaccount.google.com/apppasswords and make an app password called lifeline. Copy the 16 letters.
3. In Doppler:
   - `SMTP_URL` = `smtps://you%40gmail.com:THE16LETTERS@smtp.gmail.com:465` (the `@` in your address becomes `%40`; remove the spaces from the app password)
   - `EMAIL_FROM` = `lifeline <you@gmail.com>`

## Receiving (Resend, free)

1. Make an account at resend.com.
2. Open **Receiving**. Resend gives you a free address on its own domain, like `anything@abc123.resend.app`. Pick one, e.g. `lifeline@abc123.resend.app`.
3. Open **Webhooks**, add an endpoint:
   - URL: `https://lifeline-production.up.railway.app/webhooks/email`
   - Event: `email.received`
   Copy its **signing secret**.
4. Open **API Keys** and create one with full access (it needs to read received mail).
5. In Doppler:
   - `RESEND_API_KEY` = the key
   - `RESEND_WEBHOOK_SECRET` = the signing secret (starts with `whsec_`)
   - `INBOUND_EMAIL` = the address from step 2
6. Railway redeploys. `/doctor` shows "Email in" as on.
7. To link yourself: say `link` to the bot, then email `link CODE` to the inbound address from the address you'll use.

## Safety

- Every webhook's signature is checked, so nobody can post fake mail to the server.
- Mail that fails both SPF and DKIM is ignored, so nobody can pretend to be you.
- Addresses that aren't linked get no reply unless they mention lifeline or send a link code.
- Emails to other people always wait for your yes.
