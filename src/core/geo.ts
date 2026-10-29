/** Places to clocks: any city name, or a shared location, to a time zone and country. Open-Meteo, free, no key. */
export interface Place { name: string; country: string | null; countryName: string | null; tz: string; lat: number; lon: number }

export async function findCity(name: string): Promise<Place | null> {
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name.trim().slice(0, 80))}&count=1&language=en`, { signal: AbortSignal.timeout(8000) });
    const g: any = r.ok ? (await r.json()).results?.[0] : null;
    return g?.timezone ? { name: g.name, country: g.country_code ?? null, countryName: g.country ?? null, tz: g.timezone, lat: g.latitude, lon: g.longitude } : null;
  } catch { return null; }
}

export async function placeAt(lat: number, lon: number): Promise<Place | null> {
  try {
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m&timezone=auto`, { signal: AbortSignal.timeout(8000) });
    const j: any = r.ok ? await r.json() : null;
    return j?.timezone ? { name: j.timezone.split("/").pop().replace(/_/g, " "), country: null, countryName: null, tz: j.timezone, lat, lon } : null;
  } catch { return null; }
}
