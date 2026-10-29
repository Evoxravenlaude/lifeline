/**
 * A plan's page: /plan/:id, a calm one-page write-up in the website's paper and ink, with a picture at the top,
 * the one thing to start first, then the visa, getting there, where to stay, the days, food, packing and sources.
 * Unlisted (the id is unguessable), never indexed, and gone once the person takes it down.
 */
import type { Hono } from "hono";
import type { Db } from "../core/db.js";
import type { TripPlan } from "../modules/planner.js";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const list = (items: string[]) => (items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : "");
const section = (title: string, plate: string, body: string) => (body.trim() ? `<section class="card" style="--k:var(--k-${plate})"><h2>${esc(title)}</h2>${body}</section>` : "");

export function planHtml(id: string, raw: Partial<TripPlan>, hasHero: boolean): string {
  const p: TripPlan = { title: "A plan", destination: "", when: "", from: null, style: null, clock: "", summary: "", visa: "", gettingThere: "", budget: "", stay: [], days: [], food: [], tips: [], packing: [], questions: [], sources: [], passport: null, made: new Date().toISOString(), ...raw };
  const days = p.days.map((d, i) => `<div class="day"><h3><span>Day ${i + 1}</span> ${esc(d.title)}</h3>${list(d.items)}</div>`).join("");
  const stay = p.stay.map((s) => `<p><b>${esc(s.area)}</b>. ${esc(s.why)}</p>`).join("");
  const sources = p.sources.length ? `<ol class="src">${p.sources.map((s) => `<li><a href="${esc(s.url)}" rel="noopener nofollow" target="_blank">${esc(s.title)}</a></li>`).join("")}</ol>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(p.title)} · lifeline</title>
<meta property="og:title" content="${esc(p.title)}"><meta property="og:description" content="${esc(p.clock)}">${hasHero ? `<meta property="og:image" content="/plan/${esc(id)}/hero">` : ""}
<style>
@font-face{font-family:"Libre Caslon Display";font-display:swap;src:url("/fonts/libre-caslon-display-latin-400-normal.woff2") format("woff2")}
@font-face{font-family:"EB Garamond";font-display:swap;font-weight:400 800;src:url("/fonts/eb-garamond-latin-wght-normal.woff2") format("woff2")}
@font-face{font-family:"EB Garamond";font-style:italic;font-display:swap;font-weight:400 800;src:url("/fonts/eb-garamond-latin-wght-italic.woff2") format("woff2")}
:root{--paper:#EDE6D6;--panel:#F7F2E7;--ink:#1F1B16;--ink-2:#4F473C;--ink-3:#6F6658;--line:rgba(31,27,22,.16);--k-rem:#D9BD72;--k-event:#9FB6CF;--k-dose:#B9CCA6;--k-class:#C7B0CC;--k-trip:#DDB894;--k-money:#A9C9BD;--k-hack:#DCA99F;--k-scout:#BCB5DA;--k-list:#D8CFB4}
@media (prefers-color-scheme:dark){:root{--paper:#0F1411;--panel:#161D18;--ink:#ECE5D3;--ink-2:#C3BBA8;--ink-3:#959080;--line:rgba(236,229,211,.16);--k-rem:#7A6532;--k-event:#3E5571;--k-dose:#4D6340;--k-class:#5E4866;--k-trip:#7A5A3B;--k-money:#3E6559;--k-hack:#7A4840;--k-scout:#504A78;--k-list:#5C5544}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:400 1.15rem/1.6 "EB Garamond",Georgia,serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:24px 16px 64px}
.hero{width:100%;aspect-ratio:16/9;object-fit:cover;border:1.5px solid var(--ink);border-radius:14px;box-shadow:6px 6px 0 0 var(--k-trip),6px 6px 0 1.5px var(--ink);display:block;margin:8px 0 28px}
.mark{font-style:italic;color:var(--ink-3)}h1{font:400 clamp(2.2rem,7vw,3.4rem)/1.05 "Libre Caslon Display",Georgia,serif;margin:6px 0 6px}
.when{font-style:italic;color:var(--ink-2);margin:0 0 22px}
.clock{font-size:1.3rem;line-height:1.45;margin:0 0 10px}.summary{color:var(--ink-2)}
.card{position:relative;background:var(--panel);border:1.5px solid var(--ink);border-radius:12px;padding:18px 20px;margin:26px 0;box-shadow:5px 5px 0 0 var(--k,var(--k-list)),5px 5px 0 1.5px var(--ink)}
h2{font:400 1.6rem/1.2 "Libre Caslon Display",Georgia,serif;margin:0 0 8px}h3{font-size:1.15rem;margin:14px 0 4px}h3 span{font-style:italic;color:var(--ink-3);font-weight:400;margin-right:6px}
ul{margin:4px 0 0;padding-left:1.1em}li{margin:3px 0}p{margin:6px 0}a{color:inherit}
.src{font-size:.95rem;color:var(--ink-2);padding-left:1.3em}.foot{margin-top:34px;font-size:.95rem;color:var(--ink-3);border-top:1px solid var(--line);padding-top:14px}
</style></head><body><main class="wrap">
<div class="mark">lifeline · a plan</div>
<h1>${esc(p.title)}</h1>
<p class="when">${esc(p.when)}${p.from ? `, from ${esc(p.from)}` : ""}${p.style ? `. ${esc(p.style)}` : ""}</p>
${hasHero ? `<img class="hero" src="/plan/${esc(id)}/hero" alt="">` : ""}
${p.clock ? `<p class="clock"><b>Start here.</b> ${esc(p.clock)}</p>` : ""}
${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ""}
${section(p.passport ? `Visa, for a ${p.passport} passport` : "Visa", "rem", p.visa ? `<p>${esc(p.visa)}</p>` : "")}
${section("Getting there", "event", p.gettingThere ? `<p>${esc(p.gettingThere)}</p>` : "")}
${section("Where to stay", "trip", stay)}
${section("The days", "class", days)}
${section("Food", "hack", list(p.food))}
${section("Good to know", "money", (p.budget ? `<p>${esc(p.budget)}</p>` : "") + list(p.tips))}
${section("Pack", "list", list(p.packing))}
${p.sources.length ? section("Where this comes from", "scout", sources) : ""}
<p class="foot">Researched from live web search on ${esc(new Date(p.made).toUTCString().slice(5, 16))}. Check visa rules and prices with the official source before you pay for anything. Made with lifeline.</p>
</main></body></html>`;
}

export function mountPlans(app: Hono<any>, db: Db): void {
  app.get("/plan/:id", async (c) => {
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return c.text("Not found", 404);
    const row = await db.one<{ data: TripPlan; has_hero: boolean }>(`SELECT data, hero IS NOT NULL AS has_hero FROM plans WHERE id=$1 AND NOT deleted`, [id]);
    if (!row) return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>lifeline</title><body style="font:1.1rem Georgia,serif;background:#EDE6D6;color:#1F1B16;padding:40px 16px;max-width:600px;margin:auto"><p>This plan isn't here any more. Whoever shared it may have taken it down.</p></body>`, 404);
    const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    return c.html(planHtml(id, data, row.has_hero), 200, { "x-robots-tag": "noindex", "cache-control": "private, max-age=60" });
  });
  app.get("/plan/:id/hero", async (c) => {
    const id = c.req.param("id");
    if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return c.body(null, 404);
    const row = await db.one<{ hero: Buffer | null; hero_mime: string | null }>(`SELECT hero, hero_mime FROM plans WHERE id=$1 AND NOT deleted`, [id]);
    if (!row?.hero) return c.body(null, 404);
    return c.body(new Uint8Array(row.hero), 200, { "content-type": row.hero_mime ?? "image/jpeg", "cache-control": "private, max-age=600" });
  });
}
