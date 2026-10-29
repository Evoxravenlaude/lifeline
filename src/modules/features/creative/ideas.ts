/**
 * Ideas and sparks: a private idea inbox ("idea: a zine about Lagos danfo drivers"), a spark when
 * someone's stuck (the model when there is one, a built-in set otherwise), and an opt-in daily
 * creative prompt in the morning brief ("stop the prompts" ends it).
 * Portfolio shelf: the person's links (Behance, Instagram, Foundation, objkt, Bandcamp...) and a
 * short bio line to copy.
 */
import { z } from "zod";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addBriefSection, addCapability, addCues, addExamples, addRules, addSchema } from "../../../core/plugins.js";
import { cap, clean, plural, refuseSecret, setPrefs, think, todayOf } from "./shared.js";

addSchema(`CREATE TABLE IF NOT EXISTS crt_ideas (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), text TEXT NOT NULL, tag TEXT, created_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS crt_links (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), label TEXT NOT NULL, url TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now(), UNIQUE (user_id, url))`);

/* =====================================================================
 * 8. Ideas, sparks and the daily prompt
 * ===================================================================== */

/** Ideas are private: a key or seed phrase is still refused, but ordinary long sentences are not mistaken for one. */
function ideaSecret(text: string): string | null {
  return /\b(?:seed|recovery|mnemonic|private key|password)\b|\b(?:0x)?[0-9a-fA-F]{64}\b/i.test(text) ? refuseSecret(text) : null;
}

const ideaAdd = defineAction({
  name: "idea.add",
  tier: 1,
  description: "Save a creative idea privately in the person's idea inbox (never shown in the brief or anywhere shared). `tag` is optional, like 'song' or 'zine'.",
  schema: z.object({ text: z.string().min(2).max(1000), tag: z.string().max(30).optional() }),
  async run(a, ctx) {
    const bad = ideaSecret(a.text);
    if (bad) throw new Error(bad);
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO crt_ideas (user_id, text, tag) VALUES ($1,$2,$3) RETURNING id`, [ctx.user.id, a.text.trim(), a.tag ? clean(a.tag).toLowerCase() : null]);
    const n = Number((await ctx.db.one<{ n: string }>(`SELECT count(*)::text AS n FROM crt_ideas WHERE user_id=$1`, [ctx.user.id]))!.n);
    return { reply: `Saved, just for you. That's ${plural(n, "idea")} in your inbox; say "my ideas" to see them.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM crt_ideas WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Idea taken out."; },
});

const ideaList = defineAction({
  name: "idea.list",
  tier: 1,
  description: "Show the person's saved creative ideas, newest first. `tag` narrows to one kind (song, zine...).",
  schema: z.object({ tag: z.string().max(30).optional() }),
  async run(a, ctx) {
    const rows = await ctx.db.query<{ text: string; tag: string | null; created_at: string }>(`SELECT text, tag, created_at FROM crt_ideas WHERE user_id=$1 ${a.tag ? "AND tag ILIKE $2" : ""} ORDER BY id DESC LIMIT 10`, a.tag ? [ctx.user.id, `%${clean(a.tag)}%`] : [ctx.user.id]);
    if (!rows.length) return { reply: "No ideas saved yet. Say \"idea: a zine about Lagos danfo drivers\" whenever one turns up, and it stays here, private." };
    const n = Number((await ctx.db.one<{ n: string }>(`SELECT count(*)::text AS n FROM crt_ideas WHERE user_id=$1`, [ctx.user.id]))!.n);
    return { reply: [`${n > rows.length ? `Your ${rows.length} newest of ${n} ideas:` : `${plural(n, "idea")}:`}`, ...rows.map((r) => `- ${r.text}${r.tag ? ` (${r.tag})` : ""}`)].join("\n") };
  },
});

const ideaForget = defineAction({
  name: "idea.forget",
  tier: 1,
  description: "Delete all of the person's saved ideas, for good.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ id: number }>(`DELETE FROM crt_ideas WHERE user_id=$1 RETURNING id`, [ctx.user.id]);
    return { reply: rows.length ? `Deleted ${plural(rows.length, "idea")}. They're gone for good.` : "There were no ideas to delete." };
  },
});

export const SPARKS = [
  "Draw or describe the busiest street corner you passed today, from the point of view of someone selling something there.",
  "Make a piece using only three colours you can see from where you're sitting.",
  "Take a family recipe and turn its steps into a short poem or a four-panel comic.",
  "Pick an object in your home that's older than you and give it a voice for one page.",
  "Sketch or photograph ten hands doing ten different jobs.",
  "Rework something you made a year ago in a style you've never tried.",
  "Make a tiny map of a place that now only exists in your memory.",
  "Make the soundtrack of your commute: what does each stop sound like?",
  "Design a stamp for your neighbourhood. What would it celebrate?",
  "Take one sentence from the last voice note you got and build something around it.",
  "Draw a self-portrait using only shapes, no outlines.",
  "Make a piece about waiting: a bus stop, a queue, a loading screen.",
  "Pick a proverb from your language and illustrate it literally.",
  "Set a timer for 20 minutes, make something, and stop when it rings, finished or not.",
  "Describe today's weather as if it were a guest arriving at a party.",
  "Make a cover for an album that doesn't exist, named after the street you grew up on.",
  "Collect five textures from outside and turn them into a pattern.",
  "Write a letter from a market trader in Lagos to one in Seoul.",
  "Make a piece using only the colours of a fruit in season where you are.",
  "Draw the same cup five ways: quick, slow, huge, tiny, upside down.",
  "Write a two-line chorus about something small that annoyed you this week.",
  "Turn a receipt into a story: who bought these things, and why?",
  "Make a portrait of someone using only the things in their bag.",
  "Draw a building in your city as if it were alive and in a bad mood.",
  "Record 30 seconds of sound outside and make something that matches it.",
  "Make a piece about a festival from your childhood without showing a single person.",
  "Retell a folk tale from where you're from, set in the year 2080.",
  "Make one thing in a medium you're bad at, and enjoy being bad at it.",
  "Design a flag for your group of friends.",
  "Make a piece about the first light of the morning where you live.",
];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
export const sparkFor = (seed: string) => SPARKS[hash(seed) % SPARKS.length];

const sparkGet = defineAction({
  name: "spark.get",
  tier: 1,
  description: "Give the person one fresh creative prompt to get going (a spark), optionally for a medium like drawing, writing, music or photography.",
  schema: z.object({ medium: z.string().max(40).optional() }),
  async run(a, ctx) {
    const m = a.medium ? clean(a.medium) : "";
    const made = await think(ctx.db, ctx.user, `Give one fresh, specific creative prompt${m ? ` for ${m}` : ""}, one or two sentences, doable in under an hour, rooted in ordinary life somewhere in the world. Only the prompt.`, 120);
    const spark = made && made.length < 400 ? made : sparkFor(`${ctx.user.id}:${ctx.now.getTime()}`);
    const tail = ctx.user.prefs.crtPrompts === true ? "" : " Want one every morning? Say \"a creative prompt every morning\".";
    return { reply: `${spark}${tail}` };
  },
});

const sparkDaily = defineAction({
  name: "spark.daily",
  tier: 1,
  description: "Turn the daily creative prompt in the morning brief on or off.",
  schema: z.object({ on: z.boolean() }),
  async run(a, ctx) {
    const prev = ctx.user.prefs.crtPrompts === true;
    await setPrefs(ctx.db, ctx.user, { crtPrompts: a.on });
    return a.on
      ? { reply: "A creative prompt in your brief every morning, starting tomorrow. Say \"stop the prompts\" whenever you've had enough.", undo: { payload: { prev } } }
      : { reply: "No more daily prompts. Say \"give me a spark\" any time you want one.", undo: { payload: { prev } } };
  },
  async undo(p, ctx) { await setPrefs(ctx.db, ctx.user, { crtPrompts: p.prev }); return "Back how it was."; },
});

addBriefSection({
  key: "creative_prompt", order: 85,
  async lines(_db, user, now) {
    if (user.prefs?.crtPrompts !== true) return [];
    return [`Creative prompt: ${sparkFor(`${user.id}:${todayOf(user, now)}`)} (Say "stop the prompts" to end these.)`];
  },
});

/* =====================================================================
 * 11. Portfolio shelf
 * ===================================================================== */

const HOSTS: [RegExp, string][] = [
  [/behance\.net$/, "Behance"], [/instagram\.com$/, "Instagram"], [/foundation\.app$/, "Foundation"], [/objkt\.com$/, "objkt"], [/bandcamp\.com$/, "Bandcamp"],
  [/soundcloud\.com$/, "SoundCloud"], [/spotify\.com$/, "Spotify"], [/music\.apple\.com$/, "Apple Music"], [/(?:youtube\.com|youtu\.be)$/, "YouTube"], [/tiktok\.com$/, "TikTok"],
  [/(?:^|\.)(?:x|twitter)\.com$/, "X"], [/dribbble\.com$/, "Dribbble"], [/artstation\.com$/, "ArtStation"], [/linktr\.ee$/, "Linktree"], [/zora\.co$/, "Zora"],
  [/opensea\.io$/, "OpenSea"], [/magiceden\.(?:io|us)$/, "Magic Eden"], [/substack\.com$/, "Substack"], [/etsy\.com$/, "Etsy"], [/vimeo\.com$/, "Vimeo"],
  [/audiomack\.com$/, "Audiomack"], [/boomplay\.com$/, "Boomplay"], [/deviantart\.com$/, "DeviantArt"], [/cara\.app$/, "Cara"], [/github\.com$/, "GitHub"],
  [/pinterest\.\w+$/, "Pinterest"], [/patreon\.com$/, "Patreon"], [/ko-fi\.com$/, "Ko-fi"], [/medium\.com$/, "Medium"], [/threads\.net$/, "Threads"], [/superrare\.com$/, "SuperRare"],
];
const HANDLE_SITES: Record<string, string> = { instagram: "https://instagram.com/", insta: "https://instagram.com/", ig: "https://instagram.com/", x: "https://x.com/", twitter: "https://x.com/", tiktok: "https://tiktok.com/@", threads: "https://threads.net/@", behance: "https://behance.net/", dribbble: "https://dribbble.com/", artstation: "https://artstation.com/", soundcloud: "https://soundcloud.com/", github: "https://github.com/" };
const LABELS: Record<string, string> = { portfolio: "Portfolio", website: "Website", site: "Website", shop: "Shop", store: "Shop", insta: "Instagram", ig: "Instagram", twitter: "X", x: "X", kofi: "Ko-fi", "ko-fi": "Ko-fi", "apple music": "Apple Music", linktree: "Linktree" };
export function labelFor(url: string, said?: string): string {
  const s = (said ?? "").toLowerCase().trim();
  if (s && LABELS[s]) return LABELS[s];
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./, ""); } catch { /* not a link */ }
  const known = HOSTS.find(([re]) => re.test(host))?.[1];
  if (s && !known) return cap(s);
  return known ?? (s ? cap(s) : host || "Link");
}
/** "behance.net/ada" → "https://behance.net/ada"; "@ada" for Instagram → "https://instagram.com/ada". Null when it isn't a link. */
export function linkOf(raw: string, site?: string): string | null {
  const t = raw.trim().replace(/[.,;]+$/, "");
  const h = /^@([\w.]{1,40})$/.exec(t);
  if (h) { const base = HANDLE_SITES[(site ?? "").toLowerCase()]; return base ? `${base}${h[1]}` : null; }
  const u = /^https?:\/\//i.test(t) ? t : /^(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/i.test(t) ? `https://${t}` : null;
  if (!u) return null;
  try { const p = new URL(u); return p.protocol === "https:" || p.protocol === "http:" ? p.toString().replace(/\/$/, "") : null; } catch { return null; }
}
const bare = (u: string) => u.replace(/^https?:\/\/(?:www\.)?/i, "");

const linksAdd = defineAction({
  name: "links.add",
  tier: 1,
  description: "Keep one of the person's own portfolio or profile links (portfolio site, Behance, Instagram, Foundation, objkt, Bandcamp, SoundCloud...). `label` is what it is, if they said.",
  schema: z.object({ url: z.string().min(3).max(300), label: z.string().max(30).optional() }),
  async run(a, ctx) {
    const url = linkOf(a.url, a.label);
    if (!url) throw new Error(/^@/.test(a.url.trim()) ? `Which site is ${a.url.trim()} on? Say it like "my instagram is ${a.url.trim()}".` : "That doesn't look like a link. Send it like https://behance.net/yourname.");
    const label = labelFor(url, a.label);
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO crt_links (user_id, label, url) VALUES ($1,$2,$3) ON CONFLICT (user_id, url) DO UPDATE SET label=EXCLUDED.label RETURNING id`, [ctx.user.id, label, url]);
    return { reply: `${label}: \`${bare(url)}\`, on your shelf. Say "my links" for all of them and a bio line to copy.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) { await ctx.db.query(`DELETE FROM crt_links WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]); return "Link taken off."; },
});

const linksShow = defineAction({
  name: "links.show",
  tier: 1,
  description: "Show the person's portfolio and profile links and a short bio line they can copy into a profile, an application or an email signature.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<{ label: string; url: string }>(`SELECT label, url FROM crt_links WHERE user_id=$1 ORDER BY id`, [ctx.user.id]);
    const bio = typeof ctx.user.prefs.crtBio === "string" ? (ctx.user.prefs.crtBio as string) : "";
    if (!rows.length && !bio) return { reply: "No links kept yet. Say \"my portfolio is https://...\" or \"my instagram is @yourname\", and \"bio: illustrator in Lagos drawing city life\" for a line to copy." };
    const name = ctx.user.name ?? "";
    const line = [bio ? (name && !bio.toLowerCase().includes(name.split(" ")[0].toLowerCase()) ? `${name}, ${bio.charAt(0).toLowerCase()}${bio.slice(1)}` : cap(bio)) : name, rows.slice(0, 3).map((r) => bare(r.url)).join(" · ")].filter(Boolean).join(". ").replace(/\.\./g, ".");
    return { reply: [...rows.map((r) => `- ${r.label}: ${r.url}`), "", "A line to copy:", "", `\`\`\`\n${line}\n\`\`\``, ...(bio ? [] : ["", "Add a short bio with \"bio: ...\" and I'll put it in."])].join("\n").replace(/^\n+/, "") };
  },
});

const linksBio = defineAction({
  name: "links.bio",
  tier: 1,
  description: "Set the person's short artist bio, used in the copyable bio line with their links.",
  schema: z.object({ bio: z.string().min(2).max(300) }),
  async run(a, ctx) {
    const bad = refuseSecret(a.bio);
    if (bad) throw new Error(bad);
    const prev = ctx.user.prefs.crtBio ?? null;
    const bio = a.bio.trim().replace(/\.$/, "");
    await setPrefs(ctx.db, ctx.user, { crtBio: bio });
    return { reply: `Bio kept: "${bio}". Say "my links" to see it with your links, ready to copy.`, undo: { payload: { prev } } };
  },
  async undo(p, ctx) { await setPrefs(ctx.db, ctx.user, { crtBio: p.prev }); return "Bio back how it was."; },
});

const linksRemove = defineAction({
  name: "links.remove",
  tier: 1,
  description: "Remove one of the person's portfolio links, by its site or label (Behance, Instagram, portfolio...).",
  schema: z.object({ match: z.string().min(1).max(60) }),
  async run(a, ctx) {
    const q = clean(a.match).toLowerCase();
    const rows = await ctx.db.query<{ id: number; label: string; url: string }>(`SELECT id, label, url FROM crt_links WHERE user_id=$1`, [ctx.user.id]);
    const hit = rows.find((r) => r.label.toLowerCase() === (LABELS[q]?.toLowerCase() ?? q)) ?? rows.find((r) => r.url.toLowerCase().includes(q));
    if (!hit) throw new Error(`I don't have a ${clean(a.match)} link. Say "my links" to see them.`);
    await ctx.db.query(`DELETE FROM crt_links WHERE id=$1`, [hit.id]);
    return { reply: `${hit.label} link removed.`, undo: { payload: hit } };
  },
  async undo(p, ctx) { await ctx.db.query(`INSERT INTO crt_links (user_id, label, url) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [ctx.user.id, p.label, p.url]); return "Link back on your shelf."; },
});

register(ideaAdd, ideaList, ideaForget, sparkGet, sparkDaily, linksAdd, linksShow, linksBio, linksRemove);

/* ---------------- words ---------------- */

const SITES = "portfolio|website|site|behance|instagram|insta|ig|foundation|objkt|bandcamp|soundcloud|spotify|youtube|tiktok|x|twitter|threads|dribbble|artstation|linktree|zora|opensea|superrare|substack|etsy|vimeo|audiomack|boomplay|apple music|deviantart|cara|shop|store|github|pinterest|patreon|ko-?fi|medium";
const URLISH = "(https?:\\/\\/\\S+|@[\\w.]{1,40}|(?:www\\.)?[\\w-]+(?:\\.[\\w-]+)+(?:\\/\\S*)?)";
const MEDIA = "art|drawing|painting|writing|poetry|photo|photography|music|song|songwriting|dance|design|film|illustration|sketch|sketching|story";
addRules(
  [/^(?:new\s+|save\s+(?:this|an?)\s+)?idea(?:\s+for\s+(?:a\s+|an\s+|my\s+)?([\p{L}\s'-]{2,30}?))?\s*:\s*(.{2,})$/iu, (m) => ({ action: "idea.add", args: { text: m[2], ...(m[1] ? { tag: m[1] } : {}) } })],
  [/^i\s+(?:have|had|got|just had)\s+an?\s+idea(?:\s+for\s+(?:a\s+|an\s+|my\s+)?([\p{L}\s'-]{2,30}?))?\s*[:,-]\s*(.{2,})$/iu, (m) => ({ action: "idea.add", args: { text: m[2], ...(m[1] ? { tag: m[1] } : {}) } })],
  [/^(?:my\s+|show\s+my\s+|list\s+my\s+)?(?:ideas|idea inbox|idea list)(?:\s+for\s+(.+))?$/i, (m) => ({ action: "idea.list", args: m[1] ? { tag: m[1] } : {} })],
  [/^(?:delete|forget|clear|wipe|erase)\s+(?:all\s+)?(?:of\s+)?my\s+(?:saved\s+)?ideas$/i, () => ({ action: "idea.forget", args: {} })],
  [new RegExp(`^(?:send me |give me |i want |i'?d like )?(?:a\\s+)?(?:daily\\s+)?(?:creative|${MEDIA})?\\s*prompts?\\s+(?:every|each)\\s+(?:morning|day)$|^(?:daily|morning)\\s+(?:creative\\s+)?prompts?(?:\\s+on)?$|^(?:turn on|start)\\s+(?:the\\s+)?(?:daily\\s+)?(?:creative\\s+)?prompts$`, "i"), () => ({ action: "spark.daily", args: { on: true } })],
  [/^(?:stop|no more|turn off|pause|end)\s+(?:the\s+|my\s+)?(?:daily\s+)?(?:creative\s+)?prompts$|^(?:daily\s+|creative\s+)?prompts\s+off$/i, () => ({ action: "spark.daily", args: { on: false } })],
  [new RegExp(`^(?:give me |send me |i need |got |hit me with )?(?:a\\s+|another\\s+)?(?:creative\\s+)?(?:spark|(?:(?:creative|${MEDIA})\\s+)?prompt)(?:\\s+(?:for|about)\\s+(.+?))?\\??$`, "i"), (m) => ({ action: "spark.get", args: m[1] ? { medium: m[1] } : {} })],
  [new RegExp(`^(?:give me |send me |i need )(?:a\\s+)?(${MEDIA})\\s+(?:prompt|spark)\\??$`, "i"), (m) => ({ action: "spark.get", args: { medium: m[1] } })],
  [/^(?:i'?m|i am|i feel|feeling)\s+(?:creatively\s+(?:stuck|blocked|dry)|(?:stuck|blocked)\s+creatively|uninspired)$|^(?:i\s+have\s+|i'?ve\s+got\s+)?(?:art|creative|writer'?s)\s+block$/i, () => ({ action: "spark.get", args: {} })],
  [new RegExp(`^my\\s+(${SITES})(?:\\s+(?:link|page|profile|account|url|handle))?\\s+is\\s+${URLISH}$`, "i"), (m) => ({ action: "links.add", args: { url: m[2], label: m[1] } })],
  [new RegExp(`^(?:add|save)\\s+(?:my\\s+)?(?:portfolio\\s+)?link:?\\s+${URLISH}(?:\\s+(?:as|for)\\s+(?:my\\s+)?(.+))?$`, "i"), (m) => ({ action: "links.add", args: { url: m[1], ...(m[2] ? { label: m[2] } : {}) } })],
  [/^(?:my\s+|show\s+my\s+)?(?:links|portfolio links|creative links|link in bio|bio links|bio line|artist bio)$|^my\s+bio$/i, () => ({ action: "links.show", args: {} })],
  [/^(?:my\s+)?(?:artist\s+|short\s+)?bio(?:\s+is)?\s*:\s*(.{2,})$|^my\s+(?:artist\s+|short\s+)?bio\s+is\s+(.{2,})$/i, (m) => ({ action: "links.bio", args: { bio: m[1] ?? m[2] } })],
  [new RegExp(`^(?:remove|delete|drop)\\s+(?:my\\s+|the\\s+)?(${SITES})\\s+link$`, "i"), (m) => ({ action: "links.remove", args: { match: m[1] } })],
);

addExamples("idea.add", ["idea: a zine about Lagos danfo drivers", "idea for a song: the last bus out of São Paulo", "I had an idea: paint the Seoul subway map as a river"]);
addExamples("idea.list", ["my ideas", "my ideas for song"]);
addExamples("idea.forget", ["delete my ideas"]);
addExamples("spark.get", ["give me a spark", "writing prompt", "I'm creatively stuck", "give me a drawing prompt"]);
addExamples("spark.daily", ["a creative prompt every morning", "stop the prompts"]);
addExamples("links.add", ["my portfolio is https://adaobi.art", "my behance is behance.net/adaobi", "my instagram is @adaobi.draws", "add link https://foundation.app/@adaobi"]);
addExamples("links.show", ["my links", "my bio"]);
addExamples("links.bio", ["bio: illustrator in Lagos drawing city life", "my bio is painter and muralist based in Berlin"]);
addExamples("links.remove", ["remove my behance link"]);

addCues("idea", ["idea", "ideas", "idea inbox", "save this idea"]);
addCues("spark", ["spark", "prompt", "creative prompt", "stuck", "art block", "writer's block", "uninspired", "inspiration"]);
addCues("links", ["portfolio", "my links", "behance", "instagram", "bandcamp", "foundation", "objkt", "bio", "link in bio"]);

addCapability({
  key: "ideaslinks", name: "Ideas, sparks and your links",
  cues: ["idea", "ideas", "spark", "prompt", "stuck", "art block", "portfolio", "links", "bio", "behance", "instagram", "bandcamp"],
  what: "Drop ideas in a private inbox the moment they turn up and see them later. Ask for a spark when you're stuck, or get a creative prompt in your morning brief. Keep your portfolio and profile links in one place with a short bio line ready to copy.",
  say: ["idea: a zine about Lagos danfo drivers", "my ideas", "give me a spark", "a creative prompt every morning", "my portfolio is https://...", "my instagram is @yourname", "my links"],
  then: "Ideas never appear in the brief or anywhere shared. The daily prompt is opt in; \"stop the prompts\" ends it.",
}, "Creative and NFTs");
