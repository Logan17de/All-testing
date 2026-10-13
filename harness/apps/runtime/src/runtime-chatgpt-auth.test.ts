import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ChatGPTPlanAuth } from "./runtime-chatgpt-auth.js";

const hostId = "urn:uuid:11111111-1111-4111-8111-111111111111";
const redirectUri = "http://127.0.0.1:54321/auth/callback";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" };
function jwt(nonce: string, changes: Record<string, unknown> = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString(
    "base64url",
  );
  const body = Buffer.from(
    JSON.stringify({
      iss: "https://auth.openai.com",
      aud: "oaiapp_registered",
      sub: "test-subject",
      nonce,
      iat: 1000,
      exp: 2000,
      ...changes,
    }),
  ).toString("base64url");
  const data = `${header}.${body}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
}
function setup(changes: Record<string, unknown> = {}, claims: Record<string, unknown> = {}) {
  let now = 1_000_000;
  let nonce = "";
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    if (typeof input !== "string") throw new Error("Unexpected request");
    if (input.endsWith("jwks.json")) return Promise.resolve(Response.json({ keys: [jwk] }));
    return Promise.resolve(
      Response.json({
        access_token: "volatile-access-secret",
        refresh_token: "volatile-refresh-secret",
        id_token: jwt(nonce, claims),
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid resource.invoke chatgpt.tokens.use.direct",
        ...changes,
      }),
    );
  });
  const auth = new ChatGPTPlanAuth({ fetch, now: () => now });
  const start = () => {
    const url = new URL(auth.begin({ hostId, redirectUri }).authorizationUrl);
    nonce = url.searchParams.get("nonce")!;
    return url;
  };
  const callback = (url: URL) =>
    `${redirectUri}?state=${url.searchParams.get("state")}&code=code-secret&client_id=oaiapp_registered`;
  return {
    auth,
    fetch,
    start,
    callback,
    advance: () => {
      now += 3_590_000;
    },
  };
}

describe("standalone ChatGPT plan OAuth (mock transport; no real login)", () => {
  it("does nothing until an explicit start and uses independent dynamic registration PKCE", () => {
    const f = setup();
    expect(f.fetch).not.toHaveBeenCalled();
    const a = f.start();
    const b = f.start();
    expect(a.origin + a.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(a.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(a.searchParams.get("agent_name_hint")).toBe("Z harness");
    expect(a.searchParams.get("code_challenge_method")).toBe("S256");
    expect(a.searchParams.get("state")).not.toBe(b.searchParams.get("state"));
    expect(a.searchParams.has("code_verifier")).toBe(false);
  });
  it("validates a signed ID token and exposes only redacted account metadata", async () => {
    const f = setup();
    const start = f.start();
    const account = await f.auth.complete(f.callback(start));
    expect(account.subject).toBe("test-subject");
    expect(JSON.stringify(f.auth)).not.toContain("secret");
    expect(JSON.stringify(account)).not.toContain("secret");
    expect(await f.auth.accessToken()).toBe("volatile-access-secret");
    const init = f.fetch.mock.calls[0]![1]!;
    const form = new URLSearchParams(init.body as string);
    expect(form.get("client_id")).toBe("oaiapp_registered");
    expect(form.get("redirect_uri")).toBe(redirectUri);
    expect(form.get("resource")).toBe("https://api.openai.com/v1");
    expect(form.has("client_secret")).toBe(false);
    const returning = f.start();
    expect(returning.searchParams.get("client_id")).toBe("oaiapp_registered");
    expect(returning.searchParams.has("agent_name_hint")).toBe(false);
  });
  it.each([
    { aud: "wrong" },
    { iss: "https://evil.example" },
    { nonce: "wrong" },
    { exp: 900 },
    { sub: "" },
  ])("rejects invalid signed claims %j", async (claims) => {
    const f = setup({}, claims);
    const start = f.start();
    await expect(f.auth.complete(f.callback(start))).rejects.toThrow("CHATGPT_AUTH_INVALID");
    expect(f.auth.account()).toBeUndefined();
  });
  it("rejects missing grant despite valid identity", async () => {
    const f = setup({ scope: "openid profile email" });
    const start = f.start();
    await expect(f.auth.complete(f.callback(start))).rejects.toThrow(
      "CHATGPT_PLAN_PERMISSION_REQUIRED",
    );
    expect(f.auth.account()).toBeUndefined();
  });
  it("rejects wrong state, duplicate parameters, denial and replay without exchanging", async () => {
    const f = setup();
    let start = f.start();
    await expect(f.auth.complete(f.callback(start) + "&state=duplicate")).rejects.toThrow();
    await expect(f.auth.complete(f.callback(start))).rejects.toThrow();
    start = f.start();
    await expect(
      f.auth.complete(
        `${redirectUri}?state=${start.searchParams.get("state")}&error=access_denied`,
      ),
    ).rejects.toThrow("CHATGPT_AUTH_DENIED");
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("allows only explicit numeric loopback callbacks", () => {
    const f = setup();
    for (const uri of [
      "http://localhost:54321/auth/callback",
      "https://example.com/auth/callback",
      "http://127.0.0.1:54321/callback",
      "http://127.0.0.1:54321/auth/callback?secret=x",
    ])
      expect(() => f.auth.begin({ hostId, redirectUri: uri })).toThrow();
  });
  it("serializes rotating token refreshes and clears volatile credentials", async () => {
    const f = setup();
    await f.auth.complete(f.callback(f.start()));
    f.advance();
    await Promise.all([f.auth.accessToken(), f.auth.accessToken()]);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    const form = new URLSearchParams(f.fetch.mock.calls[2]![1]!.body as string);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.has("scope")).toBe(false);
    f.auth.clear();
    await expect(f.auth.accessToken()).rejects.toThrow("CHATGPT_LOGIN_REQUIRED");
  });
  it("rejects stale login completion after clear", async () => {
    const f = setup();
    const start = f.start();
    const pending = f.auth.complete(f.callback(start));
    f.auth.clear();
    await expect(pending).rejects.toThrow("CHATGPT_AUTH_INVALID");
    expect(f.auth.account()).toBeUndefined();
  });
  it("normalizes transport errors without exposing provider bodies or tokens", async () => {
    const f = setup();
    const start = f.start();
    f.fetch.mockRejectedValueOnce(new Error("provider-body-secret"));
    await expect(f.auth.complete(f.callback(start))).rejects.toThrow("CHATGPT_AUTH_INVALID");
  });
});

it("refuses an invalid signature even with otherwise correct OIDC claims", async () => {
  const f = setup();
  const start = f.start();
  const token = jwt(start.searchParams.get("nonce")!);
  const parts = token.split(".");
  const signature = parts[2]!;
  parts[2] = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  f.fetch.mockResolvedValueOnce(
    Response.json({
      id_token: parts.join("."),
      access_token: "unused",
      refresh_token: "unused",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "resource.invoke chatgpt.tokens.use.direct",
    }),
  );
  await expect(f.auth.complete(f.callback(start))).rejects.toThrow("CHATGPT_AUTH_INVALID");
  expect(f.auth.account()).toBeUndefined();
});

it("rejects an account identity change during reauthorization", async () => {
  const claims: Record<string, unknown> = {};
  const f = setup({}, claims);
  await f.auth.complete(f.callback(f.start()));
  claims.sub = "different-account";
  await expect(f.auth.complete(f.callback(f.start()))).rejects.toThrow("CHATGPT_AUTH_INVALID");
  expect(f.auth.account()?.subject).toBe("test-subject");
});
