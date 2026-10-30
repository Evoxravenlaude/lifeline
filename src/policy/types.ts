import type { ZodTypeAny, z } from "zod";
import type { Db } from "../core/db.js";

export interface User {
  id: number;
  telegram_id: number;
  name: string | null;
  tz: string;
  digest_hour: number;
  quiet_start: number;
  quiet_end: number;
  prefs: Record<string, unknown>;
  email?: string | null;
  preferred_channel?: string;
}

export interface Ctx {
  db: Db;
  user: User;
  now: Date;
  /** Raw text of the message that produced this action, for the audit log. */
  sourceMessage?: string;
  /** The user answered "skip" to a follow-up: run with what we have. */
  skipAsk?: boolean;
  /** A follow-up the bot is waiting on, so the model can read the message as its answer. */
  thread?: Thread | null;
  /** For long work (researching a plan): say which step is running, so the person sees it move. Optional; channels without it ignore it. */
  progress?: (step: string) => Promise<void> | void;
  /** For long work: a line said along the way, as its own message ("On it.", "Your plan is built."). Optional. */
  note?: (text: string) => Promise<void> | void;
  /** Words as they're written (a model answer streaming in). Telegram shows them as a live draft. Optional. */
  draft?: (soFar: string) => void;
  /** Set when the person pressed Stop on a streaming answer. */
  stop?: AbortSignal;
}

/** A follow-up the bot asked and is waiting on. Lives in users.prefs.thread for ten minutes. */
export interface Thread {
  action: string;
  args: Record<string, unknown>;
  need: string;
  question: string;
  askedAt: number;
}

export interface Ask {
  /** which slot is missing, e.g. "when", "dates" */
  need: string;
  /** the one question to put to the user, in plain voice */
  question: string;
}

export type Tier = 1 | 2 | 3;

/** A picture, a voice note or a Telegram dice that goes with a reply. */
export interface Attachment {
  /** base64 image bytes and their type */
  image?: { data: string; mime: string };
  /** Read this reply aloud as well (true), or read these words aloud instead (a string). */
  speak?: boolean | string;
  /** Telegram's animated dice: 🎲 🎯 🏀 ⚽ 🎳 🎰 */
  dice?: string;
  /** One of Pip's stickers to go with the reply on Telegram (src/telegram/stickers.ts), for real moments only. */
  sticker?: string;
  /** A real milestone: Telegram plays its confetti effect on the message (private chats only; never in calm mode). */
  celebrate?: boolean;
  /** Buttons of the action's own (a game's answers, a "log it" offer). callback data stays under 64 bytes. */
  buttons?: { label: string; data: string }[];
  /** A file to hand over with the reply (a PDF export, a calendar invite, a lock-screen picture at full size). base64 bytes. */
  file?: { data: string; name: string; mime: string };
  /**
   * A quick log ("took my meds", "slept 7 hours"): on Telegram the person's own message gets this reaction, and a
   * reply that only says "logged" is left unsaid. Must be one of Telegram's reaction emoji. Never in product text.
   */
  react?: string;
  /** Long, structured replies (the brief, a summary, a researched answer) go out as a Telegram rich message where possible. */
  rich?: boolean;
  /** The action that produced this reply (set by the engine), so channels can file it (Telegram topics). */
  action?: string;
}

export interface ActionResult extends Attachment {
  reply: string;
  /** If set, the user gets an Undo button valid for `undoTtlSec` (default 300s). */
  undo?: { payload: unknown; label?: string };
}

export interface Action<S extends ZodTypeAny = ZodTypeAny> {
  name: string;
  tier: Tier;
  /** Shown to the model as the tool description. Be specific; it drives routing. */
  description: string;
  schema: S;
  /** One-line, argument-echoing summary shown before a Tier-2 action runs. */
  echo?: (args: z.infer<S>, ctx: Ctx) => string;
  run: (args: z.infer<S>, ctx: Ctx) => Promise<ActionResult>;
  undo?: (payload: any, ctx: Ctx) => Promise<string>;
  /**
   * Before anything else (even before asking for a yes): can this go ahead at all? Return a reply to stop here with
   * (say why, and what to do instead), or null to carry on. For things missing outside the message, like a linked email.
   */
  gate?: (args: z.infer<S>, ctx: Ctx) => Promise<ActionResult | null> | ActionResult | null;
  /** Before running: is something essential missing? Return the one question to ask, or null. */
  needs?: (args: z.infer<S>, ctx: Ctx) => Promise<Ask | null> | Ask | null;
  /** Turn the user's answer to `needs` into the missing arguments. Return null if the answer doesn't fit. */
  fill?: (need: string, answer: string, args: z.infer<S>, ctx: Ctx) => Partial<z.infer<S>> | null;
}

export function defineAction<S extends ZodTypeAny>(a: Action<S>): Action<S> {
  return a;
}
