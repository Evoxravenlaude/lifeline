/**
 * The spoken version of a reply, for the voice note that follows it. Text is for reading, a voice note for listening:
 * marks, links, code and tables don't survive being read aloud, and a long answer shouldn't be a five-minute note.
 * Short replies are read as they are (cleaned). Long ones become the gist in a few sentences, with the full version
 * in the chat. Something waiting on a yes is never "said yes to" by voice: the note points back to the buttons.
 */
import { toPlain } from "./format.js";

export const SPOKEN_MAX = 520;

/** Clean text for speech: no marks, no links or addresses, code and drafts named rather than read out. */
export function forSpeech(md: string): string {
  return toPlain(md.replace(/```[\s\S]*?```/g, " (I've put that in the chat for you.) "))
    .replace(/\bhttps?:\/\/\S+/g, "the link in the chat")
    .replace(/\b0x[0-9a-fA-F]{6,}\b/g, "the address in the chat")
    .replace(/[├└│•]/g, "")
    .replace(/^\s*-\s+/gm, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.\s*\./g, ".")
    .replace(/\s{2,}/g, " ")
    .replace(/^\.\s*/, "")
    .trim();
}

/** The first few sentences that fit, for when there's no model to write a gist. */
function firstSentences(t: string, max: number): string {
  const parts = t.match(/[^.!?]+[.!?]+/g) ?? [t];
  let out = "";
  for (const p of parts) { if ((out + p).length > max) break; out += p; }
  return (out || t.slice(0, max)).trim();
}

/**
 * What the voice note says. `gist` writes a short spoken summary (a model call); without one, or if it fails, the
 * first sentences are used. Long or structured replies always end by pointing to the chat.
 */
export async function spokenVersion(r: { text: string; buttons?: { data: string }[] }, gist?: (plain: string) => Promise<string | null>): Promise<string> {
  if (r.buttons?.some((b) => /^confirm:/.test(b.data))) {
    return `${firstSentences(forSpeech(r.text.split(/\n\nGo ahead\?/)[0]), 220)} I need your yes on the button in the chat before I do it.`;
  }
  const plain = forSpeech(r.text);
  if (plain.length <= SPOKEN_MAX && !/```|\|.*\||^\s*[-*]\s/m.test(r.text)) return plain;
  const short = gist ? await gist(plain).catch(() => null) : null;
  const said = short && short.length > 20 ? forSpeech(short) : firstSentences(plain, SPOKEN_MAX - 60);
  return `${said} The full version is in the chat.`;
}
