# Ways to sign in on the website

The website's "Come in" card always offers Telegram first. Under it, quietly, it can also offer:

- **Continue with Google**
- **Continue with Apple**
- **Use my phone number**: a six-digit code by text message, or by iMessage
- **Use my email**: a six-digit code by email

Each one only appears once it's set up. Nothing changes for anyone until you add the settings below, and you can add them one at a time.

Someone who comes in this way without Telegram is asked two things on the web, their name and their city or time zone, and then goes straight into their day. New people count against the circle's size (`MAX_USERS`) exactly like Telegram sign-ups.

Anyone already signed in can add or remove ways in from **Settings, Ways to sign in**. If a Google account, Apple ID, number or address already belongs to another lifeline account, the page says so and nothing is merged. Nobody can remove their last way in.

## Before you start

Check these two are set in Doppler (project lifeline, config prd). Most setups have them already.

| Name | Value |
|---|---|
| `WEB_URL` | the website people open, for example `https://lifeline-web-one.vercel.app` |
| `SESSION_SECRET` | any long random string. On a Mac, run `openssl rand -hex 32` in Terminal. Codes are stored scrambled with it. |

Sign-in requests are only accepted from lifeline's own pages. The server recognises the website from `WEB_URL`, `PUBLIC_URL` and the address Vercel forwards. If you move the website to a new domain, update `WEB_URL` too.

## Google

Free, about ten minutes. You need a Google account.

1. Open **console.cloud.google.com** and sign in. At the top, open the project picker and choose **New project**. Call it `lifeline` and create it.
2. In the search bar, type **Google Auth Platform** and open it. If it asks you to get started, fill in:
   - App name: `lifeline`
   - User support email: your email
   - Audience: **External**
   - Contact email: your email
   Then agree and create.
3. Open **Branding** and add your website's address (the `WEB_URL`) under authorised domains, without `https://`. Save.
4. Open **Audience** and press **Publish app**, so anyone can sign in, not only test users. lifeline only asks for name and email, which needs no review from Google.
5. Open **Clients**, then **Create client**:
   - Application type: **Web application**
   - Name: `lifeline website`
   - **Authorised JavaScript origins**, add two:
     - your website, for example `https://lifeline-web-one.vercel.app`
     - your Railway address, for example `https://lifeline-production.up.railway.app`
   - Authorised redirect URIs: leave empty. lifeline uses Google's pop-up, which doesn't need one.
   Press **Create**.
6. Copy the **Client ID**. It ends in `.apps.googleusercontent.com`. You don't need the client secret; don't paste it anywhere.
7. In Doppler, add it and save:

   | Name | Value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | the Client ID from step 6 |

Railway restarts by itself. Reload the website: "Continue with Google" appears under the Telegram button.

If the Google button says the origin isn't allowed, the address in the browser's bar doesn't exactly match one of the origins in step 5. Add it there (with `https://`, and no slash at the end) and wait five minutes.

## Apple

Sign in with Apple needs a **paid Apple Developer account** (99 US dollars a year, at developer.apple.com/programs). Without one, skip this section; everything else works.

1. Sign in at **developer.apple.com/account**, and open **Certificates, Identifiers and Profiles**.
2. **An App ID first.** Open **Identifiers**, press **+**, choose **App IDs**, then **App**.
   - Description: `lifeline`
   - Bundle ID: Explicit, for example `com.yourname.lifeline`
   - Under Capabilities, tick **Sign in with Apple**.
   Continue and register.
3. **Now the Services ID**, which is what the website uses. In **Identifiers**, press **+** again, choose **Services IDs**.
   - Description: `lifeline website`
   - Identifier: for example `com.yourname.lifeline.web` (it must differ from the App ID). This is your `APPLE_CLIENT_ID`.
   Continue and register.
4. Open the Services ID you just made, tick **Sign in with Apple**, and press **Configure**:
   - Primary App ID: the App ID from step 2
   - **Domains and Subdomains**: your website's domain without `https://`, for example `lifeline-web-one.vercel.app`
   - **Return URLs**: your website's address with a slash at the end, for example `https://lifeline-web-one.vercel.app/`
   Press **Next**, **Done**, then **Continue** and **Save**.
5. In Doppler, add and save:

   | Name | Value |
   |---|---|
   | `APPLE_CLIENT_ID` | the Services ID identifier from step 3 |
   | `APPLE_REDIRECT_URI` | optional. Only if the Return URL in step 4 isn't exactly your website's address with a slash at the end |

Reload the website: "Continue with Apple" appears.

Good to know:
- Apple shares the person's name only the very first time they sign in. lifeline keeps it then; if it was missed, they type it on the welcome step.
- People can choose "Hide my email". lifeline never treats those relay addresses as their email.
- Apple doesn't accept `localhost` or bare IP addresses, so test on the real website.
- If Apple ever asks you to verify the domain by hosting a file, put that file in `web/.well-known/` in the repo and push; Vercel will serve it.

## Codes by text message or iMessage

There's nothing extra to set up. As soon as SMS is set up (docs/SMS.md), the website offers "Text me a code". As soon as iMessage is set up (docs/IMESSAGE.md), it offers "iMessage me a code". The code comes from the same number people text lifeline on.

People type their number with its country code, like `+44 7700 900123`. The code is six digits and works for ten minutes. Each number gets at most three codes an hour, and each code allows five tries. The page always answers "If that number can get texts, a code is on its way", whether or not that number belongs to anyone, so nobody can use it to find out who's in your circle.

Every code text costs what a normal text costs on your SIM or Twilio plan.

## Codes by email

This appears once lifeline can send email: `SMTP_URL` or `RESEND_API_KEY`, plus `EMAIL_FROM` (see docs/EMAIL.md). Gmail with an app password is the easiest way to reach everyone; Resend without a verified domain only delivers to your own address.

An email code signs in the person who already has that address, either because they linked it or because they confirmed it in settings. Otherwise it makes a new account, if the circle has room.

## Everything in Doppler, in one place

| Name | Needed for |
|---|---|
| `WEB_URL` | all of them: so sign-ins from the website are recognised |
| `SESSION_SECRET` | codes (stored scrambled with it) and sessions |
| `GOOGLE_CLIENT_ID` | Continue with Google |
| `APPLE_CLIENT_ID` | Continue with Apple |
| `APPLE_REDIRECT_URI` | Apple, only if your Return URL is unusual |
| SMS settings (docs/SMS.md) | Text me a code |
| iMessage settings (docs/IMESSAGE.md) | iMessage me a code |
| `SMTP_URL` or `RESEND_API_KEY`, and `EMAIL_FROM` | Email me a code |

## Safety, in short

- Sign-in requests must be JSON from lifeline's own pages. Anything from another site is refused.
- Google and Apple tokens are checked against Google's and Apple's published keys: who issued them, that they're for your client id, and that they haven't expired. Apple's must also carry a one-time number lifeline issued a moment before.
- Codes are never stored or logged as they are. Only a scrambled copy is kept, and the log never shows full numbers or addresses.
- Link codes that don't work are counted, per address and across the whole server, so nobody can work through them by guessing.
- Linking never merges two accounts.
- The existing Telegram sign-in, the link code, and sessions work exactly as before.
