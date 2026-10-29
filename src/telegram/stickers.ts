/**
 * Pip's own sticker set, made from assets/pip/*.png (rendered from the website's Pip by
 * scripts/dev/render-pip.cjs). The bot creates the set the first time it can, then keeps only the
 * Telegram file ids in memory, so sending one later costs nothing but an id.
 * Used sparingly, at real moments: the first hello, a streak, the week wrapped, a stumble.
 */
import path from "node:path";
import fs from "node:fs";
import { InputFile, type Api } from "grammy";
import type { Db } from "../core/db.js";
import { config } from "../core/config.js";
import { log } from "../core/log.js";

/** Order matters: Telegram keeps stickers in the order they were added. New poses go at the end. */
export const POSES = ["hello", "noted", "thinking", "waiting", "carrying", "asleep", "oops", "cheers", "later", "ontoit"] as const;
export type Pose = (typeof POSES)[number];

const ids = new Map<Pose, string>();
let tried = 0;

const dir = () => path.resolve(process.cwd(), "assets/pip");
export const setName = (botUsername: string) => `pip_by_${botUsername}`;

/** Find or make the set. Safe to call often: it does real work at most once every ten minutes until it succeeds. */
export async function ensurePip(api: Api, db: Db, botUsername: string): Promise<void> {
  if (ids.size === POSES.length || Date.now() - tried < 10 * 60_000 || !botUsername) return;
  tried = Date.now();
  const name = setName(botUsername);
  try {
    let set = await api.getStickerSet(name).catch(() => null);
    const files = POSES.map((p) => path.join(dir(), `${p}.png`));
    if (!files.every((f) => fs.existsSync(f))) { log.warn({ dir: dir() }, "pip sticker images missing"); return; }
    const owner = config.allowedUserIds[0] ?? Number((await db.one<{ id: string }>(`SELECT telegram_id::text AS id FROM users WHERE telegram_id IS NOT NULL ORDER BY id LIMIT 1`))?.id ?? 0);
    if (!set) {
      if (!owner) return; // nobody has started the bot yet; try again later
      await api.createNewStickerSet(owner, name, "Pip, from lifeline", POSES.map((p, i) => ({ sticker: new InputFile(files[i]), format: "static" as const, emoji_list: ["🐢"], keywords: ["pip", "lifeline", p] })));
      set = await api.getStickerSet(name);
    } else if (set.stickers.length < POSES.length && owner) {
      for (let i = set.stickers.length; i < POSES.length; i++) await api.addStickerToSet(owner, name, { sticker: new InputFile(files[i]), format: "static", emoji_list: ["🐢"], keywords: ["pip", "lifeline", POSES[i]] });
      set = await api.getStickerSet(name);
    }
    set.stickers.slice(0, POSES.length).forEach((s, i) => ids.set(POSES[i], s.file_id));
    log.info({ set: name, stickers: ids.size }, "pip stickers ready");
  } catch (e: any) {
    log.warn({ err: e?.description ?? e?.message }, "pip stickers not ready");
  }
}

export const pipSticker = (pose: string | undefined): string | null => (pose ? ids.get(pose as Pose) ?? null : null);
