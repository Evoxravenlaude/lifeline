/**
 * Home and the world: utilities and refills, home maintenance, circle outage alerts, sports,
 * faith rhythms, public holidays, flight status and the year wrapped. See docs/features/home.md.
 * Import order is rule order: neighbourhood outages ("power is out in Rumuola") before your own supply.
 */
import "./util.js";
import "./outages.js";
import "./utilities.js";
import "./upkeep.js";
import "./sports.js";
import "./faith.js";
import "./holidays.js";
import "./flights.js";
import "./wrapped.js";
import { addButtons } from "../../../core/plugins.js";
import { propose } from "../../../policy/engine.js";
import { utilityButton } from "./utilities.js";
import { jobButton } from "./upkeep.js";
import { areaButton } from "./outages.js";
import { teamButton } from "./sports.js";

/** Every "hm:" button: refills, home jobs, outage alerts, teams and the year wrapped. */
addButtons("hm", async (db, user, data, now) => {
  const parts = data.split(":").slice(1);
  if (parts[0] === "wr" && parts[1] === "cmp") {
    const d = await propose({ db, user, now, sourceMessage: `[button ${data}]` }, "yearwrap.compare", {});
    return { text: "reply" in d ? d.reply : "That didn't work on my side. Say \"compare my year with the circle\" instead." };
  }
  const text = (await utilityButton(db, user, parts, now)) ?? (await jobButton(db, user, parts, now)) ?? (await areaButton(db, user, parts)) ?? (await teamButton(db, user, parts));
  return { text: text ?? "That button doesn't do anything any more." };
});
