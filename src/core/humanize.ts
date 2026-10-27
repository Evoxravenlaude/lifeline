/**
 * Turn whatever an action threw into a sentence a person can act on.
 * Modules throw plain sentences on purpose ("I couldn't read a time from…"); those pass through.
 * Everything else (HTTP codes, validation dumps, database errors) is translated or replaced.
 */

/** Who an action talks to, in words. */
const SOURCES: [RegExp, string][] = [
  [/^prices?\.|^wallet|^portfolio/, "the price service"],
  [/^bills?\./, "Flutterwave"],
  [/^jobs?\./, "that job board"],
  [/^scout\./, "the company search"],
  [/^hackathons?\.|^ledger/, "the hackathon feeds"],
  [/^tools?\.(weather)|weather/, "the weather service"],
  [/^tools?\.(fx|convert)|currency|fx/, "the exchange-rate service"],
  [/^tools?\.(tldr|summar)/, "that page"],
  [/^trading\./, "Polymarket"],
  [/^launches\./, "GitHub"],
];
const sourceFor = (action = "") => SOURCES.find(([re]) => re.test(action))?.[1] ?? "the service I use for that";

const FIELD_WORDS: Record<string, string> = {
  when: "when", at: "when", time: "the time", date: "the date", due: "when it's due", title: "what it's called", text: "what it's about",
  name: "the name", amount: "the amount", currency: "the currency", to: "where to", destination: "where you're going", city: "the city",
  address: "the address", coin: "which coin", value: "the number", list: "which list", item: "what to add", items: "what to add",
};
const fieldWords = (k: string) => FIELD_WORDS[k] ?? k.replace(/_/g, " ");

/** A message that already reads like a sentence for a person. */
export function isHuman(msg: string): boolean {
  return /^[A-Z"'“]/.test(msg) && /[.?!"”)]$/.test(msg.trim()) && /\s/.test(msg) && !/→|:\/\/|\b(?:ECONN|TypeError|undefined|null|SQL|violates|syntax error|status code|stack)\b|^\w+ \d{3}\b/.test(msg);
}

export function humanError(e: unknown, action?: string): string {
  const err = e as any;
  const msg = String(err?.message ?? err ?? "").trim();

  // Validation: something essential was missing or the wrong shape.
  const issues: any[] | undefined = err?.issues ?? (err?.name === "ZodError" ? err.errors : undefined);
  if (Array.isArray(issues) && issues.length) {
    const fields = [...new Set(issues.map((i) => String(i.path?.[0] ?? "")).filter(Boolean))].map(fieldWords);
    return fields.length ? `I didn't get ${fields.slice(0, 2).join(" or ")} from that. Say it again with ${fields.length > 1 ? "those" : "that"} in?` : "I didn't quite get all of that. Say it again a little differently?";
  }

  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network|aborted|timeout|timed out/i.test(msg)) {
    return `I couldn't reach ${sourceFor(action)} just now. Try again in a minute.`;
  }

  const status = Number(/\b([45]\d\d)\b/.exec(msg)?.[1] ?? 0);
  if (status) {
    const src = sourceFor(action);
    const Src = src.charAt(0).toUpperCase() + src.slice(1);
    if (status === 429) return `${Src} is busy and asked me to slow down. Try again in a few minutes.`;
    if (status === 401 || status === 403) return `${Src} turned me away; the key on the server may need renewing. /doctor will show it.`;
    if (status === 404) return `${Src} doesn't have that. Check the name or address and try again?`;
    if (status >= 500) return `${Src} is having trouble right now. Try again later.`;
    return `${Src} didn't accept that. Check the details and try again?`;
  }

  if (msg && isHuman(msg)) return msg;
  return "That didn't work on my side, so it may not have gone through. Try once more, and if it keeps happening, /doctor shows what's wrong.";
}

/** For a whole message that fell over before any action ran. */
export const BROKE = "Something on my side broke while I was on that, so it may not have been kept. Try once more in a moment; if it keeps happening, /doctor shows what's wrong.";
