/**
 * The emergency card as a lock-screen picture: a phone-shaped PNG (1080x2340), dark and calm, with the card in
 * light paper below the clock. The top third stays empty so the phone's clock and date sit on plain dark.
 * Only the fields the person put on their card are drawn. The card fonts only carry Latin letters, so anything
 * else is left off the picture and the caller says so.
 */
import { C, PLATES, esc, latin, plateCard, renderPng } from "../../../core/cards.js";

export const LOCK_W = 1080, LOCK_H = 2340;
const CLEAR = Math.round(LOCK_H / 3); // the clock's third
const X = 84, PAD = 60, CARD_W = LOCK_W - 2 * X - 10, TEXT_W = CARD_W - 2 * PAD;
const TOP = CLEAR + 50, BOTTOM_MAX = LOCK_H - 230; // the bottom keeps clear of the torch and camera shortcuts

export interface LockCard { name: string | null; fields: { label: string; value: string }[]; updated: string }

/** Letters the picture's fonts can't draw (other scripts, emoji). Currency signs are written as codes by latin(), so they're fine. */
const UNDRAWN = /[^\s -ɏ‘-”–…€₦₹₩₱₺₽₴₵₫₪฿]/u;
export const lockDropsSomething = (c: LockCard) => [c.name ?? "", ...c.fields.map((f) => f.value)].some((s) => UNDRAWN.test(s));

/** Wrap by an average letter width (EB Garamond runs about half an em); a long word is cut to fit. */
function wrap(text: string, size: number, maxLines: number): string[] {
  const per = Math.max(8, Math.floor(TEXT_W / (size * 0.48)));
  const lines: string[] = [];
  let line = "";
  for (const w0 of text.split(" ")) {
    let w = w0;
    while (w.length > per) { if (line) { lines.push(line); line = ""; } lines.push(w.slice(0, per)); w = w.slice(per); }
    if (!line) line = w; else if (`${line} ${w}`.length <= per) line = `${line} ${w}`; else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) { const kept = lines.slice(0, maxLines); kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, per - 1).trimEnd()}…`; return kept; }
  return lines;
}

/** Lays the fields out at the largest size that fits between the clock and the bottom shortcuts. */
function layout(c: LockCard) {
  const fields = c.fields.map((f) => ({ label: latin(f.label, 40), value: latin(f.value, 400) })).filter((f) => f.value);
  for (const [size, maxLines] of [[60, 4], [54, 4], [48, 4], [44, 3], [40, 3], [36, 2]] as const) {
    const lead = Math.round(size * 1.22);
    const blocks = fields.map((f) => ({ ...f, lines: wrap(f.value, size, maxLines) }));
    const head = 64 + (c.name ? 92 : 0) + 56;
    const body = blocks.reduce((h, b) => h + 46 + b.lines.length * lead + 34, 0);
    const height = PAD + head + body + 60;
    if (TOP + height <= BOTTOM_MAX || size === 36) return { size, lead, blocks, height: Math.min(height, BOTTOM_MAX - TOP) };
  }
  throw new Error("unreachable");
}

export function lockScreenSvg(c: LockCard): string {
  const { size, lead, blocks, height } = layout(c);
  const parts: string[] = [];
  let y = TOP + PAD + 40;
  parts.push(`<text x="${X + PAD}" y="${y}" font-size="34" letter-spacing="4" fill="${C.ink2}">IN CASE OF EMERGENCY</text>`);
  y += 24;
  if (c.name) { y += 84; parts.push(`<text x="${X + PAD}" y="${y}" font-size="76" font-family="Libre Caslon Display">${esc(latin(c.name, 26))}</text>`); }
  y += 32;
  parts.push(`<line x1="${X + PAD}" y1="${y}" x2="${X + CARD_W - PAD}" y2="${y}" stroke="${C.line}" stroke-width="3"/>`);
  for (const b of blocks) {
    if (y + 46 + lead > TOP + height - 70) break;
    y += 62;
    parts.push(`<text x="${X + PAD}" y="${y}" font-size="36" font-style="italic" fill="${C.ink2}">${esc(b.label)}</text>`);
    y += 8;
    for (const l of b.lines) {
      if (y + lead > TOP + height - 70) break;
      y += lead;
      parts.push(`<text x="${X + PAD}" y="${y}" font-size="${size}" fill="${C.ink}">${esc(l)}</text>`);
    }
    y += 10;
  }
  parts.push(`<text x="${X + PAD}" y="${TOP + height - 40}" font-size="30" font-style="italic" fill="${C.ink3}">Updated ${esc(latin(c.updated, 30))}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${LOCK_W}" height="${LOCK_H}" viewBox="0 0 ${LOCK_W} ${LOCK_H}">
  <rect width="${LOCK_W}" height="${LOCK_H}" fill="#1B1915"/>
  <g font-family="EB Garamond" fill="${C.ink}">
    ${plateCard(X, TOP, CARD_W, height, PLATES.hack, 40)}
    ${parts.join("\n    ")}
  </g>
</svg>`;
}

export const lockScreenPng = (c: LockCard) => renderPng(lockScreenSvg(c), LOCK_W);
