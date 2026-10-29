/**
 * Where a phone number lives, from its country code: its country and, when the country keeps one clock, its time zone.
 * Used so a text to someone else (a parent's daily reminder) goes out at their 8am, not the sender's.
 * Countries that span several zones (the US and Canada on +1, Russia, Brazil, Mexico, Australia, Indonesia, DR Congo,
 * Mongolia) come back without a zone: ask which city.
 */

const ONE_ZONE: Record<string, [string, string]> = {
  "44": ["GB", "Europe/London"], "353": ["IE", "Europe/Dublin"], "33": ["FR", "Europe/Paris"], "49": ["DE", "Europe/Berlin"], "39": ["IT", "Europe/Rome"],
  "34": ["ES", "Europe/Madrid"], "351": ["PT", "Europe/Lisbon"], "31": ["NL", "Europe/Amsterdam"], "32": ["BE", "Europe/Brussels"], "41": ["CH", "Europe/Zurich"],
  "43": ["AT", "Europe/Vienna"], "45": ["DK", "Europe/Copenhagen"], "46": ["SE", "Europe/Stockholm"], "47": ["NO", "Europe/Oslo"], "358": ["FI", "Europe/Helsinki"],
  "48": ["PL", "Europe/Warsaw"], "420": ["CZ", "Europe/Prague"], "36": ["HU", "Europe/Budapest"], "40": ["RO", "Europe/Bucharest"], "30": ["GR", "Europe/Athens"],
  "90": ["TR", "Europe/Istanbul"], "380": ["UA", "Europe/Kyiv"], "359": ["BG", "Europe/Sofia"], "385": ["HR", "Europe/Zagreb"], "381": ["RS", "Europe/Belgrade"],
  "234": ["NG", "Africa/Lagos"], "233": ["GH", "Africa/Accra"], "254": ["KE", "Africa/Nairobi"], "27": ["ZA", "Africa/Johannesburg"], "255": ["TZ", "Africa/Dar_es_Salaam"],
  "256": ["UG", "Africa/Kampala"], "250": ["RW", "Africa/Kigali"], "251": ["ET", "Africa/Addis_Ababa"], "237": ["CM", "Africa/Douala"], "241": ["GA", "Africa/Libreville"],
  "225": ["CI", "Africa/Abidjan"], "221": ["SN", "Africa/Dakar"], "229": ["BJ", "Africa/Porto-Novo"], "228": ["TG", "Africa/Lome"], "242": ["CG", "Africa/Brazzaville"],
  "20": ["EG", "Africa/Cairo"], "212": ["MA", "Africa/Casablanca"], "216": ["TN", "Africa/Tunis"], "213": ["DZ", "Africa/Algiers"], "260": ["ZM", "Africa/Lusaka"],
  "263": ["ZW", "Africa/Harare"], "265": ["MW", "Africa/Blantyre"], "258": ["MZ", "Africa/Maputo"], "267": ["BW", "Africa/Gaborone"], "264": ["NA", "Africa/Windhoek"],
  "971": ["AE", "Asia/Dubai"], "966": ["SA", "Asia/Riyadh"], "974": ["QA", "Asia/Qatar"], "965": ["KW", "Asia/Kuwait"], "973": ["BH", "Asia/Bahrain"], "968": ["OM", "Asia/Muscat"],
  "972": ["IL", "Asia/Jerusalem"], "962": ["JO", "Asia/Amman"], "961": ["LB", "Asia/Beirut"], "98": ["IR", "Asia/Tehran"],
  "91": ["IN", "Asia/Kolkata"], "92": ["PK", "Asia/Karachi"], "880": ["BD", "Asia/Dhaka"], "94": ["LK", "Asia/Colombo"], "977": ["NP", "Asia/Kathmandu"],
  "65": ["SG", "Asia/Singapore"], "60": ["MY", "Asia/Kuala_Lumpur"], "66": ["TH", "Asia/Bangkok"], "84": ["VN", "Asia/Ho_Chi_Minh"], "63": ["PH", "Asia/Manila"],
  "86": ["CN", "Asia/Shanghai"], "852": ["HK", "Asia/Hong_Kong"], "886": ["TW", "Asia/Taipei"], "81": ["JP", "Asia/Tokyo"], "82": ["KR", "Asia/Seoul"], "64": ["NZ", "Pacific/Auckland"],
  "57": ["CO", "America/Bogota"], "51": ["PE", "America/Lima"], "54": ["AR", "America/Argentina/Buenos_Aires"], "56": ["CL", "America/Santiago"], "58": ["VE", "America/Caracas"],
  "593": ["EC", "America/Guayaquil"], "506": ["CR", "America/Costa_Rica"], "502": ["GT", "America/Guatemala"], "507": ["PA", "America/Panama"], "598": ["UY", "America/Montevideo"],
};
const MANY_ZONES: Record<string, string> = { "1": "US", "7": "RU", "55": "BR", "52": "MX", "61": "AU", "62": "ID", "243": "CD", "976": "MN" };

/** The number's country and, if the country has one clock, its zone. Null when the code isn't known. */
export function zoneForPhone(phone: string): { country: string; tz: string | null } | null {
  const digits = phone.replace(/\D/g, "").replace(/^00/, "");
  if (!/^\+|^00/.test(phone.trim()) && !/^\d{10,15}$/.test(digits)) return null;
  for (const n of [3, 2, 1]) {
    const code = digits.slice(0, n);
    if (ONE_ZONE[code]) return { country: ONE_ZONE[code][0], tz: ONE_ZONE[code][1] };
    if (MANY_ZONES[code]) return { country: MANY_ZONES[code], tz: null };
  }
  return null;
}
