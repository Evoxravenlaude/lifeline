# Texting lifeline by SMS

People who don't use Telegram can text lifeline from any phone's Messages app. The cheapest way is a spare Android phone with a local SIM: it receives the texts, hands them to lifeline, and sends lifeline's replies. Texts cost whatever that SIM charges, at local rates, and there's no Twilio bill.

## What you need

- A spare Android phone (Android 8 or newer) with a local SIM and an SMS plan.
- A place where the phone can stay plugged in, with Wi-Fi or mobile data.
- 15 minutes.

## Set it up (httpSMS, the default)

1. **Install the app.** On the spare phone, install **httpSMS** from the Google Play Store and sign in with a Google account. Allow it to send and receive SMS when asked, and turn off battery optimisation for it (Settings, Apps, httpSMS, Battery, Unrestricted). If the phone has two SIMs, pick the one you want people to text.

2. **Copy the API key.** On a computer, open the httpSMS dashboard (httpsms.com), sign in with the same account, open **Settings**, and copy the **API key**.

3. **Add the webhook.** Still in the dashboard's settings, add a webhook:
   - URL: `https://lifeline-production.up.railway.app/webhooks/sms/httpsms` (your Railway address, then `/webhooks/sms/httpsms`)
   - Event: **message.phone.received**
   - Signing key: make one up. On a Mac, run `openssl rand -hex 32` in Terminal and copy what it prints. Don't paste it into any chat.

4. **Fill in Doppler** (project lifeline, config prd), then **Save**:

   | Name | Value |
   |---|---|
   | `SMS_PROVIDER` | `httpsms` |
   | `SMS_GATEWAY_API_KEY` | the API key from step 2 |
   | `SMS_WEBHOOK_SECRET` | the signing key from step 3 |
   | `SMS_GATEWAY_FROM` | the phone's own number, in +234 form with no spaces: `+2348012345678` |
   | `SMS_NUMBER` | the same number written for people: `+234 801 234 5678` |

   Doppler pushes these to Railway, which restarts the bot. The startup log line should now say `sms: "httpsms"`.

5. **Link a phone.** Each friend says **link** to lifeline on Telegram (or presses "Get a link code" in Settings on the web). They get six characters, then text `link ABC123` to the number in `SMS_NUMBER`. lifeline replies "Linked." From then on, texting that number is the same as talking to the bot on Telegram. Where Telegram would show buttons, the text shows `1) Yes, go ahead  2) No`; reply with the number.

## TextBee instead

TextBee (textbee.dev) works the same way. Install the TextBee app, copy the API key and device id from its dashboard, add a webhook to `https://<your Railway address>/webhooks/sms/textbee` for **Message Received**, and save the webhook secret it shows you. In Doppler set `SMS_PROVIDER=textbee`, `SMS_GATEWAY_API_KEY`, `SMS_GATEWAY_FROM` (the device id), `SMS_WEBHOOK_SECRET` and `SMS_NUMBER`.

## What to expect, honestly

- **One phone is the whole SMS service.** If it's off, out of battery, out of data or out of SMS credit, texts don't arrive and replies don't go out. Telegram and the web keep working. Keep it plugged in somewhere it won't be unplugged.
- **Costs are the SIM's.** Every reply is a normal SMS from that SIM. A busy day for 17 people can be a few hundred texts, so put it on a bundle.
- **Long replies get split.** SMS is 160 characters a part; longer replies arrive as several parts, which some networks charge separately. lifeline caps a reply at 1,500 characters.
- **Phone networks and Android may throttle bulk sending.** Android asks for permission past roughly 30 texts in 30 minutes from one app. Approve it on the phone and choose "always allow".
- **Numbers are matched in +234 form.** If the gateway reports a local number like `0803 123 4567`, lifeline reads it as `+2348031234567`; numbers from other countries are kept as given. Change `SMS_DEFAULT_COUNTRY_CODE` if most of the circle isn't in Nigeria.
- **Webhooks are checked.** A request that isn't signed with your key is refused, so nobody can post fake texts to the address.

## If it doesn't work

- Text the number from your own phone, then open the httpSMS app: the message should be listed. If it isn't, the phone isn't receiving SMS (SIM, signal, app permission).
- In the httpSMS dashboard, open the webhook and look at recent deliveries. A `403` means the signing key in the dashboard and `SMS_WEBHOOK_SECRET` don't match. A `404` means the URL is wrong.
- In Railway's logs, `sms reply failed` means lifeline got the text but the gateway refused the reply. Check `SMS_GATEWAY_API_KEY` and that `SMS_GATEWAY_FROM` is the phone's exact number.
