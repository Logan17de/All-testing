import { describe, expect, it } from "vitest";

import { guardLocalRequest, type GuardedRequest } from "./local-request-guard";

function request(
  headers: Readonly<Record<string, string>>,
  url = "http://127.0.0.1:3000/api/editor/runs",
): GuardedRequest {
  const lower = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return { url, headers: { get: (name) => lower.get(name.toLowerCase()) ?? null } };
}

async function codeOf(response: Response | undefined): Promise<string | undefined> {
  if (response === undefined) return undefined;
  const body = (await response.json()) as { readonly error: { readonly code: string } };
  return body.error.code;
}

const SAME_ORIGIN = { host: "127.0.0.1:3000", "sec-fetch-site": "same-origin" };

describe("which requests reach the editor proxy", () => {
  it("accepts a same-origin read from loopback", async () => {
    expect(await codeOf(guardLocalRequest(request(SAME_ORIGIN), "read"))).toBeUndefined();
  });

  it.each(["localhost:3000", "[::1]:3000"])("accepts the loopback host %s", async (host) => {
    expect(
      await codeOf(guardLocalRequest(request({ host, "sec-fetch-site": "same-origin" }), "read")),
    ).toBeUndefined();
  });

  it("refuses a request addressed to a LAN interface", async () => {
    expect(await codeOf(guardLocalRequest(request({ host: "192.168.1.20:3000" }), "read"))).toBe(
      "LOCAL_UI_HOST_REJECTED",
    );
  });

  it("refuses a DNS-rebinding host name that resolves to loopback", async () => {
    expect(
      await codeOf(guardLocalRequest(request({ host: "attacker.example:3000" }), "read")),
    ).toBe("LOCAL_UI_HOST_REJECTED");
  });

  it("refuses a request the browser marks as cross-site", async () => {
    expect(
      await codeOf(
        guardLocalRequest(request({ ...SAME_ORIGIN, "sec-fetch-site": "cross-site" }), "read"),
      ),
    ).toBe("LOCAL_UI_CROSS_SITE");
  });

  it("refuses a same-site request from another origin", async () => {
    expect(
      await codeOf(
        guardLocalRequest(request({ ...SAME_ORIGIN, "sec-fetch-site": "same-site" }), "read"),
      ),
    ).toBe("LOCAL_UI_CROSS_SITE");
  });

  it("accepts a direct navigation, which browsers mark as none", async () => {
    expect(
      await codeOf(
        guardLocalRequest(request({ host: "127.0.0.1:3000", "sec-fetch-site": "none" }), "read"),
      ),
    ).toBeUndefined();
  });

  it("refuses a foreign Origin", async () => {
    expect(
      await codeOf(
        guardLocalRequest(request({ ...SAME_ORIGIN, origin: "http://evil.example" }), "read"),
      ),
    ).toBe("LOCAL_UI_ORIGIN_REJECTED");
  });

  it("refuses a loopback Origin on a different port", async () => {
    expect(
      await codeOf(
        guardLocalRequest(request({ ...SAME_ORIGIN, origin: "http://127.0.0.1:9999" }), "read"),
      ),
    ).toBe("LOCAL_UI_ORIGIN_REJECTED");
  });

  it("accepts this app's own Origin", async () => {
    expect(
      await codeOf(
        guardLocalRequest(request({ ...SAME_ORIGIN, origin: "http://127.0.0.1:3000" }), "read"),
      ),
    ).toBeUndefined();
  });

  it("falls back to the URL host when no Host header is present", async () => {
    expect(
      await codeOf(
        guardLocalRequest(request({}, "http://localhost:3000/api/editor/nodes"), "read"),
      ),
    ).toBeUndefined();
    expect(
      await codeOf(guardLocalRequest(request({}, "http://10.0.0.5:3000/api/editor/nodes"), "read")),
    ).toBe("LOCAL_UI_HOST_REJECTED");
  });
});

describe("mutations", () => {
  it("requires a JSON body, which a cross-site form cannot send without a preflight", async () => {
    expect(await codeOf(guardLocalRequest(request(SAME_ORIGIN), "mutation"))).toBe(
      "LOCAL_UI_JSON_REQUIRED",
    );
  });

  it("refuses a text/plain form post", async () => {
    expect(
      await codeOf(
        guardLocalRequest(request({ ...SAME_ORIGIN, "content-type": "text/plain" }), "mutation"),
      ),
    ).toBe("LOCAL_UI_JSON_REQUIRED");
  });

  it("accepts a same-origin JSON mutation", async () => {
    expect(
      await codeOf(
        guardLocalRequest(
          request({ ...SAME_ORIGIN, "content-type": "application/json; charset=utf-8" }),
          "mutation",
        ),
      ),
    ).toBeUndefined();
  });

  it("still refuses a cross-site JSON mutation", async () => {
    expect(
      await codeOf(
        guardLocalRequest(
          request({
            ...SAME_ORIGIN,
            "sec-fetch-site": "cross-site",
            "content-type": "application/json",
          }),
          "mutation",
        ),
      ),
    ).toBe("LOCAL_UI_CROSS_SITE");
  });
});
