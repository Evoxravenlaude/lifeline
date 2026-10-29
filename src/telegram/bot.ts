/**
 * Telegram channel. Thin: identity → shared handler → render buttons as
 * inline keyboards. Also handles voice notes, .ics uploads, the persona
 * picker, and Telegram Business messages (draft replies, never auto-sent).
 */
import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import type { Db } from "../core/db.js";
import { ensureUser, handleCallback, handleMessage, handlePhoto, renderDecision, type Reply } from "../core/handler.js";
import { registerSender } from "../core/dispatch.js";
import { propose } from "../policy/engine.js";
import { FULL_HELP } from "../intent/index.js";
import { overview } from "../intent/capabilities.js";
import { diagnostics, modelsInUse, providerChain } from "../intent/providers.js";
import { transcribe } from "../core/media.js";
import { PERSONAS } from "../intent/persona.js";
import { spentToday } from "../core/budget.js";
import { draftReply } from "../intent/model.js";
import { polish, personaOf } from "../core/voice.js";
import { pipLine } from "../core/pip.js";
import { admit, circleSummary, FULL_MESSAGE, isOwner } from "../core/circle.js";
import { copyButton, toPlain, toTelegramHtml } from "../core/format.js";
import { ASKS, BACK, OK, panel, shapeAnswer, type Btn, type Style } from "./panels.js";
import { ensurePip, pipSticker } from "./stickers.js";
import { pluginLocationHandlers } from "../core/plugins.js";
import { abilityLines, allow, mediaAbilities, probeVoice, speak, wantsVoice } from "../core/media.js";
import { activePlaces, webAddress } from "../core/ways.js";
import { everythingGroup, everythingIndex, helpGroups } from "../intent/capabilities.js";
import { answerWebLogin, webLoginExists } from "../core/weblogin.js";
import { activateGroup, deactivateGroup, dueBirthdays, groupActive, groupButton, groupCommand, guestAnswer, memberOf, wordsToCommand, type GroupOut, type Person } from "./group.js";

/** Telegram HTML: escape; bold the head line of a multi-line message so lists read at a glance; keep links clickable. */
/** Telegram HTML from the reply's markdown. Kept under this name for older callers. */
export function toHtml(text: string): string { return toTelegramHtml(text); }

/**
 * No persistent keyboard: it took a third of the chat to repeat what the Menu button does.
 * The old tiles still work if someone taps one before it disappears.
 */
const OLD_TILES: Record<string, string> = { Today: "today", Hackathons: "any hackathons for me", Lists: "my lists", Money: "how much did I spend this week", Scout: "Scout", Pip: "Pip", "☼ Today": "today", "⚑ Hackathons": "any hackathons for me", "☐ Lists": "my lists", "¤ Money": "how much did I spend this week", "◎ Scout": "Scout", "🐢 Pip": "Pip" };
export const ABOUT_LONG = "A personal assistant you talk to like a person, wherever you live. I keep your calendar, reminders and lists, your medication and cycle, sleep and mood, what you spend and who owes you, documents that expire, and the people you mean to call. I can check a message that feels off and look out for you on the way home. If you build things or hold crypto, I watch your sites and wallets too. Anything that spends money or reaches someone else waits for your yes. Tap Start.";
export const ABOUT_SHORT = "Your day, your body, your money and your work, kept by one assistant you just talk to.";

/** Four ways in, under the welcome only. They scroll away with it. */
const WAYS_IN = () => new InlineKeyboard().text("Open the menu ›", "p:home").primary().row().text("What can you do?", "say:what can you do").text("Things I can track", "say:what can you track");
const COMMANDS = [
  ["menu", "Everything in one place"], ["today", "Your day in one message"], ["lists", "Your lists"], ["track", "Sleep, weight, mood and more"],
  ["cycle", "Your period and cycle"], ["money", "This week's spending"], ["play", "A quick game"], ["everything", "All I can do, in drawers"],
  ["settings", "Voice, personality, brief time"], ["link", "Use me on the web, by text, email or iMessage"], ["undo", "Take back the last thing"], ["doctor", "Check that everything's connected"],
] as const;
const TZ_CHOICES: [string, string][] = [["London", "Europe/London"], ["New York", "America/New_York"], ["Los Angeles", "America/Los_Angeles"], ["Lagos", "Africa/Lagos"], ["Nairobi", "Africa/Nairobi"], ["Johannesburg", "Africa/Johannesburg"], ["Dubai", "Asia/Dubai"], ["Mumbai", "Asia/Kolkata"], ["Singapore", "Asia/Singapore"], ["Berlin", "Europe/Berlin"], ["São Paulo", "America/Sao_Paulo"], ["Sydney", "Australia/Sydney"]];

export { getUserById } from "../core/handler.js";
/** Telegram's party-popper message effect. */
const CONFETTI = "5046509860389126442";

/** The reply's own buttons, plus a Copy button when the reply holds one thing worth copying (a code, an address, a drafted message). */
/** How a button should look: a yes is green, a no or a delete is red, OK is blue, everything else plain. */
export function styleOf(data: string, label = ""): Style | undefined {
  if (/^(?:confirm|rem:done|med:taken)/.test(data) || /^Yes\b/.test(label)) return "success";
  if (/^(?:cancel)/.test(data) || /^(?:No|Delete|Cancel)\b/.test(label)) return "danger";
  if (data === "p:ok") return "primary";
  return undefined;
}
/** Panel rows to a Telegram keyboard, keeping each row as drawn. */
export function toKb(rows: Btn[][]): InlineKeyboard {
  const k = new InlineKeyboard();
  rows.forEach((row, i) => {
    for (const b of row) {
      if (b.webApp) { k.webApp(b.label, b.webApp); continue; }
      k.text(b.label, b.data); const st = b.style ?? styleOf(b.data, b.label); if (st) k.style(st);
    }
    if (i < rows.length - 1) k.row();
  });
  return k;
}
/** The reply's own buttons (coloured), a Copy button when there's one thing to copy, and OK to tidy away an Undo. */
function kb(r: Reply): InlineKeyboard | undefined {
  const copy = copyButton(r.text);
  if (!r.buttons?.length && !copy) return undefined;
  const k = new InlineKeyboard();
  (r.buttons ?? []).forEach((b, i) => { k.text(b.label, b.data); const st = styleOf(b.data, b.label); if (st) k.style(st); if (i % 2 === 1) k.row(); });
  if (r.buttons?.some((b) => /^undo:/.test(b.data))) k.text("OK", "p:ok").style("primary");
  if (copy) { if (r.buttons?.length) k.row(); k.copyText(copy.label, copy.text); }
  return k;
}

export function createBot(db: Db): Bot {
  const bot = new Bot(config.telegramToken);

  registerSender("telegram", async (externalId, reply) => {
    const parts = chunks(reply.text);
    for (let i = 0; i < parts.length; i++) {
      const markup = i === parts.length - 1 ? kb(reply) : undefined;
      await bot.api.sendMessage(Number(externalId), toHtml(parts[i]), { parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } })
        .catch(() => bot.api.sendMessage(Number(externalId), toPlain(parts[i]), { reply_markup: markup }));
    }
  });

  /* Groups, channels and guest calls never reach anything personal: they're answered here and stop. */
  bot.use(async (ctx, next) => {
    if ((ctx.update as any).guest_message) return onGuest(ctx).catch((e) => log.warn({ err: e?.message }, "guest answer failed"));
    const type = ctx.chat?.type;
    if (type === "group" || type === "supergroup") return onGroup(ctx).catch((e) => log.warn({ err: e?.message }, "group message failed"));
    if (type === "channel") return;
    await next();
  });

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return;
    if ((await admit(db, id)) === "full") {
      if (ctx.message) await ctx.reply(FULL_MESSAGE());
      else if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "The circle is full right now." }).catch(() => {});
      return;
    }
    await next();
  });

  /** The person, with their Telegram @handle kept current so friends can name them ("buddy up with @ana"). */
  const userOf = async (c: Context) => {
    const u = await ensureUser(db, "telegram", String(c.from!.id), [c.from!.first_name, c.from!.last_name].filter(Boolean).join(" "));
    const handle = c.from!.username?.toLowerCase();
    if (handle && u.prefs.username !== handle) {
      await db.query(`UPDATE users SET prefs = prefs || jsonb_build_object('username', $2::text) WHERE id=$1`, [u.id, handle]);
      u.prefs = { ...u.prefs, username: handle };
    }
    return u;
  };
  /** The old tile keyboard goes away with the first reply that has no buttons of its own. */
  const clearOld = async (c: Context): Promise<{ remove_keyboard: true } | undefined> => {
    const u = await userOf(c);
    if (u.prefs.kbCleared) return undefined;
    await db.query(`UPDATE users SET prefs = prefs || '{"kbCleared":true}'::jsonb WHERE id=$1`, [u.id]);
    return { remove_keyboard: true };
  };
  /** Speak `words` as a voice note. When someone asked to hear it, a failure is said out loud too (in text). */
  const sendVoice = async (c: Context, u: { id: number; prefs: Record<string, unknown> }, words: string, asked: boolean) => {
    if (!mediaAbilities().speak) return asked ? void (await c.reply("I can't speak on this server yet. It needs a Gemini key.").catch(() => {})) : undefined;
    if (!allow("speak", u.id)) return asked ? void (await c.reply("That's my voice used up for today. Back tomorrow.").catch(() => {})) : undefined;
    await c.replyWithChatAction("record_voice").catch(() => {});
    const sp = await speak(words, { voice: u.prefs.ttsVoice as string | undefined, persona: personaOf(u.prefs) }).catch(() => null);
    let sent = false;
    if (sp?.ogg) sent = Boolean(await c.replyWithVoice(new InputFile(sp.ogg, "lifeline.ogg"), { duration: sp.seconds }).catch((e) => { log.warn({ err: e?.message }, "voice send failed"); return null; }));
    if (sp && !sent) sent = Boolean(await c.replyWithAudio(new InputFile(sp.wav, "lifeline.wav"), { title: "lifeline", performer: "Pip" }).catch((e) => { log.warn({ err: e?.message }, "audio send failed"); return null; }));
    if (!sent && asked) await c.reply("My voice didn't come through this time. /doctor shows what went wrong.").catch(() => {});
  };
  const DICE_SAYS: Record<string, (v: number) => string> = {
    "🎲": (v) => `You rolled a ${v}.`,
    "🎯": (v) => (v === 6 ? "Bullseye." : v === 1 ? "Missed the board entirely." : `Not bad, ring ${v}.`),
    "🏀": (v) => (v >= 4 ? "Nothing but net." : "Off the rim."),
    "⚽": (v) => (v >= 3 ? "Goal!" : "Saved."),
    "🎳": (v) => (v === 6 ? "Strike!" : v === 1 ? "Gutter ball." : `${v === 5 ? "Nine" : "A few"} pins down.`),
    "🎰": (v) => ([1, 22, 43].includes(v) ? "Three of a kind!" : v === 64 ? "Jackpot. Seven seven seven." : "No luck this spin."),
  };
  const send = async (c: Context, r: Reply, spoken = false) => {
    const u = await userOf(c);
    void ensurePip(c.api, db, c.me.username);
    const st = u.prefs.calm === true ? null : pipSticker(r.sticker);
    if (st) await c.replyWithSticker(st).catch(() => {});
    const remove = r.buttons?.length ? undefined : await clearOld(c);
    if (r.dice) {
      const m = await c.replyWithDice(r.dice).catch(() => null);
      if (m?.dice) { const v = m.dice.value; setTimeout(() => { c.reply(DICE_SAYS[r.dice!]?.(v) ?? `${v}.`).catch(() => {}); }, 3200); }
      else await c.reply(toPlain(r.text));
      return;
    }
    if (r.image) {
      const photo = new InputFile(Buffer.from(r.image.data, "base64"), `lifeline.${r.image.mime.split("/")[1] ?? "jpg"}`);
      const cap = r.text.length <= 1000 ? r.text : "";
      await c.replyWithPhoto(photo, { caption: cap ? toHtml(cap) : undefined, parse_mode: "HTML", reply_markup: cap ? kb(r) : undefined })
        .catch(() => c.replyWithPhoto(photo, { caption: cap ? toPlain(cap) : undefined }));
      if (cap) return;
    }
    const parts = chunks(r.text);
    /* Confetti only for a real milestone, only one-to-one, never in calm mode. */
    const effect = r.celebrate && u.prefs.calm !== true && c.chat?.type === "private" ? CONFETTI : undefined;
    for (let i = 0; i < parts.length; i++) {
      const markup = i === parts.length - 1 ? kb(r) ?? remove : undefined;
      const base = { parse_mode: "HTML" as const, reply_markup: markup, link_preview_options: { is_disabled: true } };
      await (i === 0 && effect ? c.reply(toHtml(parts[i]), { ...base, message_effect_id: effect }).catch(() => c.reply(toHtml(parts[i]), base)) : c.reply(toHtml(parts[i]), base))
        .catch(() => c.reply(toPlain(parts[i]), { reply_markup: markup }));
    }
    if (wantsVoice(u.prefs, r, spoken)) await sendVoice(c, u, typeof r.speak === "string" ? r.speak : r.text, Boolean(r.speak) || (u.prefs.voiceReplies as string) === "always");
  };
  const say = async (c: Context, text: string, extra: Record<string, unknown> = {}) => {
    const u = await userOf(c);
    const t = polish(text, { persona: personaOf(u.prefs) });
    await c.reply(toHtml(t), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra }).catch(() => c.reply(toPlain(t), extra as any));
  };

  bot.command("start", async (c) => {
    const u = await userOf(c);
    const payload = (c.match ?? "").trim();
    if (payload.startsWith("web_")) {
      const id = payload.slice(4);
      if (!webLoginExists(id)) return say(c, "That sign-in link has expired. Go back to the page and press the button again; it lasts five minutes.");
      return say(c, "Sign in to lifeline on the web? Only say yes if you just pressed the button yourself, on your own device.", { reply_markup: new InlineKeyboard().text("Yes, sign me in", `weblogin:yes:${id}`).text("No", `weblogin:no:${id}`) });
    }
    const first = u.name ? u.name.split(" ")[0] : null;
    if (!u.prefs.onboarded) {
      await ensurePip(c.api, db, c.me.username);
      const hi = pipSticker("hello");
      if (hi) await c.replyWithSticker(hi).catch(() => {});
      const k = new InlineKeyboard();
      TZ_CHOICES.forEach(([l, z], i) => { k.text(l, `ob:tz:${z}`); if (i % 3 === 2) k.row(); });
      k.text("Somewhere else", "ob:tz:other").primary();
      await say(c, [
        `${first ? `${first}, hello` : "Hello"}. I'm lifeline, a personal assistant for everyday life. I keep your calendar, reminders and lists, your medication, your period and cycle, your sleep and anything else you track, what you spend, your trips and birthdays. If you work on things, I also find jobs, companies and hackathons worth your time.`,
        `You talk to me the way you'd text a friend. No commands to learn. Anything that moves money, deletes, or reaches someone else waits for your yes.`,
        `One thing first: where are you? Tap a city near you, or "Somewhere else" and type yours. That sets your clock and your currency, so "tomorrow at 9" means your 9.`,
      ].join("\n\n"), { reply_markup: k });
      return;
    }
    if (!u.prefs.kbCleared) { await db.query(`UPDATE users SET prefs = prefs || '{"kbCleared":true}'::jsonb WHERE id=$1`, [u.id]); await c.reply("…", { reply_markup: { remove_keyboard: true } }).then((m) => c.api.deleteMessage(m.chat.id, m.message_id)).catch(() => {}); }
    await showPanel(c, u, "home");
  });
  /** Send a fresh panel (the menu, or one of its pages). */
  const showPanel = async (c: Context, u: Awaited<ReturnType<typeof userOf>>, key: string) => {
    const r = await panel(db, u, key);
    if (r.panel) await c.reply(toHtml(r.panel.text), { parse_mode: "HTML", reply_markup: toKb(r.panel.rows), link_preview_options: { is_disabled: true } }).catch(() => c.reply(toPlain(r.panel!.text), { reply_markup: toKb(r.panel!.rows) }));
  };
  bot.command(["menu", "home"], async (c) => showPanel(c, await userOf(c), "home"));
  bot.command("settings", async (c) => showPanel(c, await userOf(c), "settings"));
  bot.api.setMyCommands(COMMANDS.map(([command, description]) => ({ command, description }))).catch((e) => log.warn({ err: e?.message }, "setMyCommands failed"));
  bot.api.setMyCommands([["split", "Split a bill: /split 120 dinner @ana @ben"], ["tab", "Who still owes what"], ["list", "The group's shared list"], ["when", "A poll to find a time"], ["trivia", "A quiz for everyone"], ["birthday", "Your birthday, said here on the day"], ["help", "What I do in a group"]].map(([command, description]) => ({ command, description })), { scope: { type: "all_group_chats" } }).catch((e) => log.warn({ err: e?.message }, "group commands failed"));
  /* What a stranger sees on the empty chat and when the link is shared. Telegram caps these at 512 and 120 characters. */
  bot.api.setMyDescription(ABOUT_LONG).catch((e) => log.warn({ err: e?.message }, "setMyDescription failed"));
  bot.api.setMyShortDescription(ABOUT_SHORT).catch((e) => log.warn({ err: e?.message }, "setMyShortDescription failed"));
  bot.command("scout", async (c) => say(c, "Which niche, and what for? Something like \"payments on base, for partnerships\" or \"ai agent startups to apply to\".", { reply_markup: { force_reply: true, input_field_placeholder: "a niche, and what you want from it" } }));
  bot.command("help", async (c) => say(c, FULL_HELP));
  const drawers = () => { const rows: Btn[][] = []; helpGroups().forEach(([t], i) => { if (i % 2 === 0) rows.push([]); rows[rows.length - 1].push({ label: `${t} ›`, data: `ev:${i}` }); }); return toKb([...rows, [BACK("home"), OK]]); };
  bot.command(["everything", "all", "features"], async (c) => { await c.reply(toHtml(everythingIndex()), { parse_mode: "HTML", reply_markup: drawers() }); });
  bot.command(["play", "game", "games"], async (c) => showPanel(c, await userOf(c), "play"));
  bot.command("voice", async (c) => showPanel(c, await userOf(c), "settings"));
  bot.command("circle", async (c) => {
    const u = await userOf(c);
    const first = await db.one<{ id: number }>(`SELECT min(id) AS id FROM users`);
    if (!isOwner(c.from!.id, u.id, first?.id)) return say(c, `This is a circle of up to ${config.maxUsers} people. Only the person who runs it can see who's in.`);
    await say(c, await circleSummary(db));
  });
  bot.command("what", async (c) => { const u = await userOf(c); await say(c, overview(u.name)); });
  bot.command("pip", async (c) => {
    const u = await userOf(c);
    const line = await draftReply(db, u, `Time: ${new Date().toISOString()}`, "You are Pip, a small tortoise with spectacles who keeps the user's day. One line (max 16 words) in the user's chosen voice: a dry, warm remark about keeping time, carrying things, or the day. No emoji. Output the line only.");
    await ensurePip(c.api, db, c.me.username);
    const st = pipSticker(["hello", "noted", "ontoit", "later", "thinking"][Math.floor(Math.random() * 5)]);
    if (st) await c.replyWithSticker(st).catch(() => {});
    await say(c, line ?? pipLine("idle", u));
  });
  bot.command("doctor", async (c) => {
    await c.replyWithChatAction("typing").catch(() => {});
    const chain = providerChain();
    const age = (t: number | null) => (t ? (Date.now() - t < 90_000 ? `${Math.round((Date.now() - t) / 1000)}s ago` : `${Math.round((Date.now() - t) / 60_000)} min ago`) : "never");
    const lines = [
      `Models, in the order I try them: ${chain.length ? chain.map((p) => (p === "openai" ? `openai (${modelsInUse().openai})` : p === "gemini" ? `gemini (${modelsInUse().gemini})` : p)).join(", then ") : "none set, so I only understand plain shapes"}.`,
      `Last good answer: ${age(diagnostics.lastOkAt)}${diagnostics.lastProvider ? ` (${diagnostics.lastProvider})` : ""}. Last failure: ${age(diagnostics.lastErrorAt)}.`,
      ...Object.values(diagnostics.errors).map((e) => `  ${e}`),
      "",
      ...abilityLines(),
      await probeVoice(),
      "",
      `Places: ${activePlaces()}. Email in: ${config.resendKey && config.resendWebhookSecret ? config.inboundEmail || "on, address not set (INBOUND_EMAIL)" : "off (RESEND_API_KEY and RESEND_WEBHOOK_SECRET)"}. iMessage: ${config.imessageProvider ? `${config.imessageProvider}${config.imessageAddress ? `, ${config.imessageAddress}` : ""}` : "off (see docs/IMESSAGE.md)"}.`,
      `Server address: ${config.publicUrl || "not set (PUBLIC_URL)"}. Website: ${webAddress() || "not set (WEB_URL)"}.`,
      `Guest calls from other chats: ${(c.me as any).supports_guest_queries ? "on" : "off (turn on guest mode in @BotFather)"}. App inside Telegram: ${/^https:/.test(webAddress()) ? "on" : "off (WEB_URL must be https)"}.`,
    ];
    await c.reply(lines.join("\n"), { link_preview_options: { is_disabled: true } });
  });
  bot.command("persona", async (c) => {
    const u = await userOf(c);
    const k = new InlineKeyboard();
    Object.entries(PERSONAS).forEach(([key, v], i) => { k.text(v.label, `persona:${key}`); if (i % 2 === 1) k.row(); });
    const cur = (u.prefs.personaCustom as string) ? "your own" : PERSONAS[(u.prefs.persona as string) ?? "plain"]?.label ?? "Plain";
    await say(c, `Right now I talk ${cur}. Pick another, or describe one in your words, like "talk like a tired pirate".`, { reply_markup: k });
  });
  bot.command("usage", async (c) => {
    const u = await userOf(c);
    await say(c, `Model spend in the last day: $${(await spentToday(db, u.id)).toFixed(3)} of $${config.dailyModelBudgetUsd}.`);
  });
  for (const [cmd, text] of [["pending", "pending"], ["undo", "undo"], ["memory", "what do you know about me"], ["audit", "/audit"], ["link", "link"], ["today", "today"], ["lists", "my lists"], ["trips", "trip"], ["hackathons", "any hackathons for me"], ["money", "how much did I spend this week"], ["cycle", "where am I in my cycle"], ["track", "what am I tracking"], ["jobs", "what jobs did you find"]] as const) {
    bot.command(cmd, async (c) => send(c, await handleMessage(db, await userOf(c), text, { channel: "telegram" })));
  }

  /** A file the person sent, or null if Telegram won't give it (over 20 MB, gone, network). */
  const download = async (c: Context): Promise<Buffer | null> => {
    try {
      const f = await c.getFile();
      const r = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`, { signal: AbortSignal.timeout(60_000) });
      return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
    } catch (e: any) { log.warn({ err: e?.message }, "telegram download failed"); return null; }
  };
  bot.on(["message:voice", "message:audio", "message:video_note"], async (c) => {
    if (!mediaAbilities().hear) return say(c, "I can't listen to voice notes on this server yet. Type it for now.");
    const u = await userOf(c);
    if (!allow("hear", u.id)) return say(c, "That's a lot of voice notes for one day. Type it for now; I'll be listening again tomorrow.");
    const size = c.message?.voice?.file_size ?? c.message?.audio?.file_size ?? c.message?.video_note?.file_size ?? 0;
    if (size > 19_000_000) return say(c, "That recording's too long for me. Keep voice notes under ten minutes or so?");
    await c.replyWithChatAction("typing").catch(() => {});
    const audio = await download(c);
    if (!audio) return say(c, "I couldn't fetch that voice note from Telegram. Send it again?");
    const isNote = Boolean(c.message?.video_note);
    const text = await transcribe(audio, isNote ? "note.mp4" : "voice.ogg", isNote ? "video/mp4" : c.message?.audio?.mime_type ?? "audio/ogg").catch(() => null);
    if (!text) return say(c, "I couldn't make out that voice note. Once more, or type it?");
    await c.reply(`<i>“${toHtml(text.length > 900 ? `${text.slice(0, 900)}…` : text)}”</i>`, { parse_mode: "HTML" }).catch(() => c.reply(`“${text.slice(0, 900)}”`).catch(() => {}));
    await send(c, await handleMessage(db, u, text, { channel: "telegram" }), true);
  });

  /* Photos: what's in it, an answer to the caption, and an offer to keep what matters. */
  const onPicture = async (c: Context, fileMime: string) => {
    const u = await userOf(c);
    const size = c.message?.document?.file_size ?? c.message?.photo?.[c.message.photo.length - 1]?.file_size ?? 0;
    if (size > 15_000_000) return say(c, "That picture's too big for me. Send it as a photo rather than a file?");
    await c.replyWithChatAction("typing").catch(() => {});
    const img = await download(c);
    if (!img) return say(c, "I couldn't fetch that picture from Telegram. Send it again?");
    await send(c, await handlePhoto(db, u, img, fileMime, c.message?.caption ?? "", "telegram"));
  };
  bot.on("message:photo", (c) => onPicture(c, "image/jpeg"));
  bot.on("message:document", async (c, next) => {
    const mime = c.message.document.mime_type ?? "";
    if (/^image\/(jpeg|png|webp|heic|heif)$/.test(mime)) return onPicture(c, mime);
    return next();
  });

  bot.on("message:document", async (c) => {
    const doc = c.message.document;
    if (!/\.ics$/i.test(doc.file_name ?? "")) return say(c, "I can read calendar files (.ics) and put the events in your calendar. Other files I can't do anything with yet.");
    if ((doc.file_size ?? 0) > 2_000_000) return say(c, "That file's over 2 MB, which is more calendar than I can take in one go.");
    const u = await userOf(c);
    const f = await c.getFile();
    const ics = await (await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`)).text();
    await send(c, renderDecision(await propose({ db, user: u, now: new Date(), sourceMessage: `[ics ${doc.file_name}]` }, "calendar.import_ics", { ics })));
  });

  /** After "Somewhere else": a city name or a shared location finishes the first step, then the voice question. */
  const finishPlace = async (c: Context, u: Awaited<ReturnType<typeof userOf>>, place: { name: string; tz: string; country: string | null } | null) => {
    if (!place) return say(c, "I couldn't find that place. Try the city with its country, like \"Porto, Portugal\".");
    const prefs = { ...u.prefs, awaitingCity: false, ...(place.country ? { country: place.country } : {}), city: place.name };
    await db.query(`UPDATE users SET tz=$2, prefs=$3 WHERE id=$1`, [u.id, place.tz, JSON.stringify(prefs)]);
    await db.query(`UPDATE jobs SET tz=$2 WHERE user_id=$1 AND kind='digest'`, [u.id, place.tz]);
    const k = new InlineKeyboard();
    Object.entries(PERSONAS).forEach(([key, v], i) => { k.text(v.label, `ob:persona:${key}`); if (i % 2 === 1) k.row(); });
    return say(c, `${place.name} it is, on ${place.tz.split("/").pop()!.replace(/_/g, " ")} time. Now, how should I talk? You can change this any time.`, { reply_markup: k });
  };
  bot.on("message:location", async (c) => {
    const u = await userOf(c);
    const loc = c.message.location;
    if (u.prefs.awaitingCity) {
      const { placeAt } = await import("../core/geo.js");
      return finishPlace(c, u, await placeAt(loc.latitude, loc.longitude));
    }
    for (const h of pluginLocationHandlers()) {
      const r = await h(db, u, { lat: loc.latitude, lon: loc.longitude, live: Boolean(loc.live_period), livePeriod: loc.live_period }, new Date()).catch(() => null);
      if (r) return send(c, r);
    }
    return say(c, "Got your location. I don't keep it unless you're using a safety check-in; say \"check on me\" to start one.");
  });
  /** Live location moving: features (a safety check-in) get every update; nothing is said unless one answers. */
  bot.on("edited_message:location", async (c) => {
    const u = await userOf(c);
    const loc = c.editedMessage.location!;
    for (const h of pluginLocationHandlers()) {
      const r = await h(db, u, { lat: loc.latitude, lon: loc.longitude, live: true, livePeriod: loc.live_period }, new Date()).catch(() => null);
      if (r) return send(c, r);
    }
  });
  bot.on("message:text", async (c, next) => {
    const u = await userOf(c);
    if (!u.prefs.awaitingCity || c.message.text.startsWith("/")) return next();
    const { findCity } = await import("../core/geo.js");
    return finishPlace(c, u, await findCity(c.message.text));
  });
  bot.on("message:text", async (c) => {
    const raw = c.message.text.trim();
    if (OLD_TILES[raw] === "Pip") {
      const u = await userOf(c);
      const line = await draftReply(db, u, `Time: ${new Date().toISOString()}`, "You are Pip, a small tortoise with spectacles who keeps the user's day. One line (max 16 words) in the user's chosen voice: a dry, warm remark about keeping time, carrying things, or the day. No emoji. Output the line only.");
      return say(c, line ?? pipLine("idle", u));
    }
    if (OLD_TILES[raw] === "Scout" || raw === "/scout") return say(c, "Which niche, and what for? Something like \"payments on base, for partnerships\" or \"ai agent startups to apply to\".", { reply_markup: { force_reply: true, input_field_placeholder: "a niche, and what you want from it" } });
    const asked = c.message.reply_to_message?.from?.id === c.me.id ? c.message.reply_to_message?.text : undefined;
    const text = OLD_TILES[raw] && !["Scout", "Pip"].includes(OLD_TILES[raw]) ? OLD_TILES[raw] : shapeAnswer(asked, raw);
    const forwarded = Boolean((c.message as any).forward_origin || (c.message as any).forward_date);
    await c.replyWithChatAction("typing").catch(() => {});
    await send(c, await handleMessage(db, await userOf(c), text, { channel: "telegram", forwarded }));
  });

  bot.on("callback_query:data", async (c) => {
    const u = await userOf(c);
    const data = c.callbackQuery.data;
    if (data.startsWith("ob:")) {
      const [, step, value] = data.match(/^ob:(\w+):(.+)$/) ?? ["", "", ""];
      await c.answerCallbackQuery().catch(() => {});
      await c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      if (step === "tz" && value === "other") {
        await db.query(`UPDATE users SET prefs = prefs || '{"awaitingCity":true}'::jsonb WHERE id=$1`, [u.id]);
        return say(c, "Type your city, or share your location with the paperclip.", { reply_markup: { force_reply: true, input_field_placeholder: "Berlin, Toronto, Accra, Manila…" } });
      }
      if (step === "tz") {
        await propose({ db, user: u, now: new Date(), sourceMessage: "[onboarding tz]" }, "settings.update", { tz: value });
        const k = new InlineKeyboard();
        Object.entries(PERSONAS).forEach(([key, v], i) => { k.text(v.label, `ob:persona:${key}`); if (i % 2 === 1) k.row(); });
        return say(c, `${value.split("/")[1].replace(/_/g, " ")} time it is. Now, how should I talk? You can change this any time, or describe your own voice later.`, { reply_markup: k });
      }
      if (step === "persona") {
        await propose({ db, user: u, now: new Date(), sourceMessage: "[onboarding persona]" }, "persona.set", { preset: value });
        await db.query(`UPDATE users SET prefs = prefs || '{"onboarded":true}'::jsonb WHERE id=$1`, [u.id]);
        return say(c, [
          `${PERSONAS[value]?.label ?? value}. That's the whole setup.`,
          `Try me with something real: "remind me to call mum on Sunday at 5", "I need to buy rice and eggs", "my period started today", "slept 6 hours".`,
          `If you ever wonder whether I can do something, just ask. "Can you track my meds?" gets a straight answer.`,
        ].join("\n\n"), { reply_markup: WAYS_IN() });
      }
      return;
    }
    if (data.startsWith("weblogin:")) {
      const [, answer, id] = data.split(":");
      const r = answerWebLogin(id, u.id, answer === "yes");
      await c.answerCallbackQuery().catch(() => {});
      await c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      return say(c, r === "expired" ? "That request has expired. Press the button on the page again." : answer === "yes" ? "Done. You're signed in on the web; the page will open by itself in a moment." : "Okay, nobody was signed in.");
    }
    if (data.startsWith("p:")) {
      const r = await panel(db, u, data.slice(2));
      await c.answerCallbackQuery(r.toast ? { text: r.toast } : {}).catch(() => {});
      if (r.close) return c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      if (r.ask) return c.reply(ASKS[r.ask].prompt, { reply_markup: { force_reply: true, input_field_placeholder: ASKS[r.ask].placeholder } }).catch(() => {});
      if (!r.panel) return;
      const p = r.panel;
      return c.editMessageText(toHtml(p.text), { parse_mode: "HTML", reply_markup: toKb(p.rows), link_preview_options: { is_disabled: true } }).catch((e) => {
        if (/not modified/i.test(String(e?.description ?? e?.message ?? ""))) return;
        return c.reply(toHtml(p.text), { parse_mode: "HTML", reply_markup: toKb(p.rows) }).catch(() => {});
      });
    }
    if (data.startsWith("ev:")) {
      await c.answerCallbackQuery().catch(() => {});
      const v = data.slice(3);
      const text = v === "home" ? everythingIndex() : everythingGroup(Number(v));
      if (!text) return;
      const markup = v === "home" ? drawers() : toKb([[{ label: "‹ Back", data: "ev:home" }, OK]]);
      return c.editMessageText(toHtml(text), { parse_mode: "HTML", reply_markup: markup }).catch((e) => {
        if (/not modified/i.test(String(e?.description ?? e?.message ?? ""))) return;
        return c.reply(toHtml(text), { parse_mode: "HTML", reply_markup: markup }).catch(() => {});
      });
    }
    if (data.startsWith("g:") || data.startsWith("photo:")) {
      await c.answerCallbackQuery().catch(() => {});
      await c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await c.replyWithChatAction("typing").catch(() => {});
      return send(c, await handleCallback(db, u, data));
    }
    if (data.startsWith("say:")) {
      await c.answerCallbackQuery().catch(() => {});
      await c.replyWithChatAction("typing").catch(() => {});
      return send(c, await handleMessage(db, u, data.slice(4), { channel: "telegram" }));
    }
    const r = await handleCallback(db, u, data);
    const short = toPlain(r.text);
    await c.answerCallbackQuery({ text: short.length > 190 ? short.slice(0, 187).replace(/\s+\S*$/, "") + "…" : short }).catch(() => {});
    await c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    if (r.text.length > 60 || r.buttons?.length) await send(c, r);
  });

  /* ---- Telegram Business: the user connected the bot to their own account.
     We never auto-reply; we draft a reply and send it to the owner's own chat. ---- */
  bot.on("business_connection", async (c) => {
    const bc = c.businessConnection;
    const u = await ensureUser(db, "telegram", String(bc.user.id), bc.user.first_name);
    await db.query(`INSERT INTO business_connections (connection_id, user_id, enabled) VALUES ($1,$2,$3) ON CONFLICT (connection_id) DO UPDATE SET enabled=EXCLUDED.enabled, updated_at=now()`, [bc.id, u.id, (bc as any).is_enabled ?? true]);
    await bot.api.sendMessage(bc.user.id, (bc as any).is_enabled === false ? "Business connection paused. I'll stop drafting replies." : "Business connection on. When someone writes to you in the chats you chose, I'll draft a reply here for you to send. I never send anything myself.");
  });
  bot.on("business_message", async (c) => {
    const m = c.businessMessage;
    const row = await db.one<{ user_id: number; enabled: boolean }>(`SELECT user_id, enabled FROM business_connections WHERE connection_id=$1`, [m.business_connection_id]);
    if (!row || !row.enabled || !m.text) return;
    const owner = await db.one<any>(`SELECT * FROM users WHERE id=$1`, [row.user_id]);
    if (!owner || m.from?.id === owner.telegram_id) return; // owner's own outgoing message
    const draft = await draftReply(db, owner, `${m.from?.first_name ?? "Someone"}: ${m.text}`);
    if (!draft) return;
    const md = `${m.from?.first_name ?? "Someone"} wrote: "${m.text.slice(0, 300)}"\n\nA reply you could send:\n\`\`\`\n${draft.replace(/\`\`\`/g, "")}\n\`\`\``;
    await bot.api.sendMessage(owner.telegram_id, toTelegramHtml(md), { parse_mode: "HTML", reply_markup: kb({ text: md }) }).catch(() => bot.api.sendMessage(owner.telegram_id, toPlain(md)));
  });

  /* ---- groups ---- */
  const person = (u: { id: number; first_name: string; last_name?: string; username?: string }): Person & { id: number } => ({ id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(" "), username: u.username });
  const groupKb = (rows?: { label: string; data: string }[][]) => (rows?.length ? toKb(rows) : undefined);
  const postGroup = async (c: Context, out: GroupOut) => {
    const chat = c.chat!.id;
    if (out.poll) {
      const p = out.poll;
      await c.api.sendPoll(chat, p.question.slice(0, 300), p.options.map((text) => ({ text: text.slice(0, 100) })), {
        is_anonymous: false, ...(p.correct != null ? { type: "quiz" as const, correct_option_id: p.correct, explanation: p.explanation } : { allows_multiple_answers: Boolean(p.multiple) }),
      }).catch((e) => log.warn({ err: e?.description ?? e?.message }, "group poll failed"));
      return;
    }
    if (!out.text) return;
    const opts = { parse_mode: "HTML" as const, reply_markup: groupKb(out.buttons), link_preview_options: { is_disabled: true } };
    /* Help and mistakes go to the one person who asked, so the group's chat stays about the group. */
    if (out.ephemeral && c.from) {
      const ok = await c.api.sendMessage(chat, toHtml(out.text), { ...opts, ephemeral_message_parameters: { receiver_user_id: c.from.id } } as any).then(() => true, () => false);
      if (ok) return;
    }
    await c.reply(toHtml(out.text), opts).catch(() => c.reply(toPlain(out.text!), { reply_markup: opts.reply_markup }).catch(() => {}));
  };
  const onGroup = async (c: Context) => {
    const chat = c.chat!;
    const title = "title" in chat ? chat.title : undefined;
    const me = c.me.username;
    if (c.myChatMember) {
      const now = c.myChatMember.new_chat_member.status, was = c.myChatMember.old_chat_member.status;
      if (["left", "kicked"].includes(now)) return deactivateGroup(db, chat.id);
      if (["member", "administrator"].includes(now) && ["left", "kicked"].includes(was)) {
        const m = await memberOf(db, c.myChatMember.from.id);
        if (!m) { await c.reply("Only someone in a lifeline circle can bring me into a group. Ask one of them to add me.").catch(() => {}); return void c.leaveChat().catch(() => {}); }
        await activateGroup(db, chat.id, title, m);
        await c.reply(`Hello, ${title ?? "everyone"}. I'm here for things you do together: splitting bills, a shared list, finding a time, trivia and birthdays. Type /help to see how. Nothing personal of anyone's ever shows up here.`).catch(() => {});
      }
      return;
    }
    if (c.callbackQuery?.data?.startsWith("gr:")) {
      const r = await groupButton(db, chat.id, person(c.callbackQuery.from), c.callbackQuery.data);
      await c.answerCallbackQuery({ text: r.toast }).catch(() => {});
      if (r.edit?.text) await c.editMessageText(toHtml(r.edit.text), { parse_mode: "HTML", reply_markup: groupKb(r.edit.buttons) }).catch(() => {});
      return;
    }
    if (c.callbackQuery) return void c.answerCallbackQuery({ text: "That button works in a private chat with me." }).catch(() => {});
    const msg = c.message;
    if (!msg?.text || !msg.from || msg.from.is_bot) return;
    const text = msg.text;
    const ents = msg.entities ?? [];
    let cmd = "", args = "";
    const lead = ents.find((e) => e.type === "bot_command" && e.offset === 0);
    if (lead) {
      const [name, at] = text.slice(1, lead.length).split("@");
      if (at && at.toLowerCase() !== me.toLowerCase()) return;
      cmd = name.toLowerCase(); args = text.slice(lead.length).trim();
    } else {
      const called = new RegExp(`@${me}\\b`, "i").test(text) || msg.reply_to_message?.from?.id === c.me.id;
      if (!called) return;
      const w = wordsToCommand(text.replace(new RegExp(`@${me}\\b`, "ig"), " ").trim());
      if (!w) return postGroup(c, { text: "In a group I split bills, keep a shared list, find a time, run trivia and remember birthdays. Type /help for how. For anything of your own, message me directly.", ephemeral: true });
      cmd = w.cmd; args = w.args;
    }
    if (!(await groupActive(db, chat.id, title, msg.from.id))) {
      if (lead) await postGroup(c, { text: "Someone in a lifeline circle needs to say something here first, then I can help the whole group.", ephemeral: true });
      return;
    }
    const mentions: Person[] = [];
    for (const e of ents) {
      if (e.type === "mention") { const u = text.slice(e.offset + 1, e.offset + e.length); if (u.toLowerCase() !== me.toLowerCase()) mentions.push({ name: u, username: u }); }
      if (e.type === "text_mention" && e.user && !e.user.is_bot) mentions.push(person(e.user));
    }
    const out = await groupCommand(db, { chatId: chat.id, title, from: person(msg.from), cmd, args, mentions });
    if (out) await postGroup(c, out);
  };
  const onGuest = async (c: Context) => {
    const m = (c.update as any).guest_message as { guest_query_id?: string; text?: string; from?: { id: number; first_name: string; last_name?: string; username?: string } };
    if (!m?.guest_query_id || !m.from) return;
    const answer = await guestAnswer(db, person(m.from), m.text ?? "", c.me.username);
    await (c.api as any).answerGuestQuery({ guest_query_id: m.guest_query_id, result: { type: "article", id: String(Date.now()), title: "lifeline", input_message_content: { message_text: toHtml(answer), parse_mode: "HTML", link_preview_options: { is_disabled: true } } } });
  };
  /* Birthdays said in groups, checked every quarter hour. */
  const birthdays = setInterval(() => {
    dueBirthdays(db, new Date()).then((due) => Promise.all(due.map((d) => bot.api.sendMessage(d.chatId, d.text).catch(() => {})))).catch((e) => log.warn({ err: e?.message }, "group birthdays failed"));
  }, 15 * 60_000);
  birthdays.unref?.();

  bot.catch((e) => log.error({ err: e.error }, "bot error"));
  return bot;
}

/** Telegram caps messages at 4096 chars; split on line breaks. */
export function chunks(text: string, max = 4000): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if ((cur + "\n" + line).length > max) { out.push(cur); cur = line; } else cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) out.push(cur);
  return out;
}
