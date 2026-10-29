/**
 * Instant developer tools (no network): JSON formatting, base64, URL encoding, unix time, UUIDs,
 * cron in plain words, regex testing, hashes and JWT decoding. Results go in code blocks so they copy.
 * Also secret rotation reminders, which keep only a name, never the secret.
 */
import { createHash, randomUUID } from "node:crypto";
import vm from "node:vm";
import { Cron } from "croner";
import { DateTime } from "luxon";
import { z } from "zod";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addButtons, addCapability, addCues, addExamples, addRules, addSchema, addSystemJob } from "../../../core/plugins.js";
import { onJob, type SchedulerDeps } from "../../../core/scheduler.js";
import { parseWhen, humanDelta } from "../../../core/time.js";
import { dayLabel, flush, looksSecret, queue, SECRET_REFUSAL } from "./shared.js";

const block = (s: string, lang = "") => `\`\`\`${lang}\n${s}\n\`\`\``;
/** "`hello`" or "\"hello\"" → hello: one pair of wrapping quotes or backticks comes off. */
const unwrap = (s: string) => s.trim().replace(/^```\w*\n?([\s\S]*?)\n?```$/, "$1").replace(/^(["'`])([\s\S]*)\1$/, "$2");

/* ---------- cron in words ---------- */

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MON = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const num = (s: string) => (NAMES[s.toLowerCase()] ?? Number(s));
const ord = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
const two = (n: number) => String(n).padStart(2, "0");
const andList = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

function listOf(field: string, name: (n: number) => string): string {
  return andList(field.split(",").map((part) => {
    const [range, step] = part.split("/");
    const [a, b] = range.split("-");
    if (range === "*" && step) return `every ${step}`;
    if (b !== undefined) return `${name(num(a))} to ${name(num(b))}${step ? `, every ${step}` : ""}`;
    return name(num(a));
  }));
}

export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length === 6) f.shift(); // seconds
  if (f.length !== 5) throw new Error("A cron line has five parts: minute, hour, day of month, month and day of week. Like `0 9 * * 1-5`.");
  const [min, hour, dom, mon, dow] = f;
  let time: string;
  const single = (s: string) => /^\d+$/.test(s);
  if (single(min) && single(hour)) time = `At ${two(+hour)}:${two(+min)}`;
  else if (single(min) && /^[\d,]+$/.test(hour)) time = `At ${andList(hour.split(",").map((h) => `${two(+h)}:${two(+min)}`))}`;
  else if (min === "*" && hour === "*") time = "Every minute";
  else if (/^\*\/\d+$/.test(min) && hour === "*") time = `Every ${min.slice(2)} minutes`;
  else if (/^\*\/\d+$/.test(min)) time = `Every ${min.slice(2)} minutes, during ${listOf(hour, (h) => `${two(h)}:00`).replace(/ to (\d\d):00/g, " to $1:59")}`;
  else if (single(min) && hour === "*") time = +min === 0 ? "Every hour, on the hour" : `Every hour at ${two(+min)} minutes past`;
  else if (single(min) && /^\*\/\d+$/.test(hour)) time = `Every ${hour.slice(2)} hours at ${two(+min)} minutes past`;
  else if (single(min)) time = `At ${two(+min)} minutes past ${listOf(hour, (h) => `${two(h)}:00`)}`;
  else time = `At minute ${listOf(min, String)} of ${hour === "*" ? "every hour" : listOf(hour, (h) => `${two(h)}:00`)}`;
  const days: string[] = [];
  if (dom !== "*" && dom !== "?") days.push(`on the ${listOf(dom, ord)} of the month`);
  if (dow !== "*" && dow !== "?") {
    const d = dow.replace(/7/g, "0");
    days.push(d === "1-5" ? "Monday to Friday" : /^(?:0,6|6,0)$/.test(d) ? "on Saturday and Sunday" : `on ${listOf(dow, (n) => DOW[n] ?? String(n))}`);
  }
  if (!days.length) days.push("every day");
  const month = mon !== "*" ? ` in ${listOf(mon, (n) => MON[n] ?? String(n))}` : "";
  return `${time}, ${days.join(" or ")}${month}.`;
}

export function nextCronRuns(expr: string, tz: string, now: Date, n = 3): Date[] {
  return new Cron(expr.trim(), { timezone: tz }).nextRuns(n, now);
}

/* ---------- the tools ---------- */

const TOOLS = ["json", "base64_encode", "base64_decode", "url_encode", "url_decode", "unix", "now", "uuid", "cron", "regex", "sha256", "sha1", "sha512", "md5", "jwt"] as const;
type Tool = (typeof TOOLS)[number];

function b64decode(s: string): Buffer {
  const clean = s.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error("That isn't base64: it has characters base64 doesn't use. Check you copied all of it?");
  return Buffer.from(clean, "base64");
}
const printable = (b: Buffer) => { const t = b.toString("utf8"); return !t.includes("�") && !/[\x00-\x08\x0E-\x1F]/.test(t) ? t : null; };

export function runRegex(source: string, flags: string, input: string): { match: string; index: number; groups: string[] }[] {
  if (source.length > 300 || input.length > 5000) throw new Error("That's a bit long for me to test here. Keep the pattern under 300 characters and the text under 5000.");
  try { new RegExp(source, flags); } catch (e) { throw new Error(`That pattern doesn't compile: ${(e as Error).message.replace(/^Invalid regular expression: /, "")}.`); }
  const script = new vm.Script(`(() => { const re = new RegExp(p, f.includes("g") ? f : f + "g"); const out = []; for (const m of s.matchAll(re)) { out.push({ match: m[0], index: m.index, groups: m.slice(1).map((g) => g === undefined ? "(none)" : g) }); if (out.length >= 20) break; } return JSON.stringify(out); })()`);
  try { return JSON.parse(script.runInNewContext({ p: source, f: flags, s: input }, { timeout: 200 })); }
  catch { throw new Error("That pattern took too long on this text (it backtracks a lot), so I stopped it. Try making the repeats less greedy."); }
}

function decodeJwt(token: string, tz: string, now: Date): string {
  const parts = token.trim().split(".");
  if (parts.length < 2 || parts.length > 3) throw new Error("A JWT has three parts separated by dots, like `xxxxx.yyyyy.zzzzz`. Check you copied all of it?");
  const part = (s: string, what: string) => { try { return JSON.parse(b64decode(s).toString("utf8")); } catch { throw new Error(`I couldn't read the ${what} of that token. Is it a JWT?`); } };
  const header = part(parts[0], "header"), payload = part(parts[1], "payload");
  const when = (k: string, label: string) => {
    if (typeof payload[k] !== "number") return null;
    const d = new Date(payload[k] * 1000);
    const at = DateTime.fromJSDate(d).setZone(tz).toFormat("ccc d LLL yyyy, HH:mm");
    return k === "exp" ? (d < now ? `Expired ${at} (${humanDelta(d, now)} ago).` : `Expires ${at}, in ${humanDelta(now, d)}.`) : `${label} ${at}.`;
  };
  const times = [when("exp", ""), when("iat", "Issued"), when("nbf", "Not valid before")].filter(Boolean).join(" ");
  return [
    "Header and payload below. The signature is NOT verified: anyone can make a token that says this, so check it with the issuer's key before you trust it.",
    block(JSON.stringify(header, null, 2), "json"),
    block(JSON.stringify(payload, null, 2), "json"),
    times,
    "If this token is still live, treat it like a password. I haven't kept it.",
  ].filter(Boolean).join("\n");
}

export function runTool(tool: Tool, raw: string | undefined, tz: string, now: Date): string {
  const input = unwrap(raw ?? "");
  const need = (what: string) => { if (!input) throw new Error(`Give me the ${what} after it, like "${what === "text" ? "base64 decode aGVsbG8=" : what}".`); };
  switch (tool) {
    case "json": {
      need("JSON");
      try { return block(JSON.stringify(JSON.parse(input), null, 2), "json"); }
      catch (e) { throw new Error(`That isn't valid JSON (${(e as Error).message.replace(/^JSON\.parse:\s*/, "").replace(/\.$/, "")}). Check for a missing quote or comma around there.`); }
    }
    case "base64_encode": need("text"); return block(Buffer.from(input, "utf8").toString("base64"));
    case "base64_decode": {
      need("text");
      const b = b64decode(input);
      const t = printable(b);
      return t !== null ? block(t) : `That decodes to ${b.length} bytes of binary, not text. In hex:\n${block(b.toString("hex"))}`;
    }
    case "url_encode": need("text"); return block(encodeURIComponent(input));
    case "url_decode": need("text"); try { return block(decodeURIComponent(input.replace(/\+/g, " "))); } catch { throw new Error("That has a broken % sequence, so it won't decode. Check you copied all of it?"); }
    case "now": {
      const ms = now.getTime();
      return `Now, in seconds and milliseconds:\n${block(`${Math.floor(ms / 1000)}\n${ms}\n${now.toISOString()}`)}`;
    }
    case "unix": {
      need("timestamp");
      let d: Date;
      if (/^-?\d{9,13}(?:\.\d+)?$/.test(input)) {
        const n = Number(input);
        d = new Date(input.replace(/^-/, "").split(".")[0].length >= 12 ? n : n * 1000);
        const local = DateTime.fromJSDate(d).setZone(tz);
        return `\`${input}\` is ${local.toFormat("cccc d LLLL yyyy, HH:mm:ss")} your time (${tz}).\n${block(d.toISOString())}`;
      }
      const p = parseWhen(input, tz, now);
      if (!p) throw new Error("I couldn't read a time in that. Give me a unix timestamp like 1730000000, or a date like \"1 Dec 2026 09:00\".");
      d = p;
      return `${DateTime.fromJSDate(d).setZone(tz).toFormat("ccc d LLL yyyy, HH:mm")} your time is:\n${block(`${Math.floor(d.getTime() / 1000)}`)}`;
    }
    case "uuid": {
      const n = Math.min(10, Math.max(1, Number(/^\d+$/.test(input) ? input : 1)));
      return block(Array.from({ length: n }, () => randomUUID()).join("\n"));
    }
    case "cron": {
      need("cron line");
      let runs: Date[];
      try { runs = nextCronRuns(input, tz, now); } catch (e) { if (/five parts/.test((e as Error).message)) throw e; throw new Error("That isn't a cron line I can read. It needs five parts, like `0 9 * * 1-5`."); }
      const words = describeCron(input);
      const fmtRun = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat("ccc d LLL, HH:mm");
      return `\`${input}\`: ${words}\nNext, your time (${tz}): ${runs.map(fmtRun).join("; ")}.`;
    }
    case "regex": {
      const m = /^\/((?:\\.|[^/\\])+)\/([dgimsuvy]*)\s+(?:against|on|with|in|vs\.?|to)\s+([\s\S]+)$/.exec(input);
      if (!m) throw new Error("Give me the pattern in slashes and the text after it, like \"test regex /a+b/ against aab\".");
      const hits = runRegex(m[1], m[2], unwrap(m[3]));
      if (!hits.length) return `/${m[1]}/${m[2]} doesn't match that text.`;
      const lines = hits.map((h) => `${JSON.stringify(h.match)} at ${h.index}${h.groups.length ? `, groups: ${h.groups.map((g) => JSON.stringify(g)).join(", ")}` : ""}`);
      return `${hits.length === 1 ? "One match" : `${hits.length}${hits.length === 20 ? " or more" : ""} matches`}:\n${block(lines.join("\n"))}`;
    }
    case "sha256": case "sha1": case "sha512": case "md5":
      need("text");
      return `${tool.toUpperCase()} of ${input.length > 40 ? "that text" : JSON.stringify(input)}:\n${block(createHash(tool).update(input, "utf8").digest("hex"))}`;
    case "jwt": need("token"); return decodeJwt(input, tz, now);
  }
}

const devtool = defineAction({
  name: "devtool.run",
  tier: 1,
  description: "Instant developer tools, no network: `tool` is json (format/pretty-print JSON), base64_encode, base64_decode, url_encode, url_decode, unix (convert a unix timestamp to a date, or a date to a timestamp), now (current unix time), uuid (input: how many), cron (explain a cron line in plain words with the next runs), regex (input like '/a+b/i against aab'), sha256, sha1, sha512, md5, jwt (decode header and payload; never verifies the signature). `input` is the text to work on.",
  schema: z.object({ tool: z.enum(TOOLS), input: z.string().max(20_000).optional() }),
  async run(args, ctx) {
    return { reply: runTool(args.tool, args.input, ctx.user.tz, ctx.now) };
  },
});

const T = (tool: Tool) => (m: RegExpMatchArray) => ({ action: "devtool.run", args: { tool, input: m[1] } });
addRules(
  [/^(?:format|pretty[- ]?print|prettify|beautify|indent|validate)\s+(?:this\s+|the\s+|my\s+)?json:?\s*([\s\S]+)$/i, T("json")],
  [/^json\s+(?:format|pretty|prettify):?\s*([\s\S]+)$/i, T("json")],
  [/^(?:base64|b64)\s+decode:?\s+([\s\S]+)$|^decode\s+(?:this\s+)?(?:base64|b64):?\s+([\s\S]+)$/i, (m) => ({ action: "devtool.run", args: { tool: "base64_decode", input: m[1] ?? m[2] } })],
  [/^(?:base64|b64)\s+encode:?\s+([\s\S]+)$|^encode\s+(?:this\s+)?(?:in\s+|as\s+|to\s+)?(?:base64|b64):?\s+([\s\S]+)$/i, (m) => ({ action: "devtool.run", args: { tool: "base64_encode", input: m[1] ?? m[2] } })],
  [/^url\s*encode:?\s+([\s\S]+)$|^(?:percent|uri)[- ]encode:?\s+([\s\S]+)$/i, (m) => ({ action: "devtool.run", args: { tool: "url_encode", input: m[1] ?? m[2] } })],
  [/^url\s*decode:?\s+([\s\S]+)$|^(?:percent|uri)[- ]decode:?\s+([\s\S]+)$/i, (m) => ({ action: "devtool.run", args: { tool: "url_decode", input: m[1] ?? m[2] } })],
  [/^(?:(?:unix|epoch)\s*(?:time|timestamp)?\s+now|timestamp\s+now|current\s+(?:unix\s+|epoch\s+)?(?:time\s*stamp|timestamp|unix time|epoch)|unix\s+now|epoch\s+now)$/i, () => ({ action: "devtool.run", args: { tool: "now" } })],
  [/^(?:unix|epoch)(?:\s+time|\s+timestamp)?\s+(?:of\s+|for\s+)?(.+)$|^timestamp\s+(-?\d{9,13}(?:\.\d+)?)$|^what (?:date|time) is\s+(-?\d{9,13})\??$/i, (m) => ({ action: "devtool.run", args: { tool: "unix", input: m[1] ?? m[2] ?? m[3] } })],
  [/^(?:(?:generate|make|give me|new)\s+(?:an?\s+|a new\s+)?)?(?:(\d{1,2})\s+)?uuids?(?:\s+v4)?(?:\s+please)?$/i, (m) => ({ action: "devtool.run", args: { tool: "uuid", input: m[1] } })],
  [/^(?:explain|what does|what is|read|translate)\s+(?:this\s+|the\s+)?cron(?:\s+line|\s+expression|\s+schedule)?:?\s+([\d*/,\-A-Za-z?\s]+?)(?:\s+mean)?\??$/i, T("cron")],
  [/^cron:?\s+([\d*/,\-?\s]{9,})$/i, T("cron")],
  [/^(?:test|try|check|run)\s+(?:this\s+|the\s+|my\s+)?(?:regex|regexp|pattern)\s+([\s\S]+)$|^(?:does|will)\s+(\/[\s\S]+\/[a-z]*\s+match\s+[\s\S]+?)\??$/i, (m) => ({ action: "devtool.run", args: { tool: "regex", input: m[1] ?? m[2]?.replace(/\s+match\s+/, " against ") } })],
  [/^(sha-?256|sha-?1|sha-?512|md5)(?:\s+hash)?\s+(?:of|for)\s+([\s\S]+)$|^(?:hash|digest)\s+([\s\S]+?)\s+(?:with|using|in)\s+(sha-?256|sha-?1|sha-?512|md5)$/i, (m) => ({ action: "devtool.run", args: { tool: (m[1] ?? m[4]).toLowerCase().replace("-", ""), input: m[2] ?? m[3] } })],
  [/^(?:decode|read|inspect|parse|what'?s in)\s+(?:this\s+|the\s+|my\s+)?jwt:?\s+([\s\S]+)$|^jwt\s+decode:?\s+([\s\S]+)$/i, (m) => ({ action: "devtool.run", args: { tool: "jwt", input: m[1] ?? m[2] } })],
);
addExamples("devtool.run", [
  "format this json {\"a\":1,\"b\":[1,2]}", "base64 decode aGVsbG8gd29ybGQ=", "base64 encode hello world", "url encode a b&c=d", "url decode a%20b%26c",
  "unix time 1730000000", "timestamp now", "uuid", "generate 3 uuids", "explain cron 0 9 * * 1-5", "test regex /a+b/ against aab", "sha256 of hello",
  "decode jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl",
]);
addCues("devtool", ["json", "base64", "url encode", "urlencode", "decode", "encode", "unix", "epoch", "timestamp", "uuid", "cron", "regex", "regexp", "sha256", "sha1", "md5", "hash", "jwt", "pretty print"]);

/* ---------- secret rotation reminders ---------- */

addSchema(`CREATE TABLE IF NOT EXISTS tech_rotations (id SERIAL PRIMARY KEY, user_id INT NOT NULL REFERENCES users(id), name TEXT NOT NULL, every_days INT NOT NULL, next_due DATE NOT NULL, reminded_for DATE, last_rotated DATE, active BOOLEAN NOT NULL DEFAULT true, created_at TIMESTAMPTZ DEFAULT now())`);

const localDate = (d: Date, tz: string) => DateTime.fromJSDate(d).setZone(tz);
const cleanName = (s: string) => s.trim().replace(/^(?:the|my|our)\s+/i, "").replace(/\s+/g, " ");

const rotationAdd = defineAction({
  name: "rotation.add",
  tier: 1,
  description: "Remind the person to rotate a secret (API key, token, password, certificate) every N days. `name` is ONLY the secret's name, like 'Stripe key'; never pass the secret itself. Refuses anything that looks like a real key.",
  schema: z.object({ name: z.string().min(2).max(80), every_days: z.number().int().min(1).max(3650) }),
  async run(args, ctx) {
    const secret = looksSecret(args.name);
    if (secret) throw new Error(SECRET_REFUSAL(secret));
    const name = cleanName(args.name);
    const due = localDate(ctx.now, ctx.user.tz).plus({ days: args.every_days }).toISODate()!;
    const r = await ctx.db.one<{ id: number }>(`INSERT INTO tech_rotations (user_id, name, every_days, next_due) VALUES ($1,$2,$3,$4) RETURNING id`, [ctx.user.id, name, args.every_days, due]);
    return { reply: `I'll remind you to rotate the ${name} every ${args.every_days} days, next on ${dayLabel(`${due}T12:00:00Z`, "UTC")}. I keep only the name, never the key. Say "rotated the ${name}" when you do it and I'll restart the clock.`, undo: { payload: { id: r!.id } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`DELETE FROM tech_rotations WHERE id=$1 AND user_id=$2`, [p.id, ctx.user.id]);
    return "Dropped that rotation reminder.";
  },
});

const rotationDone = defineAction({
  name: "rotation.done",
  tier: 1,
  description: "The person rotated a secret: restart its rotation clock. `match` is part of its name.",
  schema: z.object({ match: z.string().min(2) }),
  async run(args, ctx) {
    const secret = looksSecret(args.match);
    if (secret) throw new Error(SECRET_REFUSAL(secret));
    const row = await ctx.db.one<any>(`SELECT * FROM tech_rotations WHERE user_id=$1 AND active AND name ILIKE $2 ORDER BY next_due LIMIT 1`, [ctx.user.id, `%${cleanName(args.match).replace(/\s+(?:key|token|secret)s?$/i, "")}%`]);
    if (!row) return { reply: `I don't have a rotation reminder matching "${args.match}". Say "rotate the Stripe key every 90 days" to set one.` };
    const today = localDate(ctx.now, ctx.user.tz);
    const next = today.plus({ days: Number(row.every_days) }).toISODate()!;
    await ctx.db.query(`UPDATE tech_rotations SET last_rotated=$2, next_due=$3, reminded_for=NULL WHERE id=$1`, [row.id, today.toISODate(), next]);
    return { reply: `Noted that the ${row.name} is fresh. Next rotation ${dayLabel(`${next}T12:00:00Z`, "UTC")}.`, undo: { payload: { id: row.id, next_due: row.next_due, last_rotated: row.last_rotated, reminded_for: row.reminded_for } } };
  },
  async undo(p, ctx) {
    await ctx.db.query(`UPDATE tech_rotations SET next_due=$2, last_rotated=$3, reminded_for=$4 WHERE id=$1 AND user_id=$5`, [p.id, p.next_due, p.last_rotated, p.reminded_for, ctx.user.id]);
    return "Put the old date back.";
  },
});

register(devtool, rotationAdd, rotationDone);

const toDays = (n: string, unit: string) => Number(n) * (/^w/i.test(unit) ? 7 : /^m/i.test(unit) ? 30 : /^y/i.test(unit) ? 365 : 1);
addRules(
  [/^(?:remind me to\s+)?rotate\s+(?=[^\n]*\b(?:keys?|tokens?|secrets?|passwords?|credentials?|certs?|certificates?|api|pat|ssh|jwt|webhook)\b|[^\n]*\S{24,})(?:the\s+|my\s+|our\s+)?(.+?)\s+every\s+(\d{1,4})\s+(days?|weeks?|months?|years?)$/i, (m) => ({ action: "rotation.add", args: { name: m[1], every_days: toDays(m[2], m[3]) } })],
  [/^(?:set (?:up )?an?\s+)?(?:rotation|key rotation|secret rotation)\s+(?:reminder\s+)?(?:for\s+)?(?:the\s+|my\s+)?(.+?)\s+every\s+(\d{1,4})\s+(days?|weeks?|months?|years?)$/i, (m) => ({ action: "rotation.add", args: { name: m[1], every_days: toDays(m[2], m[3]) } })],
  [/^(?:i\s+)?(?:just\s+)?rotated\s+(?=[^\n]*\b(?:keys?|tokens?|secrets?|passwords?|credentials?|certs?|certificates?|api|pat|ssh|jwt|webhook)\b)(?:the\s+|my\s+|our\s+)?(.+)$/i, (m) => ({ action: "rotation.done", args: { match: m[1] } })],
);
addExamples("rotation.add", ["rotate the Stripe key every 90 days", "rotation reminder for the AWS keys every 3 months", "key rotation for the GitHub deploy token every 6 weeks"]);
addExamples("rotation.done", ["rotated the Stripe key", "I just rotated the AWS keys"]);
addCues("rotation", ["rotate", "rotation", "rotated", "api key", "secret", "credentials", "token expires"]);

addButtons("tc", async (db, user, data, now) => {
  const [, kind, a, b] = data.split(":");
  if (kind === "rot") {
    const row = await db.one<any>(`SELECT * FROM tech_rotations WHERE id=$1 AND user_id=$2`, [Number(a), user.id]);
    if (!row) return { text: "I couldn't find that reminder any more." };
    const next = localDate(now, user.tz).plus({ days: Number(row.every_days) }).toISODate()!;
    await db.query(`UPDATE tech_rotations SET last_rotated=$2, next_due=$3, reminded_for=NULL WHERE id=$1`, [row.id, localDate(now, user.tz).toISODate(), next]);
    return { text: `Noted. Next rotation of the ${row.name} on ${dayLabel(`${next}T12:00:00Z`, "UTC")}.` };
  }
  if (kind === "mon" && a === "off") {
    const r = await db.query(`UPDATE tech_monitors SET active=false WHERE id=$1 AND user_id=$2 RETURNING host`, [Number(b), user.id]);
    return { text: r.length ? `Stopped watching ${r[0].host}.` : "That one's already stopped." };
  }
  if (kind === "claim") {
    const r = await db.query(`UPDATE tech_claims SET done=true WHERE id=$1 AND user_id=$2 RETURNING title`, [Number(a), user.id]);
    return { text: r.length ? `Marked ${r[0].title} as done. No more reminders for it.` : "I couldn't find that one any more." };
  }
  return { text: "That button doesn't do anything any more." };
});

/** Hourly: rotation reminders on the due day, from 09:00 local. Claims run from the crypto file on the same tick. */
export async function checkRotations(deps: SchedulerDeps, now: Date): Promise<number[]> {
  const rows = await deps.db.query<any>(`SELECT r.*, u.tz FROM tech_rotations r JOIN users u ON u.id=r.user_id WHERE r.active AND (r.reminded_for IS NULL OR r.reminded_for <> r.next_due)`);
  const touched: number[] = [];
  for (const r of rows) {
    const local = localDate(now, r.tz);
    const due = typeof r.next_due === "string" ? r.next_due.slice(0, 10) : DateTime.fromJSDate(r.next_due).toUTC().toISODate();
    if (local.toISODate()! < due! || local.hour < 9) continue;
    await queue(deps.db, r.user_id, "rotation", "urgent", `Time to rotate the ${r.name} (every ${r.every_days} days). Say "rotated the ${r.name}" when it's done.`, now, { label: "Rotated", data: `tc:rot:${r.id}` });
    await deps.db.query(`UPDATE tech_rotations SET reminded_for=next_due WHERE id=$1`, [r.id]);
    touched.push(r.user_id);
  }
  return touched;
}

addSystemJob("tech_flush", "5,15,25,35,45,55 * * * *");
onJob("tech_flush", async (_job, deps) => { await flush(deps, new Date()); });

addCapability({
  key: "devtools", name: "Developer tools",
  cues: ["json", "base64", "url encode", "unix time", "timestamp", "uuid", "cron", "regex", "sha256", "hash", "jwt", "rotate", "api key rotation"],
  what: "Quick tools that answer instantly: format JSON, base64 and URL encode or decode, unix time both ways, UUIDs, cron lines in plain words with the next runs in your time zone, regex tests, SHA-256 and other hashes, and JWT decoding. I also remind you to rotate keys and tokens on a schedule.",
  say: ["format this json {\"a\":1}", "explain cron 0 9 * * 1-5", "unix time 1730000000", "test regex /a+b/ against aab", "decode jwt eyJ...", "rotate the Stripe key every 90 days"],
  then: "Results come in a block you can copy. JWTs are decoded, never verified.",
  limits: "For rotation reminders I keep only the key's name. If you paste a real key or token, I don't keep it and I'll tell you to rotate it.",
}, "Work, code and crypto");
