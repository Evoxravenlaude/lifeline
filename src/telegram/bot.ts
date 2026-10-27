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
import { HELP, FULL_HELP } from "../intent/index.js";
import { diagnostics, providerName } from "../intent/providers.js";
import { transcribe } from "../core/stt.js";
import { PERSONAS } from "../intent/persona.js";
import { spentToday } from "../core/budget.js";
import { draftReply } from "../intent/model.js";

/** Telegram HTML: escape, bold short label lines ("Outcomes:", "☀️ Mon 26 Oct"), keep links clickable. */
export function toHtml(text: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return text.split("\n").map((line) => {
    const e = esc(line);
    if ((/^[A-Za-z][^:]{1,40}:$/.test(line) || /^(?:☀️|🐢|🏁|💊|📅|✈️|📝|📈|💬|🎓)\s/.test(line)) && line.length < 60) return `<b>${e}</b>`;
    return e;
  }).join("\n");
}

const QUICK = new Keyboard().text("☼ Today").text("⚑ Hackathons").text("◎ Scout").row().text("☐ Lists").text("¤ Money").text("🐢 Pip").resized().persistent();
const QUICK_MAP: Record<string, string> = { "☼ Today": "digest", "⚑ Hackathons": "hackathons", "☐ Lists": "lists", "¤ Money": "spending week" };
const TZ_CHOICES: [string, string][] = [["Lagos", "Africa/Lagos"], ["Libreville", "Africa/Libreville"], ["Nairobi", "Africa/Nairobi"], ["London", "Europe/London"], ["New York", "America/New_York"], ["Dubai", "Asia/Dubai"]];
const PIP_QUIPS = ["Steady on. What's next?", "I keep the time so you don't have to.", "Nothing's on fire. Good day to plan something.", "Say the thing. I'll hold it.", "Slow is smooth. Smooth is fast."];

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
    for (const part of chunks(reply.text)) {
      await bot.api.sendMessage(Number(externalId), part, { reply_markup: kb(reply), link_preview_options: { is_disabled: true } });
    }
  });

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id) return;
    if (config.allowedUserIds.length && !config.allowedUserIds.includes(id)) {
      if (ctx.message) await ctx.reply("This bot is private.");
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

  bot.command("start", async (c) => {
    const u = await userOf(c);
    if (!u.prefs.onboarded) {
      const k = new InlineKeyboard();
      TZ_CHOICES.forEach(([l, z], i) => { k.text(l, `ob:tz:${z}`); if (i % 3 === 2) k.row(); });
      await c.reply(`🐢 I'm Pip. I keep your day: reminders, calendar, meds, classes, trips, lists — and your deadlines, launches and the people behind them. Nothing that moves money or reaches someone else happens without your yes.\n\nFirst: where are you? (This sets your clock.)`, { reply_markup: k });
      return;
    }
    await c.reply(`🐢 Welcome back${u.name ? `, ${u.name.split(" ")[0]}` : ""}. ${HELP}`, { reply_markup: QUICK });
  });
  bot.command("pip", async (c) => {
    const u = await userOf(c);
    const line = await draftReply(db, u, `Time: ${new Date().toISOString()}`, "You are Pip, a small tortoise mascot with spectacles who keeps the user's day. One short line (max 14 words) in the user's chosen voice. Output the line only.");
    await c.reply(`🐢 ${line ?? PIP_QUIPS[Math.floor(Math.random() * PIP_QUIPS.length)]}`);
  });
  bot.command("help", (c) => c.reply(FULL_HELP));
  bot.command("doctor", async (c) => {
    const p = providerName();
    const age = (t: number | null) => (t ? `${Math.round((Date.now() - t) / 1000)}s ago` : "never");
    await c.reply([`provider: ${p ?? "none (rules + loose NL only)"}`, `last model success: ${age(diagnostics.lastOkAt)}`, `last model error: ${age(diagnostics.lastErrorAt)}${diagnostics.lastError ? `\n  ${diagnostics.lastError}` : ""}`, `gemini key for scout: ${config.geminiKey ? "yes" : "no"}`, `stt: ${config.openaiKey ? "yes" : "no"} · email: ${config.smtpUrl ? "yes" : "no"} · public url: ${config.publicUrl || "unset"}`].join("\n"));
  });
  bot.command("persona", async (c) => {
    const u = await userOf(c);
    const k = new InlineKeyboard();
    Object.entries(PERSONAS).forEach(([key, v], i) => { k.text(v.label, `persona:${key}`); if (i % 2 === 1) k.row(); });
    const cur = (u.prefs.personaCustom as string) ? "custom" : (u.prefs.persona as string) ?? "plain";
    await c.reply(`Current voice: ${cur}. Pick one, or type "voice <describe it>" for your own.`, { reply_markup: k });
  });
  bot.command("usage", async (c) => {
    const u = await userOf(c);
    await c.reply(`Model spend last 24h: $${(await spentToday(db, u.id)).toFixed(3)} of $${config.dailyModelBudgetUsd}.`);
  });
  for (const [cmd, text] of [["pending", "pending"], ["undo", "undo"], ["memory", "/memory"], ["audit", "/audit"], ["link", "link"]] as const) {
    bot.command(cmd, async (c) => send(c, await handleMessage(db, await userOf(c), text, { channel: "telegram" })));
  }

  bot.on(["message:voice", "message:audio"], async (c) => {
    if (!config.openaiKey) return c.reply("Voice notes need OPENAI_API_KEY on the server (about $0.003/min). Type it for now.");
    const f = await c.getFile();
    const r = await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`);
    const text = await transcribe(Buffer.from(await r.arrayBuffer())).catch(() => null);
    if (!text) return c.reply("Couldn't make out that voice note.");
    await c.reply(`🎙 "${text}"`);
    await send(c, await handleMessage(db, await userOf(c), text, { channel: "telegram" }));
  });

  bot.on("message:document", async (c) => {
    const doc = c.message.document;
    if (!/\.ics$/i.test(doc.file_name ?? "")) return c.reply("I can import .ics calendar files. Other documents aren't supported yet.");
    if ((doc.file_size ?? 0) > 2_000_000) return c.reply("That file is too big (2 MB max).");
    const u = await userOf(c);
    const f = await c.getFile();
    const ics = await (await fetch(`https://api.telegram.org/file/bot${config.telegramToken}/${f.file_path}`)).text();
    await send(c, renderDecision(await propose({ db, user: u, now: new Date(), sourceMessage: `[ics ${doc.file_name}]` }, "calendar.import_ics", { ics })));
  });

  bot.on("message:text", async (c) => {
    const raw = c.message.text.trim();
    if (raw === "🐢 Pip") {
      const u = await userOf(c);
      const line = await draftReply(db, u, `Time: ${new Date().toISOString()}`, "You are Pip, a small tortoise mascot with spectacles who keeps the user's day. One short line (max 14 words) in the user's chosen voice. Output the line only.");
      return c.reply(`🐢 ${line ?? PIP_QUIPS[Math.floor(Math.random() * PIP_QUIPS.length)]}`);
    }
    if (raw === "◎ Scout") return c.reply("Which niche, and what for? e.g. <i>scout payments on base for partnerships</i> or <i>find ai agent startups to apply to</i>", { parse_mode: "HTML", reply_markup: { force_reply: true, input_field_placeholder: "scout <niche> for <objective>" } });
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
        return c.reply(`Clock set to ${value}. Now, how should I talk?`, { reply_markup: k });
      }
      if (step === "persona") {
        await propose({ db, user: u, now: new Date(), sourceMessage: "[onboarding persona]" }, "persona.set", { preset: value });
        await db.query(`UPDATE users SET prefs = prefs || '{"onboarded":true}'::jsonb WHERE id=$1`, [u.id]);
        return c.reply(`${PERSONAS[value]?.label ?? value} it is. That's all the setup. If you ever want hackathons and launches ranked to your taste, tell me what you're into (<i>interests: ai, payments, base, ethereum</i> — any chains, any themes) — no rush. Otherwise, just talk to me.`, { parse_mode: "HTML", reply_markup: QUICK });
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
    await bot.api.sendMessage(bc.user.id, (bc as any).is_enabled === false ? "Business connection paused." : "Business connection active. I'll draft replies for messages in the chats you chose; you send them.");
  });
  bot.on("business_message", async (c) => {
    const m = c.businessMessage;
    const row = await db.one<{ user_id: number; enabled: boolean }>(`SELECT user_id, enabled FROM business_connections WHERE connection_id=$1`, [m.business_connection_id]);
    if (!row || !row.enabled || !m.text) return;
    const owner = await db.one<any>(`SELECT * FROM users WHERE id=$1`, [row.user_id]);
    if (!owner || m.from?.id === owner.telegram_id) return; // owner's own outgoing message
    const draft = await draftReply(db, owner, `${m.from?.first_name ?? "Someone"}: ${m.text}`);
    if (!draft) return;
    await bot.api.sendMessage(owner.telegram_id, `💬 ${m.from?.first_name ?? "Someone"} wrote: "${m.text.slice(0, 300)}"\n\nDraft reply (copy and send yourself):\n${draft}`);
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
