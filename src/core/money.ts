/**
 * Whose money, in which currency. lifeline is used worldwide, so nothing assumes one country:
 * an amount with no currency is in the person's own, set by them ("my currency is EUR"), or by
 * the country they told us, or guessed from their time zone, or US dollars as a last resort.
 */
import type { User } from "../policy/types.js";

const BY_COUNTRY: Record<string, string> = {
  NG: "NGN", GA: "XAF", CM: "XAF", CG: "XAF", TD: "XAF", CF: "XAF", GQ: "XAF", SN: "XOF", CI: "XOF", BJ: "XOF", TG: "XOF", BF: "XOF", ML: "XOF", NE: "XOF",
  GH: "GHS", KE: "KES", UG: "UGX", TZ: "TZS", RW: "RWF", ET: "ETB", ZA: "ZAR", EG: "EGP", MA: "MAD", DZ: "DZD", TN: "TND", ZM: "ZMW", ZW: "USD", AO: "AOA",
  US: "USD", CA: "CAD", MX: "MXN", BR: "BRL", AR: "ARS", CL: "CLP", CO: "COP", PE: "PEN",
  GB: "GBP", IE: "EUR", FR: "EUR", DE: "EUR", ES: "EUR", IT: "EUR", PT: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", FI: "EUR", GR: "EUR",
  CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", TR: "TRY", UA: "UAH", RU: "RUB",
  AE: "AED", SA: "SAR", QA: "QAR", IL: "ILS", IN: "INR", PK: "PKR", BD: "BDT", LK: "LKR", NP: "NPR",
  CN: "CNY", HK: "HKD", TW: "TWD", JP: "JPY", KR: "KRW", SG: "SGD", MY: "MYR", ID: "IDR", PH: "PHP", TH: "THB", VN: "VND",
  AU: "AUD", NZ: "NZD",
};
/** A time zone's country, for the common ones; enough to guess a currency until the person says. */
const TZ_COUNTRY: Record<string, string> = {
  "Africa/Lagos": "NG", "Africa/Libreville": "GA", "Africa/Douala": "CM", "Africa/Accra": "GH", "Africa/Nairobi": "KE", "Africa/Kampala": "UG", "Africa/Dar_es_Salaam": "TZ",
  "Africa/Kigali": "RW", "Africa/Addis_Ababa": "ET", "Africa/Johannesburg": "ZA", "Africa/Cairo": "EG", "Africa/Casablanca": "MA", "Africa/Dakar": "SN", "Africa/Abidjan": "CI",
  "Europe/London": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE", "Europe/Madrid": "ES", "Europe/Rome": "IT", "Europe/Lisbon": "PT", "Europe/Amsterdam": "NL",
  "Europe/Brussels": "BE", "Europe/Vienna": "AT", "Europe/Zurich": "CH", "Europe/Stockholm": "SE", "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Europe/Warsaw": "PL",
  "Europe/Istanbul": "TR", "Europe/Kyiv": "UA", "Europe/Athens": "GR", "Europe/Helsinki": "FI",
  "Asia/Dubai": "AE", "Asia/Riyadh": "SA", "Asia/Qatar": "QA", "Asia/Jerusalem": "IL", "Asia/Kolkata": "IN", "Asia/Karachi": "PK", "Asia/Dhaka": "BD", "Asia/Shanghai": "CN",
  "Asia/Hong_Kong": "HK", "Asia/Taipei": "TW", "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Asia/Singapore": "SG", "Asia/Kuala_Lumpur": "MY", "Asia/Jakarta": "ID", "Asia/Manila": "PH",
  "Asia/Bangkok": "TH", "Asia/Ho_Chi_Minh": "VN", "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Pacific/Auckland": "NZ",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Mexico_City": "MX", "America/Sao_Paulo": "BR", "America/Argentina/Buenos_Aires": "AR", "America/Bogota": "CO",
  "America/Lima": "PE", "America/Santiago": "CL",
};

export function countryOf(user: Pick<User, "tz" | "prefs">): string | null {
  const c = typeof user.prefs?.country === "string" ? (user.prefs.country as string).toUpperCase() : "";
  if (c) return c;
  if (TZ_COUNTRY[user.tz]) return TZ_COUNTRY[user.tz];
  if (/^America\//.test(user.tz)) return "US";
  if (/^Europe\//.test(user.tz)) return "DE"; // the euro, the commonest guess for Europe
  return null;
}

export function userCurrency(user: Pick<User, "tz" | "prefs">): string {
  const own = typeof user.prefs?.currency === "string" ? (user.prefs.currency as string).toUpperCase() : "";
  if (/^[A-Z]{3}$/.test(own)) return own;
  const c = countryOf(user);
  return (c && BY_COUNTRY[c]) || "USD";
}

/** "€12,450" style, in the person's locale-neutral English, with the symbol when one is known. */
export function money(amount: number, currency: string): string {
  try { return new Intl.NumberFormat("en-GB", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: amount % 1 ? 2 : 0 }).format(amount); }
  catch { return `${Math.round(amount).toLocaleString("en-GB")} ${currency}`; }
}
