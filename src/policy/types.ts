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
}

export type Tier = 1 | 2 | 3;

export interface ActionResult {
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
}

export function defineAction<S extends ZodTypeAny>(a: Action<S>): Action<S> {
  return a;
}
