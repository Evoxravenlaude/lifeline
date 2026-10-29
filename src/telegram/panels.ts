/**
 * The Telegram menu: one message that changes in place as you move around it.
 * Home → Today, Lists, Health, Money, Trips, Play, Settings, Everything; each with ‹ Back and OK.
 * Panels are plain data (text in lifeline's small markdown + rows of buttons), so they're cheap to
 * render, easy to test, and the same message is edited rather than new ones piling up.
 */
import { DateTime } from "luxon";
import type { Db } from "../core/db.js";
import type { Ctx, User } from "../policy/types.js";
import { getAction } from "../policy/registry.js";
import { propose } from "../policy/engine.js";
import { PERSONAS } from "../intent/persona.js";
import { VOICES } from "../core/media.js";
import { buildDigest } from "../modules/digest.js";
import { cyclePicture, cycleRows, cyclePrefs, describeCycle } from "../modules/cycle.js";
import { webAddress } from "../core/ways.js";

/** The website, opened inside Telegram. Only over https, which Telegram requires. */
export const appButton = (): Btn | null => { const w = webAddress(); return /^https:\/\//.test(w) ? { label: "Open the app", data: "p:app", webApp: `${w.replace(/\/$/, "")}/` } : null; };

export type Style = "primary" | "success" | "danger";
/** `webApp`: open this https address as a Telegram Mini App instead of sending `data`. */
export interface Btn { label: string; data: string; style?: Style; webApp?: string }
export interface Panel { text: string; rows: Btn[][] }
export interface PanelResult { panel: Panel | null; toast?: string; ask?: AskKey; close?: boolean; passOn?: string }

export const BACK = (to = "home"): Btn => ({ label: "‹ Back", data: `p:${to}` });
export const OK: Btn = { label: "OK", data: "p:ok", style: "primary" };
const nav = (to = "home"): Btn[] => [BACK(to), OK];

/* ---------------- typing prompts ---------------- */

export type AskKey = "rem" | "list" | "spend" | "log";
/** Buttons that need words ask with a reply prompt; the answer is read with the right start. */
export const ASKS: Record<AskKey, { prompt: string; placeholder: string; shape: (t: string) => string }> = {
  rem: { prompt: "What should I remind you about, and when?", placeholder: "call mum on sunday at 5", shape: (t) => (/^remind\b/i.test(t) ? t : `remind me to ${t}`) },
  list: { prompt: "What should I add? Start with the list's name if it isn't your to-do list.", placeholder: "shopping: rice, eggs", shape: (t) => (/^[\w -]{2,24}:/.test(t) ? t : `todo: ${t}`) },
  spend: { prompt: "What did you spend, and on what?", placeholder: "12 on lunch", shape: (t) => (/^(?:i )?(?:spent|paid|bought)\b/i.test(t) ? t : `I spent ${t}`) },
  log: { prompt: "What should I log?", placeholder: "slept 7 hours, weight 72kg, mood 4/5", shape: (t) => t },
};
/** If a message answers one of our prompts, shape it so it reads right. */
export function shapeAnswer(promptText: string | undefined, text: string): string {
  const k = (Object.keys(ASKS) as AskKey[]).find((key) => ASKS[key].prompt === promptText);
  return k ? ASKS[k].shape(text.trim()) : text;
}

/* ---------------- the panels ---------------- */

const first = (u: User) => (u.name ? u.name.split(" ")[0] : null);
const hhmm = (d: Date | string, tz: string) => DateTime.fromJSDate(new Date(d)).setZone(tz).toFormat("HH:mm");
const greeting = (h: number) => (h < 5 ? "Still up" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening");

async function home(db: Db, u: User, now: Date): Promise<Panel> {
  const local = DateTime.fromJSDate(now).setZone(u.tz);
  const end = local.endOf("day").toJSDate();
  const [ev, rem, pend, open] = await Promise.all([
    db.one<{ title: string; at: string }>(`SELECT title, starts_at AS at FROM events WHERE user_id=$1 AND NOT deleted AND starts_at > $2 AND starts_at <= $3 ORDER BY starts_at LIMIT 1`, [u.id, now, end]),
    db.one<{ title: string; at: string }>(`SELECT text AS title, due_at AS at FROM reminders WHERE user_id=$1 AND NOT done AND NOT deleted AND due_at > $2 AND due_at <= $3 ORDER BY due_at LIMIT 1`, [u.id, now, end]),
    db.one<{ n: string }>(`SELECT count(*)::text AS n FROM pending_actions WHERE user_id=$1 AND resolved IS NULL AND expires_at > $2`, [u.id, now]),
    db.one<{ n: string }>(`SELECT count(*)::text AS n FROM todos WHERE user_id=$1 AND NOT done`, [u.id]),
  ]);
  const next = [ev, rem].filter(Boolean).sort((a, b) => +new Date(a!.at) - +new Date(b!.at))[0];
  const lines = [
    `**${greeting(local.hour)}${first(u) ? `, ${first(u)}` : ""}.**`,
    `_${local.toFormat("cccc d LLLL")}, ${local.toFormat("HH:mm")}_`,
    "",
    next ? `Next: ${next.title}, at ${hhmm(next.at, u.tz)}.` : "Nothing else on today.",
  ];
  const p = Number(pend?.n ?? 0), o = Number(open?.n ?? 0);
  if (p) lines.push(`${p === 1 ? "One thing is" : `${p} things are`} waiting on your yes.`);
  if (o) lines.push(`${o} open on your lists.`);
  return {
    text: lines.join("\n"),
    rows: [
      [{ label: "Today ›", data: "p:today" }, { label: "Lists ›", data: "p:lists" }],
      [{ label: "Health ›", data: "p:health" }, { label: "Money ›", data: "p:money" }],
      [{ label: "Trips ›", data: "p:trips" }, { label: "Play ›", data: "p:play" }],
      [{ label: "Settings ›", data: "p:settings" }, { label: "Everything ›", data: "ev:home" }],
      appButton() ? [appButton()!, OK] : [OK],
    ],
  };
}

async function today(db: Db, u: User, now: Date): Promise<Panel> {
  return { text: await buildDigest(db, u, now, { peek: true }), rows: [[{ label: "Add a reminder", data: "p:ask:rem" }, { label: "Lists ›", data: "p:lists" }], nav()] };
}

async function listNames(db: Db, u: User): Promise<{ list: string; n: number }[]> {
  return (await db.query<{ list: string; n: string }>(`SELECT list, count(*)::text AS n FROM todos WHERE user_id=$1 AND NOT done GROUP BY list ORDER BY list`, [u.id])).map((r) => ({ list: r.list, n: Number(r.n) }));
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

async function lists(db: Db, u: User): Promise<Panel> {
  const names = await listNames(db, u);
  if (!names.length) return { text: "**Your lists**\n\nNothing open. Add something, or say \"I need to buy rice and eggs\".", rows: [[{ label: "Add something", data: "p:ask:list" }], nav()] };
  const rows: Btn[][] = [];
  for (let i = 0; i < Math.min(names.length, 10); i += 2) rows.push(names.slice(i, i + 2).map((x, j) => ({ label: `${cap(x.list)} · ${x.n} ›`, data: `p:list:${i + j}` })));
  return { text: `**Your lists**\n\n${names.map((x) => `${cap(x.list)}, ${x.n} open`).join("\n")}`, rows: [...rows, [{ label: "Add something", data: "p:ask:list" }], nav()] };
}

async function oneList(db: Db, u: User, i: number): Promise<Panel | null> {
  const name = (await listNames(db, u))[i]?.list;
  if (!name) return lists(db, u);
  const items = await db.query<{ id: number; text: string }>(`SELECT id, text FROM todos WHERE user_id=$1 AND list=$2 AND NOT done ORDER BY id LIMIT 14`, [u.id, name]);
  return {
    text: `**${cap(name)}**\n\n${items.length} open. Tap one to tick it off.`,
    rows: [...items.map((t) => [{ label: `○  ${t.text}`.slice(0, 60), data: `p:tick:${t.id}:${i}` }]), [{ label: "Add something", data: "p:ask:list" }], nav("lists")],
  };
}

async function health(db: Db, u: User, now: Date): Promise<Panel> {
  const day = DateTime.fromJSDate(now).setZone(u.tz);
  const iso = day.toISODate()!;
  const lines: string[] = ["**Health**", ""];
  const pic = cyclePicture(await cycleRows(db, u.id), cyclePrefs(u), iso);
  const cyc = describeCycle(pic, iso);
  if (cyc.length) lines.push("**Cycle**", ...cyc, "");
  const meds = await db.query<{ name: string; times: string[]; taken: string }>(
    `SELECT m.name, m.times, (SELECT count(*) FROM medication_logs l WHERE l.medication_id=m.id AND l.status='taken' AND l.scheduled_for >= $2 AND l.scheduled_for < $3)::text AS taken
     FROM medications m WHERE m.user_id=$1 AND m.active ORDER BY m.name`, [u.id, day.startOf("day").toJSDate(), day.endOf("day").toJSDate()]);
  if (meds.length) lines.push("**Medication today**", ...meds.map((m) => `${cap(m.name)}: ${m.taken} of ${m.times.length} taken`), "");
  const since = day.minus({ days: 7 }).toJSDate();
  const [sleep, weight, mood] = await Promise.all([
    db.one<{ a: string | null; n: string }>(`SELECT AVG(value)::text AS a, count(*)::text AS n FROM measures WHERE user_id=$1 AND name='sleep' AND at >= $2`, [u.id, since]),
    db.one<{ value: string; unit: string | null }>(`SELECT value::text, unit FROM measures WHERE user_id=$1 AND name='weight' ORDER BY at DESC LIMIT 1`, [u.id]),
    db.one<{ value: string }>(`SELECT value::text FROM measures WHERE user_id=$1 AND name='mood' ORDER BY at DESC LIMIT 1`, [u.id]),
  ]);
  const body: string[] = [];
  if (sleep?.a) body.push(`Sleep: about ${Math.round(Number(sleep.a) * 10) / 10} hours a night`);
  if (weight) body.push(`Weight: ${Number(weight.value)}${weight.unit ? ` ${weight.unit}` : ""}, last logged`);
  if (mood) body.push(`Mood: ${Number(mood.value)}, last logged`);
  const habits = await db.query<{ name: string; n: string; target: number }>(
    `SELECT h.name, (SELECT count(*) FROM habit_checkins c WHERE c.habit_id=h.id AND c.day >= $2::date)::text AS n, h.target_per_week AS target FROM habits h WHERE h.user_id=$1 AND h.active ORDER BY h.name`, [u.id, since]);
  body.push(...habits.map((h) => `${cap(h.name)}: ${h.n} of ${h.target}`));
  if (body.length) lines.push("**This week**", ...body);
  if (lines.length === 2) lines.push("Nothing tracked yet. Try \"slept 7 hours\", \"I take vitamin D at 8\" or \"my period started today\".");
  return { text: lines.join("\n").trim(), rows: [[{ label: "Log something", data: "p:ask:log" }], nav()] };
}

async function viaAction(db: Db, u: User, now: Date, action: string, args: Record<string, unknown>): Promise<string> {
  const a = getAction(action);
  if (!a) return "That isn't available here.";
  return (await a.run(a.schema.parse(args), { db, user: u, now, sourceMessage: "[panel]" })).reply;
}

async function money(db: Db, u: User, now: Date, range: "week" | "month"): Promise<Panel> {
  return {
    text: `**Money**\n\n${await viaAction(db, u, now, "spend.summary", { range })}`,
    rows: [[range === "week" ? { label: "This month", data: "p:money:month" } : { label: "This week", data: "p:money" }, { label: "Log a spend", data: "p:ask:spend" }], nav()],
  };
}

async function trips(db: Db, u: User, now: Date): Promise<Panel> {
  return { text: `**Trips**\n\n${await viaAction(db, u, now, "trip.show", {})}`, rows: [nav()] };
}

function play(): Panel {
  return {
    text: "**Play**\n\nA quick game, a decision, or a roast.",
    rows: [
      [{ label: "Trivia", data: "g:new:trivia" }, { label: "Would you rather", data: "g:new:wyr" }],
      [{ label: "A riddle", data: "g:new:riddle" }, { label: "Surprise me", data: "g:new:any" }],
      [{ label: "Roll a dice", data: "say:roll a dice" }, { label: "Roast my week", data: "say:roast me" }],
      nav(),
    ],
  };
}

const VR_LABEL: Record<string, string> = { mirror: "when you send voice", always: "always", off: "never" };
const VR_NEXT: Record<string, string> = { mirror: "always", always: "off", off: "mirror" };

function settings(u: User): Panel {
  const vr = (u.prefs.voiceReplies as string) ?? "mirror";
  const voice = (u.prefs.ttsVoice as string) ?? "warm";
  const persona = typeof u.prefs.personaCustom === "string" && u.prefs.personaCustom ? "your own" : PERSONAS[(u.prefs.persona as string) ?? "plain"]?.label ?? "Plain";
  const hh = (h: number) => `${String(h).padStart(2, "0")}:00`;
  return {
    text: ["**Settings**", "", `Voice replies: ${VR_LABEL[vr] ?? vr}`, `Voice: ${voice}`, `Personality: ${persona}`, `Morning brief: ${hh(u.digest_hour)}`, `Quiet hours: ${hh(u.quiet_start)} to ${hh(u.quiet_end)}`, "", "_Tap to change. Everything else, just say it._"].join("\n"),
    rows: [
      [{ label: `Switch voice replies to ${VR_LABEL[VR_NEXT[vr]] ?? "on"}`, data: "p:set:vr" }],
      [{ label: "Change voice ›", data: "p:set:voice" }, { label: "Personality ›", data: "p:persona" }],
      [{ label: "Brief earlier", data: "p:set:brief:-1" }, { label: "Brief later", data: "p:set:brief:1" }],
      nav(),
    ],
  };
}

function personas(u: User): Panel {
  const cur = typeof u.prefs.personaCustom === "string" && u.prefs.personaCustom ? "" : (u.prefs.persona as string) ?? "plain";
  const keys = Object.keys(PERSONAS);
  const rows: Btn[][] = [];
  for (let i = 0; i < keys.length; i += 2) rows.push(keys.slice(i, i + 2).map((k) => ({ label: k === cur ? `${PERSONAS[k].label} · now` : PERSONAS[k].label, data: `p:persona:${k}`, ...(k === cur ? { style: "primary" as Style } : {}) })));
  return { text: "**Personality**\n\nHow I talk to you. Or describe your own, like \"talk like a tired pirate\".", rows: [...rows, nav("settings")] };
}

/* ---------------- routing ---------------- */

const fresh = async (db: Db, id: number): Promise<User> => (await db.one<User>(`SELECT * FROM users WHERE id=$1`, [id]))!;
const ctxOf = (db: Db, u: User, now: Date): Ctx => ({ db, user: u, now, sourceMessage: "[panel]" });

/** Everything a "p:…" button can do. Null panel means: nothing to redraw. */
export async function panel(db: Db, user: User, key: string, now = new Date()): Promise<PanelResult> {
  const [k, a, b] = key.split(":");
  switch (k) {
    case "home": return { panel: await home(db, user, now) };
    case "ok": return { panel: null, close: true };
    case "today": return { panel: await today(db, user, now) };
    case "lists": return { panel: await lists(db, user) };
    case "list": return { panel: await oneList(db, user, Number(a)) };
    case "tick": {
      const row = await db.one<{ text: string }>(`UPDATE todos SET done=true WHERE id=$1 AND user_id=$2 AND NOT done RETURNING text`, [Number(a), user.id]);
      return { panel: await oneList(db, user, Number(b)), toast: row ? `Ticked: ${row.text}` : undefined };
    }
    case "health": return { panel: await health(db, user, now) };
    case "money": return { panel: await money(db, user, now, a === "month" ? "month" : "week") };
    case "trips": return { panel: await trips(db, user, now) };
    case "play": return { panel: play() };
    case "settings": return { panel: settings(user) };
    case "persona": {
      if (a && PERSONAS[a]) {
        await propose(ctxOf(db, user, now), "persona.set", { preset: a });
        return { panel: settings(await fresh(db, user.id)), toast: `Personality: ${PERSONAS[a].label}` };
      }
      return { panel: personas(user) };
    }
    case "set": {
      if (a === "vr") {
        const next = VR_NEXT[(user.prefs.voiceReplies as string) ?? "mirror"] ?? "mirror";
        await propose(ctxOf(db, user, now), "speech.settings", { replies: next });
        return { panel: settings(await fresh(db, user.id)), toast: `Voice replies: ${VR_LABEL[next]}` };
      }
      if (a === "voice") {
        const keys = Object.keys(VOICES);
        const next = keys[(keys.indexOf((user.prefs.ttsVoice as string) ?? "warm") + 1) % keys.length];
        await propose(ctxOf(db, user, now), "speech.settings", { voice: next });
        return { panel: settings(await fresh(db, user.id)), toast: `Voice: ${next}. Say "read that to me" to hear it.` };
      }
      if (a === "brief") {
        const h = Math.min(23, Math.max(0, user.digest_hour + (Number(b) || 0)));
        if (h !== user.digest_hour) await propose(ctxOf(db, user, now), "settings.update", { digest_hour: h });
        return { panel: settings(await fresh(db, user.id)), toast: `Morning brief at ${String(h).padStart(2, "0")}:00` };
      }
      return { panel: settings(user) };
    }
    case "ask": return { panel: null, ask: (["rem", "list", "spend", "log"] as AskKey[]).includes(a as AskKey) ? (a as AskKey) : "log" };
    default: return { panel: await home(db, user, now) };
  }
}
