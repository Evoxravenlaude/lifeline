/**
 * "Delete my ...": every sensitive record in this area can be wiped by the person it belongs to.
 * Mood entries live in measures and are deleted with the core's "delete my mood data".
 */
import { z } from "zod";
import { defineAction } from "../../../policy/types.js";
import { register } from "../../../policy/registry.js";
import { addExamples, addRules } from "../../../core/plugins.js";
import { rx, setWb, stopJobs } from "./shared.js";

const KINDS = ["symptoms", "good", "quit", "remembrance", "people", "checkups", "capsules", "care", "buddies"] as const;
type Kind = (typeof KINDS)[number];
const WORDS: Record<Kind, string> = {
  symptoms: "your symptom log", good: "every good thing you've saved", quit: "your quit and no-contact counters", remembrance: "your remembrance dates",
  people: "your keep-in-touch list", checkups: "your checkup reminders", capsules: "your sealed time capsules, unread", care: "your caregiver reminders (texts stop too)", buddies: "your buddy pairings",
};

const DONE: Record<Kind, string> = {
  symptoms: "Your symptom log is gone.", good: "Your good things are gone, and the evening prompt is off.", quit: "Your counters are gone.", remembrance: "Your remembrance dates are gone, and nothing will be sent.",
  people: "Your keep-in-touch list is gone.", checkups: "Your checkup reminders are gone.", capsules: "Your time capsules are gone, unread.", care: "Your caregiver reminders are gone and the texts have stopped.", buddies: "Your buddy pairings have ended.",
};

const forget = defineAction({
  name: "wellbeing.forget",
  tier: 2,
  description: "Delete one kind of private wellbeing record for good: symptoms, good (good things), quit (counters), remembrance, people (keep in touch), checkups, capsules, care (caregiver reminders), buddies.",
  schema: z.object({ what: z.enum(KINDS) }),
  echo: (a) => `This deletes ${WORDS[a.what]}. It can't be undone.`,
  async run(args, ctx) {
    const u = ctx.user.id, db = ctx.db;
    switch (args.what) {
      case "symptoms": await db.query(`DELETE FROM well_symptoms WHERE user_id=$1`, [u]); break;
      case "good": await db.query(`DELETE FROM well_good WHERE user_id=$1`, [u]); await stopJobs(db, u, "well_good"); await setWb(db, ctx.user, { good: null }); break;
      case "quit": await db.query(`DELETE FROM well_quits WHERE user_id=$1`, [u]); await stopJobs(db, u, "well_quit"); break;
      case "remembrance": await db.query(`DELETE FROM well_remembrance WHERE user_id=$1`, [u]); await stopJobs(db, u, "well_remember"); break;
      case "people": await db.query(`DELETE FROM well_people WHERE user_id=$1`, [u]); await stopJobs(db, u, "well_touch"); break;
      case "checkups": await db.query(`DELETE FROM well_checkups WHERE user_id=$1`, [u]); break;
      case "capsules": await db.query(`DELETE FROM well_capsules WHERE user_id=$1`, [u]); await stopJobs(db, u, "well_capsule"); break;
      case "care": {
        await db.query(`UPDATE jobs SET active=false WHERE kind IN ('well_care_dose','well_care_check') AND user_id=$1`, [u]);
        await db.query(`DELETE FROM well_care_logs WHERE care_id IN (SELECT id FROM well_care WHERE user_id=$1)`, [u]);
        await db.query(`DELETE FROM well_care WHERE user_id=$1`, [u]);
        break;
      }
      case "buddies": await db.query(`UPDATE well_buddies SET status='ended', ended_at=now() WHERE (from_user=$1 OR to_user=$1) AND status IN ('asked','active')`, [u]); break;
    }
    return { reply: `Deleted. ${DONE[args.what]}` };
  },
});
register(forget);

const MAP: [RegExp, Kind][] = [[/symptoms?(?: log)?/, "symptoms"], [/good things/, "good"], [/(?:quit |no[- ]contact )?counters?/, "quit"], [/remembrance(?: dates| days)?/, "remembrance"], [/keep[- ]in[- ]touch(?: list)?|people list/, "people"], [/check ?-?ups?(?: reminders)?/, "checkups"], [/time capsules?|capsules|sealed letters/, "capsules"], [/caregiver reminders|reminders for (?:mum|mom|dad|others)/, "care"], [/buddies|buddy pairings/, "buddies"]];
addRules([rx(String.raw`(?:delete|erase|clear|wipe|forget)\s+(?:all\s+)?(?:of\s+)?my\s+(symptoms?(?: log)?|good things|(?:quit |no[- ]contact )?counters?|remembrance(?: dates| days)?|keep[- ]in[- ]touch(?: list)?|people list|check ?-?ups?(?: reminders)?|time capsules?|capsules|sealed letters|caregiver reminders|buddies|buddy pairings)`), (m) => ({ action: "wellbeing.forget", args: { what: MAP.find(([re]) => re.test(m[1].toLowerCase()))![1] } })]);
addExamples("wellbeing.forget", ["delete my symptom log", "delete my good things", "delete my quit counters", "erase my remembrance dates", "delete my time capsules"]);
