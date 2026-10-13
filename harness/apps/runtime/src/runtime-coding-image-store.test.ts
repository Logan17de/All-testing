import { expect, it } from "vitest";
import {
  RuntimeCodingImageStore,
  type CodingImageAuthority,
} from "./runtime-coding-image-store.js";
const image = () =>
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhb0AAAAASUVORK5CYII=",
    "base64",
  );
const authority = (): CodingImageAuthority => ({
  runId: "run",
  sessionId: "session",
  modelId: "model",
  accountId: "account-digest",
  root: "/workspace/project",
  desktopGeneration: 2,
});
const artifact = "10000000-0000-4000-8000-000000000001";
it("leases only opaque image references and refuses every changed authority dimension", async () => {
  const expected = authority();
  const store = new RuntimeCodingImageStore({ isCurrent: () => true });
  try {
    const part = store.createApprovedLease({
      authority: expected,
      bytes: image(),
      artifactId: artifact,
      expiresAt: Date.now() + 10000,
      maxUses: 2,
      approved: true,
    });
    expect(part.artifactRef).toMatch(/^artifact:/);
    expect(JSON.stringify(part)).not.toContain("base64");
    expect(JSON.stringify(part)).not.toContain("workspace");
    for (const changed of [
      { runId: "other" },
      { sessionId: "other" },
      { modelId: "other" },
      { accountId: null },
      { root: "/workspace/other" },
      { desktopGeneration: 3 },
    ])
      await expect(
        store.resolve(part.artifactRef, { ...expected, ...changed }, new AbortController().signal),
      ).rejects.toThrow("unavailable");
    expect(store.partsFor(expected)).toEqual([part]);
    expect(await store.resolve(part.artifactRef, expected, new AbortController().signal)).toEqual(
      image(),
    );
    expect(await store.resolve(part.artifactRef, expected, new AbortController().signal)).toEqual(
      image(),
    );
    await expect(
      store.resolve(part.artifactRef, expected, new AbortController().signal),
    ).rejects.toThrow();
  } finally {
    store.clear();
  }
});
it("latest approved artifact replaces old and expiry/current-account/restart fail closed", async () => {
  let now = 1000,
    current = true;
  const expected = authority();
  const store = new RuntimeCodingImageStore({ isCurrent: () => current, now: () => now });
  try {
    const create = () =>
      store.createApprovedLease({
        authority: expected,
        bytes: image(),
        artifactId: artifact,
        expiresAt: 2000,
        maxUses: 2,
        approved: true,
      });
    const old = create(),
      latest = create();
    await expect(
      store.resolve(old.artifactRef, expected, new AbortController().signal),
    ).rejects.toThrow();
    current = false;
    expect(store.partsFor(expected)).toEqual([]);
    await expect(
      store.resolve(latest.artifactRef, expected, new AbortController().signal),
    ).rejects.toThrow();
    current = true;
    const expired = create();
    now = 2001;
    await expect(
      store.resolve(expired.artifactRef, expected, new AbortController().signal),
    ).rejects.toThrow();
    const fresh = new RuntimeCodingImageStore({ isCurrent: () => true });
    await expect(
      fresh.resolve(expired.artifactRef, expected, new AbortController().signal),
    ).rejects.toThrow();
    fresh.clear();
  } finally {
    store.clear();
  }
});
it("separate approved consent and strict PNG/memory/reuse bounds are mandatory", () => {
  const store = new RuntimeCodingImageStore({ isCurrent: () => true });
  const input = {
    authority: authority(),
    bytes: image(),
    artifactId: artifact,
    expiresAt: Date.now() + 10000,
    maxUses: 1,
    approved: true as const,
  };
  try {
    expect(() => store.createApprovedLease({ ...input, approved: false as never })).toThrow(
      "consent",
    );
    expect(() => store.createApprovedLease({ ...input, maxUses: 9 })).toThrow();
    expect(() => store.createApprovedLease({ ...input, bytes: Buffer.alloc(8_388_609) })).toThrow();
    expect(() => store.createApprovedLease({ ...input, bytes: Buffer.from("not png") })).toThrow();
  } finally {
    store.clear();
  }
});
