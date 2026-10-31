/**
 * Your data, in your hands:
 *   "export my data"      everything lifeline keeps about you, as one JSON file
 *   "delete my account"   everything gone, after a yes (tier 2), in about a minute
 * And a retention rule for everyone: the conversation log is kept 180 days, the audit log a year.
 * What you asked lifeline to keep (reminders, lists, logs, memories) stays until you delete it.
 *
 * Both walk the database's own foreign keys, so a table a feature adds later is covered without a list to keep up:
 * every table with a `user_id`, and every row that hangs off one of those rows.
 */
import { z } from "zod";
import type { Db } from "../core/db.js";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { addCapability, addExamples, addRules, addSystemJob } from "../core/plugins.js";
import { onJob, schedule } from "../core/scheduler.js";
import { log } from "../core/log.js";

export const KEEP_MESSAGES_DAYS = 180;
export const KEEP_AUDIT_DAYS = 365;

interface Fk { child: string; col: string; parent: string; pcol: string; nullable: boolean }
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function foreignKeys(db: Db): Promise<Fk[]> {
  return db.query<Fk>(`
    SELECT cl.relname AS child, a.attname AS col, pl.relname AS parent, pa.attname AS pcol, NOT a.attnotnull AS nullable
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
    JOIN pg_class pl ON pl.oid = c.confrelid
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
    WHERE c.contype = 'f' AND n.nspname = current_schema() AND array_length(c.conkey, 1) = 1`);
}
async function userTables(db: Db): Promise<string[]> {
  const r = await db.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'user_id' ORDER BY table_name`);
  return r.map((x) => x.t).filter((t) => t !== "users");
}

/** Everything about one person, table by table: their rows, and the rows that hang off them (a habit's check-ins). */
export async function exportUser(db: Db, userId: number): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  const user = await db.one<any>(`SELECT id, name, tz, digest_hour, quiet_start, quiet_end, prefs, email, preferred_channel, created_at FROM users WHERE id=$1`, [userId]);
  // Codes still in flight (an email being confirmed) would let someone holding the file finish what the person started.
  if (user) { const { homeMsg: _h, thread: _t, photoSuggestions: _p, emailPending: _e, ...prefs } = user.prefs ?? {}; out.you = [{ ...user, prefs }]; }
  const fks = await foreignKeys(db);
  // Sign-in tokens, link codes, in-flight buttons and notification keys: live secrets, so they stay out of the file.
  const skip = new Set(["sessions", "pending_actions", "undo_stack", "link_codes", "push_subscriptions", "job_runs", "push_log", "model_events"]);
  for (const t of await userTables(db)) {
    if (skip.has(t)) continue;
    const rows = await db.query(`SELECT * FROM ${ident(t)} WHERE user_id=$1`, [userId]).catch(() => []);
    if (rows.length) out[t] = rows;
    for (const fk of fks.filter((f) => f.parent === t && f.col !== "user_id")) {
      const kids = await db.query(`SELECT * FROM ${ident(fk.child)} WHERE ${ident(fk.col)} IN (SELECT ${ident(fk.pcol)} FROM ${ident(t)} WHERE user_id=$1)`, [userId]).catch(() => []);
      if (kids.length) out[`${fk.child} (of ${t})`] = kids;
    }
  }
  return out;
}

/**
 * Delete one person and everything that hangs off them. Rows that only point at them in passing (a group chat they
 * brought lifeline into) lose the pointer instead of being deleted, so other people's things stay.
 */
export async function eraseUser(db: Db, userId: number): Promise<number> {
  const fks = await foreignKeys(db);
  let n = 0;
  const seen = new Set<string>();
  const erase = async (table: string, where: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    for (const fk of fks.filter((f) => f.parent === table)) {
      const key = `${fk.child}.${fk.col}<${table}`;
      if (seen.has(`${key}|${where}`)) continue;
      seen.add(`${key}|${where}`);
      const sub = `${ident(fk.col)} IN (SELECT ${ident(fk.pcol)} FROM ${ident(table)} WHERE ${where})`;
      if (table === "users" && fk.col !== "user_id" && fk.nullable) {
        await db.query(`UPDATE ${ident(fk.child)} SET ${ident(fk.col)} = NULL WHERE ${sub}`, [userId]);
        continue;
      }
      await erase(fk.child, sub, depth + 1);
    }
    const r = await db.query(`DELETE FROM ${ident(table)} WHERE ${where} RETURNING 1`, [userId]);
    n += r.length;
  };
  // Tables with a user_id but no foreign key to users still count as theirs.
  for (const t of await userTables(db)) {
    if (fks.some((f) => f.child === t && f.col === "user_id" && f.parent === "users")) continue;
    await erase(t, `user_id = $1`, 0);
  }
  await erase("users", `id = $1`, 0);
  return n;
}

const exporter = defineAction({
  name: "account.export",
  tier: 1,
  description: "Give the person a file with everything lifeline keeps about them (their data export).",
  schema: z.object({}),
  async run(_a, ctx) {
    const data = await exportUser(ctx.db, ctx.user.id);
    const tables = Object.keys(data).filter((k) => k !== "you");
    const rows = tables.reduce((s, k) => s + data[k].length, 0);
    const body = JSON.stringify({ exported_at: ctx.now.toISOString(), note: "Everything lifeline keeps about you. Sign-in tokens are left out.", ...data }, null, 2);
    return {
      reply: `Here's everything I keep about you: ${rows} record${rows === 1 ? "" : "s"} across ${tables.length} kind${tables.length === 1 ? "" : "s"} of thing, in one file. Keep it somewhere private; it has your health and money logs in it if you keep those with me.`,
      file: { data: Buffer.from(body).toString("base64"), name: `lifeline-export-${ctx.now.toISOString().slice(0, 10)}.json`, mime: "application/json" },
    };
  },
});

const deleter = defineAction({
  name: "account.delete",
  tier: 2,
  description: "Delete the person's lifeline account and everything in it, everywhere (Telegram, web, text). Asked for a yes first; it can't be undone.",
  schema: z.object({}),
  echo: () => "This deletes your lifeline account and everything I keep for you: reminders, lists, calendar, health and money logs, memories, trips, plans, contacts and settings, on every channel. It can't be undone. Say \"export my data\" first if you want a copy.",
  async run(_a, ctx) {
    // The engine still writes its audit line for this yes, so the deleting happens a moment later, in the background.
    await ctx.db.query(`UPDATE users SET prefs = prefs || '{"deleting":true}'::jsonb WHERE id=$1`, [ctx.user.id]);
    await schedule(ctx.db, { userId: null, kind: "account_erase", payload: { userId: ctx.user.id }, runAt: new Date(ctx.now.getTime() + 30_000) });
    return { reply: "Done. Your account and everything in it will be gone within a minute. Thank you for trying lifeline. If you ever want back in, just say hello." };
  },
});

register(exporter, deleter);

onJob("account_erase", async (job, deps) => {
  const id = Number((job.payload as { userId?: number }).userId);
  if (!id) return;
  // A failure throws, so the scheduler tries again after one minute and then five; what was left goes on the retry.
  const n = await eraseUser(deps.db, id).catch((e) => { log.error({ err: e?.message, user: id }, "account erase failed"); throw e; });
  log.info({ user: id, rows: n }, "account erased");
});

/* Retention: the conversation log and the audit log don't grow forever. */
addSystemJob("retention", "23 4 * * *");
onJob("retention", async (_job, deps) => {
  const m = await deps.db.query(`DELETE FROM messages WHERE created_at < now() - ($1 || ' days')::interval RETURNING 1`, [String(KEEP_MESSAGES_DAYS)]).catch(() => []);
  const a = await deps.db.query(`DELETE FROM audit_log WHERE created_at < now() - ($1 || ' days')::interval RETURNING 1`, [String(KEEP_AUDIT_DAYS)]).catch(() => []);
  // The delivery and cost records behind /stats are counts with no content; three months is plenty.
  for (const t of ["job_runs", "push_log", "model_events"]) await deps.db.query(`DELETE FROM ${t} WHERE at < now() - interval '90 days'`).catch(() => {});
  if (m.length || a.length) log.info({ messages: m.length, audit: a.length }, "retention");
});

addRules(
  [/^(?:export|download|send me|give me)\s+(?:all\s+)?(?:of\s+)?my\s+(?:data|information|info|records|account data)(?:\s+(?:please|now))?[.!]*$|^what (?:do you|data do you) (?:keep|have|store) (?:on|about) me\??$/i, () => ({ action: "account.export", args: {} })],
  [/^(?:delete|close|erase|remove|wipe)\s+(?:my\s+)?(?:lifeline\s+)?account(?:\s+and\s+(?:all\s+)?my\s+data)?[.!]*$|^(?:delete|erase|wipe)\s+(?:all\s+(?:of\s+)?)?my\s+data(?:\s+and\s+(?:my\s+)?account)?[.!]*$|^forget everything about me[.!]*$/i, () => ({ action: "account.delete", args: {} })],
);
addExamples("account.export", ["export my data", "what do you keep about me?"]);
addExamples("account.delete", ["delete my account", "forget everything about me"]);
addCapability({
  key: "account", name: "Your data",
  cues: ["my data", "delete my account", "export", "privacy", "what do you keep"],
  what: "Say \"export my data\" and I send you a file with everything I keep about you. Say \"delete my account\" and, after a yes, everything is gone on every channel. Conversation history is kept 180 days; what you ask me to keep stays until you delete it.",
  say: ["export my data", "delete my account"],
  then: "Deleting can't be undone, so export first if you want a copy.",
}, "Me");

/* Delete-sentences for parts kept elsewhere that had no plain rule. */
addRules([/^(?:forget|delete|erase|clear|wipe)\s+(?:all\s+)?(?:of\s+)?my\s+(?:cycle|period)(?:\s+(?:data|logs?|history|tracking))?[.!]*$/i, () => ({ action: "cycle.forget", args: {} })]);
addRules([/^what (?:do you|did you) (?:know|remember|keep) about me\??$/i, () => ({ action: "memory.list", args: {} })]);
