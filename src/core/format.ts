/**
 * Replies are written in a small markdown: **bold**, *italic*, `code`, ```blocks```,
 * [links](url), "- " lists, and the odd header or table a model slips in.
 * Each channel gets it rendered its own way, so nobody ever sees a raw asterisk:
 *  - Telegram: HTML. `code` and blocks are tap-to-copy there.
 *  - SMS and iMessage: clean plain text.
 *  - Web: the browser renders the same markdown (web/app.js, md()).
 */

const FENCE = /```[ \t]*([\w+-]*)[ \t]*\n?([\s\S]*?)```/g;
const INLINE = /`([^`\n]+)`/g;
/** Things people copy: EVM addresses and hashes, Solana-style base58 addresses. */
const EVM = /\b0x[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?\b/g;
const BASE58 = /(?<![\w/.=?&#])(?=[1-9A-HJ-NP-Za-km-z]*\d)(?=[1-9A-HJ-NP-Za-km-z]*[A-Z])(?=[1-9A-HJ-NP-Za-km-z]*[a-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![\w/])/g;

const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (t: string) => escHtml(t).replace(/"/g, "&quot;");

/** Markdown tables become one line per row: "a · b · c". The separator row goes. */
function untable(t: string): string {
  return t.split("\n").flatMap((l) => {
    if (!/^\s*\|.*\|\s*$/.test(l)) return [l];
    if (/^\s*\|[\s:|-]+\|\s*$/.test(l)) return [];
    return [l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean).join(" · ")];
  }).join("\n");
}

/** Pull code out first so nothing inside it is touched, then put it back rendered. */
function protect(md: string): { text: string; blocks: { lang: string; body: string }[]; spans: string[] } {
  const blocks: { lang: string; body: string }[] = [];
  const spans: string[] = [];
  let text = md.replace(FENCE, (_, lang: string, body: string) => { blocks.push({ lang, body: body.replace(/\n$/, "") }); return `\u0000B${blocks.length - 1}\u0000`; });
  text = text.replace(INLINE, (_, s: string) => { spans.push(s); return `\u0000S${spans.length - 1}\u0000`; });
  return { text, blocks, spans };
}

function inlineMarks(t: string, b: (s: string) => string, i: (s: string) => string): string {
  return t
    .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, (_, s) => b(s))
    .replace(/(?<![\w])__(?=\S)([^_\n]+?)(?<=\S)__(?![\w])/g, (_, s) => b(s))
    .replace(/(?<![*\w])\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*(?![*\w])/g, (_, s) => i(s))
    .replace(/(?<![\w_])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w_])/g, (_, s) => i(s));
}

/** Telegram HTML. Safe to send with parse_mode HTML: every tag it writes is closed, everything else is escaped. */
export function toTelegramHtml(md: string): string {
  const { text, blocks, spans } = protect(untable(md));
  const lines = text.split("\n");
  // Replies written by the app (no marks of their own) get a bold first line when it reads as a title.
  const marked = /\*\*|^\s*[-*•#]\s|\u0000/m.test(text);
  // Lists are drawn as a small tree, like a dashboard: "├" for each item and "└" for the last in a run.
  const isBullet = lines.map((l) => /^\s*[-*+•]\s+/.test(l));
  const out = lines.map((raw, n) => {
    let line = raw;
    const bullet = /^\s*[-*+•]\s+/.test(line);
    if (bullet) line = line.replace(/^\s*[-*+•]\s+/, "");
    const head = /^\s*#{1,6}\s+/.test(line);
    if (head) line = line.replace(/^\s*#{1,6}\s+/, "").replace(/\s*#+\s*$/, "");
    let e = escHtml(line);
    e = e.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `<a href="${escAttr(url.replace(/&amp;/g, "&"))}">${label}</a>`);
    e = inlineMarks(e, (s) => `<b>${s}</b>`, (s) => `<i>${s}</i>`);
    // Addresses become tap-to-copy, but never inside a tag or a link.
    e = e.split(/(<a [^>]*>.*?<\/a>|<[^>]+>)/).map((part) => (part.startsWith("<") ? part : part.replace(EVM, (m) => `<code>${m}</code>`).replace(BASE58, (m) => `<code>${m}</code>`))).join("");
    // A short line that reads like a label ("Evening:", or a first line followed by a body) is set in bold.
    const plainLabel = !/[<*_]/.test(line) && ((/^[A-Z][^:]{1,40}:$/.test(line) && line.length < 44) || (!marked && n === 0 && lines.length >= 3 && line.length < 70 && /[.:!?]$/.test(line)));
    if (head || plainLabel) e = `<b>${e}</b>`;
    return (bullet ? (isBullet[n + 1] ? "├ " : "└ ") : "") + e;
  }).join("\n");
  return out
    .replace(/\u0000S(\d+)\u0000/g, (_, k) => `<code>${escHtml(spans[Number(k)])}</code>`)
    .replace(/\u0000B(\d+)\u0000/g, (_, k) => {
      const { lang, body } = blocks[Number(k)];
      return lang ? `<pre><code class="language-${escAttr(lang)}">${escHtml(body)}</code></pre>` : `<pre>${escHtml(body)}</pre>`;
    });
}

/** Plain text for SMS and iMessage: the marks go, the words and links stay. */
export function toPlain(md: string): string {
  const { text, blocks, spans } = protect(untable(md));
  const out = text.split("\n").map((raw) => {
    let line = raw.replace(/^\s*[-*+•]\s+/, "- ").replace(/^\s*#{1,6}\s+/, "").replace(/\s*#+\s*$/, "");
    line = line.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label: string, url: string) => (label === url ? url : `${label} (${url})`));
    return inlineMarks(line, (s) => s, (s) => s);
  }).join("\n");
  return out
    .replace(/\u0000S(\d+)\u0000/g, (_, k) => spans[Number(k)])
    .replace(/\u0000B(\d+)\u0000/g, (_, k) => blocks[Number(k)].body);
}

/** What in a reply is meant to be copied, in order: blocks, then `code`, then addresses. */
export function copyables(md: string): string[] {
  const found: string[] = [];
  for (const m of md.matchAll(FENCE)) found.push(m[2].replace(/\n$/, ""));
  const rest = md.replace(FENCE, " ");
  for (const m of rest.matchAll(INLINE)) found.push(m[1]);
  const bare = rest.replace(INLINE, " ");
  for (const m of bare.matchAll(EVM)) found.push(m[0]);
  for (const m of bare.matchAll(BASE58)) found.push(m[0]);
  return [...new Set(found.map((s) => s.trim()).filter(Boolean))];
}

/** A copy button for Telegram when a reply has exactly one thing worth copying and it fits (Telegram allows 256 characters). */
export function copyButton(md: string): { label: string; text: string } | null {
  const all = copyables(md);
  // "7KQ2XM" and "link 7KQ2XM" are one thing to copy: keep the longer.
  const c = all.filter((x) => !all.some((y) => y !== x && y.includes(x)));
  if (c.length !== 1 || c[0].length > 256) return null;
  const s = c[0];
  const address = /^0x[0-9a-fA-F]{40}$/.test(s) || new RegExp(`^(?:${BASE58.source})$`).test(s);
  const label = /^(?:link )?[A-Z0-9]{6}$/.test(s) ? "Copy code" : address ? "Copy address" : /\s/.test(s) && s.length > 40 ? "Copy message" : "Copy";
  return { label, text: s };
}
