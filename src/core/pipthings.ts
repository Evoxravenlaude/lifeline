/**
 * Pip grows with you. Days you keep something up (a habit checked in, a dose taken, three good things written)
 * add up, and at each milestone Pip gains a small thing to carry: a scarf, a lantern, a cap, a satchel, a flower,
 * a pennant. They're counted from kept days in total, never from a run, so a missed day never takes one away.
 *
 * Drawn over Pip's picture on the dashboard and the menu pages, in 512-unit coordinates of Pip's art (all poses
 * share the same body: shell top at y 103, head centred near 256,275, feet near y 335, shadow at y 372).
 */
import type { Db } from "./db.js";

export interface Thing { key: string; name: string; at: number; why: string; svg: string }

/** In Pip's own 512 by 512 space. Muted inks from the cards' palette, so they sit with the drawing. */
export const THINGS: Thing[] = [
  {
    key: "scarf", name: "a scarf", at: 7, why: "a week of days kept",
    svg: `<path d="M196 330 Q256 352 316 330 L320 346 Q256 370 192 346 Z" fill="#b5523b"/><path d="M290 348 L304 346 L312 392 L296 394 Z" fill="#9c4532"/><path d="M200 336 Q256 356 312 336" stroke="#e8c9a8" stroke-width="3" fill="none" stroke-dasharray="6 6"/>`,
  },
  {
    key: "lantern", name: "a lantern", at: 21, why: "three weeks of days kept",
    svg: `<circle cx="78" cy="330" r="34" fill="#f2c96b" opacity="0.28"/><path d="M78 284 v10" stroke="#5b4a34" stroke-width="4"/><rect x="62" y="294" width="32" height="8" rx="3" fill="#5b4a34"/><rect x="64" y="302" width="28" height="44" rx="6" fill="#f6dc94" stroke="#5b4a34" stroke-width="4"/><rect x="60" y="346" width="36" height="9" rx="3" fill="#5b4a34"/><path d="M78 312 q6 10 0 20 q-6 -10 0 -20" fill="#e39a3b"/>`,
  },
  {
    key: "cap", name: "a little cap", at: 45, why: "forty-five days kept",
    svg: `<path d="M220 108 Q256 66 292 108 Z" fill="#3f5a74"/><rect x="214" y="104" width="84" height="10" rx="5" fill="#2f4458"/><circle cx="256" cy="72" r="7" fill="#c9a24a"/>`,
  },
  {
    key: "satchel", name: "a satchel", at: 75, why: "seventy-five days kept",
    svg: `<path d="M420 300 Q440 268 460 300" stroke="#6b4a2b" stroke-width="5" fill="none"/><rect x="408" y="300" width="64" height="54" rx="9" fill="#8a5d36" stroke="#5c3d22" stroke-width="4"/><path d="M408 314 h64 v12 q-32 14 -64 0 Z" fill="#a8743f"/><circle cx="440" cy="328" r="4" fill="#d8b46a"/>`,
  },
  {
    key: "flower", name: "a flower for his shell", at: 120, why: "a hundred and twenty days kept",
    svg: `<g transform="translate(176 150)"><circle cx="0" cy="-9" r="8" fill="#e9a3b4"/><circle cx="9" cy="0" r="8" fill="#e9a3b4"/><circle cx="0" cy="9" r="8" fill="#e9a3b4"/><circle cx="-9" cy="0" r="8" fill="#e9a3b4"/><circle cx="0" cy="0" r="6" fill="#f2c96b"/></g>`,
  },
  {
    key: "pennant", name: "a pennant", at: 200, why: "two hundred days kept",
    svg: `<path d="M336 132 V60" stroke="#5b4a34" stroke-width="4" stroke-linecap="round"/><path d="M338 62 L380 74 L338 88 Z" fill="#4f7a5c"/>`,
  },
];

/** Days with something kept: a habit, a dose taken, or three good things. Distinct days, all time. */
export async function keptDays(db: Db, userId: number): Promise<number> {
  const parts = [
    `SELECT c.day::date AS d FROM habit_checkins c JOIN habits h ON h.id=c.habit_id WHERE h.user_id=$1`,
    `SELECT (l.taken_at AT TIME ZONE 'UTC')::date AS d FROM medication_logs l JOIN medications m ON m.id=l.medication_id WHERE m.user_id=$1 AND l.status='taken' AND l.taken_at IS NOT NULL`,
  ];
  // Three good things lives in a feature folder that may not be installed.
  const good = await db.one<{ t: string | null }>(`SELECT to_regclass('well_good')::text AS t`).catch(() => null);
  if (good?.t) parts.push(`SELECT day AS d FROM well_good WHERE user_id=$1`);
  const r = await db.one<{ n: string }>(`SELECT count(DISTINCT d)::text AS n FROM (${parts.join(" UNION ")}) x`, [userId]).catch(() => null);
  return Number(r?.n ?? 0);
}

export const earnedBy = (days: number) => THINGS.filter((t) => days >= t.at);
export const nextThing = (days: number) => THINGS.find((t) => days < t.at) ?? null;

/** What Pip carries for this person (from prefs, so drawing never waits on a count). */
export function carried(prefs: Record<string, unknown>): Thing[] {
  const keys = Array.isArray(prefs.pipThings) ? (prefs.pipThings as string[]) : [];
  return THINGS.filter((t) => keys.includes(t.key));
}

/** Count again and keep what's newly earned. Things are only ever added. */
export async function catchUp(db: Db, user: { id: number; prefs: Record<string, unknown> }): Promise<{ days: number; fresh: Thing[]; all: Thing[] }> {
  const days = await keptDays(db, user.id);
  const had = new Set(carried(user.prefs).map((t) => t.key));
  const all = THINGS.filter((t) => had.has(t.key) || days >= t.at);
  const fresh = all.filter((t) => !had.has(t.key));
  if (fresh.length) {
    const keys = all.map((t) => t.key);
    await db.query(`UPDATE users SET prefs = prefs || jsonb_build_object('pipThings', $2::jsonb) WHERE id=$1`, [user.id, JSON.stringify(keys)]);
    user.prefs = { ...user.prefs, pipThings: keys };
  }
  return { days, fresh, all };
}

/** The things, drawn where Pip is: same x, y and size as pipArt. Clipped the same way (Pip's art shows its top 69%). */
export function thingsArt(things: Thing[], x: number, y: number, size: number): string {
  if (!things.length) return "";
  const k = size / 512;
  const top = y - size * 0.08;
  const id = `things${Math.round(x)}${Math.round(y)}`;
  return `<clipPath id="${id}"><rect x="${x}" y="${y}" width="${size}" height="${size * 0.69}"/></clipPath>
  <g clip-path="url(#${id})"><g transform="translate(${x} ${top}) scale(${k})">${things.map((t) => t.svg).join("")}</g></g>`;
}

/** "Pip has a scarf and a lantern." */
export function thingsLine(things: Thing[]): string {
  if (!things.length) return "";
  const names = things.map((t) => t.name);
  return `Pip carries ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`}.`;
}
