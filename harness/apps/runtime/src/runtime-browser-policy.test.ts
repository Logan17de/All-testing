import { describe, expect, it } from "vitest";
import { BrowserDomainPolicy } from "./runtime-browser-policy.js";

const publicV4 = { address: "93.184.215.14", family: 4 as const };
function policy(addresses = [publicV4]) {
  return new BrowserDomainPolicy({
    domains: ["example.com"],
    resolve: () => Promise.resolve(addresses),
  });
}

describe("BrowserDomainPolicy", () => {
  it("normalizes ASCII exact domains and allows ordinary HTTP URLs", async () => {
    const scope = new BrowserDomainPolicy({
      domains: ["HTTPS://EXAMPLE.COM:443", "bücher.de"],
      resolve: () => Promise.resolve([publicV4]),
    });
    expect(scope.domains).toEqual(["example.com", "xn--bcher-kva.de"]);
    expect(scope.permits("https://example.com/path?q=yes")).toBe(true);
    expect(scope.permits("http://example.com:443/")).toBe(true);
    expect(scope.permits("https://bücher.de/")).toBe(true);
    expect(await scope.pin()).toEqual(scope.domains.map((hostname) => ({ hostname, ...publicV4 })));
  });

  it.each([
    "https://sub.example.com/",
    "https://example.com.evil.org/",
    "https://example.com./",
    "https://user@example.com/",
    "https://@example.com/",
    "https://example.com:8080/",
    "file://example.com/",
    "https://example.com\\@evil.org/",
    "https://%65xample.com/",
    "https://example.com\n/",
    " https://example.com/",
    "https:example.com",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
  ])("refuses out-of-scope or repaired URL %s", (url) => {
    expect(policy().permits(url)).toBe(false);
  });

  it.each([
    "localhost",
    "a.local",
    "a.internal",
    "example.com.",
    "*.example.com",
    "127.0.0.1",
    "[::1]",
    "singlelabel",
    "https://example.com/path",
  ])("rejects invalid scope %s", (domain) => {
    expect(() => new BrowserDomainPolicy({ domains: [domain] })).toThrow();
  });

  it("bounds scope and freezes normalized entries", () => {
    expect(() => new BrowserDomainPolicy({ domains: [] })).toThrow();
    expect(
      () => new BrowserDomainPolicy({ domains: Array<string>(9).fill("example.com") }),
    ).toThrow();
    expect(Object.isFrozen(policy().domains)).toBe(true);
  });

  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.1.2",
    "127.0.0.1",
    "169.254.169.254",
    "172.31.1.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ])("rejects private/reserved IPv4 %s even mixed with public DNS", async (address) => {
    await expect(policy([publicV4, { address, family: 4 }]).pin()).rejects.toThrow(
      "DNS scope refused",
    );
  });

  it.each([
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2001::1",
    "2002:7f00:1::1",
    "3fff::1",
    "2620:4f:8000::1",
  ])("rejects private/reserved IPv6 %s", async (address) => {
    const scope = new BrowserDomainPolicy({
      domains: ["example.com"],
      resolve: () => Promise.resolve([{ address, family: 6 }]),
    });
    await expect(scope.pin()).rejects.toThrow("DNS scope refused");
  });

  it("accepts public IPv6 and refuses mismatched families, empty DNS and errors", async () => {
    const scope = new BrowserDomainPolicy({
      domains: ["example.com"],
      resolve: () => Promise.resolve([{ address: "2606:4700:4700::1111", family: 6 }]),
    });
    expect(await scope.pin()).toHaveLength(1);
    await expect(policy([]).pin()).rejects.toThrow();
    await expect(policy([{ address: "::1", family: 4 }]).pin()).rejects.toThrow();
    const failed = new BrowserDomainPolicy({
      domains: ["example.com"],
      resolve: () => Promise.reject(new Error("DNS failed")),
    });
    await expect(failed.pin()).rejects.toThrow("DNS failed");
  });
});
