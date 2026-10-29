/**
 * Emergency card (ICE): only what the person chooses to put on it, shown as a clean card to screenshot
 * or copy into their phone's medical ID. Never in the brief. No government ID numbers.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction, type Ask } from "../../../policy/types.js";
import type { Db } from "../../../core/db.js";
import { register } from "../../../policy/registry.js";
import { addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import { parseByRules } from "../../../intent/rules.js";
import { GOV_ID, looksSecret } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS safety_ice (user_id INT PRIMARY KEY REFERENCES users(id), blood TEXT, allergies TEXT, conditions TEXT, meds TEXT, contacts TEXT, plan TEXT, updated_at TIMESTAMPTZ DEFAULT now())`);

const FIELDS = ["blood", "allergies", "conditions", "meds", "contacts", "plan"] as const;
type Field = (typeof FIELDS)[number];
const LABEL: Record<Field, string> = { blood: "Blood group", allergies: "Allergies", conditions: "Conditions", meds: "Medications", contacts: "Emergency contacts", plan: "Health plan" };
const FROM_LIST = "@list";

async function medNames(db: Db, userId: number): Promise<string[]> {
  return (await db.query<{ name: string }>(`SELECT name FROM medications WHERE user_id=$1 AND active ORDER BY name`, [userId])).map((r) => r.name);
}

const ASK: Record<Field, string> = {
  blood: "Let's make your emergency card. Only what you choose goes on it, and you can say next to leave anything off, or skip to stop.\n\nBlood group? Like O+ or AB-.",
  allergies: "Any allergies? Type them, or say \"no known allergies\". Next to leave it off.",
  conditions: "Any conditions a medic should know about, like asthma, diabetes or epilepsy? Only if you want them on it. Next to leave it off.",
  meds: "Medications you take now? Type them, or next to leave it off.",
  contacts: "Who should be called in an emergency? Like \"Tunde (brother) +234 803 000 0000\".",
  plan: "Health plan or insurance? The name and member number are fine, like \"Bupa, member 1234567\". No passport or national ID numbers. Next to leave it off.",
};
const NEXT = /^(?:next|pass|leave (?:it|that) (?:off|out|blank)|-|blank)[.!]*$/i;

const cardSetup = defineAction({
  name: "emergency.card_setup",
  tier: 1,
  description: "Walk the person through making their emergency card (ICE): blood group, allergies, conditions, current medications, emergency contacts, health plan. One question at a time; each is optional.",
  schema: z.object({ blood: z.string().optional(), allergies: z.string().optional(), conditions: z.string().optional(), meds: z.string().optional(), contacts: z.string().optional(), plan: z.string().optional() }),
  async needs(args, ctx): Promise<Ask | null> {
    for (const f of FIELDS) if (args[f] === undefined) {
      if (f === "meds") {
        const list = await medNames(ctx.db, ctx.user.id);
        if (list.length) return { need: f, question: `Medications you take now? Say "from my list" to use the ones you track with me (${list.slice(0, 4).join(", ")}), type them, or next to leave it off.` };
      }
      return { need: f, question: ASK[f] };
    }
    return null;
  },
  fill: (need, answer) => {
    const a = answer.trim();
    if (!FIELDS.includes(need as Field) || a.length > 300) return null;
    if (NEXT.test(a)) return { [need]: "" };
    if (/\?\s*$/.test(a) || parseByRules(a)) return null; // a question or a new request, not an answer
    if (need === "meds" && /^(?:from|use) (?:my|the) (?:list|meds|medications)|^(?:use )?(?:those|them|the same)$/i.test(a)) return { meds: FROM_LIST };
    return { [need]: a };
  },
  async run(args, ctx) { return save(ctx.db, ctx.user.id, args, ctx.now, true); },
});

async function save(db: Db, userId: number, args: Partial<Record<Field, string>>, now: Date, guided: boolean) {
  const notes: string[] = [];
  const keep: Partial<Record<Field, string>> = {};
  for (const f of FIELDS) {
    let v = args[f]?.trim();
    if (!v) continue;
    if (v === FROM_LIST) { v = (await medNames(db, userId)).join(", "); if (!v) continue; }
    if (GOV_ID.test(v)) { notes.push(`I left the ${LABEL[f].toLowerCase()} off because it looked like a government ID number. Those don't go on the card.`); continue; }
    if (looksSecret(v)) { notes.push(`I left the ${LABEL[f].toLowerCase()} off because it looked like a password or key.`); continue; }
    keep[f] = v.slice(0, 300);
  }
  const prev = await db.one<Record<Field, string | null>>(`SELECT blood, allergies, conditions, meds, contacts, plan FROM safety_ice WHERE user_id=$1`, [userId]);
  if (!Object.keys(keep).length && !prev) {
    return { reply: `${notes.join(" ")}${notes.length ? " " : ""}Nothing's on your emergency card yet. Say "set up my emergency card" whenever you're ready.`.trim() };
  }
  const row = { ...(prev ?? {}), ...keep } as Record<Field, string | null>;
  await db.query(`INSERT INTO safety_ice (user_id, blood, allergies, conditions, meds, contacts, plan, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (user_id) DO UPDATE SET blood=$2, allergies=$3, conditions=$4, meds=$5, contacts=$6, plan=$7, updated_at=$8`, [userId, row.blood ?? null, row.allergies ?? null, row.conditions ?? null, row.meds ?? null, row.contacts ?? null, row.plan ?? null, now]);
  const head = guided ? "Your emergency card is saved." : `${Object.keys(keep).map((k) => LABEL[k as Field]).join(" and ") || "Nothing"} saved on your emergency card.`;
  return { reply: `${head}${notes.length ? ` ${notes.join(" ")}` : ""} Say "show my emergency card" to see it.`, undo: { payload: { prev } } };
}

async function restore(db: Db, userId: number, prev: Record<Field, string | null> | null) {
  if (!prev) await db.query(`DELETE FROM safety_ice WHERE user_id=$1`, [userId]);
  else await db.query(`UPDATE safety_ice SET blood=$2, allergies=$3, conditions=$4, meds=$5, contacts=$6, plan=$7 WHERE user_id=$1`, [userId, prev.blood, prev.allergies, prev.conditions, prev.meds, prev.contacts, prev.plan]);
}
cardSetup.undo = async (p, ctx) => { await restore(ctx.db, ctx.user.id, p.prev); return "Emergency card put back as it was."; };

const cardSet = defineAction({
  name: "emergency.card_set",
  tier: 1,
  description: "Put one thing on the emergency card: 'field' is blood, allergies, conditions, meds, contacts or plan (health plan or insurance name and member number; never government ID numbers). 'value' is what to write; for meds, 'from my list' uses their tracked medications.",
  schema: z.object({ field: z.enum(FIELDS), value: z.string().min(1) }),
  async run(args, ctx) {
    const v = args.field === "meds" && /^(?:from|use) (?:my|the) (?:list|meds|medications)$/i.test(args.value.trim()) ? FROM_LIST : args.value;
    return save(ctx.db, ctx.user.id, { [args.field]: v }, ctx.now, false);
  },
  async undo(p, ctx) { await restore(ctx.db, ctx.user.id, p.prev); return "Taken back."; },
});

const cardShow = defineAction({
  name: "emergency.card_show",
  tier: 1,
  description: "Show the person's emergency card as a clean text card to screenshot or copy.",
  schema: z.object({}),
  async run(_a, ctx) {
    const r = await ctx.db.one<Record<Field, string | null> & { updated_at: string }>(`SELECT * FROM safety_ice WHERE user_id=$1`, [ctx.user.id]);
    if (!r || FIELDS.every((f) => !r[f])) return { reply: "You don't have an emergency card yet. Say \"set up my emergency card\" and I'll ask a few questions; every one is optional." };
    const lines = [`Emergency card${ctx.user.name ? `: ${ctx.user.name}` : ""}`, ...FIELDS.filter((f) => r[f]).map((f) => `${LABEL[f]}: ${r[f]}`), `Updated ${DateTime.fromJSDate(new Date(r.updated_at)).setZone(ctx.user.tz).toFormat("d LLL yyyy")}`];
    return { reply: `Here's your emergency card. Screenshot it, or copy it into your phone's medical ID or lock screen.\n\n\`\`\`\n${lines.join("\n")}\n\`\`\`` };
  },
});

const cardForget = defineAction({
  name: "emergency.card_forget",
  tier: 1,
  description: "Delete the person's emergency card completely.",
  schema: z.object({}),
  async run(_a, ctx) {
    const prev = await ctx.db.one<Record<Field, string | null>>(`SELECT blood, allergies, conditions, meds, contacts, plan FROM safety_ice WHERE user_id=$1`, [ctx.user.id]);
    if (!prev) return { reply: "There's no emergency card to delete." };
    await ctx.db.query(`DELETE FROM safety_ice WHERE user_id=$1`, [ctx.user.id]);
    return { reply: "Your emergency card is deleted.", undo: { payload: { prev } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`INSERT INTO safety_ice (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [ctx.user.id]);
    await restore(ctx.db, ctx.user.id, p.prev);
    return "Emergency card restored.";
  },
});

register(cardSetup, cardSet, cardShow, cardForget);

const FIELD_WORDS: [RegExp, Field][] = [[/^blood(?: group| type)?$/i, "blood"], [/^allerg(?:y|ies)$/i, "allergies"], [/^(?:medical )?conditions?$/i, "conditions"], [/^(?:meds|medications?|medicines?)$/i, "meds"], [/^(?:emergency |ice )?contacts?$/i, "contacts"], [/^(?:health ?plan|insurance|health insurance|medical aid|hmo)$/i, "plan"]];
const fieldOf = (w: string) => FIELD_WORDS.find(([re]) => re.test(w.trim()))?.[1];

addRules(
  [/^(?:set up|make|create|start|update|fill in) (?:my |an? )?(?:emergency|ice|medical id) card$/i, () => ({ action: "emergency.card_setup", args: {} })],
  [/^(?:show|open|see|view) (?:me )?my (?:emergency|ice|medical id) card$|^(?:my )?(?:emergency|ice) card$/i, () => ({ action: "emergency.card_show", args: {} })],
  [/^(?:forget|delete|erase|remove|wipe) (?:my )?(?:emergency|ice|medical id) card$/i, () => ({ action: "emergency.card_forget", args: {} })],
  [/^(?:emergency|ice) card (blood(?: group| type)?|allerg(?:y|ies)|(?:medical )?conditions?|meds|medications?|(?:emergency )?contacts?|health ?plan|insurance)[:\s]+(.+)$/i, (m) => ({ action: "emergency.card_set", args: { field: fieldOf(m[1])!, value: m[2] } })],
  [/^my blood (?:group|type) is\s+((?:a|b|ab|o)\s?[+-]|(?:a|b|ab|o) (?:positive|negative|pos|neg))$/i, (m) => ({ action: "emergency.card_set", args: { field: "blood", value: m[1].toUpperCase().replace(/\s?(?:POSITIVE|POS)$/, "+").replace(/\s?(?:NEGATIVE|NEG)$/, "-").replace(/\s/g, "") } })],
  [/^(?:add )?(?:my )?(?:meds|medications) (?:to|on) my (?:emergency|ice) card$/i, () => ({ action: "emergency.card_set", args: { field: "meds", value: "from my list" } })],
);
addExamples("emergency.card_setup", ["set up my emergency card", "make an ICE card"]);
addExamples("emergency.card_set", ["my blood group is O+", "emergency card allergies: penicillin, peanuts", "add my meds to my emergency card", "emergency card health plan: Bupa, member 1234567"]);
addExamples("emergency.card_show", ["show my emergency card", "emergency card"]);
addExamples("emergency.card_forget", ["delete my emergency card"]);
addCues("emergency", ["emergency card", "ice card", "medical id", "blood group", "blood type", "allergies", "allergic", "in case of emergency", "emergency contact"]);
addCapability({
  key: "emergency_card", name: "Emergency card",
  cues: ["emergency card", "ice card", "medical id", "blood group", "in case of emergency"],
  what: "A short card with what a medic or stranger would need: blood group, allergies, medications, who to call. Only what you choose goes on it, and it's ready to screenshot for your lock screen.",
  say: ["set up my emergency card", "show my emergency card", "my blood group is O+"],
  then: "It's private and never appears in your brief. Say \"delete my emergency card\" to remove it. No ID numbers go on it.",
}, "Safety");
