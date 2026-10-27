/**
 * Telegram channel. Thin: identity → shared handler → render buttons as
 * inline keyboards. Also handles voice notes, .ics uploads, the persona
 * picker, and Telegram Business messages (draft replies, never auto-sent).
 */
import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { config } from "../core/config.js";
import { log } from "../core/log.js";
import type { Db } from "../core/db.js";
import { ensureUser, handleCallback, handleMessage, renderDecision, type Reply } from "../core/handler.js";
import { registerSender } from "../core/dispatch.js";
import { propose } from "../policy/engine.js";
import { FULL_HELP } from "../intent/index.js";
import { overview } from "../intent/capabilities.js";
import { diagnostics, providerName } from "../intent/providers.js";
import { transcribe } from "../core/stt.js";
import { PERSONAS } from "../intent/persona.js";
import { spentToday } from "../core/budget.js";
import { draftReply } from "../intent/model.js";
import { polish, personaOf } from "../core/voice.js";
import { pipLine } from "../core/pip.js";

/** Telegram HTML: escape; bold the head line of a multi-line message so lists read at a glance; keep links clickable. */
export function toHtml(text: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = text.split("\n");
  return lines.map((line, i) => {
    const e = esc(line);
    const isHead = (i === 0 && lines.length >= 3 && line.length < 70 && /[.:!?]$/.test(line)) || (/^[A-Z][^:]{1,40}:$/.test(line) && line.length < 44);
    return isHead ? `<b>${e}</b>` : e;
  }).join("\n");
}

const QUICK = new Keyboard().text("Today").text("Hackathons").text("Scout").row().text("Lists").text("Money").text("Pip").resized().persistent();
const QUICK_MAP: Record<string, string> = { Today: "today", Hackathons: "any hackathons for me", Lists: "my lists", Money: "how much did I spend this week" };
const TZ_CHOICES: [string, string][] = [["Lagos", "Africa/Lagos"], ["Libreville", "Africa/Libreville"], ["Accra", "Africa/Accra"], ["Nairobi", "Africa/Nairobi"], ["London", "Europe/London"], ["New York", "America/New_York"], ["Dubai", "Asia/Dubai"], ["Lisbon", "Europe/Lisbon"], ["Singapore", "Asia/Singapore"]];

export { getUserById } from "../core/handler.js";

function kb(r: Reply): InlineKeyboard | undefined {
  if (!r.buttons?.length) return undefined;
  const k = new InlineKeyboard();
  r.buttons.forEach((b, i) => { k.text(b.label, b.data); if (i % 2 === 1) k.row(); });
  return k;
}

export function createBot(db: Db): Bot {
  const bot = new Bot(config.telegramToken);

  registerSender("telegram", async (externalId, reply) => {
    const parts = chunks(reply.text);
    for (let i = 0; i < parts.length; i++) {
      const markup = i === parts.length - 1 ? kb(reply) : undefined;
      await bot.api.sendMessage(Number(externalId), toHtml(parts[i]), { parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } })
        .catch(() => bot.api.sendMessage(Number(externalId), parts[i], { reply_markup: markup }));
    }
  });

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return;
    if (config.allowedUserIds.length && !config.allowedUserIds.includes(id)) {
      if (ctx.message) await ctx.reply("This one's a private bot for a small circle. If you were meant to be in it, ask whoever runs it to add your Telegram id.");
      return;
    }
    await next();
  });

  const userOf = (c: Context) => ensureUser(db, "telegram", String(c.from!.id), [c.from!.first_name, c.from!.last_name].filter(Boolean).join(" "));
  const send = async (c: Context, r: Reply) => {
    const parts = chunks(r.text);
    for (let i = 0; i < parts.length; i++) {
      const markup = i === parts.length - 1 ? kb(r) : undefined;
      await c.reply(toHtml(parts[i]), { parse_mode: "HTML", reply_markup: markup, link_preview_options: { is_disabled: true } }).catch(() => c.reply(parts[i], { reply_markup: markup }));
    }
  };
  const say = async (c: Context, text: string, extra: Record<string, unknown> = {}) => {
    const u = await userOf(c);
    const t = polish(text, { persona: personaOf(u.prefs) });
    await c.reply(toHtml(t), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...extra }).catch(() => c.reply(t, extra as any));
  };

  bot.command("start", async (c) => {
    const u = await userOf(c);
    const first = u.name ? u.name.split(" ")[0] : null;
    if (!u.prefs.onboarded) {
      const k = new InlineKeyboard();
      TZ_CHOICES.forEach(([l, z], i) => { k.text(l, `ob:tz:${z}`); if (i % 3 === 2) k.row(); });
      await say(c, [
        `${first ? `${first}, hello` : "Hello"}. I'm lifeline. I keep your day and your deadlines so they don't live in your head: reminders, calendar, medication, classes, trips, lists; hackathons ranked to your taste and chased to payout; new projects and the people behind them; prices and wallets.`,
        `You talk to me the way you'd text a sharp friend. No commands to learn. Anything that moves money, deletes, or reaches someone else waits for your yes.`,
        `One thing first: where are you? That sets your clock, so "tomorrow at 9" means your 9.`,
      ].join("\n\n"), { reply_markup: k });
      return;
    }
    await say(c, `Welcome back${first ? `, ${first}` : ""}. ${pipLine("return", u)}`, { reply_markup: QUICK });
  });
  bot.command("help", async (c) => say(c, FULL_HELP));
  bot.command("what", async (c) => { const u = await userOf(c); await say(c, overview(u.name)); });
  bot.command("pip", async (c) => {
    const u = await userOf(c);
    const line = await draftReply(db, u, `Time: ${new Date().toISOString()}`, "You are Pip, a small tortoise with spectacles who keeps the user's day. One line (max 16 words) in the user's chosen voice: a dry, warm remark about keeping time, carrying things, or the day. No emoji. Output the line only.");
    await say(c, line ?? pipLine("idle", u));
  });
  bot.command("doctor", async (c) => {
    const p = providerName();
    const age = (t: number | null) => (t ? `${Math.round((Date.now() - t) / 1000)}s ago` : "never");
    await c.reply([`provider: ${p ?? "none (rules + loose NL only)"}`, `last model success: ${age(diagnostics.lastOkAt)}`, `last model error: ${age(diagnostics.lastErrorAt)}${diagnostics.lastError ? `\n  ${diagnostics.lastError}` : ""}`, `gemini key for scout: ${config.geminiKey ? "yes" : "no"}`, `stt: ${config.openaiKey ? "yes" : "no"}, email: ${config.smtpUrl ? "yes" : "no"}, public url: ${config.publicUrl || "unset"}`].join("\n"));
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
  for (const [cmd, text] of [["pending", "pending"], ["undo", "undo"], ["memory", "what do you know about me"], ["audit", "/audit"], ["link", "link"], ["today", "today"]] as const) {
    bot.command(cmd, async (c) => send(c, await handleMessage(db, await userOf(c), text, { channel: "telegram" })));
  }

  bot.on(["message:voice", "message:audio"], async (c) => {
    if (!config.openaiKey) return say(c, "Voice notes need a transcription key on the server, and this one doesn't have it yet. Type it for now.");
    const f = await c.getFile();
    const r = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`);
    const text = await transcribe(Buffer.from(await r.arrayBuffer())).catch(() => null);
    if (!text) return say(c, "I couldn't make out that voice note. Once more, or type it?");
    await say(c, `Heard: "${text}"`);
    await send(c, await handleMessage(db, await userOf(c), text, { channel: "telegram" }));
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

  bot.on("message:text", async (c) => {
    const raw = c.message.text.trim();
    if (raw === "Pip") {
      const u = await userOf(c);
      const line = await draftReply(db, u, `Time: ${new Date().toISOString()}`, "You are Pip, a small tortoise with spectacles who keeps the user's day. One line (max 16 words) in the user's chosen voice: a dry, warm remark about keeping time, carrying things, or the day. No emoji. Output the line only.");
      return say(c, line ?? pipLine("idle", u));
    }
    if (raw === "Scout") return say(c, "Which niche, and what for? Something like \"payments on base, for partnerships\" or \"ai agent startups to apply to\".", { reply_markup: { force_reply: true, input_field_placeholder: "a niche, and what you want from it" } });
    const text = QUICK_MAP[raw] ?? raw;
    const forwarded = Boolean((c.message as any).forward_origin || (c.message as any).forward_date);
    await c.replyWithChatAction("typing").catch(() => {});
    await send(c, await handleMessage(db, await userOf(c), text, { channel: "telegram", forwarded }));
  });

  bot.on("callback_query:data", async (c) => {
    const u = await userOf(c);
    const data = c.callbackQuery.data;
    if (data.startsWith("ob:")) {
      const [, step, value] = data.match(/^ob:(\w+):(.+)$/) ?? ["", "", ""];
      await c.answerCallbackQuery();
      await c.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
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
          `Try me with something real: "remind me to call Ada tomorrow at 9", "I'm going to Accra on the 20th", "who's building payments on base". If you want hackathons and launches ranked to your taste, tell me what you're into whenever, like "interests: ai, payments, base". Any chains, any themes.`,
          `And if you ever wonder whether I can do something, just ask. "Can you track my meds?" gets a straight answer.`,
        ].join("\n\n"), { reply_markup: QUICK });
      }
      return;
    }
    const r = await handleCallback(db, u, data);
    await c.answerCallbackQuery({ text: r.text.slice(0, 190) });
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
    await bot.api.sendMessage(owner.telegram_id, `${m.from?.first_name ?? "Someone"} wrote: "${m.text.slice(0, 300)}"\n\nA reply you could send:\n${draft}`);
  });

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
