/**
 * Several steps for one message. Before this, a model could do one thing per message: "cancel the bank reminder and
 * add Bunmi's birthday" did only the first. Now the model acts, sees what happened, and acts again, up to four
 * times, then says what's left to say (or nothing, when each action's own reply already covers it).
 *
 * Safety is unchanged, because every step goes through the policy engine exactly like a single action does:
 * - anything that needs a yes (money, deleting an account, reaching another person) stops the loop right there and
 *   shows the usual Yes / No; nothing after it runs until they answer, and they can ask again afterwards;
 * - a question back to them ("when should I...?") stops the loop and waits for the answer;
 * - a refusal or an error stops it and says so.
 * The model only ever sees what an action said (its reply), as information for this message. Nothing is saved
 * from the loop's scratch work, so no "[did x]" note can leak into later turns.
 */
import type { Attachment } from "../policy/types.js";

export interface StepReply extends Attachment { text: string; buttons?: { label: string; data: string }[]; action?: string }

/** What the handler reports back after running one step. `stop`: hand this reply to the person now and end the loop. */
export interface StepResult { stop: boolean; reply: StepReply; changed: boolean }
export type ToolRunner = (action: string, args: Record<string, unknown>) => Promise<StepResult>;

export const MAX_STEPS = 4;

/** Actions that only look (a list, a search, a status): their replies inform the next step and aren't shown on their own. */
export const LOOK = /(?:^|\.)(?:list|show|search|find|get|status|next|check|view|summary|today|deep|recap|week|lookup|scan|quote|price|rate|times|due|upcoming|balance|portfolio)$|^(?:weather|fx|web\.search|research\.deep|images\.find)$/;
export const looksOnly = (action: string) => LOOK.test(action);

/**
 * Whether one more model call is worth it after this step. A plain "remind me at 9" is done after one action, and
 * asking the model again would only add a second or two and some cost. Keep going when the message has more than
 * one ask in it, or when the step only looked and the message wants something done with what it found.
 */
export function wantsMore(action: string, text: string): boolean {
  const t = text.toLowerCase();
  const doing = /\b(?:cancel|delete|remove|drop|move|change|reschedule|push|remind|add|set|book|send|email|log|track|mark|tick|follow|stop|turn|make|create|save|plan|pay|split|draft)\b/;
  if (looksOnly(action)) return doing.test(t) || /\b(?:then|and|so)\b/.test(t);
  return /\b(?:and then|then|also|after that|as well|plus)\b|\band\s+(?:also\s+)?(?:cancel|delete|remove|drop|move|change|remind|add|set|book|send|email|log|track|mark|follow|make|create|save|tell|show|what)\b|[,;]\s*(?:and\s+)?(?:cancel|delete|remove|drop|move|change|remind|add|set|book|send|email|log|track|mark|follow|make|create|save)\b/.test(t);
}

/** The note the model gets on its next step: what this message has done so far, as information, not as a turn of its own. */
export function progressNote(done: { action: string; said: string }[]): string {
  return [
    "[What you've already done for this message. Information for you; the person sees each action's own reply.]",
    ...done.map((d, i) => `${i + 1}. ${d.action}: ${d.said.replace(/\s+/g, " ").slice(0, 700)}`),
    "",
    "If something they asked for is still not done, call the next tool. If everything is done and those replies say it all, reply with just DONE. Otherwise reply with a short final message (an answer from what you found, or one question). Never repeat what the replies already said.",
  ].join("\n");
}

/** What the person finally sees: each change in order, then the model's last word if it added one. */
export function assemble(steps: { action: string; reply: StepReply; changed: boolean }[], final: string): StepReply {
  const shown = steps.filter((s) => s.changed);
  const words = final.trim();
  const finalSays = words && !/^done\.?$/i.test(words) ? words : "";
  const parts = shown.map((s) => s.reply.text);
  if (finalSays) parts.push(finalSays);
  // Only looked (a list) and nothing more to say: the look's own reply is the answer.
  if (!parts.length && steps.length) parts.push(steps[steps.length - 1].reply.text);
  const last = shown[shown.length - 1] ?? steps[steps.length - 1];
  const { text: _t, ...rest } = last?.reply ?? { text: "" };
  return { ...rest, text: parts.join("\n\n"), action: last?.action };
}
