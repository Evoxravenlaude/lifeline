/**
 * What never goes into storage: keys, tokens, private keys, seed phrases, passwords and card numbers.
 * Messages are saved (for context) and every action is audited; both pass through `redact` first, so a key
 * pasted by mistake is used for nothing and kept nowhere. Features still refuse such things in their own words.
 */

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[hidden key]"],
  [/\b(?:sk|rk|pk)_(?:live|test)_[0-9a-zA-Z]{10,}/g, "[hidden key]"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, "[hidden key]"],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[hidden token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[hidden token]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[hidden key]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[hidden key]"],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, "[hidden token]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, "[hidden token]"],
  [/\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g, "[hidden key]"],
  [/\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/g, "[hidden key]"],
  [/\b((?:password|passcode|passwd|pwd|pin(?: code| number)?)(?:\s+(?:for|to|of)\s+[\w .'-]{1,30}?)?\s*(?:is|:|=)\s*)(?!(?:in|on|at|inside|under|with|kept|stored|written|saved|the|my|a|an|behind|taped|somewhere|also)\b)\S+/gi, "$1[hidden]"],
  [/\b((?:seed|recovery|secret|backup|mnemonic)\s*(?:phrase|words?|key)s?\s*(?:is|are|:|=)\s*)[^\n]+/gi, "$1[hidden]"],
];

/** Short words of ordinary sentences that aren't in the BIP39 list: a long run without any reads as a seed phrase. */
const STOP = new Set("the and for with that was are have this your not but she her his they our from you has had were been can him them what when there here would could should then than because please tell always i a an to of in on at is it my me we".split(" "));

function luhn(digits: string): boolean {
  let sum = 0, alt = false;
  for (let i = digits.length - 1; i >= 0; i--) { let d = Number(digits[i]); if (alt) { d *= 2; if (d > 9) d -= 9; } sum += d; alt = !alt; }
  return sum % 10 === 0;
}

export function redact(text: string): string {
  if (!text) return text;
  let t = text;
  for (const [re, to] of PATTERNS) t = t.replace(re, to);
  // A 64-character hex string is a private key, unless it's plainly a transaction or block hash.
  if (!/\b(?:tx|txn|transaction|hash|block|explain|receipt)\b/i.test(t)) t = t.replace(/\b(?:0x)?[0-9a-fA-F]{64}\b/g, "[hidden key]");
  // Card numbers: 13 to 19 digits (spaces or dashes allowed) that pass the Luhn check.
  t = t.replace(/\b(?:\d[ -]?){12,18}\d\b/g, (m) => { const d = m.replace(/\D/g, ""); return d.length >= 13 && d.length <= 19 && luhn(d) ? "[hidden card number]" : m; });
  // A bare seed phrase: twelve or more short lowercase words in a row with none of a sentence's small words.
  // The run may start with a few ordinary words ("here they are abandon ability ..."): only the stretch without them goes.
  t = t.replace(/(?:\b[a-z]{3,8}\b[ ,\n]+){11,47}\b[a-z]{3,8}\b/g, (m) => {
    const parts = m.split(/([ ,\n]+)/); // words at even indexes, separators at odd
    let start = -1;
    const spans: [number, number][] = [];
    for (let i = 0; i <= parts.length + 1; i += 2) {
      if (i < parts.length && !STOP.has(parts[i])) { if (start < 0) start = i; continue; }
      if (start >= 0 && (i - start) / 2 >= 12) spans.push([start, i - 2]);
      start = -1;
    }
    for (const [a, b] of spans.reverse()) parts.splice(a, b - a + 1, "[hidden seed phrase]");
    return parts.join("");
  });
  return t;
}

/** The same for anything JSON-shaped (action arguments in the audit log). */
export function redactJson(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactJson);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactJson(v)]));
  return value;
}
