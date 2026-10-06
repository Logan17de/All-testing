export interface WindowsBrokerReadinessInput {
  readonly version: 1;
  readonly nodeVersion: string;
  readonly caller: "human-broker" | "other-application-sandbox" | "unknown";
  readonly crossUserLaunchPrivileges: "unproven" | "missing" | "reviewed";
  readonly credentialIdentityAndAccess: "unresolved" | "incompatible" | "reviewed";
  readonly effectiveNetworkPolicy: "unreadable" | "unassessed" | "reviewed";
  readonly networkAndIpcProof: "unproven" | "synthetic-only" | "native-reviewed";
  readonly originalAndFutureObjectProof: "unproven" | "synthetic-only" | "native-reviewed";
  readonly sourceAllowlist: "unselected" | "reviewed";
  readonly privateStatePaths: "unselected" | "reviewed";
  readonly commandFamily: "unselected" | "reviewed";
}
export type WindowsBrokerReadinessBlocker =
  | "unsupported-node-version"
  | "caller-identity-unproven"
  | "cross-user-launch-privileges-unproven"
  | "credential-lifecycle-unresolved"
  | "effective-network-policy-unproven"
  | "network-and-ipc-proof-missing"
  | "original-and-future-object-proof-missing"
  | "source-allowlist-unselected"
  | "private-state-paths-unselected"
  | "command-family-unselected"
  | "native-implementation-unavailable";
const values = {
  caller: ["human-broker", "other-application-sandbox", "unknown"],
  crossUserLaunchPrivileges: ["unproven", "missing", "reviewed"],
  credentialIdentityAndAccess: ["unresolved", "incompatible", "reviewed"],
  effectiveNetworkPolicy: ["unreadable", "unassessed", "reviewed"],
  networkAndIpcProof: ["unproven", "synthetic-only", "native-reviewed"],
  originalAndFutureObjectProof: ["unproven", "synthetic-only", "native-reviewed"],
  sourceAllowlist: ["unselected", "reviewed"],
  privateStatePaths: ["unselected", "reviewed"],
  commandFamily: ["unselected", "reviewed"],
} as const;

/** Untrusted review metadata only; neither host attestation nor execution authorization. */
export function assessWindowsBrokerReadiness(input: WindowsBrokerReadinessInput) {
  const refuse = (): never => {
    throw new Error("Invalid Windows broker readiness metadata.");
  };
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    refuse();
  const keys = ["version", "nodeVersion", ...Object.keys(values)];
  const own = Reflect.ownKeys(input);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key)) ||
    own.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, "value"))
  )
    refuse();
  if (
    Object.keys(input).length !== keys.length ||
    Object.keys(input).some((key) => !keys.includes(key)) ||
    input.version !== 1 ||
    typeof input.nodeVersion !== "string" ||
    !/^v?\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(input.nodeVersion)
  )
    refuse();
  for (const key of Object.keys(values) as (keyof typeof values)[])
    if (!(values[key] as readonly string[]).includes(input[key])) refuse();
  const blockers: WindowsBrokerReadinessBlocker[] = [];
  const version = input.nodeVersion.replace(/^v/, "").split(".").map(Number);
  if (version[0] !== 24 || version[1]! < 20) blockers.push("unsupported-node-version");
  if (input.caller !== "human-broker") blockers.push("caller-identity-unproven");
  if (input.crossUserLaunchPrivileges !== "reviewed")
    blockers.push("cross-user-launch-privileges-unproven");
  if (input.credentialIdentityAndAccess !== "reviewed")
    blockers.push("credential-lifecycle-unresolved");
  if (input.effectiveNetworkPolicy !== "reviewed")
    blockers.push("effective-network-policy-unproven");
  if (input.networkAndIpcProof !== "native-reviewed")
    blockers.push("network-and-ipc-proof-missing");
  if (input.originalAndFutureObjectProof !== "native-reviewed")
    blockers.push("original-and-future-object-proof-missing");
  if (input.sourceAllowlist !== "reviewed") blockers.push("source-allowlist-unselected");
  if (input.privateStatePaths !== "reviewed") blockers.push("private-state-paths-unselected");
  if (input.commandFamily !== "reviewed") blockers.push("command-family-unselected");
  // A caller-supplied "reviewed" label never opens the production dispatch gate.
  blockers.push("native-implementation-unavailable");
  return Object.freeze({
    version: 1 as const,
    availability: "disabled" as const,
    executionAuthority: "none" as const,
    evidenceAuthority: "untrusted-review-metadata" as const,
    supportedCandidateApi: "LogonUserW/restricted-primary-token/CreateProcessAsUserW" as const,
    blockers: Object.freeze(blockers),
    decisions: Object.freeze([
      "Prove the exact trusted broker identity, logon type and cross-user launch privileges; never reuse another application's sandbox identity.",
      "Reconcile user-scoped DPAPI identity/profile with access to owned private storage; no machine-scope or plaintext workaround.",
      "Inspect effective network policy and prove exact-token external/loopback IPv4/IPv6 and service-mediated IPC denial before provisioning.",
      "Choose source allowlist, private-state exclusions and fixed command family; preserve original workspace ACLs.",
      "Review the native implementation and obtain separate action-time approval for every account, credential and owned security change.",
    ]),
  });
}
