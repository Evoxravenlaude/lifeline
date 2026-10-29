/**
 * Mint calendar and allowlists: "Azuki Elementals mint opens 3 Nov 18:00 UTC, allowlist, 0.08 ETH",
 * "public mint for X at 5pm my time", "I'm on the allowlist for X with wallet 2", "reveal for X on Friday".
 * Times in the person's zone, both zones said when they gave UTC. Reminders an hour and ten minutes
 * before are their own time-critical reminders (push with exempt); the day itself gets a brief line.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type User } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import { cancelJob, onJob, push, schedule } from "../../../core/scheduler.js";
import type { Db } from "../../../core/db.js";
import { addBriefItems, byName, cap, clean, num, parseMoment, refuseSecret, sayMoment, todayOf } from "./shared.js";
import { NFT_CHAIN_WORDS, TOKEN_WORDS, chainLabel, ckeyOf, nftChain, tokenOf } from "./chains.js";

addSchema(`CREATE TABLE IF NOT EXISTS crt_drops (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT NOT NULL, ckey TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'mint', at TIMESTAMPTZ, timed BOOLEAN NOT NULL DEFAULT true, utc BOOLEAN NOT NULL DEFAULT false, price NUMERIC, token TEXT, chain TEXT, wallet TEXT, allowlisted BOOLEAN NOT NULL DEFAULT false, link TEXT, jobs JSONB NOT NULL DEFAULT '[]', created_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS crt_drops_user ON crt_drops (user_id, at)`);

const STAGES: Record<string, string> = { free: "free mint", public: "public mint", allowlist: "allowlist mint", whitelist: "allowlist mint", wl: "allowlist mint", presale: "presale", "pre-sale": "presale", og: "OG mint", holder: "holder mint", gtd: "guaranteed mint", guaranteed: "guaranteed mint", fcfs: "first-come mint", mint: "mint", reveal: "reveal" };
const stageKey = (w?: string | null) => { const k = (w ?? "mint").toLowerCase(); return k === "whitelist" || k === "wl" ? "allowlist" : k === "pre-sale" ? "presale" : k === "guaranteed" ? "gtd" : STAGES[k] ? k : "mint"; };

interface DropRow { id: number; name: string; ckey: string; stage: string; at: string | null; timed: boolean; utc: boolean; price: string | null; token: string | null; chain: string | null; wallet: string | null; allowlisted: boolean; link: string | null; jobs: any }
const jobsOf = (r: DropRow): number[] => (typeof r.jobs === "string" ? JSON.parse(r.jobs) : r.jobs) ?? [];
const title = (r: Pick<DropRow, "name" | "stage">) => (r.stage === "reveal" ? `the ${r.name} reveal` : `${r.name} ${STAGES[r.stage] ?? "mint"}`);

/** The rest of a drop sentence after the time: "allowlist, 0.08 ETH", "on base", "with wallet 2", a link. */
export function dropTail(tail: string): { when: string; stage?: string; price?: number; token?: string; chain?: string; wallet?: string; link?: string } {
  const parts = tail.split(/\s*,\s*|\s+(?=(?:with|using|from)\s+(?:my\s+)?(?:wallet|\w+\s+wallet))|\s+(?=https?:\/\/)/i).map((p) => p.trim()).filter(Boolean);
  const out: ReturnType<typeof dropTail> = { when: "" };
  const whenBits: string[] = [];
  for (const p of parts) {
    let m: RegExpExecArray | null;
    if ((m = /^(?:it'?s\s+|an?\s+)?(free|public|allowlist|whitelist|wl|presale|pre-sale|og|holder|gtd|guaranteed|fcfs)(?:\s+(?:mint|phase|sale|spot))?$/i.exec(p))) { out.stage = stageKey(m[1]); if (m[1].toLowerCase() === "free") out.price = 0; continue; }
    if ((m = new RegExp(`^(?:at\\s+|for\\s+|price\\s+)?(free|\\d*\\.?\\d+)\\s*(${TOKEN_WORDS})?\\b(?:\\s+each)?$`, "i").exec(p)) && (m[2] || /\./.test(m[1]) || /free/i.test(m[1]))) { out.price = /free/i.test(m[1]) ? 0 : Number(m[1]); if (m[2]) out.token = m[2]; continue; }
    if ((m = new RegExp(`^(?:on\\s+)?(${NFT_CHAIN_WORDS})(?:\\s+chain)?$`, "i").exec(p))) { out.chain = m[1]; continue; }
    if ((m = /^(?:with|using|from|on)?\s*(?:my\s+)?((?:wallet\s*[\w-]{1,20})|(?:[\w-]{1,20}\s+wallet))$/i.exec(p))) { out.wallet = m[1]; continue; }
    if (/^https?:\/\//i.test(p)) { out.link = p; continue; }
    whenBits.push(p);
  }
  // "18:00 UTC at 0.08 ETH on base" without commas: lift a price and a chain out of the time words.
  let when = whenBits.join(" ");
  const pr = new RegExp(`\\s+(?:at|for)\\s+(\\d*\\.?\\d+)\\s*(${TOKEN_WORDS})\\b`, "i").exec(when);
  if (pr) { out.price ??= Number(pr[1]); out.token ??= pr[2]; when = when.replace(pr[0], ""); }
  const ch = new RegExp(`\\s+on\\s+(${NFT_CHAIN_WORDS})\\b`, "i").exec(when);
  if (ch && !/\d/.test(ch[1])) { out.chain ??= ch[1]; when = when.replace(ch[0], ""); }
  out.when = when.trim();
  return out;
}

async function cancelJobs(db: Db, r: DropRow) { for (const id of jobsOf(r)) await cancelJob(db, id); }
/** Reminders an hour and ten minutes before, when there's a time and it's still ahead. */
async function scheduleReminders(db: Db, user: User, id: number, at: Date, timed: boolean, now: Date): Promise<number[]> {
  if (!timed) return [];
  const ids: number[] = [];
  for (const min of [60, 10]) {
    const runAt = new Date(at.getTime() - min * 60_000);
    if (runAt <= now) continue;
    ids.push(await schedule(db, { userId: user.id, kind: "crt_drop", runAt, payload: { id, min, at: at.getTime() } }));
  }
  await db.query(`UPDATE crt_drops SET jobs=$2 WHERE id=$1`, [id, JSON.stringify(ids)]);
  return ids;
}

const upcoming = (db: Db, userId: number, now: Date) =>
  db.query<DropRow>(`SELECT * FROM crt_drops WHERE user_id=$1 AND (at IS NULL OR at > $2) ORDER BY at NULLS LAST, id`, [userId, new Date(now.getTime() - 3 * 3_600_000)]);

const details = (r: Pick<DropRow, "price" | "token" | "chain" | "wallet" | "allowlisted">) => {
  const bits: string[] = [];
  if (r.price !== null && r.price !== undefined) bits.push(Number(r.price) === 0 ? "free" : `${num(Number(r.price))} ${r.token ?? "ETH"}`);
  if (r.chain) bits.push(`on ${chainLabel(r.chain)}`);
  if (r.allowlisted) bits.push(r.wallet ? `you're on the allowlist with ${r.wallet}` : "you're on the allowlist");
  else if (r.wallet) bits.push(`with ${r.wallet}`);
  return bits;
};

const dropAdd = defineAction({
  name: "drop.add",
  tier: 1,
  description: "Put an NFT mint, allowlist or public phase, or a reveal on the person's mint calendar, with reminders an hour and ten minutes before. `when` is in their words ('3 Nov 18:00 UTC', '5pm my time', 'Friday'). Optional price, token, chain, wallet label and link. Never mints for them.",
  schema: z.object({ name: z.string().min(1).max(120), stage: z.string().max(20).optional(), when: z.string().max(80).optional(), price: z.number().min(0).optional(), token: z.string().max(10).optional(), chain: z.string().max(30).optional(), wallet: z.string().max(40).optional(), link: z.string().max(300).optional() }),
  needs(a) { return a.when?.trim() ? null : { need: "when", question: `When does ${clean(a.name)} ${a.stage === "reveal" ? "reveal" : "open"}? Like "3 Nov 18:00 UTC" or "Friday at 5pm".` }; },
  fill(need, answer, _a, ctx) { return need === "when" && parseMoment(answer, ctx.user, ctx.now) ? { when: answer } : null; },
  async run(a, ctx) {
    const bad = refuseSecret(a.name, a.wallet);
    if (bad) throw new Error(bad);
    const name = cap(clean(a.name));
    const m = parseMoment(a.when ?? "", ctx.user, ctx.now);
    if (!m) throw new Error(`I couldn't read a time in "${a.when}". When does it open? Like "3 Nov 18:00 UTC" or "Friday at 5pm".`);
    if (m.at.getTime() < ctx.now.getTime() - 3_600_000) throw new Error("That time has already passed. When is it?");
    const stage = stageKey(a.stage);
    const token = tokenOf(a.token) ?? (a.price !== undefined ? (nftChain(a.chain) === "solana" ? "SOL" : "ETH") : null);
    const ck = ckeyOf(name);
    // An allowlist note waiting for a time, or the same phase again, is updated rather than doubled.
    const prev = await ctx.db.one<DropRow>(`SELECT * FROM crt_drops WHERE user_id=$1 AND ckey=$2 AND (stage=$3 OR (at IS NULL AND $3 <> 'reveal')) ORDER BY at NULLS FIRST LIMIT 1`, [ctx.user.id, ck, stage]);
    let id: number;
    if (prev) {
      await cancelJobs(ctx.db, prev);
      await ctx.db.query(`UPDATE crt_drops SET name=$2, stage=$3, at=$4, timed=$5, utc=$6, price=COALESCE($7, price), token=COALESCE($8, token), chain=COALESCE($9, chain), wallet=COALESCE($10, wallet), link=COALESCE($11, link) WHERE id=$1`,
        [prev.id, name, prev.stage === "allowlist" && stage === "mint" ? "allowlist" : stage, m.at, m.timed, m.utc, a.price ?? null, token, nftChain(a.chain), a.wallet ?? null, a.link ?? null]);
      id = prev.id;
    } else {
      id = (await ctx.db.one<{ id: number }>(`INSERT INTO crt_drops (user_id, name, ckey, stage, at, timed, utc, price, token, chain, wallet, link) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [ctx.user.id, name, ck, stage, m.at, m.timed, m.utc, a.price ?? null, token, nftChain(a.chain), a.wallet ?? null, a.link ?? null]))!.id;
    }
    await scheduleReminders(ctx.db, ctx.user, id, m.at, m.timed, ctx.now);
    const r = (await ctx.db.one<DropRow>(`SELECT * FROM crt_drops WHERE id=$1`, [id]))!;
    const when = sayMoment(m.at, m.timed, m.utc, ctx.user, ctx.now);
    const extra = details(r);
    const remind = m.timed ? (m.at.getTime() - ctx.now.getTime() > 3_600_000 ? "I'll remind you an hour before and 10 minutes before." : "I'll remind you 10 minutes before.") : "I'll put it in your brief that morning; tell me the time if you want a reminder.";
    return { reply: `${cap(title(r))}, ${when}${extra.length ? `, ${extra.join(", ")}` : ""}. ${remind} Say "cancel the ${name} ${r.stage === "reveal" ? "reveal" : "mint"}" to drop it.`, undo: { payload: { id, prev: prev ?? null } } };
  },
  async undo(p, ctx) {
    const r = await ctx.db.one<DropRow>(`SELECT * FROM crt_drops WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    if (r) await cancelJobs(ctx.db, r);
    if (!p.prev) { await ctx.db.query(`DELETE FROM crt_drops WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Taken off your mint calendar."; }
    const o = p.prev as DropRow;
    await ctx.db.query(`UPDATE crt_drops SET name=$2, stage=$3, at=$4, timed=$5, utc=$6, price=$7, token=$8, chain=$9, wallet=$10, link=$11 WHERE id=$1`, [o.id, o.name, o.stage, o.at, o.timed, o.utc, o.price, o.token, o.chain, o.wallet, o.link]);
    if (o.at) await scheduleReminders(ctx.db, ctx.user, o.id, new Date(o.at), o.timed, ctx.now);
    return "Back how it was.";
  },
});

const dropAllowlist = defineAction({
  name: "drop.allowlist",
  tier: 1,
  description: "Note that the person is on the allowlist (whitelist, WL) for an NFT mint, optionally with which wallet. Joins the mint on their calendar if it's there.",
  schema: z.object({ name: z.string().min(1).max(120), wallet: z.string().max(40).optional() }),
  async run(a, ctx) {
    const bad = refuseSecret(a.name, a.wallet);
    if (bad) throw new Error(bad);
    const name = cap(clean(a.name));
    const ck = ckeyOf(name);
    const rows = (await upcoming(ctx.db, ctx.user.id, ctx.now)).filter((r) => r.stage !== "reveal");
    const hit = rows.find((r) => r.ckey === ck) ?? byName(rows, ["name"], name)[0];
    if (hit) {
      await ctx.db.query(`UPDATE crt_drops SET allowlisted=true, wallet=COALESCE($2, wallet) WHERE id=$1`, [hit.id, a.wallet ?? null]);
      const when = hit.at ? ` It opens ${sayMoment(new Date(hit.at), hit.timed, hit.utc, ctx.user, ctx.now)}, and I'll remind you before.` : "";
      return { reply: `You're on the allowlist for ${hit.name}${a.wallet ? ` with ${a.wallet}` : ""}.${when}`, undo: { payload: { id: hit.id, was: { allowlisted: hit.allowlisted, wallet: hit.wallet } } } };
    }
    const id = (await ctx.db.one<{ id: number }>(`INSERT INTO crt_drops (user_id, name, ckey, stage, allowlisted, wallet) VALUES ($1,$2,$3,'allowlist',true,$4) RETURNING id`, [ctx.user.id, name, ck, a.wallet ?? null]))!.id;
    return { reply: `You're on the allowlist for ${name}${a.wallet ? ` with ${a.wallet}` : ""}. When does it open? Say it like "${name} mint opens Friday 18:00 UTC" and I'll remind you an hour and 10 minutes before.`, undo: { payload: { id, created: true } } };
  },
  async undo(p, ctx) {
    if (p.created) await ctx.db.query(`DELETE FROM crt_drops WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    else await ctx.db.query(`UPDATE crt_drops SET allowlisted=$2, wallet=$3 WHERE id=$1 AND user_id=$4`, [p.id, p.was.allowlisted, p.was.wallet, ctx.user.id]);
    return "Taken back.";
  },
});

const dropList = defineAction({
  name: "drop.list",
  tier: 1,
  description: "Show the person's upcoming NFT mints, allowlist phases and reveals, in their time zone.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await upcoming(ctx.db, ctx.user.id, ctx.now);
    if (!rows.length) return { reply: "No mints on your calendar. Say \"Azuki Elementals mint opens 3 Nov 18:00 UTC, allowlist, 0.08 ETH\" and I'll remind you before it opens." };
    const lines = rows.slice(0, 10).map((r) => {
      const when = r.at ? sayMoment(new Date(r.at), r.timed, r.utc, ctx.user, ctx.now) : "time not set";
      const d = details(r);
      return `- ${cap(when)}: ${title(r)}${d.length ? `, ${d.join(", ")}` : ""}`;
    });
    return { reply: [`${rows.length === 1 ? "One thing" : `${rows.length} things`} on your mint calendar:`, ...lines, ...(rows.length > 10 ? [`- and ${rows.length - 10} more`] : [])].join("\n") };
  },
});

const dropCancel = defineAction({
  name: "drop.cancel",
  tier: 1,
  description: "Take a mint, allowlist phase or reveal off the person's mint calendar, and its reminders with it. Matches by collection name.",
  schema: z.object({ name: z.string().min(1).max(120), stage: z.string().max(20).optional() }),
  async run(a, ctx) {
    const rows = await upcoming(ctx.db, ctx.user.id, ctx.now);
    const ck = ckeyOf(clean(a.name));
    let hits = rows.filter((r) => r.ckey === ck);
    if (!hits.length) hits = byName(rows, ["name"], a.name);
    if (a.stage === "reveal") hits = hits.filter((r) => r.stage === "reveal");
    else if (a.stage) hits = hits.filter((r) => r.stage !== "reveal");
    if (!hits.length) throw new Error(`There's nothing called ${clean(a.name)} on your mint calendar. Say "my upcoming mints" to see what is.`);
    for (const r of hits) { await cancelJobs(ctx.db, r); await ctx.db.query(`DELETE FROM crt_drops WHERE id=$1`, [r.id]); }
    return { reply: `${hits.length === 1 ? cap(title(hits[0])) : `${hits.length} ${hits[0].name} dates`}, off your calendar, with ${hits.length === 1 ? "its" : "their"} reminders.`, undo: { payload: { rows: hits } } };
  },
  async undo(p, ctx) {
    for (const o of p.rows as DropRow[]) {
      const id = (await ctx.db.one<{ id: number }>(`INSERT INTO crt_drops (user_id, name, ckey, stage, at, timed, utc, price, token, chain, wallet, allowlisted, link) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [ctx.user.id, o.name, o.ckey, o.stage, o.at, o.timed, o.utc, o.price, o.token, o.chain, o.wallet, o.allowlisted, o.link]))!.id;
      if (o.at) await scheduleReminders(ctx.db, ctx.user, id, new Date(o.at), o.timed, ctx.now);
    }
    return "Back on your calendar.";
  },
});

register(dropAdd, dropAllowlist, dropList, dropCancel);

/** The person's own reminder: through quiet hours and calm mode, since they set it and it can't wait. */
onJob("crt_drop", async (job, deps) => {
  const r = await deps.db.one<DropRow>(`SELECT * FROM crt_drops WHERE id=$1`, [job.payload.id]);
  if (!r?.at || new Date(r.at).getTime() !== Number(job.payload.at)) return;
  const user = await deps.getUser(job.user_id!);
  if (!user) return;
  const at = new Date(r.at);
  const local = DateTime.fromJSDate(at).setZone(user.tz).toFormat("HH:mm");
  const utc = r.utc && DateTime.fromJSDate(at).setZone(user.tz).offset !== 0 ? ` (${DateTime.fromJSDate(at).setZone("UTC").toFormat("HH:mm")} UTC)` : "";
  const verb = r.stage === "reveal" ? "is" : "opens";
  const d = details(r);
  const head = job.payload.min === 60 ? `${cap(title(r))} ${verb} in an hour, at ${local}${utc}.` : `${cap(title(r))} ${verb} in 10 minutes.`;
  const tail = r.stage === "reveal" ? "" : job.payload.min === 60 ? " Use only the project's official link, and never sign anything you don't understand." : "";
  await push(deps, user, "reminder", `${head}${d.length ? ` ${cap(d.join(", "))}.` : ""}${tail}${r.link && job.payload.min === 60 ? `\n${r.link}` : ""}`, { exempt: true, now: new Date() });
});

/** The day of a drop, and the day before, in the brief. */
addBriefItems(async (db, user, now) => {
  const today = todayOf(user, now);
  const rows = await db.query<DropRow>(`SELECT * FROM crt_drops WHERE user_id=$1 AND at IS NOT NULL AND at > $2 AND at < $3 ORDER BY at`, [user.id, new Date(now.getTime() - 3_600_000), new Date(now.getTime() + 2 * 86_400_000)]);
  const out: { p: number; text: string }[] = [];
  for (const r of rows) {
    const day = DateTime.fromJSDate(new Date(r.at!)).setZone(user.tz).toISODate()!;
    const when = sayMoment(new Date(r.at!), r.timed, r.utc, user, now);
    if (day === today) out.push({ p: 5, text: `${cap(title(r))} ${when.replace(/^today/, "today")}${r.allowlisted ? ", you're on the allowlist" : ""}` });
    else if (day > today && day <= DateTime.fromISO(today).plus({ days: 1 }).toISODate()!) out.push({ p: 18, text: `${cap(title(r))} ${when}` });
  }
  return out;
});

/* ---------------- words ---------------- */

const DATEY = "(?=[^,]*?(?:\\d|\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|today|tonight|tomorrow|next|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\\b))";
const PHASE = "(free|public|allowlist|whitelist|wl|presale|pre-sale|og|holder|gtd|guaranteed|fcfs)";
const fromTail = (name: string, stage: string | undefined, tail: string) => {
  const t = dropTail(tail);
  return { action: "drop.add", args: { name, ...(t.stage || stage ? { stage: t.stage ?? stageKey(stage) } : {}), when: t.when, ...(t.price !== undefined ? { price: t.price } : stage?.toLowerCase() === "free" ? { price: 0 } : {}), ...(t.token ? { token: t.token } : {}), ...(t.chain ? { chain: t.chain } : {}), ...(t.wallet ? { wallet: t.wallet } : {}), ...(t.link ? { link: t.link } : {}) } };
};
const WALLET = "(?:\\s+(?:with|using|on|from)\\s+(?:my\\s+)?((?:wallet\\s*[\\w-]{1,20})|(?:[\\w-]{1,20}\\s+wallet)))?";
addRules(
  [new RegExp(`^(?!(?:remind|ping|tell|alert|nudge|don'?t|can you|please|cancel)\\b)(?!(?:the\\s+|my\\s+)?(?:school|kids?|children|nursery|daycare|creche|laundry|parcel|price|prices|stock|stocks|market|temperature|weight|rain|rate|rates|pressure|petrol|fuel)\\b)(?:the\\s+)?(.+?)\\s+(?:${PHASE}\\s+)?(?:mint|drop)\\s+(?:opens|starts|begins|goes live|is live|is|happens|on|at)\\s+(?:on\\s+|at\\s+)?${DATEY}(.+)$`, "i"), (m) => fromTail(m[1], m[2], m[3])],
  [new RegExp(`^(?:the\\s+)?(?:${PHASE}\\s+)?mint\\s+(?:for|of)\\s+(.+?)\\s+(?:(?:opens|starts|begins|goes live|is)\\s+(?:on\\s+|at\\s+)?|(?:on|at)\\s+)${DATEY}(.+)$`, "i"), (m) => fromTail(m[2], m[1], m[3])],
  [new RegExp(`^(?:the\\s+)?reveal\\s+(?:for|of)\\s+(.+?)\\s+(?:is\\s+)?(?:on|at)\\s+${DATEY}(.+)$`, "i"), (m) => fromTail(m[1], "reveal", m[2])],
  [new RegExp(`^(?!(?:the\\s+)?(?:gender|baby|big|grand|surprise|party)\\b)(?:the\\s+)?(.+?)\\s+reveals?\\s+(?:is\\s+)?(?:on\\s+|at\\s+)?${DATEY}(.+)$`, "i"), (m) => fromTail(m[1], "reveal", m[2])],
  [new RegExp(`^(?:i'?m|i am|we'?re)\\s+(?:on\\s+(?:the\\s+)?(?:allowlist|whitelist|wl|al)|allowlisted|whitelisted|wl'?d)\\s+(?:for|on)\\s+(.+?)${WALLET}$`, "i"), (m) => (/^(?:nothing|free|it|that|this|me|you|us|them)$/i.test(m[1].trim()) ? null : { action: "drop.allowlist", args: { name: m[1], ...(m[2] ? { wallet: m[2] } : {}) } })],
  [new RegExp(`^(?:i\\s+)?got\\s+(?:the\\s+|an?\\s+)?(?:allowlist|whitelist|wl|al)(?:\\s+spot)?\\s+(?:for|on)\\s+(.+?)${WALLET}$`, "i"), (m) => (/^(?:nothing|free|it|that|this|me|you|us|them)$/i.test(m[1].trim()) ? null : { action: "drop.allowlist", args: { name: m[1], ...(m[2] ? { wallet: m[2] } : {}) } })],
  [new RegExp(`^(?:i'?m|i am)\\s+on\\s+the\\s+(.+?)\\s+(?:allowlist|whitelist|wl)${WALLET}$`, "i"), (m) => (/^(?:nothing|free|it|that|this|me|you|us|them)$/i.test(m[1].trim()) ? null : { action: "drop.allowlist", args: { name: m[1], ...(m[2] ? { wallet: m[2] } : {}) } })],
  [/^(?:my\s+|show\s+my\s+|any\s+)?(?:upcoming\s+(?:mints|drops|reveals)|mint\s+(?:calendar|schedule)|drop\s+calendar|allowlists|whitelists)(?:\s+coming\s+up)?\??$|^(?:what|which)\s+mints\s+(?:are|have i got)\s+coming(?:\s+up)?\??$/i, () => ({ action: "drop.list", args: {} })],
  [/^(?:cancel|remove|delete|drop|forget)\s+(?:the\s+|my\s+)?(.+?)\s+(mint|reveal|drop|allowlist)(?:\s+reminders?)?(?:\s+from\s+my\s+(?:mint\s+)?calendar)?$/i, (m) => ({ action: "drop.cancel", args: { name: m[1], stage: m[2].toLowerCase() === "reveal" ? "reveal" : "mint" } })],
);
addExamples("drop.add", ["Azuki Elementals mint opens 3 Nov 18:00 UTC, allowlist, 0.08 ETH", "public mint for Lagos Nights Pass at 5pm my time", "reveal for Azuki Elementals on Friday", "Seoul Souls free mint starts tomorrow at 15:00 on base", "the Mad Lads drop is on 20 Nov at 17:00 UTC, 2 SOL"]);
addExamples("drop.allowlist", ["I'm on the allowlist for Azuki Elementals with wallet 2", "got WL for Seoul Souls", "I'm on the Azuki Elementals allowlist"]);
addExamples("drop.list", ["my upcoming mints", "mint calendar", "upcoming drops"]);
addExamples("drop.cancel", ["cancel the Azuki Elementals mint", "remove the Seoul Souls reveal"]);
addCues("drop", ["mint opens", "mint calendar", "allowlist", "whitelist", "wl", "public mint", "presale", "reveal", "drop", "upcoming mints", "mint time"]);
