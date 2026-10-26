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
  databaseUrl: process.env.DATABASE_URL ?? "",
  anthropicKey: process.env.ANTHROPIC_API_KEY ?? "",
  model: process.env.MODEL ?? "claude-haiku-4-5",
  geminiKey: process.env.GEMINI_API_KEY ?? "",
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  modelProvider: (process.env.MODEL_PROVIDER ?? "") as "" | "anthropic" | "gemini",
  // web + messaging channels
  port: Number(process.env.PORT ?? 3000),
  publicUrl: (process.env.PUBLIC_URL ?? "").replace(/\/$/, ""),
  sessionSecret: process.env.SESSION_SECRET ?? "",
  twilioSid: process.env.TWILIO_ACCOUNT_SID ?? "",
  twilioToken: process.env.TWILIO_AUTH_TOKEN ?? "",
  twilioFrom: process.env.TWILIO_FROM ?? "",
  imessageProvider: (process.env.IMESSAGE_PROVIDER ?? "") as "" | "bluebubbles" | "sendblue",
  bluebubblesUrl: (process.env.BLUEBUBBLES_URL ?? "").replace(/\/$/, ""),
  bluebubblesPassword: process.env.BLUEBUBBLES_PASSWORD ?? "",
  sendblueKey: process.env.SENDBLUE_API_KEY ?? "",
  sendblueSecret: process.env.SENDBLUE_API_SECRET ?? "",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  defaultTz: process.env.DEFAULT_TZ ?? "Africa/Lagos",
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
