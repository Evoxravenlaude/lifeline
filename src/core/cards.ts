/**
 * The picture cards shown above the Telegram menu: the website's paper, ink and letterpress plates, Pip on the right.
 * Drawn as SVG and rendered to PNG with resvg, using the site's own fonts (the woff2 files are unpacked once).
 * Only Latin text is drawn on a card; anything else (a name in another script, an emoji) is left to the message below.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Resvg } from "@resvg/resvg-js";

const root = process.cwd();
const W = 1200, H = 630;
const C = { paper: "#EDE6D6", panel: "#F7F2E7", ink: "#1F1B16", ink2: "#4F473C", ink3: "#6F6658", line: "rgba(31,27,22,.16)" };
export const PLATES = { rem: "#D9BD72", event: "#9FB6CF", dose: "#B9CCA6", class: "#C7B0CC", trip: "#DDB894", money: "#A9C9BD", hack: "#DCA99F", scout: "#BCB5DA", list: "#D8CFB4" } as const;
export type Plate = keyof typeof PLATES;

/** resvg reads fonts from files: the site's woff2 fonts are unpacked to TTF once, into the temp folder. */
let fontFiles: Promise<string[]> | null = null;
/** Unpacked once; everyone drawing at the same moment waits for the same unpacking, so no card is drawn without fonts. */
function loadFonts(): Promise<string[]> {
  fontFiles ??= (async () => {
    const { decompress } = (await import("wawoff2")) as unknown as { decompress: (b: Uint8Array) => Promise<Uint8Array> };
    const dir = path.join(root, "web/fonts"), out = path.join(os.tmpdir(), "lifeline-fonts");
    fs.mkdirSync(out, { recursive: true });
    const files = ["eb-garamond-latin-wght-normal.woff2", "eb-garamond-latin-wght-italic.woff2", "libre-caslon-display-latin-400-normal.woff2"];
    const done: string[] = [];
    for (const f of files) {
      const ttf = path.join(out, f.replace(/\.woff2$/, ".ttf"));
      try {
        if (!fs.existsSync(ttf)) { const tmp = `${ttf}.${process.pid}.tmp`; fs.writeFileSync(tmp, Buffer.from(await decompress(fs.readFileSync(path.join(dir, f))))); fs.renameSync(tmp, ttf); }
        done.push(ttf);
      } catch { /* a missing font only changes the look */ }
    }
    return done;
  })();
  return fontFiles;
}

const pipCache = new Map<string, string>();
function pip(pose: string): string | null {
  if (pipCache.has(pose)) return pipCache.get(pose)!;
  const f = path.join(root, "assets/pip", `${pose}.png`);
  if (!fs.existsSync(f)) return null;
  const uri = `data:image/png;base64,${fs.readFileSync(f).toString("base64")}`;
  pipCache.set(pose, uri);
  return uri;
}

/** Keep only what the card's fonts can draw; trim to fit. */
export function latin(s: string, max: number): string {
  const t = s.normalize("NFC").replace(/[^ -ɏ‘-”–…₠-⃏]/g, "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A letterpress card: ink edge, paper face, a coloured plate offset behind it (as on the website). */
function plateCard(x: number, y: number, w: number, h: number, plate: string, r = 18): string {
  return `<rect x="${x + 10}" y="${y + 10}" width="${w}" height="${h}" rx="${r}" fill="${plate}" stroke="${C.ink}" stroke-width="3"/>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${C.panel}" stroke="${C.ink}" stroke-width="3"/>`;
}

/** Pip without his caption: the top of the sticker image, clipped. */
function pipArt(pose: string, x: number, y: number, size: number): string {
  const uri = pip(pose);
  if (!uri) return "";
  const id = `clip${Math.round(x)}${Math.round(y)}`;
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size * 0.69}"/></clipPath>
  <image href="${uri}" x="${x}" y="${y - size * 0.08}" width="${size}" height="${size}" clip-path="url(#${id})"/>`;
}

const frame = (inner: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="${C.paper}"/>
  <g font-family="EB Garamond" fill="${C.ink}">${inner}</g>
  <text x="64" y="${H - 34}" font-family="EB Garamond" font-style="italic" font-size="26" fill="${C.ink3}">lifeline</text>
</svg>`;

export interface HomeCard { greeting: string; date: string; stats: { label: string; value: string; plate: Plate }[]; pose: string }
export interface PageCard { title: string; subtitle?: string; plate: Plate; pose: string; lines?: string[] }

export function homeSvg(c: HomeCard): string {
  const stats = c.stats.slice(0, 3);
  const w = 300, gap = 28, y = 352, h = 170;
  const tiles = stats.map((s, i) => {
    const x = 64 + i * (w + gap);
    return `${plateCard(x, y, w, h, PLATES[s.plate])}
    <text x="${x + 26}" y="${y + 50}" font-size="26" fill="${C.ink2}" font-style="italic">${esc(latin(s.label, 22))}</text>
    <text x="${x + 26}" y="${y + 112}" font-size="${latin(s.value, 40).length > 15 ? 34 : 46}" font-family="Libre Caslon Display">${esc(latin(s.value, 26))}</text>`;
  }).join("\n");
  return frame(`
  <text x="64" y="128" font-size="${latin(c.greeting, 60).length > 26 ? 60 : 76}" font-family="Libre Caslon Display">${esc(latin(c.greeting, 40))}</text>
  <text x="66" y="190" font-size="36" font-style="italic" fill="${C.ink2}">${esc(latin(c.date, 60))}</text>
  <line x1="64" y1="236" x2="${W - 64}" y2="236" stroke="${C.line}" stroke-width="2"/>
  ${pipArt(c.pose, W - 330, 18, 300)}
  ${tiles}`);
}

export function pageSvg(c: PageCard): string {
  const lines = (c.lines ?? []).slice(0, 3);
  return frame(`
  ${plateCard(64, 140, 720, 300, PLATES[c.plate], 24)}
  <text x="104" y="254" font-size="${latin(c.title, 30).length > 16 ? 64 : 84}" font-family="Libre Caslon Display">${esc(latin(c.title, 26))}</text>
  ${c.subtitle ? `<text x="106" y="316" font-size="36" font-style="italic" fill="${C.ink2}">${esc(latin(c.subtitle, 40))}</text>` : ""}
  ${lines.map((l, i) => `<text x="106" y="${374 + i * 40}" font-size="30" fill="${C.ink2}">${esc(latin(l, 46))}</text>`).join("\n")}
  ${pipArt(c.pose, W - 380, 150, 340)}`);
}

/** SVG to PNG. Rendering takes tens of milliseconds; callers cache. */
export async function renderPng(svg: string): Promise<Buffer> {
  const fontFiles = await loadFonts();
  const r = new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "EB Garamond" } });
  return Buffer.from(r.render().asPng());
}
