/**
 * Conversation without a model, or when the model is down. Not a chatbot:
 * just enough to acknowledge, defer, greet and close naturally, so the user
 * never gets a wall of commands for saying "later" or "thanks".
 */
import { PERSONAS } from "./persona.js";

const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];

const RULES: [RegExp, (voice: string, m: RegExpMatchArray) => string][] = [
  [/^(?:hi|hey|hello|yo|hiya|good (?:morning|afternoon|evening)|gm|morning)\b/i, () => pick(["Hey. What's on your mind?", "Hi. I'm here.", "Hello. What do you need kept?"])],
  [/^(?:thanks|thank you|thx|ty|cheers|appreciate it)\b/i, () => pick(["Anytime.", "Of course.", "That's what I'm for."])],
  [/\b(?:later|not now|another time|skip|maybe later|hold (?:that|this)|leave it|not yet)\b/i, () => pick(["Sure. Whenever you're ready.", "No rush. I'll be here.", "Fine by me. Say the word when you want to pick it up."])],
  [/^(?:how are you|how'?s it going|you good|wyd|what'?s up|sup)\b/i, () => pick(["Steady. Keeping your day warm. You?", "All good here. What's next?", "Quiet on my end. Nothing's on fire."])],
  [/^(?:ok|okay|k|cool|nice|great|alright|sounds good|fine|got it|noted)\b[.!]?$/i, () => pick(["👍", "Good.", "Noted."])],
  [/^(?:bye|goodbye|good night|gn|night|see you|talk later|ttyl)\b/i, () => pick(["Rest well. Reminders still ring.", "Later. I've got the list.", "Night."])],
  [/^(?:who are you|what are you|what can you do|what do you do)\b/i, () => "I'm Pip. I keep your day: reminders, calendar, meds, classes, trips, lists, hackathons, launches, prices. Just tell me things plainly. /help has examples."],
  [/^(?:yes|yeah|yep|no|nope|nah)\b[.!]?$/i, () => pick(["Nothing's waiting on a yes or no right now. What did you mean?", "Nothing pending. Say what you'd like."])],
  [/^(?:sorry|my bad|oops)\b/i, () => "No harm done."],
  [/^(?:lol|haha|lmao|😂|🤣)/i, () => pick(["Ha.", "Glad it landed."])],
];

export function smalltalk(text: string, prefs: Record<string, unknown> = {}): string | null {
  const t = text.trim();
  const voice = typeof prefs.persona === "string" ? prefs.persona : "plain";
  for (const [re, fn] of RULES) {
    const m = t.match(re);
    if (m) return style(fn(voice, m), voice);
  }
  return null;
}

/** Light accent per preset so even the no-model replies match the chosen voice. */
function style(s: string, voice: string): string {
  switch (voice) {
    case "hype": return s.replace(/\.$/, "!") + " 🔥";
    case "pidgin": return s.replace(/^Sure\./, "No wahala.").replace(/^Anytime\./, "Anytime, my guy.").replace(/^(?:Hey|Hi|Hello)\./, "How far.");
    case "butler": return s.replace(/^Sure\./, "Very good.").replace(/^Anytime\./, "At your service.").replace(/^Hey\.|^Hi\./, "Good day.");
    case "degen": return s.replace(/^Hey\.|^Hi\./, "gm ser.").replace(/^Anytime\./, "wagmi.").replace(/^Sure\./, "say less.");
    case "dry": return s.replace(/^Anytime\./, "Sure.").replace(/ 🔥$/, "");
    default: return s;
  }
}

/** When nothing understood the message. Short, human, no command wall. */
export function didNotCatch(modelDown: boolean): string {
  if (modelDown) return pick(["I didn't catch that, and my chat brain is offline right now. Plain asks still work: reminders, lists, prices, hackathons. /doctor shows what's wrong.", "Chat is down on my side for the moment. I can still do the practical things if you say them straight — /help has examples."]);
  return pick(["I didn't catch that. Say it another way?", "Not sure what you'd like me to do with that. Try it plainly, or /help for examples."]);
}

export { PERSONAS };
