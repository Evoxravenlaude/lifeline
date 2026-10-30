/**
 * How the Telegram chat itself behaves: topics (Money, Health, Trips, Work, Home threads) and reactions on
 * quick logs. Both are switched with a sentence, and both quietly do nothing outside Telegram.
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { addCapability, addExamples, addRules } from "../core/plugins.js";
import { AREA_NAMES, AREAS, topicMaker, topicsOf } from "../core/topics.js";

const telegramChat = async (ctx: { db: any; user: { id: number; telegram_id: number } }): Promise<number | null> => {
  const r = await ctx.db.one(`SELECT external_id FROM identities WHERE user_id=$1 AND channel='telegram' LIMIT 1`, [ctx.user.id]) as { external_id: string } | undefined;
  const id = Number(r?.external_id ?? ctx.user.telegram_id);
  return Number.isFinite(id) && id > 0 ? id : null;
};

const setup = defineAction({
  name: "topics.setup",
  tier: 1,
  description: "Split the person's Telegram chat with lifeline into topics (Money, Health, Trips, Work, Home), so pings land in their own thread and the main chat stays tidy.",
  schema: z.object({}),
  async run(_a, ctx) {
    const chat = await telegramChat(ctx);
    const make = topicMaker();
    if (!chat || !make) return { reply: "Topics are a Telegram thing, so this only works in your Telegram chat with me." };
    const r = await make(chat, topicsOf(ctx.user.prefs) ?? {});
    if (!r.ok) return {
      reply: r.why === "off"
        ? "Telegram hasn't switched topics on for me yet. Whoever runs lifeline turns it on in @BotFather (the bot's settings, under topics in private chats). Then say \"use topics\" again."
        : "I couldn't make the topics just now. Try again in a minute?",
    };
    await ctx.db.query(`UPDATE users SET prefs = prefs || jsonb_build_object('topics', $2::jsonb) WHERE id=$1`, [ctx.user.id, JSON.stringify(r.topics)]);
    return {
      reply: [
        "Your chat has topics now:",
        ...AREAS.filter((a) => r.topics[a]).map((a, i, all) => `${i === all.length - 1 ? "└" : "├"} ${AREA_NAMES[a]}`),
        "",
        "Pings about money go to Money, doses and your cycle to Health, and so on. Reminders, your morning brief and anything about your safety stay here in the main chat, so you never miss them. Ask me anything inside a topic and I answer there. Say \"stop using topics\" to go back.",
      ].join("\n"),
    };
  },
});

const off = defineAction({
  name: "topics.off",
  tier: 1,
  description: "Stop filing messages into Telegram topics; everything comes to the main chat again.",
  schema: z.object({}),
  async run(_a, ctx) {
    if (!topicsOf(ctx.user.prefs)) return { reply: "Topics aren't on, so everything already comes to the main chat." };
    await ctx.db.query(`UPDATE users SET prefs = prefs - 'topics' WHERE id=$1`, [ctx.user.id]);
    return { reply: "Everything comes to the main chat again. The old topics stay in Telegram with what's in them; you can delete them there if you like." };
  },
});

const reactions = defineAction({
  name: "reactions.set",
  tier: 1,
  description: "Whether quick logs (took my meds, slept 7 hours, spent 20 on lunch) get a reaction on the person's message instead of a reply. On by default, Telegram only.",
  schema: z.object({ on: z.boolean() }),
  async run(args, ctx) {
    await ctx.db.query(`UPDATE users SET prefs = prefs || jsonb_build_object('reactions', $2::boolean) WHERE id=$1`, [ctx.user.id, args.on]);
    return { reply: args.on ? "Quick logs get a reaction from me again instead of a message." : "I'll answer every log in words from now on. Say \"react to my logs\" to go back." };
  },
});

register(setup, off, reactions);

addRules(
  [/^(?:use|turn on|switch on|set up|start using)\s+topics$|^(?:tidy|split|organi[sz]e|sort)\s+(?:my|the|our|this)\s+chat(?:\s+(?:into|with)\s+topics)?$|^topics on$/i, () => ({ action: "topics.setup", args: {} })],
  [/^(?:stop using|turn off|switch off|no more|no)\s+topics$|^topics off$/i, () => ({ action: "topics.off", args: {} })],
  [/^(?:reply to|answer|words for)\s+(?:my|every)\s+logs?$|^(?:no|stop the|turn off)\s+reactions$|^reactions off$/i, () => ({ action: "reactions.set", args: { on: false } })],
  [/^(?:react to my logs|reactions on|turn on reactions)$/i, () => ({ action: "reactions.set", args: { on: true } })],
);
addExamples("topics.setup", ["use topics", "tidy my chat into topics"]);
addExamples("topics.off", ["stop using topics"]);
addExamples("reactions.set", ["reply to my logs", "react to my logs"]);
addCapability({
  key: "topics", name: "A tidy chat",
  cues: ["topics", "tidy", "organise", "too many messages", "threads"],
  what: "On Telegram I can split our chat into topics: Money, Health, Trips, Work and Home. Pings land in their own thread, and reminders and your brief stay in the main chat. Quick logs like \"took my meds\" get a reaction instead of a whole message.",
  say: ["use topics", "reply to my logs"],
  then: "Topics take a moment to appear in Telegram. Reactions start with your next log.",
  limits: "Topics need Telegram's topic mode switched on for the bot in @BotFather.",
}, "Me");
