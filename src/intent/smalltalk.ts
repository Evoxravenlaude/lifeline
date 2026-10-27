/**
 * Conversation without a model, or when the model is down. Not a chatbot:
 * just enough to acknowledge, defer, greet and close like a person, so the
 * user never gets a wall of commands for saying "later" or "thanks".
 */
import { PERSONAS } from "./persona.js";
import { accent } from "../core/voice.js";
import { overview, intro } from "./capabilities.js";

const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];

const RULES: [RegExp, (name: string | null, m: RegExpMatchArray) => string][] = [
  [/^(?:hi|hey|hello|yo|hiya|good (?:morning|afternoon|evening)|gm|morning|how far)\b[^?]*$/i, (n) => pick([`Hey${n ? ` ${n}` : ""}. What's on your mind?`, "Hi. I'm here.", `Hello${n ? ` ${n}` : ""}. What do you need kept?`])],
  [/^(?:thanks|thank you|thx|ty|cheers|appreciate it|appreciated)\b/i, () => pick(["Anytime.", "Of course.", "That's what I'm for."])],
  [/\b(?:later|not now|another time|skip this|maybe later|hold (?:that|this)|leave it|not yet|in a bit)\b/i, () => pick(["Sure. Whenever you're ready.", "No rush. I'll be here.", "Fine by me. Say the word when you want to pick it up."])],
  [/^(?:what'?s good|wagwan|how far|what'?s happening|what'?s new|what'?s popping)\b[?!. ]*$/i, () => pick(["All quiet on my side. What's on yours?", "Not much, I'm keeping your day. What do you need?", "Same as ever. What are we sorting out?"])],
  [/^(?:i(?:'m| am) (?:good|fine|great|okay|ok|well|alright)|(?:all )?good|fine|not bad)[,.! ]+(?:and |how about |what about )?(?:you|u|yourself)\b[?!. ]*$/i, () => pick(["Good to hear. Steady here, thanks for asking. Anything you want kept today?", "Glad. I'm well, keeping your list warm. What's next?"])],
  [/^(?:how are you|how'?s it going|you good|wyd|what'?s up|sup|how are things)\b/i, () => pick(["Steady. Keeping your day warm. You?", "All good here. What's next?", "Quiet on my end. Nothing's on fire."])],
  [/^(?:ok|okay|k|cool|nice|great|alright|sounds good|fine|got it|noted|perfect|sweet)\b[.!]?$/i, () => pick(["Good.", "Right.", "Okay."])],
  [/^(?:bye|goodbye|good night|gn|night|see you|talk later|ttyl|off to bed)\b/i, () => pick(["Rest well. Reminders still ring.", "Later. I've got the list.", "Night."])],
  [/^(?:who are you|what are you)\b/i, () => intro()],
  [/^(?:what can you do|what do you do|what is this)\b/i, (n) => overview(n)],
  [/^(?:what'?s my name|who am i)\b/i, (n) => (n ? `You're ${n}. Or that's what you told Telegram, anyway.` : "You haven't told me. Say \"my name is ...\" and I'll keep it.")],
  [/^(?:yes|yeah|yep|no|nope|nah)\b[.!]?$/i, () => pick(["Nothing's waiting on a yes or no right now. What did you mean?", "Nothing pending. Say what you'd like."])],
  [/^(?:sorry|my bad|oops|apologies)\b/i, () => "No harm done."],
  [/^(?:i(?:'m| am) (?:good|fine|great|okay|ok|well|alright|doing (?:good|well|fine))|doing (?:good|well|fine)|not bad|all good)\b[^?]*$/i, () => pick(["Good to hear. Anything you want me to keep for you today?", "Glad. Say the word if there's something to remember.", "Good. I'm here when you need something kept."])],
  [/^(?:lol|haha|lmao|rofl|😂|🤣)/i, () => pick(["Ha.", "Glad it landed."])],
  [/^(?:love you|you'?re the best|good bot|well done|nice one)\b/i, () => pick(["Careful, I'll get ideas.", "Noted, and returned.", "I try."])],
  [/^(?:are you (?:a )?(?:bot|robot|ai|human|real))\b/i, () => "A bot, with a tortoise for a face. The memory is real, though."],
];

export function smalltalk(text: string, prefs: Record<string, unknown> = {}, name?: string | null): string | null {
  const t = text.trim();
  const voice = typeof prefs.persona === "string" ? prefs.persona : "plain";
  const first = name ? name.split(" ")[0] : null;
  for (const [re, fn] of RULES) {
    const m = t.match(re);
    if (m) return accent(fn(first, m), voice);
  }
  return null;
}

/** When nothing understood the message. Short, human, no command wall. */
export function didNotCatch(modelDown: boolean): string {
  if (modelDown) return pick(["I didn't catch that, and I can't hold a free conversation right now. Plain asks still work: a reminder, a list, something to track or spend. /doctor shows what's wrong.", "Conversation is down on my side for the moment. I can still do the practical things if you say them plainly. /help has examples."]);
  return pick(["I didn't catch that. Say it another way?", "Not sure what you'd like me to do with that. Try it plainly, or ask me \"can you ...\" and I'll tell you."]);
}

export { PERSONAS };
