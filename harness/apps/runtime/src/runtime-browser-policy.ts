import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export interface BrowserPinnedAddress {
  hostname: string;
  address: string;
  family: 4 | 6;
}
type Resolver = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

function hostname(value: string): string {
  if (/[\\\x00-\x20\x7f/%:@?#]/.test(value)) throw new Error("Invalid browser hostname");
  const name = domainToASCII(value).toLowerCase();
  if (
    !name ||
    name.length > 253 ||
    isIP(name) ||
    name.endsWith(".") ||
    !name.includes(".") ||
    name.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /(?:^|\.)(?:localhost|local|internal|invalid|test|example|onion|home|lan|arpa)$/.test(name)
  )
    throw new Error("Browser scope requires a public DNS hostname");
  return name;
}

function scopedUrl(value: string): URL {
  // Reject parser repairs and escaped authority spellings, including numeric IP aliases.
  if (value !== value.trim() || /[\\\x00-\x20\x7f]/.test(value))
    throw new Error("Invalid browser URL");
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error("Unsupported browser URL");
  const authority = value.match(/^https?:\/\/([^/?#]+)/i)?.[1];
  if (!authority || /[%@]/.test(authority)) throw new Error("Invalid browser authority");
  hostname(url.hostname);
  return url;
}

function inPrefix(value: bigint, base: bigint, bits: number, width: number): boolean {
  const shift = BigInt(width - bits);
  return value >> shift === base >> shift;
}

function ipv6(value: string): bigint {
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const parts =
    halves.length === 2
      ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right]
      : left;
  return parts.reduce((result, part) => (result << 16n) | BigInt(`0x${part}`), 0n);
}

function publicAddress(address: string, family: 4 | 6): boolean {
  if (isIP(address) !== family) return false;
  if (family === 4) {
    const value = address.split(".").reduce((result, part) => (result << 8n) | BigInt(part), 0n);
    // Conservatively exclude every IANA special-purpose allocation, plus multicast.
    const blocks: [string, number][] = [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.31.196.0", 24],
      ["192.52.193.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["192.175.48.0", 24],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ];
    return !blocks.some(([base, bits]) =>
      inPrefix(
        value,
        base.split(".").reduce((n, part) => (n << 8n) | BigInt(part), 0n),
        bits,
        32,
      ),
    );
  }
  // Global unicast only; mapped, translated, scoped and special IPv6 are refused.
  if (address.includes(".") || address.includes("%")) return false;
  const value = ipv6(address);
  return (
    inPrefix(value, ipv6("2000::"), 3, 128) &&
    ![
      ["2001::", 23],
      ["2001:db8::", 32],
      ["2002::", 16],
      ["3fff::", 20],
      ["2620:4f:8000::", 48],
    ].some(([base, bits]) => inPrefix(value, ipv6(String(base)), Number(bits), 128))
  );
}

/** Exact-domain scope. pin() must succeed before a driver starts, and returned
 * addresses must be enforced by its resolver for every connection (no DNS fallback).
 * Source: IANA IPv4/IPv6 Special-Purpose Address Registries. */
export class BrowserDomainPolicy {
  readonly domains: readonly string[];
  private readonly resolve: Resolver;

  constructor(options: { domains: string[]; resolve?: Resolver }) {
    if (!options.domains.length || options.domains.length > 8)
      throw new Error("Browser scope requires 1–8 exact domains");
    this.domains = Object.freeze([
      ...new Set(
        options.domains.map((domain) => {
          if (domain.includes("://")) {
            const url = scopedUrl(domain);
            if (url.pathname !== "/" || url.search || url.hash)
              throw new Error("Scope must contain a domain or origin");
            return hostname(url.hostname);
          }
          return hostname(domain);
        }),
      ),
    ]);
    this.resolve =
      options.resolve ??
      (async (name) => {
        const records = await lookup(name, { all: true, verbatim: true });
        return records.map(({ address, family }) => ({ address, family: family as 4 | 6 }));
      });
  }

  permits(value: string): boolean {
    try {
      return this.domains.includes(hostname(scopedUrl(value).hostname));
    } catch {
      return false;
    }
  }

  async pin(): Promise<BrowserPinnedAddress[]> {
    const result: BrowserPinnedAddress[] = [];
    for (const name of this.domains) {
      const records = await this.resolve(name);
      if (
        !records.length ||
        records.length > 64 ||
        records.some(({ address, family }) => !publicAddress(address, family))
      ) {
        throw new Error(`Browser DNS scope refused for ${name}`);
      }
      for (const record of records) result.push({ hostname: name, ...record });
    }
    return result;
  }
}
