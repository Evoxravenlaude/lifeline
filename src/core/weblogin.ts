/**
 * Signing in on the web through the bot itself, for when the Telegram login
 * widget can't be used (domain not set in BotFather, or its confirmation
 * lands in the "Telegram" service chat and gets missed).
 *
 *   1. The page asks for a request and opens t.me/<bot>?start=web_<id>.
 *   2. The bot asks "Sign in on the web?" with Yes / No. Only Yes approves it,
 *      so a link someone else sends you can't sign them in as you.
 *   3. The page polls; once approved, that one browser gets a session.
 *
 * Requests live in memory for five minutes and can be used once. One server
 * instance is assumed, which is how lifeline runs on Railway.
 */
import { randomBytes } from "node:crypto";

interface LoginRequest { createdAt: number; userId?: number; state: "waiting" | "approved" | "declined" | "used" }
const TTL_MS = 5 * 60_000;
const requests = new Map<string, LoginRequest>();

function sweep(now = Date.now()) { for (const [k, v] of requests) if (now - v.createdAt > TTL_MS) requests.delete(k); }

export function startWebLogin(): string {
  sweep();
  const id = randomBytes(12).toString("base64url");
  requests.set(id, { createdAt: Date.now(), state: "waiting" });
  return id;
}

/** Called by the bot when the person taps Yes or No. */
export function answerWebLogin(id: string, userId: number, approve: boolean): "ok" | "expired" {
  sweep();
  const r = requests.get(id);
  if (!r || r.state !== "waiting") return "expired";
  r.userId = userId; r.state = approve ? "approved" : "declined";
  return "ok";
}

export function webLoginExists(id: string): boolean { sweep(); return requests.get(id)?.state === "waiting"; }

/** Polled by the page. Returns the user id exactly once, when approved. */
export function pollWebLogin(id: string): { state: "waiting" | "declined" | "expired" } | { state: "approved"; userId: number } {
  sweep();
  const r = requests.get(id);
  if (!r || r.state === "used") return { state: "expired" };
  if (r.state === "approved" && r.userId) { r.state = "used"; return { state: "approved", userId: r.userId }; }
  return { state: r.state === "declined" ? "declined" : "waiting" };
}
