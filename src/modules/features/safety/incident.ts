/**
 * Evidence and incident log: harassment at work, a landlord dispute, a bad vendor. Each entry is stored
 * with its time and a SHA-256 hash that includes the previous entry's hash, so changing or removing any
 * entry breaks every hash after it. Private: never in the brief, Wrapped or any shared view.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { DateTime } from "luxon";
import { defineAction } from "../../../policy/types.js";
import type { Db } from "../../../core/db.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import { canEmail, sendEmail } from "../../../core/email.js";
import { SECRET_REFUSAL, keepEnding, looksSecret, ownEmail } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS safety_incidents (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), seq INT NOT NULL, logged_at TIMESTAMPTZ NOT NULL, text TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL, UNIQUE (user_id, seq))`);

export const GENESIS = "0".repeat(64);
interface Entry { id: number; seq: number; logged_at: string; text: string; prev_hash: string; hash: string }

/** The hash of one entry: its number, its time, its words and the hash before it. */
export function entryHash(seq: number, loggedAt: string, text: string, prev: string): string {
  return createHash("sha256").update(`${seq}\n${loggedAt}\n${text}\n${prev}`).digest("hex");
}
const iso = (d: string | Date) => new Date(d).toISOString();
const all = (db: Db, userId: number) => db.query<Entry>(`SELECT * FROM safety_incidents WHERE user_id=$1 ORDER BY seq`, [userId]);

/** Walk the chain. Returns the first entry number that doesn't match, or null when it all holds. */
export function verifyChain(rows: Entry[]): number | null {
  let prev = GENESIS;
  for (const r of rows) {
    if (r.prev_hash !== prev || entryHash(r.seq, iso(r.logged_at), r.text, r.prev_hash) !== r.hash) return r.seq;
    prev = r.hash;
  }
  return null;
}

const when = (d: string | Date, tz: string) => DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat("ccc d LLL yyyy, HH:mm");

const incidentLog = defineAction({
  name: "incident.log",
  tier: 1,
  description: "Add an entry to the person's private incident log (harassment, a landlord or vendor dispute, anything they may need evidence of later). 'text' is what happened, in their words. Each entry is time-stamped and hash-chained so it's tamper-evident.",
  schema: z.object({ text: z.string().min(2).max(4000) }),
  async run(args, ctx) {
    const secret = looksSecret(args.text);
    if (secret) return { reply: SECRET_REFUSAL(secret) };
    const last = await ctx.db.one<Entry>(`SELECT * FROM safety_incidents WHERE user_id=$1 ORDER BY seq DESC LIMIT 1`, [ctx.user.id]);
    const seq = (last?.seq ?? 0) + 1, prev = last?.hash ?? GENESIS, at = iso(ctx.now), text = keepEnding(args.text, ctx.sourceMessage);
    const hash = entryHash(seq, at, text, prev);
    const row = (await ctx.db.one<{ id: number }>(`INSERT INTO safety_incidents (user_id, seq, logged_at, text, prev_hash, hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [ctx.user.id, seq, at, text, prev, hash]))!;
    return { reply: `Logged, ${when(at, ctx.user.tz)}. That's entry ${seq} in your incident log. Say "export my incident log" for the full timeline.`, undo: { payload: { id: row.id, seq } } };
  },
  async undo(p, ctx) {
    const r = await ctx.db.query(`DELETE FROM safety_incidents WHERE id=$1 AND user_id=$2 AND seq = (SELECT max(seq) FROM safety_incidents WHERE user_id=$2) RETURNING id`, [p.id, ctx.user.id]);
    return r.length ? "Taken out of your incident log." : "A newer entry came after it, so I left it in to keep the log intact.";
  },
});

const incidentShow = defineAction({
  name: "incident.show",
  tier: 1,
  description: "Show the person's incident log, briefly: the latest entries with their times.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await all(ctx.db, ctx.user.id);
    if (!rows.length) return { reply: "Your incident log is empty. Say \"log incident:\" and what happened whenever you need to." };
    const shown = rows.slice(-8);
    const lines = shown.map((r) => `- ${DateTime.fromJSDate(new Date(r.logged_at)).setZone(ctx.user.tz).toFormat("d LLL, HH:mm")}: ${r.text.length > 80 ? `${r.text.slice(0, 77).trimEnd()}...` : r.text}`);
    return { reply: `Your incident log, ${rows.length} ${rows.length === 1 ? "entry" : "entries"}${rows.length > shown.length ? ", the latest 8" : ""}:\n${lines.join("\n")}\n\nSay "export my incident log" for the full timeline with hashes.` };
  },
});

export function timeline(rows: Entry[], tz: string, name: string | null): string {
  const head = `Incident log${name ? ` of ${name}` : ""}, exported ${when(new Date(), tz)} (${tz})`;
  const body = rows.map((r) => `${r.seq}. ${when(r.logged_at, tz)}\n${r.text}\nsha256: ${r.hash}`).join("\n\n");
  return `${head}\nEach hash covers the entry and the hash before it.\n\n${body}`;
}

const incidentExport = defineAction({
  name: "incident.export",
  tier: 1,
  description: "Export the person's whole incident log as a plain-text timeline with each entry's hash, check the chain is intact, and email it to their own confirmed address if they have one.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await all(ctx.db, ctx.user.id);
    if (!rows.length) return { reply: "Your incident log is empty, so there's nothing to export yet." };
    const broken = verifyChain(rows);
    const text = timeline(rows, ctx.user.tz, ctx.user.name);
    const to = canEmail() ? await ownEmail(ctx.db, ctx.user) : null;
    const mailed = to ? await sendEmail(to, "Your incident log", text) : false;
    const check = broken ? `Entry ${broken} doesn't match its hash, so something changed from there on.` : "The chain checks out: no entry has been changed or removed.";
    return { reply: `${check}${mailed ? ` I've emailed a copy to ${to}.` : ""}\n\n\`\`\`\n${text}\n\`\`\`` };
  },
});

const incidentForget = defineAction({
  name: "incident.forget",
  tier: 2,
  description: "Delete the person's whole incident log for good. Always confirmed first.",
  schema: z.object({}),
  echo: () => "This deletes your whole incident log for good, every entry and its hash. Export it first if you might need it.",
  async run(_a, ctx) {
    const r = await ctx.db.query(`DELETE FROM safety_incidents WHERE user_id=$1 RETURNING id`, [ctx.user.id]);
    return { reply: r.length ? `Your incident log is deleted, all ${r.length} ${r.length === 1 ? "entry" : "entries"}.` : "Your incident log was already empty." };
  },
});

register(incidentLog, incidentShow, incidentExport, incidentForget);

addRules(
  [/^(?:log|record|add) (?:an? )?(?:incident|evidence)(?: (?:log )?entry)?[:,-]?\s+([\s\S]{2,})$/i, (m) => ({ action: "incident.log", args: { text: m[1].trim() } })],
  [/^(?:show|open|see|view) (?:me )?my (?:incident|evidence) log$|^(?:my )?(?:incident|evidence) log$/i, () => ({ action: "incident.show", args: {} })],
  [/^(?:export|download|send me|email me) (?:a copy of )?my (?:incident|evidence) log$|^verify my (?:incident|evidence) log$/i, () => ({ action: "incident.export", args: {} })],
  [/^(?:forget|delete|erase|clear|wipe) (?:my )?(?:incident|evidence) log$/i, () => ({ action: "incident.forget", args: {} })],
);
addExamples("incident.log", ["log incident: my manager shouted at me in front of the team again", "log incident landlord entered the flat without notice"]);
addExamples("incident.show", ["show my incident log", "incident log"]);
addExamples("incident.export", ["export my incident log", "verify my incident log"]);
addExamples("incident.forget", ["delete my incident log"]);
addCues("incident", ["incident", "evidence", "harass", "landlord", "record what happened", "log what happened", "timeline", "dispute", "abuse", "bullying"]);
addCapability({
  key: "incident_log", name: "Incident log",
  cues: ["incident log", "evidence log", "harassment", "landlord dispute", "keep a record of what happened"],
  what: "A private, time-stamped record of things you may need evidence of later: harassment at work, a landlord or a bad vendor. Each entry is sealed with a hash linked to the one before, so any change shows.",
  say: ["log incident: what happened", "show my incident log", "export my incident log"],
  then: "It's never in your brief or anywhere shared. Export it whenever you need it; say \"delete my incident log\" to remove it.",
}, "Safety");
