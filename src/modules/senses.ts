/** Drawing, searching, speaking and emailing, as actions anyone can ask for in plain words. */
import { z } from "zod";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { allow, draw, refuseDrawing, search, VOICES, mediaAbilities } from "../core/media.js";
import { canEmail, sendEmail } from "../core/email.js";
import { emailLinkOffer, linkedEmail } from "./emaillink.js";

/** Pip, described for a picture model, so "draw yourself as a pirate" gets the real Pip. */
export const PIP_LOOKS = "Pip, a small friendly tortoise with round brass spectacles and a domed olive-green shell with brass edging, warm storybook illustration";
export function pipPrompt(p: string): string {
  return /\b(pip|yourself|your ?self)\b/i.test(p) ? p.replace(/\b(pip|yourself|your ?self)\b/gi, PIP_LOOKS) : p;
}

const imageDraw = defineAction({
  name: "image.draw",
  tier: 1,
  description: "Draw / generate / make a picture, image, illustration, wallpaper, sticker or logo idea from a description. 'prompt' is the full visual description in English, enriched with style and detail. Use when the user asks for an image; 'draw yourself' or 'Pip' means the tortoise mascot.",
  schema: z.object({ prompt: z.string().min(2), style: z.string().optional() }),
  async run(args, ctx) {
    const prompt = pipPrompt(args.style ? `${args.prompt}, ${args.style}` : args.prompt);
    const no = refuseDrawing(`${args.prompt} ${args.style ?? ""}`) ?? refuseDrawing(prompt);
    if (no) return { reply: no };
    if (/^\[(?:sms|imessage|email)\]/.test(ctx.sourceMessage ?? "")) return { reply: "I can only send pictures on Telegram or the website. Ask me there and I'll draw it." };
    if (!mediaAbilities().draw) return { reply: "Drawing isn't switched on for this circle yet. Whoever runs lifeline can turn it on with a free Cloudflare key." };
    if (!allow("image", ctx.user.id)) return { reply: "That's today's pictures used up. I can draw again tomorrow." };
    const pic = await draw(prompt);
    if (!pic) return { reply: "The picture didn't come back this time. Try again in a minute, or describe it a little differently." };
    return { reply: `Here's ${args.prompt.length > 80 ? "your picture" : args.prompt.replace(/^(?:a|an|the)\s+/i, (m) => m.toLowerCase())}. Say "again" for another take, or tell me what to change.`, image: { data: pic.data.toString("base64"), mime: pic.mime } };
  },
});

const webSearch = defineAction({
  name: "web.search",
  tier: 1,
  description: "Search the web for anything current or factual you'd otherwise guess: news, scores, prices of things, opening hours, who won, release dates, how to do something, reviews. 'query' is a clear search question.",
  schema: z.object({ query: z.string().min(2) }),
  async run(args, ctx) {
    if (!mediaAbilities().search) return { reply: "Looking things up on the web isn't switched on for this circle yet. Whoever runs lifeline can turn it on." };
    if (!allow("search", ctx.user.id)) return { reply: "That's a lot of searching for one day; I'm out of searches until tomorrow." };
    const f = await search(args.query, ctx.user.tz);
    if (!f) return { reply: "The search didn't come back. Try again in a minute?" };
    const src = f.sources.length ? `\n\nSources: ${f.sources.map((s) => `[${(s.title ?? new URL(s.uri).hostname).replace(/[[\]]/g, "")}](${s.uri})`).join(", ")}` : "";
    return { reply: f.answer + src };
  },
});

const speechSettings = defineAction({
  name: "speech.settings",
  tier: 1,
  description: "Voice replies: 'replies' is off (text only), mirror (talk back when they send a voice note; the default) or always. 'voice' picks how it sounds: warm, upbeat, calm, deep, lively, gentle, bright, easy.",
  schema: z.object({ replies: z.enum(["off", "mirror", "always"]).optional(), voice: z.string().optional() }),
  async run(args, ctx) {
    const patch: Record<string, unknown> = {};
    const bits: string[] = [];
    if (args.replies) {
      patch.voiceReplies = args.replies;
      bits.push(args.replies === "off" ? "I'll reply in text only" : args.replies === "always" ? "I'll send a voice note with every reply" : "I'll talk back whenever you send me a voice note");
    }
    if (args.voice) {
      const key = args.voice.toLowerCase().trim();
      const known = VOICES[key] ? key : Object.entries(VOICES).find(([, v]) => v.toLowerCase() === key)?.[0];
      if (!known) return { reply: `I have these voices: ${Object.keys(VOICES).join(", ")}. Which one?` };
      patch.ttsVoice = known;
      bits.push(`I'll sound ${known}`);
    }
    if (!bits.length) return { reply: `Say "voice replies always", "only when I send voice notes" or "text only", and pick a voice: ${Object.keys(VOICES).join(", ")}.` };
    await ctx.db.query(`UPDATE users SET prefs = prefs || $2::jsonb WHERE id=$1`, [ctx.user.id, JSON.stringify(patch)]);
    const said = bits.join(", and ");
    return { reply: `${said.charAt(0).toUpperCase()}${said.slice(1)}.`, speak: args.voice ? "This is how I sound now." : undefined };
  },
});

const speechSay = defineAction({
  name: "speech.say",
  tier: 1,
  description: "Read something out loud as a voice note: 'text' to read, or leave it empty to read the last thing you said.",
  schema: z.object({ text: z.string().optional() }),
  async run(args, ctx) {
    if (!mediaAbilities().speak) return { reply: "My voice isn't switched on for this circle yet. Whoever runs lifeline can turn it on." };
    let words = args.text;
    if (!words) {
      const last = await ctx.db.one<{ content: string }>(`SELECT content FROM messages WHERE user_id=$1 AND role='assistant' ORDER BY id DESC LIMIT 1`, [ctx.user.id]);
      words = last?.content;
    }
    if (!words) return { reply: "There's nothing for me to read yet." };
    return { reply: "Here it is, out loud.", speak: words };
  },
});

/** Only an address that's been proven: a linked email identity, or one confirmed with a code. */
async function addressOf(ctx: { db: any; user: { id: number; prefs: Record<string, unknown> } }): Promise<string | null> {
  const r = await ctx.db.one(`SELECT external_id FROM identities WHERE user_id=$1 AND channel='email' LIMIT 1`, [ctx.user.id]);
  return r?.external_id ?? (typeof ctx.user.prefs.emailVerified === "string" ? ctx.user.prefs.emailVerified : null);
}
/** "my shopping list", "my brief", "my notes" mean the real thing, not those words. */
async function resolveBody(body: string, ctx: any): Promise<{ subject: string; body: string }> {
  const b = body.trim().replace(/[.!]+$/, "");
  const list = /^(?:my |the )?(?:(\w+) )?list$/i.exec(b) ?? /^(?:my |the )?(shopping|todo|to-do)(?: list)?$/i.exec(b);
  if (list) {
    const name = (list[1] ?? "todo").toLowerCase().replace("to-do", "todo");
    const rows = await ctx.db.query(`SELECT text FROM todos WHERE user_id=$1 AND list=$2 AND NOT done ORDER BY id`, [ctx.user.id, name]);
    return { subject: `Your ${name} list`, body: rows.length ? rows.map((r: any) => `- ${r.text}`).join("\n") : `Your ${name} list is empty.` };
  }
  if (/^(?:my |the |today'?s )?(?:brief|day|digest|morning brief)$/i.test(b)) {
    const { buildDigest } = await import("./digest.js");
    return { subject: "Your day", body: await buildDigest(ctx.db, ctx.user, ctx.now) };
  }
  if (/^(?:my |the )?notes$/i.test(b)) {
    const rows = await ctx.db.query(`SELECT text FROM notes WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [ctx.user.id]);
    return { subject: "Your notes", body: rows.length ? rows.map((r: any) => `- ${r.text}`).join("\n") : "No notes yet." };
  }
  return { subject: "From lifeline", body };
}

const emailMe = defineAction({
  name: "email.me",
  tier: 1,
  description: "Email something to the user themselves: a list, a note, a summary, their brief, a draft. 'body' is the full text to send; 'subject' a short subject.",
  schema: z.object({ subject: z.string().optional(), body: z.string().min(1) }),
  async gate(_args, ctx) {
    if (!canEmail()) return { reply: "Sending email isn't switched on for this circle yet. I can put it in a note, or show it here for you to copy." };
    if (await linkedEmail(ctx)) return null;
    return emailLinkOffer(ctx, "I'll email you as soon as your email is linked, so I know where \"me\" is.");
  },
  async run(args, ctx) {
    const to = await addressOf(ctx);
    if (!to) return { reply: "Link your email first: say \"link my email\"." };
    const { subject, body } = await resolveBody(args.body, ctx);
    const ok = await sendEmail(to, args.subject ?? subject, body);
    return { reply: ok ? `${subject === "From lifeline" ? "Sent" : `${subject}, sent`} to ${to}.` : "The email didn't go out. Try again in a minute?" };
  },
});

const emailSend = defineAction({
  name: "email.send",
  tier: 2,
  description: "Send an email to someone else on the user's behalf. 'to' is their address, 'subject' and 'body' the full email, signed with the user's name. Always confirmed first.",
  schema: z.object({ to: z.string().email(), subject: z.string().min(1), body: z.string().min(1) }),
  echo: (a) => `This emails ${a.to}:\n\nSubject: ${a.subject}\n\n${a.body}`,
  /* No yes is asked for until it can actually go: email switched on, and the person's own address linked so replies reach them. */
  async gate(args, ctx) {
    const draft = `\n\nHere's the draft meanwhile, to send yourself if you'd rather:\n\`\`\`\nTo: ${args.to}\nSubject: ${args.subject}\n\n${args.body}\n\`\`\``;
    if (!canEmail()) return { reply: `Sending email isn't switched on for this circle yet.${draft}` };
    if (await linkedEmail(ctx)) return null;
    const offer = await emailLinkOffer(ctx, "Link your email first, so I can send this from lifeline with replies coming back to you. It takes one tap.");
    return { ...offer, reply: `${offer.reply}${draft}` };
  },
  async run(args, ctx) {
    const from = await addressOf(ctx);
    const ok = await sendEmail(args.to, args.subject, args.body, { replyTo: from ?? undefined });
    return { reply: ok ? `Sent to ${args.to}.${from ? " Replies come to your own inbox." : ""}` : "The email didn't go out. Nothing was sent; try again in a minute?" };
  },
});

register(imageDraw, webSearch, speechSettings, speechSay, emailMe, emailSend);
