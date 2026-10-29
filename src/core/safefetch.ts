/**
 * Fetching an address a person gave us (a site to watch, a status page, a link to summarise): only the
 * public internet. Loopback, private ranges, link-local (cloud metadata at 169.254.169.254), the platform's
 * own private network and non-http schemes are refused, and every redirect hop is checked again.
 * DNS rebinding (a name that answers with a public address when checked, then a private one when fetched) is
 * stopped too: the connection itself resolves through `safeLookup`, which refuses private answers, so the address
 * checked is the address connected to. The TLS probe uses the same lookup.
 */
import { BlockList, isIP, type LookupFunction } from "node:net";
import dns, { type LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";

const blocked = new BlockList();
for (const [net, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) blocked.addSubnet(net, bits, "ipv4");
// IPv4-mapped IPv6 (::ffff:a.b.c.d) is checked against the IPv4 ranges by BlockList itself.
for (const [net, bits] of [["::", 127], ["64:ff9b::", 96], ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8]] as const) blocked.addSubnet(net, bits, "ipv6");

/** A public unicast address (not loopback, private, link-local, reserved or an IPv4 address hidden in IPv6). */
export function isPublicIp(ip: string): boolean {
  const v = isIP(ip);
  return v !== 0 && !blocked.check(ip, v === 6 ? "ipv6" : "ipv4");
}

/** A person-facing refusal: the address isn't on the public internet. */
export class BlockedAddress extends Error {}
const PRIVATE = "That address isn't on the public internet (it points to a private or local address), so I won't open it. I only check public websites.";

/** Thrown inside the connection when a name resolves to a private address. */
const REBIND = "EBLOCKEDADDR";

/**
 * A DNS lookup for sockets that only ever hands back public addresses. Used at connect time, so whatever the name
 * resolves to at that moment is what's checked: a second, different answer can't slip through.
 */
export const safeLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, verbatim: true, family: (options as any)?.family ?? 0 }, (err, addrs) => {
    if (err) return (callback as any)(err);
    const list = (addrs as unknown as LookupAddress[]) ?? [];
    if (!list.length || list.some((a) => !isPublicIp(a.address))) return (callback as any)(Object.assign(new Error(PRIVATE), { code: REBIND }));
    if ((options as any)?.all) return (callback as any)(null, list);
    return (callback as any)(null, list[0].address, list[0].family);
  });
};

/** Connections for addresses people give us: every socket resolves through safeLookup. */
const pinned = new Agent({ connect: { lookup: safeLookup as any } });
/** The fetch this file was loaded with. Tests replace globalThis.fetch with a mock; then the mock is used as is. */
const nativeFetch = globalThis.fetch;
const send = (url: string, init: RequestInit): Promise<Response> =>
  globalThis.fetch === nativeFetch ? (undiciFetch(url, { ...(init as any), dispatcher: pinned }) as unknown as Promise<Response>) : globalThis.fetch(url, init);

/** Swappable in tests: every address a host name resolves to. */
export const resolver = { lookup: async (host: string): Promise<string[]> => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address) };

/** The URL, if it's http(s) on a public host. Throws BlockedAddress otherwise; a name that doesn't resolve throws the DNS error. */
export async function checkPublic(raw: string | URL): Promise<URL> {
  const u = new URL(String(raw));
  if (!/^https?:$/.test(u.protocol)) throw new BlockedAddress("I can only open http and https addresses.");
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (!host || /(?:^|\.)(?:localhost|local|internal|lan|home\.arpa|localdomain)$/.test(host)) throw new BlockedAddress(PRIVATE);
  const ips = isIP(host) ? [host] : await resolver.lookup(host);
  if (!ips.length || ips.some((ip) => !isPublicIp(ip))) throw new BlockedAddress(PRIVATE);
  return u;
}

/** fetch, for an address someone gave us: public hosts only, redirects followed by hand (at most five) and each hop checked. */
export async function publicFetch(url: string | URL, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = String(url);
  let opts: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    await checkPublic(current);
    let r: Response;
    try { r = await send(current, opts); } catch (e: any) {
      if (e?.cause?.code === REBIND || e?.code === REBIND) throw new BlockedAddress(PRIVATE);
      throw e;
    }
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!loc) return r;
    await r.body?.cancel().catch(() => {});
    if (hop >= maxRedirects) throw new BlockedAddress("That address redirects too many times, so I stopped following it.");
    current = new URL(loc, current).href;
    if (r.status === 303 && !/^(?:GET|HEAD)$/i.test(opts.method ?? "GET")) opts = { ...opts, method: "GET", body: undefined };
  }
}
