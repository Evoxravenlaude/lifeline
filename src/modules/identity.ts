/**
 * "What model are you?" lifeline is lifeline. It runs on several models from different labs, routed by task, so no
 * single name is the honest answer, and it doesn't name them. Said warmly, with what it can tell you instead.
 * The model is told the same (src/intent/model.ts), and a reply where a model names itself is put right (keepIdentity).
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { addExamples, addRules } from "../core/plugins.js";

const LINES = [
  "I'm lifeline. Under the hood I'm not one model: a few from different labs, picked per task. Quick ones for quick things, stronger ones when something needs thinking, plus my own rules and tools around them. Which one answers changes from message to message, so there's no single honest name to give, and I keep the mix to myself.",
  "Just lifeline. I'm built on a mix of models that take turns depending on what you ask, with my own memory and tools tying it together, so it's always the same me you're talking to. The names of the parts stay in the kitchen.",
  "I'm lifeline, made of several models working as one. A light one handles the quick stuff, a heavier one does the thinking, and the switch happens without you noticing. I don't name them, but I'm happy to tell you what I keep, what I never do, and what I can help with.",
];

const engine = defineAction({
  name: "about.engine",
  tier: 1,
  description: "The person asks which AI model, LLM, provider or company powers lifeline (ChatGPT? Claude? Gemini? GPT?). Answer as lifeline, without naming any.",
  schema: z.object({}),
  async run(_a, ctx) {
    const i = Math.abs(Math.floor(ctx.now.getTime() / 60_000)) % LINES.length;
    return { reply: `${LINES[i]}\n\nWhat I can say: you're talking to lifeline wherever you reach me, with one memory, and nothing spends money or reaches anyone without your yes.` };
  },
});
register(engine);

const NAMES = String.raw`(?:chat\s?gpt|gpt[-\s]?\d*[\w.-]*|claude|gemini|llama|grok|mistral|deepseek|qwen|copilot|openai|anthropic|google|meta|groq)`;
addRules(
  [new RegExp(String.raw`^(?:(?:so|ok|hey|lifeline|pip)[,\s]+)?(?:what|which)\s+(?:ai|a\.i\.|llm|model|language model|large language model|engine|brain)\s+(?:are you|do you (?:use|run on)|is (?:this|behind (?:this|you))|powers (?:you|this)|are you (?:built|running) on|runs you)\??$`, "i"), () => ({ action: "about.engine", args: {} })],
  [new RegExp(String.raw`^(?:(?:so|ok|hey|lifeline|pip)[,\s]+)?(?:are you|is this|r u|you'?re)\s+(?:just\s+|actually\s+|really\s+)?(?:a\s+)?${NAMES}(?:\s+\w+)?(?:\s+(?:or\s+)?${NAMES}(?:\s+\w+)?)*\??$`, "i"), () => ({ action: "about.engine", args: {} })],
  [/^(?:who|what)\s+(?:made|built|trained|created|powers|runs)\s+(?:you|this|lifeline)\??$|^(?:what(?:'s| is) your (?:model|llm|engine|underlying model)|what are you (?:built|running|based) on|which llm)\??$/i, () => ({ action: "about.engine", args: {} })],
);
addExamples("about.engine", ["what model are you?", "are you chatgpt?", "is this claude or gemini", "what llm do you use", "who built you"]);
