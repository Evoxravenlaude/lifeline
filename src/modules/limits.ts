/**
 * Knowing its limits, and selling what it can do instead. Some asks are out of reach for any assistant that lives in
 * messages (your inbox, your phone, your bank, your other apps). lifeline says so in one line, then offers the
 * nearest real thing with buttons. No beating around the bush, no pretending.
 *
 * And one thing most assistants can't do well: "find my personal data online" runs a real search from several angles
 * (privacy.scan), shows where you appear, and hands you removal requests ready to send. It can't delete anything
 * itself; sites remove things when you ask, so it makes asking easy.
 */
import { z } from "zod";
import { defineAction, type Ctx } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { addCapability, addExamples, addRules } from "../core/plugins.js";
import { allow, mediaAbilities, search } from "../core/media.js";
import { linkedEmail } from "./emaillink.js";

type Reach = "inbox" | "call" | "social" | "order" | "money" | "apps" | "alarm" | "delete_online";

const REACH: Record<Reach, { cant: string; can: string[]; buttons: { label: string; data: string }[] }> = {
  inbox: {
    cant: "I can't open your inbox, so I can't delete, archive or sort your emails myself. I only see what you send or forward me.",
    can: [
      "**Gmail, in under a minute:** search `unsubscribe`, tick the select-all box, then \"Select all conversations\", then Archive (or the bin to delete). To keep it that way: search `unsubscribe`, open the search options, choose Create filter, then Skip the Inbox (Archive it).",
      "**Outlook:** search `unsubscribe`, select all, then Archive or Delete. For the future: Settings, Mail, Rules, Add a rule: message body includes \"unsubscribe\", move to Archive.",
      "**Apple Mail:** search `unsubscribe`, select all (Cmd+A on a Mac), then Archive.",
      "Archiving is the safer choice: nothing is lost, and receipts that say \"unsubscribe\" stay findable.",
    ],
    buttons: [{ label: "Remind me Sunday", data: "say:remind me on Sunday at 10am to clean out my inbox" }, { label: "Link my email", data: "say:link my email" }],
  },
  call: {
    cant: "I can't make phone calls.",
    can: ["I can write what you'd say as a text or WhatsApp message to send yourself, remind you to call at a good time, or set them up as a safety contact so I can reach them if you don't check in."],
    buttons: [{ label: "Remind me to call", data: "say:remind me to make that call in an hour" }],
  },
  social: {
    cant: "I can't post or send messages on your social accounts.",
    can: ["I can draft the post or reply for you to paste, in your voice, and remind you when to post it."],
    buttons: [{ label: "Draft it", data: "say:draft the post for me" }],
  },
  order: {
    cant: "I can't place orders or book things on other apps.",
    can: ["I can compare options with sources, keep a shopping list, plan the trip or the order, put the booking date in your calendar, and remind you. Bills I can pay through Flutterwave, after your yes."],
    buttons: [{ label: "Compare options", data: "say:research the best options for this" }, { label: "Add to a list", data: "p:ask:list" }],
  },
  money: {
    cant: "I can't send money to people or touch your bank account.",
    can: ["I can keep track of who you owe and who owes you, draft a friendly payment reminder, split a bill in a group, and pay utility bills through Flutterwave after your yes."],
    buttons: [{ label: "Who owes me", data: "say:who owes me" }, { label: "Log an IOU", data: "say:help me log an IOU" }],
  },
  apps: {
    cant: "I can't see into WhatsApp, Instagram, your phone or your other apps.",
    can: ["Forward me the message, or send a screenshot, and I'll read it, pull out what matters, check it for scams, or draft your reply."],
    buttons: [],
  },
  alarm: {
    cant: "I can't set an alarm on your phone.",
    can: ["I can ring you at that time instead: a reminder on Telegram, and as a notification if you've installed the app."],
    buttons: [{ label: "Set a reminder", data: "p:ask:rem" }],
  },
  delete_online: {
    cant: "I can't delete things from other websites myself; only the site can, when you ask it to.",
    can: ["What I can do: search properly for where your details show up, from several angles, read the pages, and hand you removal requests ready to send, plus the opt-out pages for people-search sites."],
    buttons: [{ label: "Find my data online", data: "say:find my personal data online" }],
  },
};

const reach = defineAction({
  name: "limits.reach",
  tier: 1,
  description: "The person asks for something lifeline can't do from messages (clean or delete their emails, make a call, post on social media, order or book on another app, send money to a person, read their WhatsApp, set a phone alarm). Say so plainly and offer the nearest thing it can do.",
  schema: z.object({ kind: z.enum(["inbox", "call", "social", "order", "money", "apps", "alarm", "delete_online"]) }),
  async run(args) {
    const r = REACH[args.kind];
    return { reply: [r.cant, "", ...r.can].join("\n"), buttons: r.buttons.length ? r.buttons : undefined };
  },
});

/* ---------------- finding your data online ---------------- */

interface Hit { title: string; url: string; why: string }
const PEOPLE_SEARCH = /spokeo|whitepages|beenverified|truepeoplesearch|fastpeoplesearch|radaris|mylife|intelius|peoplefinders|instantcheckmate|thatsthem|192\.com|zabasearch|nuwber|pipl|clustrmaps|rocketreach|zoominfo|apollo\.io|signalhire|contactout|lusha/i;
const PASTE = /pastebin|ghostbin|justpaste|controlc|throwbin|paste\.ee/i;
const kindOf = (url: string): "people-search" | "paste" | "social" | "other" => PEOPLE_SEARCH.test(url) ? "people-search" : PASTE.test(url) ? "paste" : /linkedin|facebook|instagram|x\.com|twitter|tiktok|github|medium|youtube|threads/i.test(url) ? "social" : "other";
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

/** A removal request someone can send to a site, citing the law that fits where they live. */
export function removalRequest(name: string, site: string, country?: string): string {
  const law = country === "NG" ? "the Nigeria Data Protection Act 2023 (section 34, right to erasure)"
    : ["GB", "UK"].includes(country ?? "") ? "UK GDPR (Article 17, right to erasure)"
    : ["US"].includes(country ?? "") ? "applicable US state privacy law (for example the CCPA, where it applies)"
    : "the GDPR (Article 17, right to erasure) and any local data protection law that applies";
  return [
    `Subject: Request to remove my personal data`,
    ``,
    `Hello,`,
    ``,
    `I'm writing to ask you to remove my personal information from ${site}, including any profile, listing or page about me, and to stop processing it. My name is ${name}.`,
    ``,
    `I'm making this request under ${law}. Please confirm when it's done, within one month.`,
    ``,
    `Thank you,`,
    name,
  ].join("\n");
}

const scan = defineAction({
  name: "privacy.scan",
  tier: 1,
  description: "Search the web properly for where the person's OWN personal details appear (their name, email, phone, handles), read the results, and give removal steps and request drafts. Only for the person themselves, never about someone else.",
  schema: z.object({ name: z.string().max(80).optional(), extras: z.array(z.string().max(80)).max(5).optional(), city: z.string().max(60).optional() }),
  async run(args, ctx) {
    if (!mediaAbilities().search) return { reply: `${REACH.delete_online.cant} Searching the web isn't switched on for this circle yet, so here's the do-it-yourself version: search your name in quotes with your city, your email in quotes and your phone number; use Google's "Results about you" to ask for removals from Google search; and for people-search sites, look for an "opt out" link at the bottom of the page.` };
    if (!allow("search", ctx.user.id)) return { reply: "That's a lot of searching for one day; I'm out of searches until tomorrow." };
    const name = (args.name ?? ctx.user.name ?? "").trim();
    if (!name) return { reply: "Whose details am I looking for? Say \"find my personal data online, my name is ...\". Only your own, please." };
    const email = await linkedEmail(ctx);
    const handle = typeof ctx.user.prefs.username === "string" ? `@${ctx.user.prefs.username}` : null;
    const city = args.city ?? (typeof ctx.user.prefs.city === "string" ? ctx.user.prefs.city : undefined);
    const extras = [...(args.extras ?? []), ...(email ? [email] : []), ...(handle ? [handle] : [])].filter((x, i, a) => a.indexOf(x) === i).slice(0, 4);
    const say = async (s: string) => { try { await ctx.progress?.(s); } catch { /* nicety */ } };
    try { await ctx.note?.(`On it. I'll look for where "${name}" shows up${extras.length ? `, and ${extras.join(", ")}` : ""}, from a few angles, and read what comes back. I can't delete anything myself, but I'll make asking easy.`); } catch { /* nicety */ }
    const queries = [
      `"${name}"${city ? ` ${city}` : ""} personal information address phone`,
      `"${name}" people search profile`,
      ...extras.map((x) => `"${x}"`),
      `"${name}" data leak OR paste OR exposed`,
    ].slice(0, 5);
    const hits: Hit[] = [];
    for (const q of queries) {
      if (!allow("search", ctx.user.id)) break;
      await say(`Searching: ${q.length > 56 ? `${q.slice(0, 53)}…` : q}`);
      const f = await search(`Find web pages that mention or list this person or identifier, including people-search and data-broker sites: ${q}. List pages only where it actually appears.`, ctx.user.tz).catch(() => null);
      for (const s of f?.sources ?? []) if (s.uri && !hits.some((h) => h.url === s.uri)) hits.push({ title: s.title ?? host(s.uri), url: s.uri, why: q });
    }
    await say("Sorting what I found");
    const groups = { "people-search": [] as Hit[], paste: [] as Hit[], social: [] as Hit[], other: [] as Hit[] };
    for (const h of hits.slice(0, 24)) groups[kindOf(h.url)].push(h);
    const line = (h: Hit) => `- [${h.title.replace(/[[\]]/g, "").slice(0, 60)}](${h.url})`;
    const country = typeof ctx.user.prefs.country === "string" ? (ctx.user.prefs.country as string) : undefined;
    const firstBroker = groups["people-search"][0];
    const out = [
      hits.length ? `I searched ${queries.length} ways and found ${hits.length} page${hits.length === 1 ? "" : "s"} worth a look. Searches miss things and find namesakes, so check each one is really you.` : `I searched ${queries.length} ways and found nothing that clearly lists your details. That's good news, though searches can miss pages, so it's worth checking again every few months.`,
      ...(groups["people-search"].length ? ["", "**People-search and data-broker sites** (each has an opt-out page, usually linked at the bottom):", ...groups["people-search"].map(line)] : []),
      ...(groups.paste.length ? ["", "**Paste sites** (report the paste to the site; if a password was in it, change that password now):", ...groups.paste.map(line)] : []),
      ...(groups.social.length ? ["", "**Social profiles** (yours to tighten in privacy settings, or ask the owner to take down):", ...groups.social.map(line)] : []),
      ...(groups.other.length ? ["", "**Other pages:**", ...groups.other.slice(0, 8).map(line)] : []),
      "",
      "**What to do next**",
      "- Google search: use \"Results about you\" in the Google app to ask Google to drop results with your phone, address or email.",
      "- Each site: use its opt-out or contact page, or send the request below.",
      "- Breaches: check your email on haveibeenpwned.com, and change any reused password.",
      "",
      `A removal request${firstBroker ? ` for ${host(firstBroker.url)}` : ""}, ready to send:`,
      "```",
      removalRequest(name, firstBroker ? host(firstBroker.url) : "your site", country),
      "```",
    ];
    return { reply: out.join("\n"), rich: true, buttons: [{ label: "Check again in 3 months", data: "say:remind me in 3 months to check my personal data online" }] };
  },
});

register(reach, scan);

addRules(
  // Inbox clean-up and anything that needs the mailbox itself.
  [/^(?:please\s+)?(?:can you\s+)?(?:archive|clean(?: up| out)?|clear|sort|organi[sz]e|tidy(?: up)?|go through|read|check)\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?(?:e-?mails?|inbox|mails?|gmail|outlook)\b.*$/i, () => ({ action: "limits.reach", args: { kind: "inbox" } })],
  [/^(?:please\s+)?(?:can you\s+)?(?:delete|remove|trash|bin)\s+(?:all\s+)?(?:of\s+)?(?:my\s+|the\s+)?(?:e-?mails|mails|inbox|messages in my inbox|spam|newsletters)\b.*$/i, () => ({ action: "limits.reach", args: { kind: "inbox" } })],
  [/^(?:please\s+)?(?:can you\s+)?(?:unsubscribe me from|delete (?:all )?(?:the )?(?:e-?mails?|mails?) (?:with|containing|that say)|archive (?:all )?(?:the )?(?:e-?mails?|mails?) (?:with|containing))\b.*$/i, () => ({ action: "limits.reach", args: { kind: "inbox" } })],
  // Only a clear ask to place the call ("can you call...", "...for me"): "call mum every Sunday" is a keep-in-touch rhythm.
  [/^(?:(?:please|can you|could you)\s+)+(?:call|phone|ring|dial)\s+(?!me\b)[\w' ]{2,40}?(?:\s+for me)?[.!?]*$|^(?:call|phone|ring|dial)\s+(?!me\b)[\w' ]{2,40}?\s+for me[.!?]*$/i,
    (m) => (/\b(?:every|each|on|at|tomorrow|today|tonight|weekly|daily|later|in \d|if we haven'?t)\b/i.test(m[0]) ? null : { action: "limits.reach", args: { kind: "call" } })],
  [/^(?:please\s+)?(?:can you\s+)?(?:post|tweet|share)\s+(?:this|it|that|something)?\s*(?:on|to)\s+(?:my\s+)?(?:twitter|x|instagram|ig|facebook|linkedin|tiktok|threads|status)\b.*$/i, () => ({ action: "limits.reach", args: { kind: "social" } })],
  [/^(?:please\s+)?(?:can you\s+)?(?:order|book)\s+(?:me\s+)?(?:a\s+|an\s+|some\s+)?(?:food|pizza|uber|bolt|taxi|ride|flight|hotel|table|ticket|tickets|groceries)\b.*$/i, () => ({ action: "limits.reach", args: { kind: "order" } })],
  [/^(?:please\s+)?(?:can you\s+)?(?:send|transfer|wire)\s+(?:₦|\$|£|€)?\s*\d[\d,.]*\s*(?:k|naira|dollars?|pounds?|euros?|cedis?)?\s+to\s+(?!(?:my\s+)?(?:electricity|bill|bills|dstv|gotv|startimes|showmax|ekedc|ikedc|aedc|phed|eedc|ibedc|kedco|jed|bedc|mtn|airtel|glo|9mobile|data|airtime|meter|prepaid)\b)[\w@' ]{2,40}[.!?]*$/i, () => ({ action: "limits.reach", args: { kind: "money" } })],
  [/^(?:please\s+)?(?:can you\s+)?(?:read|check|open|see)\s+(?:my\s+)?(?:whatsapp|instagram|ig|dms?|texts?|sms|messages on)\b.*$/i, () => ({ action: "limits.reach", args: { kind: "apps" } })],
  [/^(?:please\s+)?(?:can you\s+)?set (?:an?\s+)?alarm\b.*$/i, () => ({ action: "limits.reach", args: { kind: "alarm" } })],
  // Personal data online: the agentic search.
  [/^(?:please\s+)?(?:can you\s+)?(?:find|search for|look for|check|scan for|remove|delete|wipe|erase|take down|get rid of|clean)\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?(?:personal\s+)?(?:data|details|info|information|stuff)\s+(?:online|on the internet|from the internet|from the web|on the web|off the internet)(?:,?\s+my name is\s+(.{2,60}))?[.!?]*$/i, (m) => ({ action: "privacy.scan", args: m[1] ? { name: m[1].trim() } : {} })],
  [/^(?:what(?:'s| is) (?:out there|online) about me|(?:google|search) me|am i (?:on|in) (?:any )?(?:data ?brokers?|people.?search sites?))\??$/i, () => ({ action: "privacy.scan", args: {} })],
);
addExamples("limits.reach", ["delete all my emails containing unsubscribe", "clean up my inbox", "call my landlord for me", "post this on instagram", "order food for me", "send 5000 to Tunde", "read my whatsapp", "set an alarm for 6am"]);
addExamples("privacy.scan", ["find my personal data online", "remove my personal data from the internet", "what's out there about me?"]);
addCapability({
  key: "privacy-scan", name: "Your data online",
  cues: ["personal data online", "remove my data", "data broker", "people search", "doxx", "exposed", "what's out there about me"],
  what: "Ask me to find your personal data online and I search properly, from several angles, read the results, show where you appear (people-search sites, paste sites, profiles), and hand you removal requests ready to send. I can't delete anything from other sites myself; I make asking easy.",
  say: ["find my personal data online", "what's out there about me?"],
  then: "Only for your own details, never someone else's.",
}, "Safety");
