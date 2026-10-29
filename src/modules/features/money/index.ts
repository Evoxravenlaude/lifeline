/**
 * Money and paperwork (see docs/features/money.md). Import order is rule order:
 * people (IOUs, invoices, savings circles), then paperwork (warranties before documents),
 * then recurring (rent before subscriptions, then tax), then spending (cool-off, debt).
 */
import "./common.js";
import "./people.js";
import "./paperwork.js";
import { subRenewRule } from "./recurring.js";
import "./spending.js";

// "Netflix renews on the 3rd" only after the documents rules have had "car insurance renews 1 Jan".
subRenewRule();
