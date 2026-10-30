/**
 * A reply on its way to the web page. Everything an action attached goes along as it is (pictures, voice, buttons),
 * and a file is checked first: real base64, a plain file name with no folders in it, and a sensible type.
 * The page offers it as a "Save <name>" link.
 */
export interface PageFile { data: string; name: string; mime: string }

/** About 15 MB of bytes, as base64. A reply carrying more than that isn't something to hand to a browser. */
const MAX_B64 = 20_000_000;

/** A file fit for the page, or null when it isn't one. */
export function pageFile(f: unknown): PageFile | null {
  if (!f || typeof f !== "object") return null;
  const { data, name, mime } = f as Record<string, unknown>;
  if (typeof data !== "string" || !data || data.length > MAX_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const base = String(typeof name === "string" ? name : "").split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "-").replace(/^[.\s]+/, "").replace(/\s+/g, " ").trim().slice(0, 120);
  const type = typeof mime === "string" && /^[a-z]+\/[a-z0-9.+-]+$/i.test(mime) ? mime.toLowerCase() : "application/octet-stream";
  return { data, name: clean || "lifeline-file", mime: type };
}

/** The same reply with its file checked: kept when it's sound, left off when it isn't. */
export function pageReply<T extends object>(r: T): T {
  if (!r || !("file" in r)) return r;
  const { file, ...rest } = r as T & { file?: unknown };
  const ok = pageFile(file);
  return (ok ? { ...rest, file: ok } : rest) as T;
}
