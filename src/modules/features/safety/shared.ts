/** Helpers shared by the safety features: who is who, how to reach them, and what never to keep. */
import type { Db } from "../../../core/db.js";
import type { User } from "../../../policy/types.js";
import { complete, providerName } from "../../../intent/providers.js";
import { overBudget, recordUsage } from "../../../core/budget.js";
import { countryOf } from "../../../core/money.js";
import { log } from "../../../core/log.js";

export const first = (u: Pick<User, "name"> | null | undefined) => u?.name?.split(" ")[0] || "Someone";
export const fullName = (u: Pick<User, "name"> | null | undefined) => u?.name || "Someone in lifeline";

/** Update prefs in the database and on the object we hold. */
export async function setPrefs(db: Db, user: User, patch: Record<string, unknown>) {
  await db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [user.id, JSON.stringify(patch)]);
  Object.assign(user.prefs, patch);
}

/** A proven address for the person themselves: a linked email identity, or one confirmed with a code. */
export async function ownEmail(db: Db, user: User): Promise<string | null> {
  const r = await db.one<{ external_id: string }>(`SELECT external_id FROM identities WHERE user_id=$1 AND channel='email' LIMIT 1`, [user.id]);
  return r?.external_id ?? (typeof user.prefs.emailVerified === "string" ? (user.prefs.emailVerified as string) : null);
}

export const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;
export const PHONE = /^\+?[\d\s().-]{7,20}$/;

/** Someone in the circle, by "@handle", full name or first name. Never the person themselves. */
export async function findMember(db: Db, me: User, who: string): Promise<{ found: User | null; many: boolean }> {
  const w = who.trim().replace(/^@/, "").toLowerCase();
  if (!w) return { found: null, many: false };
  const rows = await db.query<User>(
    `SELECT * FROM users WHERE id<>$1 AND (lower(coalesce(prefs->>'username','')) = $2 OR lower(coalesce(name,'')) = $2 OR lower(split_part(coalesce(name,''),' ',1)) = $2) ORDER BY id`,
    [me.id, w],
  );
  const exact = rows.filter((r) => String(r.prefs?.username ?? "").toLowerCase() === w || (r.name ?? "").toLowerCase() === w);
  const pick = exact.length === 1 ? exact : rows;
  return { found: pick.length === 1 ? pick[0] : null, many: pick.length > 1 };
}

/** Well-known numbers only, and only when we know the country. Otherwise: "your local emergency number". */
const EMERGENCY: Record<string, [string, string]> = {
  US: ["911", "the US"], CA: ["911", "Canada"], MX: ["911", "Mexico"], GB: ["999", "the UK"], AU: ["000", "Australia"], NZ: ["111", "New Zealand"],
  IE: ["112", "Ireland"], DE: ["112", "Germany"], FR: ["112", "France"], ES: ["112", "Spain"], IT: ["112", "Italy"], PT: ["112", "Portugal"], NL: ["112", "the Netherlands"],
  BE: ["112", "Belgium"], AT: ["112", "Austria"], SE: ["112", "Sweden"], DK: ["112", "Denmark"], FI: ["112", "Finland"], PL: ["112", "Poland"], GR: ["112", "Greece"],
  IN: ["112", "India"], NG: ["112", "Nigeria"],
};
export function emergencyNumber(user: Pick<User, "tz" | "prefs">): string {
  const explicit = typeof user.prefs?.country === "string" ? String(user.prefs.country).toUpperCase() : "";
  const guessed = countryOf(user);
  // countryOf falls back to US for any America/* zone and DE for Europe/*; only trust those when the zone really is there.
  const trust = explicit || (guessed && !(guessed === "US" && !/^America\/(?:New_York|Chicago|Denver|Los_Angeles|Phoenix|Anchorage|Detroit)$/.test(user.tz)) && !(guessed === "DE" && user.tz !== "Europe/Berlin") ? guessed : "");
  const e = trust ? EMERGENCY[trust] : undefined;
  return e ? `your local emergency number (${e[0]} in ${e[1]})` : "your local emergency number";
}

/** Passwords, seed phrases and private keys: never kept. Returns what it looked like, or null. */
/** Small words of ordinary sentences that are not in the BIP39 word list, so a run without any of them reads like a seed phrase. */
const STOP = new Set("the and for with that was are have this your not but she her his they our from you has had were been can him them what when there here would could should then than because please tell always".split(" "));
export function looksSecret(text: string): string | null {
  const t = text.trim();
  if (/\b(?:seed|recovery|secret|backup|mnemonic)\s*(?:phrase|words?|key)s?\b\s*(?:is|are|:|=)/i.test(t)) return "a seed phrase";
  if (/\bprivate\s*key\b\s*(?:is|:|=)/i.test(t)) return "a private key";
  if (/\b(?:0x)?[a-fA-F0-9]{64}\b/.test(t)) return "a private key";
  if (/\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/.test(t) || /\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/.test(t) || /\[\s*\d{1,3}(?:\s*,\s*\d{1,3}){31,}\s*\]/.test(t)) return "a private key";
  if (/\b(?:password|passcode|passwd|pwd|pin(?: code| number)?)\b(?:\s+(?:for|to|of)\s+[\w .'-]{1,30}?)?\s*(?:is|:|=)\s*(?!(?:in|on|at|inside|under|with|kept|stored|written|saved|the|my|a|an|behind|taped|somewhere|also)\b)\S+/i.test(t)) return "a password";
  // A seed phrase pasted bare: twelve or more short lowercase words in a row, none of them the small words of a sentence.
  const runs = t.split(/[^a-z ]|\s{2,}/).map((r) => r.trim().split(" ").filter(Boolean));
  for (const run of runs) {
    let streak: string[] = [];
    for (const w of [...run, "|"]) {
      if (/^[a-z]{3,8}$/.test(w) && !STOP.has(w)) streak.push(w);
      else { if (streak.length >= 12) return "a seed phrase"; streak = []; }
    }
  }
  return null;
}
export const SECRET_REFUSAL = (what: string) => `That looks like ${what}, so I haven't kept it. I never store passwords, seed phrases or private keys, even here. Say where to find them instead, like "the recovery sheet is in the blue folder in my desk".`;

/** Government ID numbers stay off the emergency card. */
export const GOV_ID = /\b(?:passport|national (?:id|identity|insurance)(?: number| no)?|nin|ssn|social security|bvn|aadhaa?r|driver'?s? licen[cs]e|driving licen[cs]e|id (?:card )?(?:no|number|#)|tax (?:id|number)|cpf|curp|dni|nik)\b|\b\d{3}-\d{2}-\d{4}\b/i;

/** A short model call for a plain verdict. Null when there's no model, it's over budget, or it fails. */
export async function think(db: Db, user: User, system: string, prompt: string, max = 160): Promise<string | null> {
  if (!providerName() || (await overBudget(db, user.id))) return null;
  try {
    const r = await complete({ system, messages: [{ role: "user", content: prompt }], maxTokens: max });
    if (!r) return null;
    await recordUsage(db, user.id, r.usage.input, r.usage.output);
    return r.text?.trim() || null;
  } catch (e: any) { log.warn({ err: e?.message }, "safety model call failed"); return null; }
}

export const mapLink = (lat: number, lon: number) => `https://maps.google.com/?q=${lat.toFixed(5)},${lon.toFixed(5)}`;

/** The rules pass drops a final "." or "!"; a message someone wrote for a person keeps it. */
export function keepEnding(text: string, source?: string): string {
  const raw = source?.replace(/^\[[\w ]+\]\s*/, "").trimEnd();
  const end = raw?.match(/[.!?]+$/)?.[0];
  const t = text.trimEnd();
  return end && !/[.!?]$/.test(t) && raw!.slice(0, -end.length).endsWith(t) ? t + end : t;
}
