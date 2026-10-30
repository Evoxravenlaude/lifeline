/**
 * The incident log as a PDF: a title, whose log it is, when it was exported and in which time zone, then each
 * entry numbered with its time, its words and its sha256. Text is drawn with the site's own fonts (unpacked once
 * by src/core/cards.ts). Those are Latin fonts, so for any other script a wider font already on the machine is
 * used when there is one (Noto Sans, DejaVu Sans, FreeSans). A character no font has is drawn as a blank box and
 * reported back, so the caller can hand over the exact text as well.
 */
import fs from "node:fs";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { cardFontFiles } from "../../../core/cards.js";

/** Wide-coverage fonts that may already be installed. Single-font files only (pdf-lib can't read .ttc collections). */
const WIDE = [
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
  "/Library/Fonts/Arial Unicode.ttf",
  "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
];

interface Face { font: PDFFont; has: (cp: number) => boolean }
type Chain = Face[];

const INK = rgb(0x1f / 255, 0x1b / 255, 0x16 / 255), INK2 = rgb(0x4f / 255, 0x47 / 255, 0x3c / 255), INK3 = rgb(0x6f / 255, 0x66 / 255, 0x58 / 255), LINE = rgb(0.82, 0.8, 0.76);

async function ttf(doc: PDFDocument, file: string | undefined): Promise<Face | null> {
  if (!file) return null;
  try {
    const bytes = fs.readFileSync(file);
    const probe = fontkit.create(bytes);
    const font = await doc.embedFont(bytes, { subset: true });
    return { font, has: (cp) => probe.hasGlyphForCodePoint(cp) };
  } catch { return null; }
}

/** Fonts in order of preference for body, italic and headings, each with the wide fallback behind it. */
async function faces(doc: PDFDocument): Promise<{ body: Chain; italic: Chain; head: Chain; mono: PDFFont }> {
  doc.registerFontkit(fontkit);
  const files = await cardFontFiles().catch(() => [] as string[]);
  const pick = (re: RegExp) => files.find((f) => re.test(f));
  const [body, italic, head] = await Promise.all([ttf(doc, pick(/garamond.*normal/)), ttf(doc, pick(/garamond.*italic/)), ttf(doc, pick(/caslon/))]);
  const wide = await ttf(doc, WIDE.find((f) => fs.existsSync(f)));
  let base: Face | null = body ?? wide;
  if (!base) {
    // No TTF at all: the PDF's built-in Times, which only draws Western European letters.
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    base = { font, has: (cp) => { try { font.encodeText(String.fromCodePoint(cp)); return true; } catch { return false; } } };
  }
  const chain = (f: Face | null): Chain => [...new Set([f, wide, base].filter((x): x is Face => !!x))];
  return { body: chain(body), italic: chain(italic), head: chain(head), mono: await doc.embedFont(StandardFonts.Courier) };
}

/** Text split into runs, each drawn with the first font that has its letters. */
function runs(text: string, chain: Chain, missing: { any: boolean }): { font: PDFFont; text: string }[] {
  const out: { font: PDFFont; text: string }[] = [];
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0)!;
    let face = /\s/.test(ch) ? chain[0] : chain.find((f) => f.has(cp));
    let c = ch;
    if (!face) {
      missing.any = true;
      face = chain[0];
      // A built-in PDF font can't even draw a blank box for a letter it lacks; a TTF draws its .notdef box.
      try { face.font.encodeText(ch); } catch { c = "?"; }
    }
    const last = out[out.length - 1];
    if (last && last.font === face.font) last.text += c; else out.push({ font: face.font, text: c });
  }
  return out;
}
const widthOf = (rs: { font: PDFFont; text: string }[], size: number) => rs.reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0);

/** Greedy word wrap; a word longer than the line (a long link) is broken between letters. */
function wrap(text: string, chain: Chain, size: number, max: number, missing: { any: boolean }): string[] {
  const lines: string[] = [];
  const w = (s: string) => widthOf(runs(s, chain, missing), size);
  for (const para of text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) {
    let line = "";
    for (const word of para.split(/ +/)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (w(tryLine) <= max) { line = tryLine; continue; }
      if (line) lines.push(line);
      line = "";
      let piece = "";
      for (const ch of Array.from(word)) {
        if (w(piece + ch) > max && piece) { lines.push(piece); piece = ""; }
        piece += ch;
      }
      line = piece;
    }
    lines.push(line);
  }
  return lines;
}

export interface IncidentPdfEntry { seq: number; when: string; text: string; hash: string }
export interface IncidentPdfInput { name: string | null; exported: string; tz: string; status: string; entries: IncidentPdfEntry[] }

/** Builds the PDF. `missing` is true when some character couldn't be drawn by any font available. */
export async function incidentPdf(input: IncidentPdfInput): Promise<{ bytes: Uint8Array; pages: number; missing: boolean }> {
  const doc = await PDFDocument.create();
  const f = await faces(doc);
  const missing = { any: false };
  const W = 595.28, H = 841.89, M = 56, FOOT = 40, max = W - 2 * M;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;

  const room = (h: number) => { if (y - h < M + FOOT - 16) { page = doc.addPage([W, H]); y = H - M; } };
  const draw = (text: string, chain: Chain, size: number, color = INK, x = M) => {
    let cx = x;
    for (const r of runs(text, chain, missing)) { page.drawText(r.text, { x: cx, y, size, font: r.font, color }); cx += r.font.widthOfTextAtSize(r.text, size); }
  };
  const para = (text: string, chain: Chain, size: number, lead: number, color = INK) => {
    for (const l of wrap(text, chain, size, max, missing)) { room(lead); y -= lead; draw(l, chain, size, color); }
  };

  // Header.
  y -= 6;
  para("Incident log", f.head, 26, 30);
  if (input.name) para(input.name, f.body, 14, 20, INK2);
  para(`Exported ${input.exported}, time zone ${input.tz}`, f.body, 11, 16, INK2);
  para(`${input.entries.length} ${input.entries.length === 1 ? "entry" : "entries"}. ${input.status}`, f.body, 11, 16, INK2);
  y -= 4;
  para("How the hashes work: each entry's sha256 covers its number, its logged time, its words and the hash of the entry before it (the first starts from 64 zeros). Changing or removing any entry breaks every hash after it, so any change shows.", f.italic, 10, 14, INK3);
  y -= 12;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: LINE });
  y -= 6;

  for (const e of input.entries) {
    room(18 + 16 + 14);
    y -= 14;
    para(`${e.seq}.  ${e.when}`, f.head, 13, 18);
    y -= 2;
    para(e.text || " ", f.body, 11.5, 15.5);
    room(14);
    y -= 13;
    page.drawText(`sha256: ${e.hash}`, { x: M, y, size: 8.5, font: f.mono, color: INK2 });
    y -= 4;
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => p.drawText(`Incident log, page ${i + 1} of ${pages.length}`, { x: M, y: M - 20, size: 8.5, font: f.italic[0].font, color: INK3 }));
  doc.setTitle(input.name ? `Incident log of ${input.name}` : "Incident log");
  doc.setCreator("lifeline");
  doc.setProducer("lifeline");
  return { bytes: await doc.save(), pages: pages.length, missing: missing.any };
}
