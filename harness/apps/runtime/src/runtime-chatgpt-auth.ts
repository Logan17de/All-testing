import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN_ENDPOINT = `${ISSUER}/api/accounts/oauth/token`;
const REQUIRED_SCOPES = ["resource.invoke", "chatgpt.tokens.use.direct"];
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const random = () => randomBytes(32).toString("base64url");

export class ChatGPTAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ChatGPTAuthError";
  }
}
const fail = (): never => {
  throw new ChatGPTAuthError("CHATGPT_AUTH_INVALID");
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function safeUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    return fail();
  }
}
function required(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 16384) return fail();
  return value;
}

export interface ChatGPTAccount {
  readonly clientId: string;
  readonly subject: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}
interface Credentials extends ChatGPTAccount {
  accessToken: string;
  refreshToken: string;
}
interface Attempt {
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  clientId: string | undefined;
  subject: string | undefined;
  expiresAt: number;
}

/** Optional server-side OAuth plumbing. Constructing it performs no login or network operation.
 * Call begin only after an explicit user action and after a loopback listener is running.
 * All credentials/transactions are private and volatile; persistence requires separate consent.
 */
export class ChatGPTPlanAuth {
  #attempt: Attempt | undefined;
  #generation = 0;
  #credentials: Credentials | undefined;
  #refresh: Promise<void> | undefined;
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => number;
  constructor(options: { fetch?: typeof globalThis.fetch; now?: () => number } = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
  }

  account(): ChatGPTAccount | undefined {
    const value = this.#credentials;
    return value
      ? {
          clientId: value.clientId,
          subject: value.subject,
          expiresAt: value.expiresAt,
          scopes: [...value.scopes],
        }
      : undefined;
  }
  toJSON(): { connected: boolean } {
    return { connected: this.#credentials !== undefined };
  }
  cancel(): void {
    this.#attempt = undefined;
    this.#generation++;
  }
  clear(): void {
    this.cancel();
    this.#credentials = undefined;
  }

  begin(options: { hostId: string; redirectUri: string }): {
    authorizationUrl: string;
    expiresAt: number;
  } {
    this.cancel();
    const callback = safeUrl(options.redirectUri);
    if (
      callback.protocol !== "http:" ||
      callback.hostname !== "127.0.0.1" ||
      callback.pathname !== "/auth/callback" ||
      callback.search ||
      callback.hash ||
      callback.username ||
      callback.password ||
      !callback.port
    )
      fail();
    if (!/^urn:uuid:[0-9a-f-]{36}$/iu.test(options.hostId)) fail();
    const current = this.#credentials;
    const attempt: Attempt = {
      state: random(),
      nonce: random(),
      verifier: random(),
      redirectUri: callback.href,
      clientId: current?.clientId,
      subject: current?.subject,
      expiresAt: this.#now() + 600_000,
    };
    this.#attempt = attempt;
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({
      client_id: attempt.clientId ?? "dynamic_agent_client",
      ext_agent_host_id: options.hostId,
      ...(attempt.clientId ? {} : { agent_name_hint: "Z harness" }),
      redirect_uri: attempt.redirectUri,
      response_type: "code",
      scope: SCOPE,
      resource: RESOURCE,
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(attempt.verifier).digest("base64url"),
    }).toString();
    return { authorizationUrl: url.href, expiresAt: attempt.expiresAt };
  }

  async #json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    try {
      const response = await this.#fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new ChatGPTAuthError("CHATGPT_AUTH_HTTP_ERROR");
      if (!response.body) return fail();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 262_144) return fail();
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return object(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
    } catch (error) {
      if (error instanceof ChatGPTAuthError) throw error;
      throw new ChatGPTAuthError("CHATGPT_AUTH_INVALID");
    }
  }

  async #identity(token: string, clientId: string, nonce: string): Promise<string> {
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return fail();
      const [headerPart, bodyPart, signaturePart] = parts;
      if (!headerPart || !bodyPart || !signaturePart) return fail();
      const header = object(
        JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as unknown,
      );
      if (header.alg !== "RS256" || header.crit !== undefined) return fail();
      const kid = required(header.kid);
      const jwks = await this.#json(`${ISSUER}/.well-known/jwks.json`);
      if (!Array.isArray(jwks.keys)) return fail();
      const matching = jwks.keys
        .map(object)
        .filter(
          (key) =>
            key.kid === kid &&
            key.kty === "RSA" &&
            (key.use === undefined || key.use === "sig") &&
            (key.alg === undefined || key.alg === "RS256"),
        );
      if (matching.length !== 1) return fail();
      const key = createPublicKey({
        key: matching[0] as JsonWebKey,
        format: "jwk",
      });
      if (
        !verify(
          "RSA-SHA256",
          Buffer.from(`${headerPart}.${bodyPart}`),
          key,
          Buffer.from(signaturePart, "base64url"),
        )
      )
        return fail();
      const claims = object(
        JSON.parse(Buffer.from(bodyPart, "base64url").toString("utf8")) as unknown,
      );
      const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud;
      const now = this.#now() / 1000;
      if (
        claims.iss !== ISSUER ||
        !Array.isArray(audiences) ||
        !audiences.includes(clientId) ||
        (audiences.length > 1 && claims.azp !== clientId) ||
        claims.nonce !== nonce ||
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= now ||
        typeof claims.iat !== "number" ||
        !Number.isFinite(claims.iat) ||
        claims.iat > now + 5 ||
        (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + 5))
      )
        return fail();
      return required(claims.sub);
    } catch (error) {
      if (error instanceof ChatGPTAuthError) throw error;
      return fail();
    }
  }

  #tokens(value: Record<string, unknown>, clientId: string, subject: string): Credentials {
    if (
      value.token_type !== "Bearer" ||
      typeof value.expires_in !== "number" ||
      !Number.isFinite(value.expires_in) ||
      value.expires_in <= 0 ||
      value.expires_in > 86400
    )
      return fail();
    const scopes = required(value.scope).split(/\s+/u);
    if (!REQUIRED_SCOPES.every((scope) => scopes.includes(scope)))
      throw new ChatGPTAuthError("CHATGPT_PLAN_PERMISSION_REQUIRED");
    return {
      clientId,
      subject,
      scopes,
      accessToken: required(value.access_token),
      refreshToken: required(value.refresh_token),
      expiresAt: this.#now() + value.expires_in * 1000,
    };
  }

  async complete(callbackUrl: string): Promise<ChatGPTAccount> {
    const attempt = this.#attempt;
    const generation = this.#generation;
    this.#attempt = undefined; // consume before asynchronous work, including errors
    if (!attempt || attempt.expiresAt <= this.#now()) return fail();
    const callback = safeUrl(callbackUrl);
    const expected = safeUrl(attempt.redirectUri);
    if (
      callback.origin !== expected.origin ||
      callback.pathname !== expected.pathname ||
      callback.hash ||
      callback.username ||
      callback.password
    )
      return fail();
    for (const name of ["state", "code", "client_id", "error"])
      if (callback.searchParams.getAll(name).length > 1) return fail();
    if (callback.searchParams.get("state") !== attempt.state) return fail();
    if (callback.searchParams.has("error")) throw new ChatGPTAuthError("CHATGPT_AUTH_DENIED");
    const clientId = callback.searchParams.get("client_id") ?? attempt.clientId;
    if (
      !clientId ||
      !/^oaiapp_[A-Za-z0-9_-]+$/u.test(clientId) ||
      (attempt.clientId && clientId !== attempt.clientId)
    )
      return fail();
    const code = required(callback.searchParams.get("code"));
    const value = await this.#json(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        code_verifier: attempt.verifier,
        redirect_uri: attempt.redirectUri,
        resource: RESOURCE,
      }).toString(),
    });
    const subject = await this.#identity(required(value.id_token), clientId, attempt.nonce);
    if (attempt.subject && subject !== attempt.subject) return fail();
    const credentials = this.#tokens(value, clientId, subject);
    if (generation !== this.#generation) return fail();
    this.#credentials = credentials;
    return this.account()!;
  }

  /** Runtime credential provider only: never return this value in a UI/RPC/log. */
  async accessToken(): Promise<string> {
    if (!this.#credentials) throw new ChatGPTAuthError("CHATGPT_LOGIN_REQUIRED");
    if (this.#credentials.expiresAt <= this.#now() + 30_000) {
      this.#refresh ??= this.#renew().finally(() => {
        this.#refresh = undefined;
      });
      await this.#refresh;
    }
    if (!this.#credentials) throw new ChatGPTAuthError("CHATGPT_LOGIN_REQUIRED");
    return this.#credentials.accessToken;
  }
  async #renew(): Promise<void> {
    const old = this.#credentials;
    if (!old) return fail();
    const value = await this.#json(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: old.clientId,
        refresh_token: old.refreshToken,
        resource: RESOURCE,
      }).toString(),
    });
    const replacement = this.#tokens(value, old.clientId, old.subject);
    if (this.#credentials === old) this.#credentials = replacement;
  }
}
