/** Importing registers every action and job handler. Order doesn't matter. */
import "./reminders.js";
import "./calendar.js";
import "./medications.js";
import "./classes.js";
import "./trips.js";
import "./life.js";
import "./hackathons.js";
import "./trading.js";
import "./digest.js";
import "./prices.js";
import "./jobs.js";
import "./launches.js";
import "./bills.js";
import "./scout.js";
import "./extras.js";
import "./cycle.js";
import "./measures.js";
import "./senses.js";
import "./fun.js";
import "./calm.js";
import "./appinfo.js";
import "./planner.js";
import "./research.js";
import "./chatstyle.js";
import "./pip.js";
import "./account.js";
import "./identity.js";
import "./emaillink.js";
import "./limits.js";

/* Feature folders: every src/modules/features/<area>/index.ts registers itself (see docs/PLUGINS.md). */
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const featuresDir = join(dirname(fileURLToPath(import.meta.url)), "features");
if (existsSync(featuresDir)) {
  for (const area of readdirSync(featuresDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const ts = join(featuresDir, area, "index.ts"), js = join(featuresDir, area, "index.js");
    const file = existsSync(ts) ? ts : existsSync(js) ? js : null;
    if (file) { const url = pathToFileURL(file).href; await import(url); }
  }
}
import "../intent/persona.js";
import "../pollers/hackathons.js";
import "../telegram/group.js";
