/**
 * Pip. The face of lifeline: a tortoise with spectacles.
 *
 * Why a tortoise: he is slow on purpose. He never drops what he carries, he
 * reads everything before he moves, and he is still there in the morning.
 * The shell is where your things are kept. The spectacles are for the fine
 * print you forward him. He does not cheer, he does not nag, he does not
 * use emoji. He says one true line and gets out of the way.
 *
 * Every line here is tied to a real state of the user's day, never random
 * filler. The web app asks for a line by state; Telegram uses "idle" and
 * "return". With a model, Pip's lines are generated in the user's voice and
 * these are the fallback.
 */
import { DateTime } from "luxon";
import type { User } from "../policy/types.js";

export type PipState = "idle" | "return" | "thinking" | "pending" | "done" | "quiet" | "morning" | "late" | "empty" | "reminder" | "error" | "welcome";

const LINES: Record<PipState, string[]> = {
  welcome: ["I'm Pip. I keep the day so it doesn't have to live in your head.", "Pip. I carry what you tell me and I don't put it down.", "I'm Pip. Slow on purpose, and I never lose the thread."],
  idle: ["Nothing's on fire. Good moment to plan something.", "I keep the time so you don't have to.", "Say the thing. I'll hold it.", "Slow is smooth. Smooth is fast.", "Everything you've told me is still in the shell.", "Quiet in here. Quiet is fine."],
  return: ["Just talk to me. I've kept everything where you left it.", "I kept the list warm. What's next?", "Back again. Nothing fell off while you were away."],
  thinking: ["Reading that properly.", "One moment. Spectacles on.", "Thinking. I don't rush this part."],
  pending: ["Something's waiting on your yes. I won't move until you say.", "I've got one held. Yes or no, when you're ready.", "Not moving on that until you say so."],
  done: ["Off the list.", "Ticked. Fewer things in the shell.", "Done, and I won't bring it up again."],
  quiet: ["Quiet hours. I'll hold anything new until morning.", "It's late. Reminders you asked for still ring; the rest waits.", "Keeping watch, quietly."],
  morning: ["Morning. Your day's in one message, when you want it.", "Up early. The brief's ready whenever you are.", "New day. Nothing carried over that you didn't ask for."],
  late: ["Late one. Say stop and I'll let the rest keep till tomorrow.", "Still here. The list keeps till morning if you'd rather.", "Night. I don't sleep, but I do go quiet."],
  empty: ["Nothing kept yet. Tell me one thing you'd hate to forget.", "The shell's empty. That changes with one sentence.", "Start anywhere. A reminder, a date, a trip."],
  reminder: ["That's the one you asked me to bring back.", "As promised.", "Here it is, on time."],
  error: ["That one slipped. Say it once more?", "I missed that. Plainer, and I'll catch it.", "Lost the thread for a second. Again?"],
};

const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];

/** A line for the moment. Time of day shapes idle into morning/late. */
export function pipLine(state: PipState, user?: Pick<User, "tz" | "prefs"> | null, now = new Date()): string {
  let s = state;
  if (s === "idle" && user?.tz) {
    const h = DateTime.fromJSDate(now).setZone(user.tz).hour;
    if (h >= 5 && h < 10) s = "morning";
    else if (h >= 23 || h < 5) s = "late";
  }
  return pick(LINES[s] ?? LINES.idle);
}

/** For the web app's "about Pip" panel and the onboarding card. */
export const PIP_BIO = {
  name: "Pip",
  what: "A tortoise with spectacles. The face of lifeline.",
  why: [
    "Slow on purpose. He reads everything before he moves.",
    "Never puts down what he's carrying. The shell is where your things are kept.",
    "The spectacles are for the fine print you forward him.",
    "He says one true line and gets out of the way. No cheering, no nagging, no emoji.",
  ],
};
