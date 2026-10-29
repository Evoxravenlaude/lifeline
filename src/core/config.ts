import "dotenv/config";

function bool(v: string | undefined, d = false): boolean {
  if (v === undefined || v === "") return d;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function parseQuiet(v: string | undefined): [number, number] {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(v ?? "22-07");
  return m ? [Number(m[1]), Number(m[2])] : [22, 7];
}

export const config = {
  telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
  allowedUserIds: (process.env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),
  /** How many people the circle holds. Anyone with the link joins until it's full. */
  maxUsers: Number(process.env.MAX_USERS || 55),
  databaseUrl: process.env.DATABASE_URL ?? "",
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  model: process.env.MODEL ?? "claude-haiku-4-5",
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  // Google's rolling alias for its current Flash model; if it ever 404s, the provider layer asks Google what exists.
  geminiModel: process.env.GEMINI_MODEL || "gemini-flash-latest",
  modelProvider: (process.env.MODEL_PROVIDER ?? "") as "" | "anthropic" | "gemini" | "openai",
  openaiCompatKey: process.env.OPENAI_COMPAT_API_KEY ?? "",
  openaiCompatBaseUrl: (process.env.OPENAI_COMPAT_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/$/, ""),
  // Groq retired the Llama 3.x models on 16 Aug 2026; gpt-oss is their recommended replacement and supports tool calls.
  openaiCompatModel: process.env.OPENAI_COMPAT_MODEL || "openai/gpt-oss-120b",
  /** Used when the main model is rate-limited (Groq only). Empty string turns it off. */
  openaiCompatFallbackModel: process.env.OPENAI_COMPAT_FALLBACK_MODEL ?? "openai/gpt-oss-20b",
  // web + messaging channels
  port: Number(process.env.PORT ?? 3000),
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/$/, ""),
  /** Extra origins allowed to call /api and /auth with cookies (a Vercel-hosted web front that does NOT proxy through rewrites). Usually empty: web/vercel.json proxies instead. */
  /** The website people open (the Vercel address). Falls back to the first web origin, then the server's own address. */
  webUrl: (process.env.WEB_URL ?? "").replace(/\/$/, ""),
  /** The phone number or Apple ID email people send iMessages to, when iMessage is set up. */
  imessageAddress: process.env.IMESSAGE_ADDRESS ?? "",
  webOrigins: (process.env.WEB_ORIGINS ?? "").split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean),
  sessionSecret: process.env.SESSION_SECRET ?? "",
  twilioSid: process.env.TWILIO_ACCOUNT_SID ?? "",
  twilioToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  twilioFrom: process.env.TWILIO_FROM ?? "",
  /** Which SMS route is live. Empty: Twilio if its vars are set, else an Android gateway if its key is set, else none. See docs/SMS.md. */
  smsProvider: (process.env.SMS_PROVIDER ?? "").toLowerCase() as "" | "twilio" | "httpsms" | "textbee",
  /** API key from the Android gateway's dashboard (httpSMS: Settings, API key; TextBee: Dashboard, API keys). */
  smsGatewayKey: process.env.SMS_GATEWAY_API_KEY ?? "",
  /** httpSMS: the gateway phone's own number in E.164 (+234...), used as "from". TextBee: the device id. */
  smsGatewayFrom: process.env.SMS_GATEWAY_FROM ?? "",
  /** The signing key/secret you set on the gateway's webhook; unsigned or wrongly signed webhooks are refused. */
  smsWebhookSecret: process.env.SMS_WEBHOOK_SECRET ?? "",
  /** The number people text, as you'd write it for a friend: +234 801 234 5678. Shown on the web app. */
  smsNumber: process.env.SMS_NUMBER ?? "",
  /** Country code assumed for local numbers like 0801...: 234 Nigeria by default. */
  smsDefaultCountry: (process.env.SMS_DEFAULT_COUNTRY_CODE ?? "234").replace(/\D/g, ""),
  /* ---- voice, pictures and search (src/core/media.ts) ---- */
  /** Speech to text on Groq, using the Groq key you already have. */
  groqSttModel: process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo",
  /** Text to speech on Gemini. The fallback uses the older generateContent route. */
  ttsModel: process.env.GEMINI_TTS_MODEL || "gemini-3.8-flash-tts",
  ttsFallbackModel: process.env.GEMINI_TTS_FALLBACK_MODEL || "gemini-2.5-flash-preview-tts",
  ttsVoice: process.env.TTS_VOICE || "Sulafat",
  /** Looking at photos on Groq when Gemini can't. */
  groqVisionModel: process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct",
  /** Groq's model with web search built in, the fallback when Gemini search isn't available. */
  groqSearchModel: process.env.GROQ_SEARCH_MODEL || "groq/compound",
  /** Drawing: Cloudflare Workers AI has a free daily allowance (about 200 pictures a day). */
  cfAccountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
  cfApiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  cfImageModel: process.env.CLOUDFLARE_IMAGE_MODEL || "@cf/black-forest-labs/flux-1-schnell",
  /** A Gemini image model id, if your Gemini project has billing (image generation isn't on the free tier). */
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL ?? "",
  /** Pollinations needs no key but is slow and limited; the last resort for drawing. */
  enablePollinations: !/^(0|false|no|off)$/i.test(process.env.ENABLE_POLLINATIONS ?? "true"),
  /* ---- email (src/channels/email.ts) ---- */
  /** Resend: sends email, and receives it at an address like lifeline@<id>.resend.app. */
  resendKey: process.env.RESEND_API_KEY ?? "",
  resendWebhookSecret: process.env.RESEND_WEBHOOK_SECRET ?? "",
  /** The address people email or forward things to, shown in "link" replies. */
  inboundEmail: process.env.INBOUND_EMAIL ?? "",
  /** BlueBubbles send method: apple-script works on any Mac; private-api needs its helper installed. */
  bluebubblesMethod: (process.env.BLUEBUBBLES_METHOD || "apple-script") as "apple-script" | "private-api",
  imessageProvider: (process.env.IMESSAGE_PROVIDER ?? "") as "" | "bluebubbles" | "sendblue",
  bluebubblesUrl: (process.env.BLUEBUBBLES_URL ?? "").replace(/\/$/, ""),
  bluebubblesPassword: process.env.BLUEBUBBLES_PASSWORD ?? "",
  sendblueKey: process.env.SENDBLUE_API_KEY ?? "",
  sendblueSecret: process.env.SENDBLUE_API_SECRET ?? "",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  defaultTz: process.env.DEFAULT_TZ ?? "UTC",
  quietHours: parseQuiet(process.env.QUIET_HOURS),
  maxPushesPerDay: Number(process.env.MAX_PUSHES_PER_DAY ?? 3),
  digestHour: Number(process.env.DIGEST_HOUR ?? 7),
  hackathonRadarKey: process.env.HACKATHONRADAR_API_KEY ?? "",
  enableDevpost: bool(process.env.ENABLE_DEVPOST, true),
  enableSuperteam: bool(process.env.ENABLE_SUPERTEAM, true),
  enablePolymarketShadow: bool(process.env.ENABLE_POLYMARKET_SHADOW, false),
  enablePumpfunShadow: bool(process.env.ENABLE_PUMPFUN_SHADOW, false),
  pumpportalKey: process.env.PUMPPORTAL_API_KEY ?? "",
  dailyModelBudgetUsd: Number(process.env.DAILY_MODEL_BUDGET_USD ?? 0.5),
  openaiKey: process.env.OPENAI_API_KEY ?? "",
  sttModel: process.env.STT_MODEL ?? "gpt-4o-mini-transcribe",
  smtpUrl: process.env.SMTP_URL ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "",
  enableEthglobal: bool(process.env.ENABLE_ETHGLOBAL, true),
  enableHackclub: bool(process.env.ENABLE_HACKCLUB, false),
  enableColosseum: bool(process.env.ENABLE_COLOSSEUM, true),
  flutterwaveKey: process.env.FLUTTERWAVE_SECRET_KEY ?? "",
  flutterwaveBase: process.env.FLUTTERWAVE_BASE ?? "https://api.flutterwave.com/v3",
  githubToken: process.env.GITHUB_TOKEN ?? "",
};

export type Config = typeof config;
