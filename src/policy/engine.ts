/**
 * The policy gate. Rules live here in code, not in the prompt.
 *
 *  Tier 1  read-only or reversible  → runs now, returns an Undo button
 *  Tier 2  irreversible / money / third-party-visible → echoed, held pending, runs on exact confirm
 *  Tier 3  never → refused and logged
 *
 * Every proposal, confirmation, undo and refusal lands in audit_log with the
 * source message, so a returning user (or you, after an incident) can see
 * exactly which sentence produced which action.
 */
import { getAction } from "./registry.js";
import type { ActionResult, Ctx, Thread, Tier } from "./types.js";

export const CONFIRM_TTL_SEC = 10 * 60;
export const THREAD_TTL_MS = 10 * 60_000;

const FIELD_WORDS: Record<string, string> = { when: "a time", text: "what to say", title: "a name", destination: "where to", amount: "an amount", name: "a name", times: "the times", query: "what to look for", niche: "a niche", address: "an address", symbol: "a coin" };
export const UNDO_TTL_SEC = 5 * 60;

export type Decision =
  | { kind: "ran"; reply: string; undoId?: number }
  | { kind: "pending"; pendingId: number; echo: string }
  | { kind: "ask"; reply: string; thread: Thread }
  | { kind: "refused"; reply: string }
  | { kind: "error"; reply: string };

export async function propose(ctx: Ctx, actionName: string, rawArgs: unknown): Promise<Decision> {
  const action = getAction(actionName);
  if (!action) return { kind: "error", reply: `I don't have an action called ${actionName}.` };

  const parsed = action.schema.safeParse(rawArgs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "that";
    return { kind: "error", reply: `I'm missing ${FIELD_WORDS[field] ?? `the ${field}`} for that. Say it again with that in?` };
  }
  const args = parsed.data;

  if (action.needs && !ctx.skipAsk) {
    const ask = await action.needs(args, ctx);
    if (ask) return { kind: "ask", reply: ask.question, thread: { action: actionName, args: args as Record<string, unknown>, need: ask.need, question: ask.question, askedAt: ctx.now.getTime() } };
  }

  if (action.tier === 3) {
    await audit(ctx, actionName, 3, args, "refused");
    return { kind: "refused", reply: `That's one of the things I never do: ${action.description.split(".")[0].toLowerCase()}. It's logged, nothing happened.` };
  }

  if (action.tier === 2) {
    const echo = action.echo ? action.echo(args, ctx) : `${actionName} ${JSON.stringify(args)}`;
    const expires = new Date(ctx.now.getTime() + CONFIRM_TTL_SEC * 1000);
    const row = await ctx.db.one<{ id: number }>(
      `INSERT INTO pending_actions (user_id, action, args, echo, expires_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.user.id, actionName, JSON.stringify(args), echo, expires],
    );
    await audit(ctx, actionName, 2, args, "pending");
    return { kind: "pending", pendingId: row!.id, echo };
  }

  return runNow(ctx, actionName, 1, args);
}

async function runNow(ctx: Ctx, actionName: string, tier: Tier, args: unknown): Promise<Decision> {
  const action = getAction(actionName)!;
  let result: ActionResult;
  try {
    result = await action.run(args, ctx);
  } catch (e: any) {
    await audit(ctx, actionName, tier, args, `error: ${e?.message ?? e}`);
    const msg = String(e?.message ?? "");
    if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network|aborted|timeout/i.test(msg)) return { kind: "error", reply: "I couldn't reach the source for that just now. Try again in a minute." };
    return { kind: "error", reply: msg || "That didn't work, and I'm not sure why. Try once more?" };
  }
  await audit(ctx, actionName, tier, args, "ran");
  let undoId: number | undefined;
  if (result.undo && action.undo) {
    const row = await ctx.db.one<{ id: number }>(
      `INSERT INTO undo_stack (user_id, action, undo_payload, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [ctx.user.id, actionName, JSON.stringify(result.undo.payload), new Date(ctx.now.getTime() + UNDO_TTL_SEC * 1000)],
    );
    undoId = row!.id;
  }
  return { kind: "ran", reply: result.reply, undoId };
}

/** Confirm a pending Tier-2 action. Only an exact id for this user, not expired, not resolved. */
export async function confirmPending(ctx: Ctx, pendingId: number): Promise<Decision> {
  const row = await ctx.db.one<{ id: number; action: string; args: any; expires_at: string }>(
    `SELECT id, action, args, expires_at FROM pending_actions WHERE id=$1 AND user_id=$2 AND resolved IS NULL`,
    [pendingId, ctx.user.id],
  );
  if (!row) return { kind: "error", reply: "That one's already been handled, or it's not yours to confirm." };
  if (new Date(row.expires_at) < ctx.now) {
    await ctx.db.query(`UPDATE pending_actions SET resolved='expired' WHERE id=$1`, [row.id]);
    return { kind: "error", reply: "That waited more than ten minutes, so I let it go. Ask again if you still want it." };
  }
  await ctx.db.query(`UPDATE pending_actions SET resolved='confirmed' WHERE id=$1`, [row.id]);
  const args = typeof row.args === "string" ? JSON.parse(row.args) : row.args;
  return runNow(ctx, row.action, 2, args);
}

export async function cancelPending(ctx: Ctx, pendingId: number): Promise<string> {
  const r = await ctx.db.query(
    `UPDATE pending_actions SET resolved='cancelled' WHERE id=$1 AND user_id=$2 AND resolved IS NULL RETURNING id`,
    [pendingId, ctx.user.id],
  );
  return r.length ? "Cancelled. Nothing happened." : "There's nothing waiting to cancel.";
}

/** Latest unresolved pending action for a user (for "yes" typed as text). */
export async function latestPending(ctx: Ctx): Promise<number | undefined> {
  const row = await ctx.db.one<{ id: number }>(
    `SELECT id FROM pending_actions WHERE user_id=$1 AND resolved IS NULL AND expires_at > $2 ORDER BY id DESC LIMIT 1`,
    [ctx.user.id, ctx.now],
  );
  return row?.id;
}

export async function undo(ctx: Ctx, undoId: number): Promise<string> {
  const row = await ctx.db.one<{ id: number; action: string; undo_payload: any; expires_at: string }>(
    `SELECT id, action, undo_payload, expires_at FROM undo_stack WHERE id=$1 AND user_id=$2 AND used=false`,
    [undoId, ctx.user.id],
  );
  if (!row) return "There's nothing to undo.";
  if (new Date(row.expires_at) < ctx.now) return "That's past the five-minute undo window. Tell me what to change and I'll do it the long way.";
  const action = getAction(row.action);
  if (!action?.undo) return "That one can't be undone, but tell me what you want instead.";
  const payload = typeof row.undo_payload === "string" ? JSON.parse(row.undo_payload) : row.undo_payload;
  const msg = await action.undo(payload, ctx);
  await ctx.db.query(`UPDATE undo_stack SET used=true WHERE id=$1`, [row.id]);
  await audit(ctx, row.action, 1, payload, "undone");
  return msg;
}

async function audit(ctx: Ctx, action: string, tier: Tier, args: unknown, outcome: string) {
  await ctx.db.query(
    `INSERT INTO audit_log (user_id, action, tier, args, outcome, source_message) VALUES ($1,$2,$3,$4,$5,$6)`,
    [ctx.user.id, action, tier, JSON.stringify(args ?? {}), outcome, ctx.sourceMessage ?? null],
  );
}
