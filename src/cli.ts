/**
 * Local CLI: the same brain without any channel.
 *   npx tsx src/cli.ts chat            # interactive; "1"/"2" press the last buttons
 *   npx tsx src/cli.ts poll            # hackathon pollers once
 *   npx tsx src/cli.ts scout "<niche>" # scout once
 *   npx tsx src/cli.ts digest          # today's digest for the CLI user
 */
import "./modules/index.js";
import readline from "node:readline";
import { getDb } from "./core/db.js";
import { ensureUser, handleCallback, handleMessage, buttonsAsText } from "./core/handler.js";
import { pollAll } from "./pollers/hackathons.js";
import { buildDigest } from "./modules/digest.js";
import { scout, fmtHit } from "./modules/scout.js";

const cmd = process.argv[2] ?? "chat";
const db = await getDb();
const user = await ensureUser(db, "web", "cli", "cli");

if (cmd === "poll") console.log(await pollAll(db));
else if (cmd === "digest") console.log(await buildDigest(db, user, new Date()));
else if (cmd === "scout") console.log((await scout(db, process.argv[3] ?? "solana", process.argv[4])).map(fmtHit).join("\n"));
else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("lifeline cli — type a sentence; 'quit' to exit");
  rl.setPrompt("> ");
  rl.prompt();
  let buttons: { label: string; data: string }[] = [];
  rl.on("line", async (line) => {
    const t = line.trim();
    if (t === "quit") process.exit(0);
    const u = (await ensureUser(db, "web", "cli"))!;
    const n = /^\d$/.test(t) ? Number(t) : 0;
    const r = n && buttons[n - 1] ? await handleCallback(db, u, buttons[n - 1].data) : await handleMessage(db, u, t, { channel: "web" });
    buttons = r.buttons ?? [];
    console.log(buttonsAsText(r));
    rl.prompt();
  });
}
