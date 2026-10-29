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
  /** Before running: is something essential missing? Return the one question to ask, or null. */
  needs?: (args: z.infer<S>, ctx: Ctx) => Promise<Ask | null> | Ask | null;
  /** Turn the user's answer to `needs` into the missing arguments. Return null if the answer doesn't fit. */
  fill?: (need: string, answer: string, args: z.infer<S>, ctx: Ctx) => Partial<z.infer<S>> | null;
}

export function defineAction<S extends ZodTypeAny>(a: Action<S>): Action<S> {
  return a;
}
