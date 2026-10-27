/**
 * The last thing every reply passes through before it reaches a person.
 * See docs/VOICE.md. The modules are written in plain voice already; this
 * pass catches what slips (model output, pasted content, old strings) and
 * applies the light accent of a chosen persona when no model did.
 */

const EMOJI = /[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{20E3}]/gu;
const KEEP_EMOJI_VOICES = new Set(["hype", "degen"]);

export interface VoiceOpts {
  persona?: string;
  /** Model-written text keeps its own paragraphing; we only enforce the hard rules. */
  fromModel?: boolean;
}

export function polish(text: string, opts: VoiceOpts = {}): string {
  let t = text;
  // Em and en dashes become commas or full stops. "a — b" reads as "a, b"; "a—b" too.
  t = t.replace(/\s*[—–]\s*/g, ", ");
  t = t.replace(/,\s*,/g, ",").replace(/,\s*([.!?])/g, "$1").replace(/\n, /g, "\n").replace(/^, /gm, "");
  // Decorative emoji go, unless the user picked a voice that lives on them. Even then: one, at the end.
  if (!KEEP_EMOJI_VOICES.has(opts.persona ?? "")) t = t.replace(EMOJI, "");
  else {
    const found = t.match(EMOJI) ?? [];
    t = t.replace(EMOJI, "");
    if (found.length) t = t.trimEnd() + " " + found[0];
  }
  // Robotic residue.
  t = t.replace(/\bSuccessfully\s+/gi, "").replace(/\bhas been (added|created|removed|deleted|saved|updated)\b/gi, "is $1").replace(/^(?:Error|Invalid)[:\s]+/gim, "");
  // A reply starts with a capital, unless it starts with a handle, an address or a link.
  if (/^[a-z]/.test(t) && !/^(?:https?:|0x|@|\$)/.test(t)) t = t.charAt(0).toUpperCase() + t.slice(1);
  // Whitespace: no leading spaces on lines, no triple blank lines, no double spaces.
  t = t.split("\n").map((l) => l.replace(/[ \t]+$/g, "").replace(/^[ \t]+(?=\S)/, "").replace(/ {2,}/g, " ")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return t;
}

/** Light accent for replies written without a model. Register only; nothing factual changes. */
export function accent(text: string, persona?: string): string {
  const s = text;
  switch (persona) {
    case "hype": return s.replace(/\.$/, "!");
    case "pidgin": return s.replace(/^Sure\./, "No wahala.").replace(/^Anytime\./, "Anytime, my guy.").replace(/^(?:Hey|Hi|Hello)\./, "How far.").replace(/^No rush\./, "No rush at all.");
    case "butler": return s.replace(/^Sure\./, "Very good.").replace(/^Anytime\./, "At your service.").replace(/^(?:Hey|Hi)\./, "Good day.");
    case "degen": return s.replace(/^(?:Hey|Hi)\./, "gm ser.").replace(/^Anytime\./, "wagmi.").replace(/^Sure\./, "say less.");
    case "dry": return s.replace(/^Anytime\./, "Sure.").replace(/!$/, ".");
    default: return s;
  }
}

export function personaOf(prefs: Record<string, unknown> | undefined): string | undefined {
  if (!prefs) return undefined;
  if (typeof prefs.personaCustom === "string" && prefs.personaCustom) return "custom";
  return typeof prefs.persona === "string" ? prefs.persona : undefined;
}
