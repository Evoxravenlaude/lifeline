# The lifeline app (install it, get notifications)

The website can be installed like an app on phones and computers, and it can deliver reminders and pings as notifications. This is for people who mute or block Telegram while they focus and still want their reminders to arrive.

There's no app store involved: it's a Progressive Web App (PWA). The same website, once installed, opens in its own window from the home screen or dock.

## What people see

- **Install lifeline.** On Android and desktop Chrome or Edge, an Install button. On iPhone and iPad, a short how-to: open the site in Safari, tap Share, then Add to Home Screen. lifeline offers this once, gently, a little after the day has loaded. After that it lives in **Settings, This app**, and never nags.
- **Notifications on this device**, On or Off, in the same card. The browser asks for permission once. A line under the switch says what's happening ("Waiting for your answer in the address bar", "On, and this device has been tested", or how to unblock them on this exact device).
- **Asked at the right moment.** Right after someone sets their first reminder, adds a medication or starts a check-in on the web, the chat offers "Want that to ring on this device too?" with one button. That's when the ask makes sense to them. It shows at most once a fortnight, never inside Telegram, and never once they've blocked notifications.
- **Where should reminders reach you?** Telegram, This app, or Both. Both sends each reminder to the app and to Telegram, so muting one never means missing it.
- Notifications sit on lock screens, so anything about health, the cycle, mood, quitting, grief, safety or a remembered fact says only what sort of thing it is ("A medication reminder. Open lifeline for the details."); the details wait inside the app. The morning brief shows its first line. A yes that moves money or reaches someone is never a button on a notification; tapping opens Today.
- Signing out on a device also turns off that device's notifications, so the next person to use it never sees them.
- Reminders arrive as notifications. Where the platform supports buttons (Chrome and Edge on Android, Windows, Mac and Linux), the first two buttons of the reply, such as Done and Snooze, or Taken and Skip, appear on the notification and work without opening anything. Elsewhere (Safari, iPhone), tapping the notification opens lifeline on the right page: doses on Health, reminders and anything waiting on your yes on Today, everything else in Chat.

## How it works

- `web/manifest.webmanifest` tells the browser the name, icons (including a maskable one for Android), colours and start page.
- `web/sw.js` is the service worker. It's served from the site's root by both Vercel and the Railway server, so it covers every page. It:
  - keeps fonts and icons for instant loads, and keeps a copy of the code and styles for when the network is slow;
  - shows a calm "You're offline" page (`web/offline.html`) when there's no connection;
  - never caches `/api` or `/auth`, so your day is always fresh;
  - turns each push into a notification, and handles taps on it and its buttons.
- `src/core/webpush.ts` sends pushes with the `web-push` package and your VAPID keys. Each browser that turns notifications on is one row in `push_subscriptions`, per person and per device. A person with at least one gets an "app" way of being reached, and the dispatcher (`src/core/dispatch.ts`) uses it like Telegram or SMS. If a push service says a subscription is gone (404 or 410), or refuses it because it was made with an older server key (403 mentioning VAPID), it's dropped on the spot, and the page makes a fresh one on its next visit. Every send is logged as delivered or not (no content), for `/stats`.

### Why "the button didn't work" (fixed in v19)

Chrome now often shows a quiet prompt: a small "Get notifications? Allow" bubble in the address bar instead of a pop-up. While that bubble is showing, the permission request answers "default" straight away, as if the person had dismissed it. The old switch read that as a no and said "Notifications stay off", while the bubble was still waiting for an answer. Tapping Allow afterwards did nothing, because the page had already given up.

What it does now (`web/app.js`):
- Remembers that the person asked (`ll_push_wanted`), then waits up to 90 seconds for the answer, watching the permission status, page focus and `navigator.permissions` changes. The status line says to look for the bubble in the address bar.
- If the answer comes later, even after the page is closed and reopened, `resumePush` finishes the subscription on load and whenever the page comes back into view.
- Once a day it re-sends the subscription to the server (`ll_push_synced`), so a database restore or a dropped row heals itself.
- If the server's key changed, the old subscription is replaced rather than left broken.
- When notifications are blocked, it shows the steps for that device: iPhone home-screen app, Android installed app, Android Chrome tab, or desktop (the padlock or tune icon beside the address).
- Inside Telegram's in-app view, where web notifications can't work, the card says so and offers "Open in your browser" instead of a switch that can't succeed.
- The fallback chain is unchanged: the preferred place first, then Telegram, the app, iMessage, SMS, the web inbox, and email as the last resort. With **Both**, the app is sent to as well as the chain, and if the app reached the person, the email last resort isn't used.

## Inside the app

### Your day, as a timeline

Today has a card that lays the day out by time: calendar events, reminders, classes, medication doses and trip plans. A strip across the top shows the whole 24 hours, with a mark for each thing and a brass line at now. Below it the day runs in order on a rail, with a "Now" marker between what's behind you and what's still to come.

- A filled dot is still to come. A tick is done: a reminder ticked off, a dose taken or skipped, an event or class that's over. A dashed dot is a time that went by without a mark ("Not ticked off", "Not marked"), or a dose that's waiting on an answer.
- Reminders have Done and Snooze; a dose waiting on you has Taken and Skip. They work the same as everywhere else.
- The arrows step a day at a time, up to a week either way, and "Back to today" returns. A trip that covers the day shows as a chip ("Lisbon trip, day 2 of 5").
- Only real things show. An empty day says so.

It reads `GET /api/day?date=YYYY-MM-DD` (today when left off), signed in like every other `/api` call, in the person's own time zone. The code is `dayPlan` in `src/web/views.ts`.

### The cycle calendar

On Health, for someone who has logged a period or chosen cycle settings, there's a month calendar under the cycle card. Nobody else sees it, and it never appears anywhere but this page.

- Logged period days are filled in. The next period and the fertile window are marked only as `src/modules/cycle.ts` predicts them, from the person's own history, and are left off when the period is late, the same as the brief and the chat.
- A dot means something was noted that day. Tap a day to see what.
- The arrows move month to month, up to two years either way.
- It says plainly that these are estimates, not birth control.

It reads `GET /api/cycle?month=YYYY-MM`, which answers `{ shown: false }` for anyone who doesn't track their cycle, and `Cache-Control: no-store` always. The lock-screen rules for notifications don't apply here, since this is inside the app.

### The emergency card, kept on the phone

Health also shows the emergency card, ready to copy or screenshot (`GET /api/emergency`, which reads it through the same action as "show my emergency card").

Inside Telegram's app, on a Telegram version with secure storage (Bot API 9.0 or later), there's **Keep a copy on this phone**. The card's text goes into Telegram's SecureStorage on that phone, tied to that Telegram account. If lifeline can't be reached later, the Mini App shows the copy under the "can't reach the server" notice, and Health shows it too. **Update the copy** appears when the card has changed since, and **Remove the copy** takes it off the phone. Telegram Desktop and the web version don't have secure storage, so the offer doesn't appear there. Outside Telegram there's no copy at all; the website never keeps the card in the browser's own storage.

### Files in chat

A reply can carry a file (a calendar invite, a PDF). In the web chat it shows as a **Save** button with the file's name, the same as a picture's Save. `/api/chat`, `/api/voice`, `/api/photo`, `/api/button` and `/api/do` pass it through after a check (`src/web/replies.ts`): real base64, a plain name with no folders, and a type a browser can be given safely. Anything that could run as a page is saved as plain bytes.

## Turning on notifications (once, for whoever runs lifeline)

1. **Make the keys.** On any computer with Node installed, in Terminal:

   ```
   npx web-push generate-vapid-keys
   ```

   It prints a Public Key and a Private Key. Keep this window private; don't paste the private key into any chat.

2. **Put them in Doppler** (project lifeline, config prd), then Save:

   | Name | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | the Public Key |
   | `VAPID_PRIVATE_KEY` | the Private Key |
   | `VAPID_SUBJECT` | `mailto:` and your email, for example `mailto:you@example.com`. Push services use it to reach you if something's wrong. |

3. Railway restarts. Open the website, go to **Settings, This app**, turn notifications on, and press **Send a test**.

Keep the same keys forever. If you change them, every device has to turn notifications on again.

## Platform notes, honestly

- **iPhone and iPad:** notifications work from iOS and iPadOS 16.4 onwards, and only once lifeline is added to the Home Screen and opened from there. In Safari itself, the settings card explains this instead of offering a switch. Notification buttons aren't shown on iPhone; tapping opens the app.
- **Android:** Chrome, Edge, Samsung Internet and Firefox all work. Some phone makers' battery savers delay notifications; setting the browser to "Unrestricted" battery use helps.
- **Desktop:** Chrome, Edge, Firefox and Safari on the Mac all work. The browser has to have run at least once since the computer started.
- **Inside Telegram:** the Mini App doesn't install or register for notifications. That's Telegram's frame, not a browser. Telegram's own messages already ring there; for app notifications too, the card's "Open in your browser" button opens lifeline outside Telegram.
- **Chrome's quiet prompt:** on sites people haven't used much, Chrome may show only a small bubble in the address bar. lifeline waits for it (see above) instead of treating it as a no.
- Focus modes and Do Not Disturb on the device still apply. That's the person's choice, and lifeline respects it.

## Optional: putting it in the app stores

You don't need this. The installed website already does everything above. But if people expect to find lifeline in a store:

### Google Play, with Bubblewrap (a Trusted Web Activity)

A Trusted Web Activity is a tiny Android app that opens your website full screen, with your notifications and everything else working as they do on the web.

1. You need a Google Play developer account (a one-time 25 US dollar fee) and, at the time of writing, new personal accounts must run a closed test with at least 12 testers for 14 days before going public. Check Play Console's current rules.
2. Install Bubblewrap: `npm i -g @bubblewrap/cli`
3. In an empty folder: `bubblewrap init --manifest https://<your website>/manifest.webmanifest`. Answer the questions; it reads the name, colours and icons from the manifest.
4. `bubblewrap build` makes an `.aab` file to upload to Play Console, and a signing key. Keep the key and its password somewhere safe; you need them for every update.
5. Prove the app and the website belong together: `bubblewrap fingerprint` prints a SHA-256 fingerprint. Put an `assetlinks.json` file (Bubblewrap can generate it) at `web/.well-known/assetlinks.json` in this repo and push. If Play signs the app for you, also add Play's own fingerprint from Play Console, App integrity.
6. Upload, fill in the store listing and the data safety form, and submit.

Website changes reach the Play app instantly; you only rebuild for a new icon or name.

### Apple App Store, with a thin wrapper such as Capacitor

Possible, but weigh it first:

- You need the paid Apple Developer account (99 US dollars a year) and a Mac with Xcode.
- Apple's review guideline 4.2 (minimum functionality) often rejects apps that are only a website in a frame. You'd likely need app-only features to pass.
- Web push doesn't work inside a wrapped app. Notifications would need Apple's own push service (APNs) through a plugin such as `@capacitor/push-notifications`, plus server code to send through it, which lifeline doesn't have yet.
- Since lifeline offers Google sign-in, Apple requires Sign in with Apple in the app too (lifeline has it; see docs/SIGNIN.md).

The rough path: `npm i @capacitor/core @capacitor/cli @capacitor/ios`, `npx cap init lifeline com.yourname.lifeline --web-dir web`, set `server.url` in `capacitor.config` to your website, `npx cap add ios`, open the project in Xcode, then archive and upload to App Store Connect.

For most people, Add to Home Screen on iPhone gives the same thing today, without review, fees or a Mac.

## Safety, your data and privacy

- **Safety** (in the bar on a laptop, under More on a phone): check a message that feels off, start or end a check-in, see safety contacts, make the emergency card a lock-screen picture, log an incident and export the log as a PDF, and the legacy plan's state. `GET /api/safety`.
- **Settings** has Calm (calm mode, quiet day), On Telegram (reactions, topics) and Your data (export, delete with a yes, privacy).
- **Today** says what Pip carries and how many kept days until his next thing. `GET /api/you`.
- **Privacy** is a static page, `web/privacy.html`, at `/privacy`.
