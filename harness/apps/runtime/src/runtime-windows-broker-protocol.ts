export const WINDOWS_BROKER_PROJECT_COMMANDS = Object.freeze([
  "project-test",
  "project-build",
  "project-typecheck",
  "project-lint",
] as const);
export interface WindowsBrokerReviewRequest {
  readonly version: 1;
  readonly command: (typeof WINDOWS_BROKER_PROJECT_COMMANDS)[number];
  readonly ownerId: string;
  readonly runId: string;
  readonly workerSid: string;
  readonly sourceDigest: string;
  readonly toolDigest: string;
  readonly nonceDigest: string;
  readonly expiresAtMs: number;
}
const sequence = Object.freeze([
  ["attested", "synthetic-attestation"],
  ["restricted-token-prepared", "synthetic-restricted-primary-token"],
  ["private-desktop-prepared", "synthetic-private-desktop"],
  ["child-created-suspended", "synthetic-suspended-child"],
  ["actual-child-token-verified", "synthetic-child-token-readback"],
  ["job-contained", "synthetic-job-containment"],
  ["denial-proof", "synthetic-access-and-network-denial"],
  ["ready-for-review", "synthetic-review-summary"],
] as const);
export type WindowsBrokerPreparationPhase = "disabled" | "cancelled" | (typeof sequence)[number][0];
export interface WindowsBrokerPreparationEvent {
  readonly version: 1;
  readonly type: (typeof sequence)[number][0] | "cancel";
  readonly evidence: (typeof sequence)[number][1] | "synthetic-cancellation";
  readonly binding: WindowsBrokerReviewRequest;
}
export interface WindowsBrokerPreparationState {
  readonly version: 1;
  readonly purpose: "preparation-only";
  readonly availability: "disabled";
  readonly executionAuthority: "none";
  readonly evidenceTrust: "synthetic-only";
  readonly phase: WindowsBrokerPreparationPhase;
  readonly request: WindowsBrokerReviewRequest;
  readonly prerequisites: readonly [
    "cross-user-launch-unresolved",
    "native-acceptance-pending",
    "human-approval-required",
    "worker-sid-local-ownership-unattested",
  ];
  readonly cleanup: readonly (
    "owned-job" | "owned-child-process" | "owned-private-desktop" | "owned-restricted-token"
  )[];
}
function refuse(): never {
  throw new Error("Invalid Windows broker preparation metadata.");
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    refuse();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.prototype.hasOwnProperty.call(Object.getOwnPropertyDescriptor(value, key), "value"),
    )
  )
    refuse();
}
function time(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) refuse();
}
const requestKeys = Object.freeze([
  "version",
  "command",
  "ownerId",
  "runId",
  "workerSid",
  "sourceDigest",
  "toolDigest",
  "nonceDigest",
  "expiresAtMs",
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function request(input: unknown, nowMs: number, cancellation = false): WindowsBrokerReviewRequest {
  exact(input, requestKeys);
  time(nowMs);
  time(input.expiresAtMs);
  if (input.version !== 1 || !WINDOWS_BROKER_PROJECT_COMMANDS.includes(input.command as never))
    refuse();
  if (
    typeof input.ownerId !== "string" ||
    !uuid.test(input.ownerId) ||
    typeof input.runId !== "string" ||
    !uuid.test(input.runId)
  )
    refuse();
  if (
    typeof input.workerSid !== "string" ||
    !/^S-1-5-21-(?:[1-9]\d{0,9}-){3}[1-9]\d{0,9}$/.test(input.workerSid)
  )
    refuse();
  if (
    input.workerSid
      .slice(9)
      .split("-")
      .some((part) => Number(part) > 0xffffffff)
  )
    refuse();
  for (const key of ["sourceDigest", "toolDigest", "nonceDigest"])
    if (typeof input[key] !== "string" || !/^[0-9a-f]{64}$/.test(input[key])) refuse();
  if ((!cancellation && input.expiresAtMs <= nowMs) || input.expiresAtMs - nowMs > 300000) refuse();
  return Object.freeze({
    version: 1,
    command: input.command as WindowsBrokerReviewRequest["command"],
    ownerId: input.ownerId,
    runId: input.runId,
    workerSid: input.workerSid,
    sourceDigest: input.sourceDigest as string,
    toolDigest: input.toolDigest as string,
    nonceDigest: input.nonceDigest as string,
    expiresAtMs: input.expiresAtMs,
  });
}
function state(
  binding: WindowsBrokerReviewRequest,
  phase: WindowsBrokerPreparationPhase,
): WindowsBrokerPreparationState {
  return Object.freeze({
    version: 1,
    purpose: "preparation-only",
    availability: "disabled",
    executionAuthority: "none",
    evidenceTrust: "synthetic-only",
    phase,
    request: binding,
    prerequisites: Object.freeze([
      "cross-user-launch-unresolved",
      "native-acceptance-pending",
      "human-approval-required",
      "worker-sid-local-ownership-unattested",
    ] as const),
    cleanup: Object.freeze(
      phase === "cancelled"
        ? ([
            "owned-job",
            "owned-child-process",
            "owned-private-desktop",
            "owned-restricted-token",
          ] as const)
        : [],
    ),
  });
}
/** Metadata only. SID shape does not attest local ownership; hashes do not attest identity.
 * A future host must verify machine SID prefix and transaction-owned creation receipt.
 * Neither an imported request nor a transition authorizes OS work. */
export function prepareWindowsBrokerReviewRequest(
  input: WindowsBrokerReviewRequest,
  nowMs: number,
): WindowsBrokerPreparationState {
  return state(request(input, nowMs), "disabled");
}
/** Pure synthetic lifecycle; deliberately has no launch, resume, execution or apply event.
 * Serialized state can be fabricated or replayed. It is not protected custody or issuer attestation;
 * a real broker must maintain its own protected state and fresh independent authorization. */
export function reduceWindowsBrokerPreparation(
  current: WindowsBrokerPreparationState,
  event: WindowsBrokerPreparationEvent,
  nowMs: number,
): WindowsBrokerPreparationState {
  exact(current, [
    "version",
    "purpose",
    "availability",
    "executionAuthority",
    "evidenceTrust",
    "phase",
    "request",
    "prerequisites",
    "cleanup",
  ]);
  if (
    current.version !== 1 ||
    current.purpose !== "preparation-only" ||
    current.availability !== "disabled" ||
    current.executionAuthority !== "none" ||
    current.evidenceTrust !== "synthetic-only"
  )
    refuse();
  if (
    JSON.stringify(current.prerequisites) !==
      JSON.stringify(state(current.request, "disabled").prerequisites) ||
    !Array.isArray(current.cleanup) ||
    current.cleanup.length !== 0
  )
    refuse();
  if (current.phase === "cancelled") refuse();
  const index =
    current.phase === "disabled" ? -1 : sequence.findIndex((item) => item[0] === current.phase);
  if (index < 0 && current.phase !== "disabled") refuse();
  exact(event, ["version", "type", "evidence", "binding"]);
  const cancellation = event.type === "cancel";
  const binding = request(current.request, nowMs, cancellation);
  const incoming = request(event.binding, nowMs, cancellation);
  if (
    requestKeys.some(
      (key) =>
        binding[key as keyof WindowsBrokerReviewRequest] !==
        incoming[key as keyof WindowsBrokerReviewRequest],
    ) ||
    event.version !== 1
  )
    refuse();
  if (event.type === "cancel") {
    if (event.evidence !== "synthetic-cancellation") refuse();
    return state(binding, "cancelled");
  }
  const next = sequence[index + 1];
  if (!next || event.type !== next[0] || event.evidence !== next[1]) refuse();
  return state(binding, next[0]);
}
