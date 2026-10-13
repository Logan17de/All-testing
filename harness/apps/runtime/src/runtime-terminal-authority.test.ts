import { resolve, parse } from "node:path";
import { expect, it } from "vitest";
import {
  RuntimeTerminalAuthority,
  type TerminalAuthorityScope,
} from "./runtime-terminal-authority.js";
const identity = { ownerKey: "a".repeat(43), conversationId: "chat-one" };
const scope: TerminalAuthorityScope = {
  cwd: resolve("fixture-workspace"),
  shell: resolve("fixture-shell.exe"),
  windowsIdentity: "S-1-5-21-fixture",
  trusted: true,
};
it("binds one-use review to owner/chat/exact server scope", () => {
  const authority = new RuntimeTerminalAuthority();
  const review = authority.review(identity, scope);
  expect(authority.review(identity, scope)).toEqual(review);
  expect(authority.get(identity)).toBeUndefined();
  expect(() =>
    authority.confirm(
      { ...identity, ownerKey: "b".repeat(43) },
      { nonce: review.nonce, confirm: true },
      scope,
    ),
  ).toThrow();
  expect(() =>
    authority.confirm(
      { ...identity, conversationId: "other" },
      { nonce: review.nonce, confirm: true },
      scope,
    ),
  ).toThrow();
  const grant = authority.confirm(identity, { nonce: review.nonce, confirm: true }, scope);
  expect(grant).toMatchObject({
    ...identity,
    cwd: scope.cwd,
    shell: scope.shell,
    windowsIdentity: scope.windowsIdentity,
  });
  expect(authority.get(identity)).toBe(grant);
  expect(() =>
    authority.confirm(identity, { nonce: review.nonce, confirm: true }, scope),
  ).toThrow();
});
it("fails closed for expired, revoked and changed reviews/grants", () => {
  let now = 0;
  const authority = new RuntimeTerminalAuthority({ now: () => now, reviewTtlMs: 10, ttlMs: 20 });
  const expired = authority.review(identity, scope);
  now = 10;
  expect(() =>
    authority.confirm(identity, { nonce: expired.nonce, confirm: true }, scope),
  ).toThrow();
  const changed = authority.review(identity, scope);
  expect(() =>
    authority.confirm(
      identity,
      { nonce: changed.nonce, confirm: true },
      { ...scope, shell: resolve("other.exe") },
    ),
  ).toThrow();
  const review = authority.review(identity, scope);
  authority.confirm(identity, { nonce: review.nonce, confirm: true }, scope);
  now = 30;
  expect(authority.get(identity)).toBeUndefined();
  const revoked = authority.review(identity, scope);
  authority.revoke(identity);
  expect(() =>
    authority.confirm(identity, { nonce: revoked.nonce, confirm: true }, scope),
  ).toThrow();
  expect(authority.get(identity)).toBeUndefined();
});
it("refuses untrusted/noncanonical/root folders and bounds authority memory", () => {
  const authority = new RuntimeTerminalAuthority();
  expect(() =>
    authority.review(identity, { ...scope, trusted: false } as unknown as TerminalAuthorityScope),
  ).toThrow();
  expect(() => authority.review(identity, { ...scope, cwd: parse(scope.cwd).root })).toThrow();
  expect(() => authority.review(identity, { ...scope, cwd: "relative" })).toThrow();
  for (let index = 0; index < 128; index++)
    authority.review({ ...identity, conversationId: `chat${index}` }, scope);
  expect(() => authority.review(identity, scope)).toThrow();
  authority.revokeAll();
  expect(authority.review(identity, scope)).toBeDefined();
});
