/**
 * Fetching an address a person gave us (a site to watch, a status page, a link to summarise): only the
 * public internet. Loopback, private ranges, link-local (cloud metadata at 169.254.169.254), the platform's
 * own private network and non-http schemes are refused, and every redirect hop is checked again.
 * Known limit: the name is resolved here and again by fetch itself, so a hostile DNS server that changes
 * its answer between the two (DNS rebinding) isn't stopped by this alone.
 */
import { BlockList, isIP } from "node:net";
import { lookup } from "node:dns/promises";

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
    const r = await fetch(current, opts);
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
    if (!loc) return r;
    await r.body?.cancel().catch(() => {});
    if (hop >= maxRedirects) throw new BlockedAddress("That address redirects too many times, so I stopped following it.");
    current = new URL(loc, current).href;
    if (r.status === 303 && !/^(?:GET|HEAD)$/i.test(opts.method ?? "GET")) opts = { ...opts, method: "GET", body: undefined };
  }
}
