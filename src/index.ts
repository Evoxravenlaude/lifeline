import "./modules/index.js";
import { registerEmail } from "./channels/email.js";
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
import { pluginSystemJobs } from "./core/plugins.js";

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
  for (const [kind, cron] of [...systemJobs, ...pluginSystemJobs()]) {
    const exists = await db.one(`SELECT 1 FROM jobs WHERE kind=$1 AND active AND user_id IS NULL`, [kind]);
    if (!exists) await schedule(db, { kind, cron, tz: "UTC" });
  }
  await ensurePriceJob(db);

  // Channels
  let botUsername = "";
  let bot: ReturnType<typeof createBot> | null = null;
  if (config.telegramToken) {
    bot = createBot(db);
    botUsername = (await bot.api.getMe()).username;
  } else {
    log.warn("TELEGRAM_BOT_TOKEN not set; running web/SMS/iMessage only");
  }
  registerSms();
  registerIMessage();
  registerEmail();
  startWeb(db, botUsername);

  startLoop({ db, getUser: (id) => getUserById(db, id), send: (user, reply) => dispatch(db, user, reply) });
  startPumpfunWatcher(db);

  log.info({
    circle: `${(await db.one<{ n: string }>(`SELECT count(*)::text AS n FROM users`))?.n ?? 0} of ${config.maxUsers}`, owners: config.allowedUserIds.length, model: providerName() ?? "rules-only", stt: Boolean(config.openaiKey),
    sms: smsProvider() ?? false, imessage: config.imessageProvider || false, email: Boolean(config.smtpUrl), web: config.port,
  }, "lifeline starting");
  // During a redeploy the old container still polls for a few seconds and Telegram answers 409. Wait it out instead of crashing.
  for (let attempt = 1; bot; attempt++) {
    try {
      await bot.start({ allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member", "business_connection", "business_message", "guest_message", "stopped_message_generation", "poll_answer"] as any, onStart: (me) => log.info({ username: me.username }, "telegram polling") });
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
