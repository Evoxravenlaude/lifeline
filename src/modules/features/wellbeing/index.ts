/**
 * Wellbeing and people. Loaded automatically (src/modules/index.ts). Every feature here is opt-in,
 * private, calm and kind; see docs/features/wellbeing.md.
 */
import { addButtons } from "../../../core/plugins.js";
import { wbButton } from "./shared.js";
// The crisis rule lives in mind.ts and is registered first, so it is checked before this area's other sentences.
import "./mind.js";
import "./people.js";
import "./health.js";
import "./change.js";
import "./remember.js";
import "./lessons.js";
import "./privacy.js";

addButtons("wb", wbButton);

export { handleCareSms } from "./people.js";
