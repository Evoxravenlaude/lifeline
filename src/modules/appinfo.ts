/**
 * "Do you have a website?", "open the app", "/app": the website, the app inside Telegram, and installing it.
 * On Telegram the reply carries an Open button that opens the app in place (a Mini App).
 */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { addExamples, addRules } from "../core/plugins.js";
import { webAddress } from "../core/ways.js";

const open = defineAction({
  name: "app.open",
  tier: 1,
  description: "The person asks about lifeline's website or app, or wants to open it: give the address, how to sign in, and how to install it.",
  schema: z.object({}),
  async run(_a, _ctx) {
    const web = webAddress().replace(/\/$/, "");
    if (!web) return { reply: "There's a website and an app, but this server doesn't know its address yet. Whoever runs lifeline sets it as WEB_URL." };
    const https = web.startsWith("https://");
    return {
      reply: [
        "**lifeline on the web and as an app**",
        `Everything you keep here is there too: ${web}`,
        "- Sign in with Telegram, or the other ways on the page.",
        "- To have it as an app, open the site on your phone and choose Install (on iPhone: Share, then Add to Home Screen). Reminders can then arrive as notifications, even with Telegram closed.",
      ].join("\n"),
      buttons: https ? [{ label: "Open the app", data: `webapp:${web}/` }] : undefined,
    };
  },
});
/** The picture above the menu can be switched off for a plain, text-only menu. */
const menuCard = defineAction({
  name: "menu.card",
  tier: 1,
  description: "Show or hide the picture card above the Telegram menu (on by default).",
  schema: z.object({ on: z.boolean() }),
  async run(args, ctx) {
    await ctx.db.query(`UPDATE users SET prefs = prefs || jsonb_build_object('menuCard', $2::boolean) WHERE id=$1`, [ctx.user.id, args.on]);
    return { reply: args.on ? "The picture is back above your menu." : "Plain menu from now on, no picture. Say \"menu picture on\" to bring it back." };
  },
});
register(open, menuCard);

addRules(
  [/^\/?app$|^(?:open|launch|show me)\s+(?:the\s+)?(?:lifeline\s+)?(?:app|web ?app|mini ?app|website|site|dashboard)$/i, () => ({ action: "app.open", args: {} })],
  [/^(?:do you|does lifeline|is there)\s+(?:have\s+)?(?:a|an)\s+(?:website|site|web ?app|app|mobile app|phone app|dashboard)(?:\s+(?:too|as well|i can use))?\??$|^(?:what'?s|where'?s|what is|where is)\s+(?:your|the|lifeline'?s?)\s+(?:website|site|web ?app|app|link)\??$|^(?:can i|how do i)\s+(?:get|install|download|use)\s+(?:you|lifeline|this)\s+(?:as an app|on my phone|on the web|on my laptop|outside telegram)\??$/i, () => ({ action: "app.open", args: {} })],
);
addRules(
  [/^(?:plain menu|menu (?:pictures?|cards?|images?) off|(?:hide|turn off|no) (?:the )?menu (?:pictures?|cards?|images?))$/i, () => ({ action: "menu.card", args: { on: false } })],
  [/^(?:menu (?:pictures?|cards?|images?) on|(?:show|turn on) (?:the )?menu (?:pictures?|cards?|images?))$/i, () => ({ action: "menu.card", args: { on: true } })],
);
addExamples("menu.card", ["plain menu", "menu picture on"]);
addExamples("app.open", ["open the app", "do you have a website?", "what's your website", "can I install you as an app", "/app"]);
