/**
 * Pip grows with you (src/core/pipthings.ts): "Pip's things" shows what he carries and what's next, and the
 * morning brief says when he's picked up something new. Nothing is ever taken away for a missed day.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { addBriefSection, addCapability, addExamples, addRules } from "../core/plugins.js";
import { carried, catchUp, keptDays, THINGS, thingsLine } from "../core/pipthings.js";
import { renderSection } from "../core/dashboard.js";
import { DateTime } from "luxon";

const things = defineAction({
  name: "pip.things",
  tier: 1,
  description: "Show Pip the tortoise and the small things he's gained as the person keeps their habits and doses (a scarf, a lantern, a cap...), and what comes next.",
  schema: z.object({}),
  async run(_a, ctx) {
    const { days, all } = await catchUp(ctx.db, ctx.user);
    const next = THINGS.find((t) => !all.some((x) => x.key === t.key)) ?? null;
    const lines = [
      all.length ? thingsLine(all) : "Pip isn't carrying anything yet.",
      days ? `You've kept something up on ${days} day${days === 1 ? "" : "s"} so far: a habit, a dose, or three good things.` : `Every day you keep something up (a habit, a dose, three good things) counts towards his ${all.length ? "next" : "first"} thing.`,
      next ? `Next: ${next.name}, at ${next.at} days.${next.at > days ? ` ${next.at - days} to go.` : ""}` : "That's everything he can carry. He's very proud of it.",
      "A missed day never takes anything away.",
    ];
    const png = await renderSection({
      title: "Pip's things", subtitle: days ? `${days} day${days === 1 ? "" : "s"} kept` : "Just starting",
      plate: "hack", pose: all.length ? "cheers" : "hello", updated: DateTime.fromJSDate(ctx.now).setZone(ctx.user.tz).toFormat("HH:mm"),
      rows: THINGS.map((t) => [t.name.charAt(0).toUpperCase() + t.name.slice(1), days >= t.at || all.some((x) => x.key === t.key) ? "carried" : `at ${t.at} days`] as [string, string]),
      things: all.map((t) => t.key),
    }).catch(() => null);
    return { reply: lines.join("\n"), ...(png ? { image: { data: png.toString("base64"), mime: "image/png" } } : {}) };
  },
});
register(things);

addRules([/^(?:pip'?s things|what (?:does|has) pip (?:got|have|carry)|what is pip carrying|how(?:'s| is) pip(?: doing)?|show me pip)\??$/i, () => ({ action: "pip.things", args: {} })]);
addExamples("pip.things", ["pip's things", "what does pip have", "how is pip doing"]);

/* The brief mentions a new thing once. A peek (the Today panel) shows it without counting it as said. */
addBriefSection({
  key: "pip_things", order: 88,
  async lines(db, user, _now, opts) {
    if (opts?.peek) {
      const days = await keptDays(db, user.id);
      const had = new Set(carried(user.prefs).map((t) => t.key));
      const fresh = THINGS.filter((t) => days >= t.at && !had.has(t.key));
      return fresh.length ? [`Pip has picked up ${fresh[fresh.length - 1].name}, for ${fresh[fresh.length - 1].why}.`] : [];
    }
    const { fresh } = await catchUp(db, user);
    if (!fresh.length) return [];
    const t = fresh[fresh.length - 1];
    return [`Pip has picked up ${t.name}, for ${t.why}. Say "Pip's things" to see him.`];
  },
});

addCapability({
  key: "pip", name: "Pip grows with you",
  cues: ["pip", "tortoise", "streak", "reward"],
  what: "Days you keep something up (a habit, a dose, three good things) add up, and Pip picks up small things to carry: a scarf, a lantern, a cap, a satchel. They show on your dashboard. A missed day never takes one away.",
  say: ["Pip's things"],
  then: "When he gets something new, your morning brief says so.",
}, "Fun");
