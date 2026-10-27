import "./modules/index.js";
import { config } from "./core/config.js";
import { getDb } from "./core/db.js";
import { log } from "./core/log.js";
import { schedule, startLoop } from "./core/scheduler.js";
import { dispatch } from "./core/dispatch.js";
import { getUserById } from "./core/handler.js";
import { createBot } from "./telegram/bot.js";
import { startWeb } from "./web/server.js";
import { registerSms, smsProvider } from "./channels/sms.js";
import { registerIMessage } from "./channels/imessage.js";
import { startPumpfunWatcher } from "./modules/trading.js";
import { ensurePriceJob } from "./modules/prices.js";
import { providerName } from "./intent/providers.js";

async function main() {
  const db = await getDb();

  // System jobs (idempotent). Minutes are jittered so nothing lands on :00.
  const systemJobs: [string, string][] = [
    ["poll_hackathons", "17 */6 * * *"],
    ["poll_launches", "23 */3 * * *"],
    ["poll_jobs", "41 */4 * * *"],
    ["poll_scout", "7 */12 * * *"],
    ["poll_polymarket", "*/2 * * * *"],
  ];
  for (const [kind, cron] of systemJobs) {
    const exists = await db.one(`SELECT 1 FROM jobs WHERE kind=$1 AND active AND user_id IS NULL`, [kind]);
    if (!exists) await schedule(db, { kind, cron, tz: "UTC" });
  }
  await ensurePriceJob(db);

  // Channels
  let botUsername = "";
  let bot: ReturnType<typeof createBot> | null = null;
  if (config.telegramToken) {
    bot = createBot(db);
    await bot.api.setMyCommands([
      { command: "start", description: "What I can do" },
      { command: "help", description: "Examples" },
      { command: "persona", description: "Pick how I talk" },
      { command: "link", description: "Code to connect web / SMS / iMessage" },
      { command: "pending", description: "Actions waiting for your confirm" },
      { command: "undo", description: "Undo the last change" },
      { command: "memory", description: "What I remember about you" },
      { command: "audit", description: "Recent actions log" },
      { command: "usage", description: "Model spend today" },
    ]);
    botUsername = (await bot.api.getMe()).username;
  } else {
    log.warn("TELEGRAM_BOT_TOKEN not set; running web/SMS/iMessage only");
  }
  registerSms();
  registerIMessage();
  startWeb(db, botUsername);

  startLoop({ db, getUser: (id) => getUserById(db, id), send: (user, reply) => dispatch(db, user, reply) });
  startPumpfunWatcher(db);

  log.info({
    allowed: config.allowedUserIds.length, model: providerName() ?? "rules-only", stt: Boolean(config.openaiKey),
    sms: smsProvider() ?? false, imessage: config.imessageProvider || false, email: Boolean(config.smtpUrl), web: config.port,
  }, "lifeline starting");
  // During a redeploy the old container still polls for a few seconds and Telegram answers 409. Wait it out instead of crashing.
  for (let attempt = 1; bot; attempt++) {
    try {
      await bot.start({ allowed_updates: ["message", "callback_query", "business_connection", "business_message"] as any, onStart: (me) => log.info({ username: me.username }, "telegram polling") });
      break;
    } catch (e: any) {
      if (e?.error_code !== 409 || attempt > 12) throw e;
      log.warn({ attempt }, "another instance is still polling Telegram; retrying in 5s");
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

main().catch((e) => {
  log.error({ err: e }, "fatal");
  process.exit(1);
});
