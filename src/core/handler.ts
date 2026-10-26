/**
 * Channel-agnostic brain. Telegram, web, SMS and iMessage all call these two
 * functions; they differ only in how they render buttons.
 */
import { randomBytes } from "node:crypto";
import type { Db } from "./db.js";
import { config } from "./config.js";
import { schedule } from "./scheduler.js";
import type { Ctx, User } from "../policy/types.js";
import { cancelPending, confirmPending, latestPending, propose, undo, type Decision } from "../policy/engine.js";
import { resolveIntent } from "../intent/index.js";
import { markDone, snooze } from "../modules/reminders.js";
import { resolveLog } from "../modules/medications.js";

export type Channel = "telegram" | "web" | "sms" | "imessage";

export interface Reply {
  text: string;
  buttons?: { label: string; data: string }[];
}

export async function findUserByIdentity(db: Db, channel: Channel, externalId: string): Promise<User | undefined> {
  return db.one<User>(`SELECT u.* FROM users u JOIN identities i ON i.user_id=u.id WHERE i.channel=$1 AND i.external_id=$2`, [channel, externalId]);
}

/** Find or create a user for an identity. New users only auto-create on Telegram (allow-listed); other channels must link. */
export async function ensureUser(db: Db, channel: Channel, externalId: string, name?: string): Promise<User> {
  const existing = await findUserByIdentity(db, channel, externalId);
  if (existing) return existing;
  if (channel === "telegram") {
    const legacy = await db.one<User>(`SELECT * FROM users WHERE telegram_id=$1`, [Number(externalId)]);
    if (legacy) {
      await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,'telegram',$2) ON CONFLICT DO NOTHING`, [legacy.id, externalId]);
      return legacy;
    }
  }
  const [qs, qe] = config.quietHours;
  const u = (await db.one<User>(
    `INSERT INTO users (telegram_id, name, tz, digest_hour, quiet_start, quiet_end, preferred_channel) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [channel === "telegram" ? Number(externalId) : null, name ?? null, config.defaultTz, config.digestHour, qs, qe, channel],
  ))!;
  await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,$2,$3)`, [u.id, channel, externalId]);
  await schedule(db, { userId: u.id, kind: "digest", cron: `0 ${u.digest_hour} * * *`, tz: u.tz });
  await schedule(db, { userId: u.id, kind: "memory_review", cron: `0 18 * * 0`, tz: u.tz });
  return u;
}

export async function getUserById(db: Db, id: number): Promise<User | undefined> {
  return db.one<User>(`SELECT * FROM users WHERE id=$1`, [id]);
}

export async function identitiesOf(db: Db, userId: number): Promise<{ channel: Channel; external_id: string }[]> {
  return db.query(`SELECT channel, external_id FROM identities WHERE user_id=$1 AND verified`, [userId]);
}

/* ---------- linking other channels to an existing account ---------- */

export async function createLinkCode(db: Db, userId: number, channel?: Channel): Promise<string> {
  const code = randomBytes(3).toString("hex").toUpperCase(); // 6 chars
  await db.query(`INSERT INTO link_codes (code, user_id, channel, expires_at) VALUES ($1,$2,$3,$4)`, [code, userId, channel ?? null, new Date(Date.now() + 15 * 60_000)]);
  return code;
}

export async function redeemLinkCode(db: Db, code: string, channel: Channel, externalId: string): Promise<User | null> {
  const row = await db.one<{ user_id: number }>(`UPDATE link_codes SET used=true WHERE code=$1 AND NOT used AND expires_at > now() AND (channel IS NULL OR channel=$2) RETURNING user_id`, [code.toUpperCase(), channel]);
  if (!row) return null;
  await db.query(`INSERT INTO identities (user_id, channel, external_id) VALUES ($1,$2,$3) ON CONFLICT (channel, external_id) DO UPDATE SET user_id=EXCLUDED.user_id, verified=true`, [row.user_id, channel, externalId]);
  return getUserById(db, row.user_id) as Promise<User>;
}

/* ---------- messages ---------- */

export function renderDecision(d: Decision): Reply {
  switch (d.kind) {
    case "pending":
      return { text: `${d.echo}\n\nConfirm? (expires in 10 min)`, buttons: [{ label: "✅ Confirm", data: `confirm:${d.pendingId}` }, { label: "✖ Cancel", data: `cancel:${d.pendingId}` }] };
    case "ran":
      return d.undoId ? { text: d.reply, buttons: [{ label: "Undo", data: `undo:${d.undoId}` }] } : { text: d.reply };
    default:
      return { text: d.reply };
  }
}

export async function handleMessage(db: Db, user: User, text: string, opts: { forwarded?: boolean; channel: Channel; now?: Date }): Promise<Reply> {
  const ctx: Ctx = { db, user, now: opts.now ?? new Date(), sourceMessage: `[${opts.channel}] ${text}` };
  await db.query(`INSERT INTO messages (user_id, role, content) VALUES ($1,'user',$2)`, [user.id, text]);

  // Link code typed on a secondary channel is handled by the channel before reaching here.
  if (/^(yes|y|confirm|ok|okay|do it)$/i.test(text.trim())) {
    const pid = await latestPending(ctx);
    if (pid) return finish(db, user, renderDecision(await confirmPending(ctx, pid)));
  }
  if (/^(no|cancel|nevermind|never mind)$/i.test(text.trim())) {
    const pid = await latestPending(ctx);
    if (pid) return finish(db, user, { text: await cancelPending(ctx, pid) });
  }
  if (/^undo$/i.test(text.trim())) {
    const row = await db.one<{ id: number }>(`SELECT id FROM undo_stack WHERE user_id=$1 AND NOT used ORDER BY id DESC LIMIT 1`, [user.id]);
    return finish(db, user, { text: row ? await undo(ctx, row.id) : "Nothing to undo." });
  }
  if (/^link$/i.test(text.trim())) {
    const code = await createLinkCode(db, user.id);
    return finish(db, user, { text: `Link code: ${code}\nSend "link ${code}" from the other channel (web, SMS or iMessage) within 15 minutes.` });
  }

  const intent = await resolveIntent(text, ctx, { forwarded: opts.forwarded });
  const reply = intent.kind === "reply" ? { text: intent.text } : renderDecision(await propose(ctx, intent.intent.action, intent.intent.args));
  return finish(db, user, reply);
}

async function finish(db: Db, user: User, r: Reply): Promise<Reply> {
  await db.query(`INSERT INTO messages (user_id, role, content) VALUES ($1,'assistant',$2)`, [user.id, r.text.slice(0, 2000)]);
  return r;
}

/** Button presses (Telegram callback_data, web button, or "1"/"2" on SMS). */
export async function handleCallback(db: Db, user: User, data: string, now = new Date()): Promise<Reply> {
  const ctx: Ctx = { db, user, now, sourceMessage: `[button ${data}]` };
  const [kind, a, b] = data.split(":");
  switch (kind) {
    case "confirm": return renderDecision(await confirmPending(ctx, Number(a)));
    case "cancel": return { text: await cancelPending(ctx, Number(a)) };
    case "undo": return { text: await undo(ctx, Number(a)) };
    case "rem":
      if (a === "done") { await markDone(db, user.id, Number(b)); return { text: "Done ✅" }; }
      await snooze(db, user.id, Number(b)); return { text: "Snoozed 1h." };
    case "med": {
      const ok = await resolveLog(db, user.id, Number(b), a === "taken" ? "taken" : "skipped");
      return { text: ok ? (a === "taken" ? "Logged as taken ✅" : "Skipped.") : "Couldn't find that dose." };
    }
    case "mem":
      if (a === "keep") await db.query(`UPDATE memories SET confirmed=true WHERE id=$1 AND user_id=$2`, [Number(b), user.id]);
      else await db.query(`DELETE FROM memories WHERE id=$1 AND user_id=$2`, [Number(b), user.id]);
      return { text: a === "keep" ? "Kept." : "Dropped." };
    case "persona": return renderDecision(await propose(ctx, "persona.set", { preset: a }));
    default: return { text: "Unknown button." };
  }
}

/** For text-only channels: map "1"/"2" replies to the last message's buttons. */
export function buttonsAsText(r: Reply): string {
  if (!r.buttons?.length) return r.text;
  return `${r.text}\n${r.buttons.map((b, i) => `${i + 1}) ${b.label.replace(/^[✅✖]\s*/, "")}`).join("  ")}`;
}
