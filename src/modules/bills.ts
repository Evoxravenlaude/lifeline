/**
 * Nigerian airtime, data and bills via Flutterwave Bills v3. Tier 2: the
 * echo names biller, customer and amount; nothing is sent before Confirm.
 * Needs FLUTTERWAVE_SECRET_KEY, completed KYC, a funded balance and a
 * whitelisted server IP. Untested here — run against the sandbox first.
 */
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { defineAction } from "../policy/types.js";
import { register } from "../policy/registry.js";
import { config } from "../core/config.js";
import { fmtDate } from "../core/time.js";

async function fw(path: string, init: RequestInit = {}) {
  if (!config.flutterwaveKey) throw new Error("Bills aren't switched on for this server yet; it needs a Flutterwave key. Everything else still works.");
  const r = await fetch(`${config.flutterwaveBase}${path}`, { ...init, headers: { authorization: `Bearer ${config.flutterwaveKey}`, "content-type": "application/json", ...(init.headers ?? {}) } });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.status === "error") throw new Error(j.message ? `Flutterwave turned that down: ${String(j.message).replace(/\.?$/, ".")}` : `Flutterwave ${r.status}`);
  return j;
}

const billers = defineAction({
  name: "bill.billers",
  tier: 1,
  description: "List Nigerian billers for a category: airtime, data, cable, power, internet.",
  schema: z.object({ category: z.string() }),
  async run(args) {
    const j = await fw(`/bills/categories?country=NG`);
    const rows = (j.data ?? []).filter((b: any) => String(b.biller_name ?? b.name ?? "").toLowerCase().includes(args.category.toLowerCase()) || String(b.label_name ?? "").toLowerCase().includes(args.category.toLowerCase()));
    if (!rows.length) return { reply: `No billers match "${args.category}". Try airtime, data, cable, power or internet.` };
    const head = `Billers for ${args.category}. Say "pay <amount> to <code> for <number>" and I'll check with you before anything moves.`;
    return { reply: [head, ...rows.slice(0, 15).map((b: any) => `${b.biller_name ?? b.name}, code ${b.biller_code ?? b.code}${b.amount ? `, ${Number(b.amount).toLocaleString()} naira` : ""}`)].join("\n") };
  },
});

const pay = defineAction({
  name: "bill.pay",
  tier: 2,
  description: "Pay a Nigerian bill or buy airtime/data: biller_code (from bill.billers), customer (phone number, meter or smartcard), amount in NGN, optional item_code. Confirmed with an echo of all three before anything is sent.",
  schema: z.object({ biller_code: z.string(), customer: z.string().min(5).optional(), amount: z.number().positive().optional(), item_code: z.string().optional(), label: z.string().optional() }),
  needs(args) {
    if (args.amount === undefined) return { need: "amount", question: `How much, in naira, to ${args.label ?? args.biller_code}?` };
    if (!args.customer) return { need: "customer", question: `Which number (or meter or smartcard) is the ${args.amount.toLocaleString()} naira for?` };
    return null;
  },
  echo: (a) => `This sends ${a.amount!.toLocaleString()} naira to ${a.label ?? a.biller_code} for ${a.customer}${a.item_code ? ` (${a.item_code})` : ""}. It comes out of the funded balance and can't be pulled back.`,
  async run(a, ctx) {
    const args = { ...a, amount: a.amount!, customer: a.customer! };
    const reference = `lifeline-${randomUUID()}`;
    const row = await ctx.db.one<{ id: number }>(`INSERT INTO bill_payments (user_id, provider, biller_code, item_code, customer, amount, reference) VALUES ($1,'flutterwave',$2,$3,$4,$5,$6) RETURNING id`, [ctx.user.id, args.biller_code, args.item_code ?? null, args.customer, args.amount, reference]);
    try {
      const j = await fw(`/billers/${args.biller_code}/items/${args.item_code ?? "default"}/payment`, { method: "POST", body: JSON.stringify({ country: "NG", customer_id: args.customer, amount: args.amount, reference }) });
      await ctx.db.query(`UPDATE bill_payments SET status=$2, response=$3 WHERE id=$1`, [row!.id, j.data?.status ?? "submitted", JSON.stringify(j)]);
      const st = String(j.data?.status ?? "submitted").toLowerCase();
      return { reply: `${args.amount.toLocaleString()} naira is on its way to ${args.label ?? args.biller_code} for ${args.customer}${st === "successful" || st === "success" ? ", and it went through" : `, status ${st}`}${j.data?.fee ? `, fee ${Number(j.data.fee).toLocaleString()} naira` : ""}. Reference ${reference} if you ever need to chase it.` };
    } catch (e: any) {
      await ctx.db.query(`UPDATE bill_payments SET status='failed', response=$2 WHERE id=$1`, [row!.id, JSON.stringify({ error: e?.message })]);
      throw e;
    }
  },
});

const history = defineAction({
  name: "bill.history",
  tier: 1,
  description: "Recent bill and airtime payments made through the bot.",
  schema: z.object({}),
  async run(_a, ctx) {
    const rows = await ctx.db.query<any>(`SELECT biller_code, customer, amount, status, created_at FROM bill_payments WHERE user_id=$1 ORDER BY id DESC LIMIT 10`, [ctx.user.id]);
    if (!rows.length) return { reply: "No payments through me yet." };
    const head = rows.length === 1 ? "One payment so far." : `Your last ${rows.length} payments, newest first.`;
    return { reply: [head, ...rows.map((r) => `${fmtDate(r.created_at, ctx.user.tz)}: ${Number(r.amount).toLocaleString()} naira to ${r.biller_code} for ${r.customer}, ${r.status}`)].join("\n") };
  },
});

register(billers, pay, history);
