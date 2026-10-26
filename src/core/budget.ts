/**
 * Per-user model spend tracking and a daily cap. Alerts without enforcement
 * are what let the $47k loop run; the cap here is enforced before the call.
 */
import type { Db } from "./db.js";
import { config } from "./config.js";

// USD per million tokens; override with MODEL_PRICE_IN / MODEL_PRICE_OUT.
const PRICE_IN = Number(process.env.MODEL_PRICE_IN ?? 1);
const PRICE_OUT = Number(process.env.MODEL_PRICE_OUT ?? 5);

export async function spentToday(db: Db, userId: number): Promise<number> {
  const r = await db.one<{ usd: string }>(`SELECT COALESCE(sum(usd),0)::text AS usd FROM model_usage WHERE user_id=$1 AND created_at > now() - interval '1 day'`, [userId]);
  return Number(r?.usd ?? 0);
}

export async function overBudget(db: Db, userId: number): Promise<boolean> {
  return (await spentToday(db, userId)) >= config.dailyModelBudgetUsd;
}

export async function recordUsage(db: Db, userId: number, inputTokens: number, outputTokens: number) {
  const usd = (inputTokens * PRICE_IN + outputTokens * PRICE_OUT) / 1_000_000;
  await db.query(`INSERT INTO model_usage (user_id, input_tokens, output_tokens, usd) VALUES ($1,$2,$3,$4)`, [userId, inputTokens, outputTokens, usd]);
}
