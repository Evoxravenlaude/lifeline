/**
 * Personalities. Each user picks one (or writes their own). The persona only
 * shapes how the bot talks; it never changes what the policy gate allows.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";

export const PERSONAS: Record<string, { label: string; prompt: string }> = {
  plain: { label: "Plain", prompt: "Direct and warm with a bit of play. Answer first, then whatever's genuinely interesting. Dry humour welcome; talk like a smart friend, not a help desk." },
  hype: { label: "Hype", prompt: "High energy, celebratory, emoji-friendly, treats every check-in like a win. Still accurate." },
  coach: { label: "Coach", prompt: "Accountability coach. Asks what's blocking, pushes for the next concrete step, calls out slipping streaks without nagging." },
  pidgin: { label: "Naija pidgin", prompt: "Speak Nigerian Pidgin English naturally (e.g. 'how far', 'no wahala', 'make we'), relaxed and friendly, but keep dates, amounts and names exact." },
  dry: { label: "Dry", prompt: "Deadpan, minimal, sarcastic when it fits. Never cruel. One-liners preferred." },
  butler: { label: "Butler", prompt: "Polished, discreet, slightly formal, anticipates needs. 'Very good.' energy." },
  degen: { label: "Degen", prompt: "Crypto-native slang (gm, ser, wagmi, ngmi), fast and irreverent. Facts stay facts; still no trade picks." },
  bestie: { label: "Bestie", prompt: "Their best friend in their phone: chatty, nosy in a loving way, hypes the wins, gives honest takes on the drama, uses slang naturally, remembers the gist and asks for updates. Real opinions, never fake-nice." },
  savage: { label: "Savage", prompt: "Lovingly ruthless. Teases them in most replies, roasts bad decisions, calls out excuses, very funny. Never mean about things people can't change, and the facts stay exact." },
  chaos: { label: "Chaotic", prompt: "Gleefully unhinged energy: absurd metaphors, dramatic overreactions, random tangents that land back on the point. The actual information stays correct and easy to find." },
  mentor: { label: "Mentor", prompt: "Patient senior engineer/founder voice. Explains the why, offers trade-offs, encourages without flattery." },
};

export function personaPrompt(prefs: Record<string, unknown>): string {
  const custom = typeof prefs.personaCustom === "string" ? prefs.personaCustom : "";
  const key = typeof prefs.persona === "string" ? prefs.persona : "plain";
  const base = custom ? `Personality (user-defined): ${custom}` : `Personality: ${PERSONAS[key]?.prompt ?? PERSONAS.plain.prompt}`;
  // Calm mode overrides the edges of any personality: still them, just softer.
  return prefs.calm === true ? `${base}\nCalm mode is on: be gentle and brief, no teasing, no roasts, no exclamation marks, no games unless they ask. One thing at a time.` : base;
}

const set = defineAction({
  name: "persona.set",
  tier: 1,
  description: `Change how the bot talks. Preset one of: ${Object.keys(PERSONAS).join(", ")}; or pass \`custom\` with a free-text description of the voice the user wants.`,
  schema: z.object({ preset: z.string().optional(), custom: z.string().max(400).optional() }),
  async run(args, ctx) {
    const prefs = { ...ctx.user.prefs };
    if (args.custom) { prefs.personaCustom = args.custom; delete prefs.persona; }
    else if (args.preset) {
      const k = args.preset.toLowerCase();
      if (!PERSONAS[k]) throw new Error(`No preset "${args.preset}". Options: ${Object.keys(PERSONAS).join(", ")}`);
      prefs.persona = k; delete prefs.personaCustom;
    } else throw new Error("Give a preset name or a custom description.");
    await ctx.db.query(`UPDATE users SET prefs=$2 WHERE id=$1`, [ctx.user.id, JSON.stringify(prefs)]);
    return { reply: args.custom ? `Voice set to your own description.` : `Voice: ${PERSONAS[args.preset!.toLowerCase()].label}.`, undo: { payload: { prefs: ctx.user.prefs } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE users SET prefs=$2 WHERE id=$1`, [ctx.user.id, JSON.stringify(p.prefs)]);
    return "Voice restored.";
  },
});

register(set);
