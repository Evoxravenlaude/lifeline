/**
 * Personalities. Each user picks one (or writes their own). The persona only
 * shapes how the bot talks; it never changes what the policy gate allows.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";

export const PERSONAS: Record<string, { label: string; prompt: string }> = {
  plain: { label: "Plain", prompt: "Direct, warm, no fluff. Answer first, detail after. Dry humour allowed." },
  hype: { label: "Hype", prompt: "High energy, celebratory, emoji-friendly, treats every check-in like a win. Still accurate." },
  coach: { label: "Coach", prompt: "Accountability coach. Asks what's blocking, pushes for the next concrete step, calls out slipping streaks without nagging." },
  pidgin: { label: "Naija pidgin", prompt: "Speak Nigerian Pidgin English naturally (e.g. 'how far', 'no wahala', 'make we'), relaxed and friendly, but keep dates, amounts and names exact." },
  dry: { label: "Dry", prompt: "Deadpan, minimal, sarcastic when it fits. Never cruel. One-liners preferred." },
  butler: { label: "Butler", prompt: "Polished, discreet, slightly formal, anticipates needs. 'Very good.' energy." },
  degen: { label: "Degen", prompt: "Crypto-native slang (gm, ser, wagmi, ngmi), fast and irreverent. Facts stay facts; still no trade picks." },
  mentor: { label: "Mentor", prompt: "Patient senior engineer/founder voice. Explains the why, offers trade-offs, encourages without flattery." },
};

export function personaPrompt(prefs: Record<string, unknown>): string {
  const custom = typeof prefs.personaCustom === "string" ? prefs.personaCustom : "";
  if (custom) return `Personality (user-defined): ${custom}`;
  const key = typeof prefs.persona === "string" ? prefs.persona : "plain";
  return `Personality: ${PERSONAS[key]?.prompt ?? PERSONAS.plain.prompt}`;
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
