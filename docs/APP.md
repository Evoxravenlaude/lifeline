# The lifeline app (install it, get notifications)

The website can be installed like an app on phones and computers, and it can deliver reminders and pings as notifications. This is for people who mute or block Telegram while they focus and still want their reminders to arrive.

There's no app store involved: it's a Progressive Web App (PWA). The same website, once installed, opens in its own window from the home screen or dock.

## What people see

- **Install lifeline.** On Android and desktop Chrome or Edge, an Install button. On iPhone and iPad, a short how-to: open the site in Safari, tap Share, then Add to Home Screen. lifeline offers this once, gently, a little after the day has loaded. After that it lives in **Settings, This app**, and never nags.
- **Notifications on this device**, On or Off, in the same card. The browser asks for permission once.
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
- `src/core/webpush.ts` sends pushes with the `web-push` package and your VAPID keys. Each browser that turns notifications on is one row in `push_subscriptions`, per person and per device. A person with at least one gets an "app" way of being reached, and the dispatcher (`src/core/dispatch.ts`) uses it like Telegram or SMS. If a push service says a subscription is gone (404 or 410), it's dropped on the spot.
- The fallback chain is unchanged: the preferred place first, then Telegram, the app, iMessage, SMS, the web inbox, and email as the last resort. With **Both**, the app is sent to as well as the chain, and if the app reached the person, the email last resort isn't used.

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
- **Inside Telegram:** the Mini App doesn't install or register for notifications. That's Telegram's frame, not a browser.
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
