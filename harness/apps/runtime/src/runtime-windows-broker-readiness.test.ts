import { expect, it } from "vitest";
import {
  assessWindowsBrokerReadiness,
  type WindowsBrokerReadinessInput,
} from "./runtime-windows-broker-readiness.js";

const unknownHost: WindowsBrokerReadinessInput = {
  version: 1,
  nodeVersion: "24.19.0",
  caller: "other-application-sandbox",
  crossUserLaunchPrivileges: "missing",
  credentialIdentityAndAccess: "incompatible",
  effectiveNetworkPolicy: "unreadable",
  networkAndIpcProof: "synthetic-only",
  originalAndFutureObjectProof: "unproven",
  sourceAllowlist: "unselected",
  privateStatePaths: "unselected",
  commandFamily: "unselected",
};

it("separates unsupported runtime, foreign identity, credentials, unreadable policy and missing scope", () => {
  const result = assessWindowsBrokerReadiness(unknownHost);
  expect(result.blockers).toEqual([
    "unsupported-node-version",
    "caller-identity-unproven",
    "cross-user-launch-privileges-unproven",
    "credential-lifecycle-unresolved",
    "effective-network-policy-unproven",
    "network-and-ipc-proof-missing",
    "original-and-future-object-proof-missing",
    "source-allowlist-unselected",
    "private-state-paths-unselected",
    "command-family-unselected",
    "native-implementation-unavailable",
  ]);
  expect(Object.isFrozen(result.blockers)).toBe(true);
});

it("cannot authorize execution even when every imported assessment claims review", () => {
  const result = assessWindowsBrokerReadiness({
    ...unknownHost,
    nodeVersion: "v24.20.0",
    caller: "human-broker",
    crossUserLaunchPrivileges: "reviewed",
    credentialIdentityAndAccess: "reviewed",
    effectiveNetworkPolicy: "reviewed",
    networkAndIpcProof: "native-reviewed",
    originalAndFutureObjectProof: "native-reviewed",
    sourceAllowlist: "reviewed",
    privateStatePaths: "reviewed",
    commandFamily: "reviewed",
  });
  expect(result).toMatchObject({
    availability: "disabled",
    executionAuthority: "none",
    evidenceAuthority: "untrusted-review-metadata",
  });
  expect(result.blockers).toEqual(["native-implementation-unavailable"]);
});

it("rejects malformed metadata and imported execution or credential fields without exposing them", () => {
  let getterCalled = false;
  const accessor = { ...unknownHost };
  Object.defineProperty(accessor, "caller", {
    get() {
      getterCalled = true;
      return "human-broker";
    },
  });
  expect(() => assessWindowsBrokerReadiness(accessor)).toThrow(
    "Invalid Windows broker readiness metadata.",
  );
  expect(getterCalled).toBe(false);
  const hiddenApproval = Object.defineProperty({ ...unknownHost }, "approved", { value: true });
  expect(() => assessWindowsBrokerReadiness(hiddenApproval)).toThrow();
  for (const extra of [
    { password: "synthetic-private" },
    { approved: true },
    { caller: "admin" },
    { nodeVersion: "25.0.0-beta" },
  ])
    expect(() =>
      assessWindowsBrokerReadiness({ ...unknownHost, ...extra } as WindowsBrokerReadinessInput),
    ).toThrow("Invalid Windows broker readiness metadata.");
  for (const version of ["24.19.99", "25.0.0", "23.99.0"])
    expect(
      assessWindowsBrokerReadiness({ ...unknownHost, nodeVersion: version }).blockers,
    ).toContain("unsupported-node-version");
});
