/**
 * How a feature plugs into lifeline without touching shared files. A module calls these at import
 * time (from its own file under src/modules/), and the core picks them up:
 *
 *   addRules(...)        plain-sentence shortcuts that work without a model (checked before the core rules)
 *   addCues(mod, [...])  words that make the model see this module's actions
 *   addCapability(card, drawer)   a card in /everything, "what can you do" and the website
 *   addSchema(sql)       tables (CREATE TABLE IF NOT EXISTS ...), applied after the core migrations
 *   addBriefSection(...) a line or two in the morning brief: the calm channel, instead of extra pings
 *   addSystemJob(kind, cron)      a background job for everyone (pair with onJob from core/scheduler)
 *
 * Calm by design: a feature speaks through the brief first, pings only when time matters, and every
 * ping goes through push() (quiet hours, the daily cap, calm mode and quiet days all apply there).
 * See docs/PLUGINS.md.
 */
import type { Db } from "./db.js";
import type { User } from "../policy/types.js";

export interface Intent { action: string; args: Record<string, unknown> }
export type Rule = [RegExp, (m: RegExpMatchArray) => Intent];

/** Same shape as a card in src/intent/capabilities.ts. */
export interface Card { key: string; name: string; cues: string[]; what: string; say: string[]; then: string; limits?: string }

/** The drawers of /everything, in order. A module picks one by name. */
export const DRAWERS = ["Your day", "Body and mind", "Money", "Home and paperwork", "Safety", "People", "Voice, photos and search", "Fun", "Work, code and crypto", "Me"] as const;
export type Drawer = (typeof DRAWERS)[number];

export interface BriefSection {
  key: string;
  /** Lower comes first. Time-sensitive things (a check-in, an expiry this week) ~10; gentle things (on this day) ~80. */
  order: number;
  /** Zero to two short lines, already in plain words. Never health, cycle or grief details unless the person asked for them in the brief. */
  /** `peek` is true when someone is only looking (the Today panel): show the lines, but don't count them as said. */
  lines: (db: Db, user: User, now: Date, opts?: { peek?: boolean }) => Promise<string[]>;
}

const rules: Rule[] = [];
const cues: Record<string, string[]> = {};
const cards: { card: Card; drawer: Drawer }[] = [];
const schemas: string[] = [];
const brief: BriefSection[] = [];
const systemJobs: [string, string][] = [];
const examples: Record<string, string[]> = {};

/** What a feature's button press returns: the same shape as any reply. */
export interface ButtonReply { text: string; buttons?: { label: string; data: string; }[]; sticker?: string; speak?: boolean | string }
export type ButtonHandler = (db: Db, user: User, data: string, now: Date) => Promise<ButtonReply>;
export type LocationHandler = (db: Db, user: User, loc: { lat: number; lon: number; live: boolean; livePeriod?: number }, now: Date) => Promise<ButtonReply | null>;
const buttons: { prefix: string; fn: ButtonHandler }[] = [];
const locations: LocationHandler[] = [];
const photoActions = new Set<string>();

export const addRules = (...r: Rule[]) => { rules.push(...r); };
export const addCues = (mod: string, words: string[]) => { cues[mod] = [...(cues[mod] ?? []), ...words]; };
export const addCapability = (card: Card, drawer: Drawer) => { if (!cards.some((c) => c.card.key === card.key)) cards.push({ card, drawer }); };
export const addSchema = (sql: string) => { schemas.push(sql); };
export const addBriefSection = (s: BriefSection) => { if (!brief.some((b) => b.key === s.key)) brief.push(s); };
/** Sentences a person might type, each of which must reach `action` WITHOUT a model (rules or the loose layer). test/coverage checks every one. */
export const addExamples = (action: string, sentences: string[]) => { examples[action] = [...(examples[action] ?? []), ...sentences]; };
export const pluginExamples = () => examples;
export const addSystemJob = (kind: string, cron: string) => { if (!systemJobs.some(([k]) => k === kind)) systemJobs.push([kind, cron]); };

export const pluginRules = () => rules;
export const pluginCues = () => cues;
export const pluginCards = () => cards;
export const pluginBrief = () => [...brief].sort((a, b) => a.order - b.order);
export const pluginSystemJobs = () => systemJobs;

/** Buttons whose callback data starts with `prefix:` (keep the whole of it under 64 bytes) come to `fn`. Prefixes must be unique. */
export const addButtons = (prefix: string, fn: ButtonHandler) => { if (!buttons.some((b) => b.prefix === prefix)) buttons.push({ prefix, fn }); };
export const buttonHandler = (data: string) => buttons.find((b) => data.startsWith(`${b.prefix}:`))?.fn ?? null;
/** A shared location (one-off or live, and each live update) is offered to every handler; the first non-null reply is sent. */
export const addLocationHandler = (fn: LocationHandler) => { locations.push(fn); };
export const pluginLocationHandlers = () => locations;
/** Let a photo's suggested sentence turn into this tier-1 action (e.g. a receipt into a subscription). Only add actions that just record things for the person. */
export const addPhotoAction = (action: string) => { photoActions.add(action); };
export const pluginPhotoActions = () => photoActions;

/**
 * A first look at every message the person writes themselves (not forwarded), before anything else reads it:
 * before yes/no, open questions and rules. For the few things that must never be missed, like someone in crisis.
 * Return a reply to answer with it, or null to let the message carry on.
 */
export type FirstLook = (db: Db, user: User, text: string) => Promise<string | null>;
const firstLooks: FirstLook[] = [];
export const addFirstLook = (fn: FirstLook) => { firstLooks.push(fn); };
export const pluginFirstLooks = () => firstLooks;

/**
 * Texts from people who aren't lifeline users but agreed to hear from it (a caregiver's "YES", "TAKEN", "STOP").
 * Checked before anything else on SMS. Return the reply to text back, or null when the text isn't yours.
 */
export type TextReplyHandler = (db: Db, channel: "sms" | "imessage" | "email", from: string, text: string) => Promise<string | null>;
const textReplies: TextReplyHandler[] = [];
export const addTextReplyHandler = (fn: TextReplyHandler) => { textReplies.push(fn); };
export const pluginTextReplyHandlers = () => textReplies;

/**
 * Forwarded messages skip every rule (they're information, not instructions). A forwarded rule may still read one
 * as something to look at, like a suspicious message to check. Only tier-1 actions are taken this way.
 */
export type ForwardedRule = (text: string) => Intent | null;
const forwardedRules: ForwardedRule[] = [];
export const addForwardedRule = (fn: ForwardedRule) => { forwardedRules.push(fn); };
export const pluginForwardedRules = () => forwardedRules;

/** Applied after the numbered migrations; every statement must be idempotent. */
export async function applySchemas(db: Db): Promise<void> {
  for (const sql of schemas) for (const stmt of sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
}

/** The brief's extra lines: a few, in order, never more than `max`, and one failing section never breaks the brief. */
export async function briefExtras(db: Db, user: User, now: Date, max = 6, opts: { peek?: boolean } = {}): Promise<string[]> {
  const out: string[] = [];
  for (const s of pluginBrief()) {
    if (out.length >= max) break;
    try { out.push(...(await s.lines(db, user, now, opts)).slice(0, 2)); } catch { /* a section that fails stays quiet */ }
  }
  return out.slice(0, max);
}
