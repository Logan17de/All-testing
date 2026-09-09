import type { CapabilityId } from "@zet-harness/plugin-api";

export type CapabilityPermissionDecision = "allow" | "deny";
export type CapabilityPermissionDenialReason = "explicitly-denied" | "not-granted";

export interface CapabilityPermissionPolicyConfig {
  readonly granted?: readonly CapabilityId[];
  readonly denied?: readonly CapabilityId[];
}

export interface CapabilityPermissionEvaluation {
  readonly capability: CapabilityId;
  readonly decision: CapabilityPermissionDecision;
  readonly denialReason?: CapabilityPermissionDenialReason;
}

export interface CapabilityPermissionBatchResult {
  readonly allowed: boolean;
  readonly evaluations: readonly CapabilityPermissionEvaluation[];
  readonly allowedCapabilities: readonly CapabilityId[];
  readonly explicitlyDeniedCapabilities: readonly CapabilityId[];
  readonly notGrantedCapabilities: readonly CapabilityId[];
}

function assertCapabilityId(capability: CapabilityId): void {
  if (capability.length === 0 || capability !== capability.trim()) {
    throw new TypeError("Capability id must be a non-empty trimmed string.");
  }
}

function uniqueCapabilityIds(values: readonly CapabilityId[]): readonly CapabilityId[] {
  const seen = new Set<CapabilityId>();
  const result: CapabilityId[] = [];

  for (const capability of values) {
    assertCapabilityId(capability);
    if (!seen.has(capability)) {
      seen.add(capability);
      result.push(capability);
    }
  }

  return Object.freeze(result);
}

/**
 * Host-owned v1 capability permission policy.
 *
 * Capability IDs are opaque, exact, case-sensitive strings. V1 intentionally
 * has no wildcard, prefix, hierarchy, or implication semantics: granting
 * `fs:read` does not grant `fs:read:metadata`, and granting `network` does not
 * grant `network:https`.
 *
 * The policy is default-deny. Explicit denial wins over a grant when the same
 * capability appears in both sets. Inputs are copied into immutable snapshots
 * so later caller mutation cannot alter an already-created authority decision.
 *
 * This class only defines permission semantics. Phase 5.6 will apply it to
 * graph/node capability requirements at compile time, and Phase 5.7 will
 * re-check actual capability use at invocation time.
 */
export class CapabilityPermissionPolicy {
  readonly grantedCapabilities: readonly CapabilityId[];
  readonly deniedCapabilities: readonly CapabilityId[];
  readonly effectiveCapabilities: readonly CapabilityId[];

  private readonly granted: ReadonlySet<CapabilityId>;
  private readonly denied: ReadonlySet<CapabilityId>;

  constructor(config: CapabilityPermissionPolicyConfig = {}) {
    this.grantedCapabilities = uniqueCapabilityIds(config.granted ?? []);
    this.deniedCapabilities = uniqueCapabilityIds(config.denied ?? []);
    this.granted = new Set(this.grantedCapabilities);
    this.denied = new Set(this.deniedCapabilities);
    this.effectiveCapabilities = Object.freeze(
      this.grantedCapabilities.filter((capability) => !this.denied.has(capability)),
    );

    Object.freeze(this);
  }

  evaluate(capability: CapabilityId): CapabilityPermissionEvaluation {
    assertCapabilityId(capability);

    if (this.denied.has(capability)) {
      return Object.freeze({
        capability,
        decision: "deny",
        denialReason: "explicitly-denied",
      });
    }

    if (this.granted.has(capability)) {
      return Object.freeze({ capability, decision: "allow" });
    }

    return Object.freeze({
      capability,
      decision: "deny",
      denialReason: "not-granted",
    });
  }

  allows(capability: CapabilityId): boolean {
    return this.evaluate(capability).decision === "allow";
  }

  /**
   * Evaluate an all-of capability requirement set.
   *
   * Duplicate requirements are collapsed by exact ID while preserving the first
   * occurrence order. Callers that model optional capabilities should evaluate
   * those separately rather than weakening this all-required result.
   */
  evaluateAll(capabilities: readonly CapabilityId[]): CapabilityPermissionBatchResult {
    const requested = uniqueCapabilityIds(capabilities);
    const evaluations = Object.freeze(requested.map((capability) => this.evaluate(capability)));
    const allowedCapabilities: CapabilityId[] = [];
    const explicitlyDeniedCapabilities: CapabilityId[] = [];
    const notGrantedCapabilities: CapabilityId[] = [];

    for (const evaluation of evaluations) {
      if (evaluation.decision === "allow") {
        allowedCapabilities.push(evaluation.capability);
      } else if (evaluation.denialReason === "explicitly-denied") {
        explicitlyDeniedCapabilities.push(evaluation.capability);
      } else {
        notGrantedCapabilities.push(evaluation.capability);
      }
    }

    return Object.freeze({
      allowed: explicitlyDeniedCapabilities.length === 0 && notGrantedCapabilities.length === 0,
      evaluations,
      allowedCapabilities: Object.freeze(allowedCapabilities),
      explicitlyDeniedCapabilities: Object.freeze(explicitlyDeniedCapabilities),
      notGrantedCapabilities: Object.freeze(notGrantedCapabilities),
    });
  }
}
