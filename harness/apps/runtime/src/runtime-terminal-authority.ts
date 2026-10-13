import { randomBytes } from "node:crypto";
import { isAbsolute, normalize, parse } from "node:path";
import {
  TerminalError,
  type HumanTerminalGrant,
  type TerminalIdentity,
} from "./runtime-terminal-service.js";

export interface TerminalAuthorityScope {
  readonly cwd: string;
  readonly shell: string;
  readonly windowsIdentity: string;
  readonly trusted: true;
}
export interface TerminalGrantReview {
  readonly nonce: string;
  readonly identity: string;
  readonly shell: string;
  readonly cwd: string;
  readonly conversationId: string;
  readonly expiresAt: number;
  readonly policyVersion: string;
}
type Review = {
  identity: TerminalIdentity;
  scope: TerminalAuthorityScope;
  view: TerminalGrantReview;
};
const denied = () =>
  new TerminalError(
    "TERMINAL_GRANT_DENIED",
    "Terminal authority review expired, changed or was refused.",
    409,
  );

/** Human host authority only, volatile and independent of all model/tool permissions. */
export class RuntimeTerminalAuthority {
  readonly #reviews = new Map<string, Review>();
  readonly #grants = new Map<string, HumanTerminalGrant>();
  readonly #now: () => number;
  readonly #reviewTtl: number;
  readonly #grantTtl: number;
  readonly #policyVersion: string;
  constructor(
    options: {
      now?: () => number;
      reviewTtlMs?: number;
      ttlMs?: number;
      policyVersion?: string;
    } = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#reviewTtl = options.reviewTtlMs ?? 60_000;
    this.#grantTtl = options.ttlMs ?? 300_000;
    this.#policyVersion = options.policyVersion ?? "human-host-terminal-v1";
    if (
      ![this.#reviewTtl, this.#grantTtl].every(
        (value) => Number.isSafeInteger(value) && value > 0 && value <= 600_000,
      ) ||
      !this.#policyVersion ||
      this.#policyVersion.length > 128
    )
      throw denied();
  }
  #key(identity: TerminalIdentity) {
    if (
      !identity.ownerKey ||
      identity.ownerKey.length > 128 ||
      !identity.conversationId ||
      identity.conversationId.length > 128
    )
      throw denied();
    return JSON.stringify([identity.ownerKey, identity.conversationId]);
  }
  #scope(scope: TerminalAuthorityScope) {
    if (
      scope.trusted !== true ||
      !isAbsolute(scope.cwd) ||
      normalize(scope.cwd) !== scope.cwd ||
      scope.cwd === parse(scope.cwd).root ||
      scope.cwd.length > 4096 ||
      !isAbsolute(scope.shell) ||
      scope.shell.length > 4096 ||
      !scope.windowsIdentity ||
      scope.windowsIdentity.length > 256 ||
      /[\x00-\x1f]/u.test(scope.cwd + scope.shell + scope.windowsIdentity)
    )
      throw denied();
  }
  #same(a: TerminalAuthorityScope, b: TerminalAuthorityScope) {
    return (
      a.cwd === b.cwd &&
      a.shell === b.shell &&
      a.windowsIdentity === b.windowsIdentity &&
      b.trusted === true
    );
  }
  #prune() {
    for (const [key, value] of this.#reviews)
      if (value.view.expiresAt <= this.#now()) this.#reviews.delete(key);
    for (const [key, value] of this.#grants)
      if (value.expiresAt <= this.#now()) this.#grants.delete(key);
  }
  review(identity: TerminalIdentity, scope: TerminalAuthorityScope): TerminalGrantReview {
    const key = this.#key(identity);
    this.#scope(scope);
    this.#prune();
    const previous = this.#reviews.get(key);
    if (previous && this.#same(previous.scope, scope)) return previous.view;
    this.#reviews.delete(key);
    if (this.#reviews.size + this.#grants.size >= 128) throw denied();
    const view = Object.freeze({
      nonce: randomBytes(32).toString("base64url"),
      identity: scope.windowsIdentity,
      shell: scope.shell,
      cwd: scope.cwd,
      conversationId: identity.conversationId,
      expiresAt: this.#now() + this.#reviewTtl,
      policyVersion: this.#policyVersion,
    });
    this.#reviews.set(key, {
      identity: Object.freeze({ ...identity }),
      scope: Object.freeze({ ...scope }),
      view,
    });
    return view;
  }
  confirm(
    identity: TerminalIdentity,
    input: { nonce: string; confirm: true },
    scope: TerminalAuthorityScope,
  ): HumanTerminalGrant {
    const key = this.#key(identity);
    this.#prune();
    const review = this.#reviews.get(key);
    if (!review || input.confirm !== true || input.nonce !== review.view.nonce) throw denied();
    this.#reviews.delete(key); // consume before scope validation; a changed review cannot be replayed
    this.#scope(scope);
    if (!this.#same(review.scope, scope) || review.view.policyVersion !== this.#policyVersion)
      throw denied();
    const grant = Object.freeze({
      ...identity,
      cwd: scope.cwd,
      shell: scope.shell,
      windowsIdentity: scope.windowsIdentity,
      nonce: review.view.nonce,
      expiresAt: this.#now() + this.#grantTtl,
    });
    this.#grants.set(key, grant);
    return grant;
  }
  get(identity: TerminalIdentity): HumanTerminalGrant | undefined {
    const key = this.#key(identity);
    this.#prune();
    return this.#grants.get(key);
  }
  revoke(identity: TerminalIdentity): void {
    const key = this.#key(identity);
    this.#reviews.delete(key);
    this.#grants.delete(key);
  }
  revokeAll(): void {
    this.#reviews.clear();
    this.#grants.clear();
  }
}
