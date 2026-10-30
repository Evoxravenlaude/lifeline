/**
 * Linking an email address, in one tap: "link my email" makes a code and a button that opens the person's mail app
 * with an email to lifeline already written (subject and body "link CODE"). They press send; that address is theirs.
 * Or they copy `link CODE` and send it themselves. "my email is ..." (a code sent to the address) still works too.
 *
 * Sending email needs a linked address either way: to someone else (replies must come back to the person) or to
 * themselves (lifeline has to know where "me" is). Until then, lifeline says so and offers the link.
 */
import { z } from "zod";
import { defineAction, type ActionResult, type Ctx } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { addCapability, addExamples, addRules } from "../core/plugins.js";
import { canEmail } from "../core/email.js";
import { emailInOn, mailLink } from "../core/ways.js";

/** The person's own email address, if it's linked (an email identity, or one confirmed by code). */
export async function linkedEmail(ctx: Pick<Ctx, "db" | "user">): Promise<string | null> {
  const r = await ctx.db.one<{ external_id: string }>(`SELECT external_id FROM identities WHERE user_id=$1 AND channel='email' ORDER BY id LIMIT 1`, [ctx.user.id]).catch(() => undefined);
  return r?.external_id ?? (typeof ctx.user.prefs.emailVerified === "string" ? (ctx.user.prefs.emailVerified as string) : null);
}

/** "Link your email first", with the one-tap button and the line to copy. `why` leads, in the person's terms. */
export async function emailLinkOffer(ctx: Ctx, why: string): Promise<ActionResult> {
  if (!emailInOn()) {
    return { reply: `${why} Say "my email is" and your address, and I'll send a code there to confirm it's yours. Once it's confirmed, I can send for you.` };
  }
  const { createLinkCode } = await import("../core/handler.js");
  const code = await createLinkCode(ctx.db, ctx.user.id);
  const m = mailLink(code)!;
  return {
    reply: [
      why,
      "",
      m.page ? "Tap **Link my email**: your mail app opens with an email to me already written. Just press send, from the address you want to use." : `Send this to ${m.address} from the address you want to use:`,
      `\`link ${code}\``,
      `To: ${m.address}. The code lasts fifteen minutes.`,
    ].join("\n"),
    buttons: m.page ? [{ label: "Link my email", data: `url:${m.page}` }] : undefined,
  };
}

const link = defineAction({
  name: "email.link",
  tier: 1,
  description: "Link the person's email address to lifeline (so they can email it, forward things, and have emails sent with replies to them). Gives a one-tap button that writes the email for them.",
  schema: z.object({}),
  async run(_a, ctx) {
    const have = await linkedEmail(ctx);
    if (have) return { reply: `${have} is already linked. To use another address too, send me \`link\` and a fresh code from it: say "link" for one.` };
    if (!canEmail() && !emailInOn()) return { reply: "Email isn't switched on for this circle yet, so there's nothing to link it to. Whoever runs lifeline can turn it on." };
    return emailLinkOffer(ctx, "Let's link your email.");
  },
});
register(link);

addRules(
  [/^(?:link|connect|add|set ?up|hook up)\s+(?:my\s+)?(?:email|e-mail|gmail|mail|inbox)(?:\s+(?:address|account))?(?:\s+(?:to|with)\s+(?:you|lifeline))?[.!]*$|^(?:how (?:do|can) i )?link (?:my )?email\??$/i, () => ({ action: "email.link", args: {} })],
);
addExamples("email.link", ["link my email", "connect my email", "set up my email"]);
addCapability({
  key: "email-link", name: "Email",
  cues: ["email", "mail", "inbox", "send an email", "forward"],
  what: "Link your email in one tap and you can email or forward me anything, and I can send emails for you (always after your yes, with replies coming back to you). I can't open or tidy your inbox itself.",
  say: ["link my email", "email Ana the plan for Saturday", "email me my shopping list"],
  then: "Sending needs a linked email, so replies reach you.",
  limits: "I see what you send or forward me, never your inbox.",
}, "Voice, photos and search");
