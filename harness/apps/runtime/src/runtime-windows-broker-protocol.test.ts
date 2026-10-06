import { expect, it } from "vitest";
import {
  prepareWindowsBrokerReviewRequest,
  reduceWindowsBrokerPreparation,
  type WindowsBrokerReviewRequest,
  type WindowsBrokerPreparationEvent,
} from "./runtime-windows-broker-protocol.js";
const input: WindowsBrokerReviewRequest = {
  version: 1,
  command: "project-test",
  ownerId: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000002",
  workerSid: "S-1-5-21-100-200-300-400",
  sourceDigest: "a".repeat(64),
  toolDigest: "b".repeat(64),
  nonceDigest: "c".repeat(64),
  expiresAtMs: 200000,
};
const event = (
  type: WindowsBrokerPreparationEvent["type"],
  evidence: WindowsBrokerPreparationEvent["evidence"],
): WindowsBrokerPreparationEvent => ({ version: 1, type, evidence, binding: input });
it("keeps the complete correctly ordered synthetic lifecycle disabled and immutable", () => {
  let state = prepareWindowsBrokerReviewRequest(input, 0);
  for (const [type, evidence] of [
    ["attested", "synthetic-attestation"],
    ["restricted-token-prepared", "synthetic-restricted-primary-token"],
    ["private-desktop-prepared", "synthetic-private-desktop"],
    ["child-created-suspended", "synthetic-suspended-child"],
    ["actual-child-token-verified", "synthetic-child-token-readback"],
    ["job-contained", "synthetic-job-containment"],
    ["denial-proof", "synthetic-access-and-network-denial"],
    ["ready-for-review", "synthetic-review-summary"],
  ] as const) {
    state = reduceWindowsBrokerPreparation(state, event(type, evidence), 1);
    expect(state.availability).toBe("disabled");
    expect(state.executionAuthority).toBe("none");
    expect(Object.isFrozen(state.request)).toBe(true);
    expect(
      reduceWindowsBrokerPreparation(state, event("cancel", "synthetic-cancellation"), 200001)
        .phase,
    ).toBe("cancelled");
  }
  expect(state.phase).toBe("ready-for-review");
  expect(state.evidenceTrust).toBe("synthetic-only");
  expect(
    reduceWindowsBrokerPreparation(state, event("cancel", "synthetic-cancellation"), 200001).phase,
  ).toBe("cancelled");
  expect(() =>
    reduceWindowsBrokerPreparation(state, event("attested", "synthetic-attestation"), 2),
  ).toThrow();
});
it("rejects unsupported inputs, arbitrary commands, secrets and imported approvals", () => {
  const hidden = Object.defineProperty({ ...input }, "argv", { value: ["bad"], enumerable: false });
  expect(() => prepareWindowsBrokerReviewRequest(hidden, 0)).toThrow();
  let getterCalled = false;
  const accessor = Object.defineProperty({ ...input }, "command", {
    get: () => {
      getterCalled = true;
      return "project-test";
    },
  });
  expect(() => prepareWindowsBrokerReviewRequest(accessor, 0)).toThrow();
  expect(getterCalled).toBe(false);
  for (const change of [
    { version: 2 },
    { command: "node --eval bad" },
    { workerSid: "S-1-5-18" },
    { workerSid: "S-1-5-21-100-200-300-4294967296" },
    { sourceDigest: "A".repeat(64) },
    { nonceDigest: "x" },
    { ownerId: "not-a-uuid" },
    { expiresAtMs: 0 },
    { expiresAtMs: 300001 },
    { argv: [] },
    { env: {} },
    { password: "synthetic" },
    { approved: true },
    { path: "C:\\source" },
  ])
    expect(() =>
      prepareWindowsBrokerReviewRequest({ ...input, ...change } as WindowsBrokerReviewRequest, 0),
    ).toThrow();
});
it("rejects out-of-order events, replay, stale bindings and expiry", () => {
  const initial = prepareWindowsBrokerReviewRequest(input, 0);
  expect(() =>
    reduceWindowsBrokerPreparation(initial, null as unknown as WindowsBrokerPreparationEvent, 1),
  ).toThrow("Invalid Windows broker preparation metadata.");
  expect(() =>
    reduceWindowsBrokerPreparation(
      initial,
      event("child-created-suspended", "synthetic-suspended-child"),
      1,
    ),
  ).toThrow();
  const attested = reduceWindowsBrokerPreparation(
    initial,
    event("attested", "synthetic-attestation"),
    1,
  );
  expect(() =>
    reduceWindowsBrokerPreparation(attested, event("attested", "synthetic-attestation"), 2),
  ).toThrow();
  for (const key of [
    "ownerId",
    "runId",
    "workerSid",
    "sourceDigest",
    "toolDigest",
    "nonceDigest",
    "command",
    "expiresAtMs",
  ] as const) {
    const replacement = {
      ...input,
      [key]:
        key === "expiresAtMs"
          ? 200001
          : key === "command"
            ? "project-build"
            : key === "workerSid"
              ? "S-1-5-21-100-200-300-401"
              : key.endsWith("Id")
                ? "00000000-0000-4000-8000-000000000003"
                : "d".repeat(64),
    };
    expect(() =>
      reduceWindowsBrokerPreparation(
        initial,
        {
          ...event("attested", "synthetic-attestation"),
          binding: replacement,
        },
        1,
      ),
    ).toThrow();
  }
  expect(() =>
    reduceWindowsBrokerPreparation(initial, event("attested", "synthetic-attestation"), 200000),
  ).toThrow();
  expect(() =>
    reduceWindowsBrokerPreparation(
      initial,
      {
        ...event("attested", "synthetic-attestation"),
        resume: true,
      } as WindowsBrokerPreparationEvent,
      1,
    ),
  ).toThrow();
});
it("cancels every unfinished phase without providing a resume transition", () => {
  const initial = prepareWindowsBrokerReviewRequest(input, 0);
  const cancelled = reduceWindowsBrokerPreparation(
    initial,
    event("cancel", "synthetic-cancellation"),
    1,
  );
  expect(cancelled.phase).toBe("cancelled");
  expect(cancelled.cleanup).toEqual([
    "owned-job",
    "owned-child-process",
    "owned-private-desktop",
    "owned-restricted-token",
  ]);
  expect(() =>
    reduceWindowsBrokerPreparation(cancelled, event("attested", "synthetic-attestation"), 2),
  ).toThrow();
});
