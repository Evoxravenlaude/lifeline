/**
 * Calm mode and quiet days. Built for people on hard days as much as good ones:
 *  - calm mode: gentler, shorter replies; nudges wait for the morning brief; no stickers or effects
 *  - a quiet day: nothing but what you set yourself (reminders, doses, a safety check-in) until it ends
 * Also the reference module for docs/PLUGINS.md: actions, rules, cues and a card, all from this one file.
 */
import { z } from "zod";
import { DateTime } from "luxon";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules } from "../core/plugins.js";

const calmSet = defineAction({
  name: "calm.set",
  tier: 1,
  description: "Turn calm mode on or off. Calm mode: gentler, shorter replies, no teasing or games unless asked, nudges wait for the morning brief, no stickers or effects.",
  schema: z.object({ on: z.boolean() }),
  async run(args, ctx) {
    await ctx.db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [ctx.user.id, JSON.stringify({ calm: args.on })]);
    return args.on
      ? { reply: "Calm mode is on. I'll keep things short and gentle, and anything that can wait will wait for your morning note. Say \"calm mode off\" whenever you like." }
      : { reply: "Calm mode is off. Back to normal." };
  },
});

const quietDay = defineAction({
  name: "calm.quiet_day",
  tier: 1,
  description: "Pause every nudge for a while (a quiet day): only reminders, doses and safety check-ins the person set themselves still come. 'hours' defaults to the rest of today and tonight.",
  schema: z.object({ hours: z.number().min(1).max(168).optional() }),
  async run(args, ctx) {
    const local = DateTime.fromJSDate(ctx.now).setZone(ctx.user.tz);
    const until = args.hours ? local.plus({ hours: args.hours }) : local.plus({ days: 1 }).set({ hour: 8, minute: 0, second: 0 });
    await ctx.db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [ctx.user.id, JSON.stringify({ quietUntil: until.toMillis() })]);
    return { reply: `Quiet until ${until.toFormat(until.hasSame(local, "day") ? "HH:mm" : "ccc HH:mm")}. I'll only bring the things you set yourself, like reminders and doses. Take care of yourself.`, undo: { payload: { prev: ctx.user.prefs.quietUntil ?? 0 } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [ctx.user.id, JSON.stringify({ quietUntil: p.prev })]);
    return "Quiet day cancelled.";
  },
});

const resume = defineAction({
  name: "calm.resume",
  tier: 1,
  description: "End a quiet day early and let nudges through again.",
  schema: z.object({}),
  async run(_a, ctx) {
    await ctx.db.query(`UPDATE users SET prefs = prefs || '{"quietUntil":0}'::jsonb WHERE id=$1`, [ctx.user.id]);
    return { reply: "Welcome back. Nudges are on again." };
  },
});

register(calmSet, quietDay, resume);

addRules(
  [/^calm(?: mode)?(?: (on|off))?$/i, (m) => ({ action: "calm.set", args: { on: (m[1] ?? "on").toLowerCase() === "on" } })],
  [/^(?:turn (on|off) calm(?: mode)?)$/i, (m) => ({ action: "calm.set", args: { on: m[1].toLowerCase() === "on" } })],
  [/^(?:i need a |give me a |have a )?quiet (?:day|night|evening)$|^pause (?:everything|nudges|notifications)(?: for (?:today|now))?$|^leave me alone (?:today|for now)$|^i(?:'m| am) not (?:ok|okay) today$/i, () => ({ action: "calm.quiet_day", args: {} })],
  [/^(?:quiet|pause(?: everything)?) for (\d{1,3}) hours?$/i, (m) => ({ action: "calm.quiet_day", args: { hours: Number(m[1]) } })],
  [/^(?:i'?m back|resume|unpause|end (?:the )?quiet day)$/i, () => ({ action: "calm.resume", args: {} })],
);
addExamples("calm.set", ["calm mode on", "calm mode off", "calm"]);
addExamples("calm.quiet_day", ["quiet day", "I need a quiet day", "pause everything", "quiet for 3 hours"]);
addExamples("calm.resume", ["I'm back", "end quiet day"]);
addCues("calm", ["calm", "quiet day", "pause", "overwhelmed", "too much", "leave me alone", "break", "rest", "not ok", "not okay"]);
addCapability({
  key: "calm", name: "Calm mode and quiet days",
  cues: ["calm", "quiet day", "pause", "overwhelmed", "too many messages", "too much"],
  what: "On a hard day, say \"quiet day\" and I hold every nudge except what you set yourself. Calm mode keeps me gentle and brief, and lets anything that can wait arrive in your morning note instead.",
  say: ["quiet day", "calm mode on", "pause for 3 hours", "I'm back"],
  then: "Reminders, doses and safety check-ins you set still come; nothing else does until you're ready.",
}, "Me");

/** The brief says so when a quiet day is on, so it never feels like the bot just went silent. */
addBriefSection({
  key: "calm", order: 1,
  async lines(_db, user, now) {
    const q = Number(user.prefs.quietUntil ?? 0);
    return q > now.getTime() ? [`Quiet day on until ${DateTime.fromMillis(q).setZone(user.tz).toFormat("ccc HH:mm")}. Say "I'm back" to end it early.`] : [];
  },
});
