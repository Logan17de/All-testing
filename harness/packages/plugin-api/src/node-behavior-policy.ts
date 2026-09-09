import type { NodeBehavior } from "./index.js";

export type NodeBehaviorPolicyViolationCode =
  | "NODE_BEHAVIOR_EFFECT_FAMILY_MISMATCH"
  | "NODE_BEHAVIOR_IDEMPOTENCY_INVALID"
  | "NODE_BEHAVIOR_EFFECT_EXECUTION_MODE_INVALID"
  | "NODE_BEHAVIOR_RECOVERY_INVALID"
  | "NODE_BEHAVIOR_RECOVERY_UNSAFE";

export type NodeBehaviorPolicyField =
  | "primitiveFamily"
  | "effect"
  | "idempotency"
  | "recovery"
  | "executionMode";

export interface NodeBehaviorPolicyViolation {
  readonly code: NodeBehaviorPolicyViolationCode;
  readonly field: NodeBehaviorPolicyField;
  readonly message: string;
}

export interface NodeBehaviorPolicyResult {
  readonly valid: boolean;
  readonly violations: readonly NodeBehaviorPolicyViolation[];
}

/**
 * Validate the Phase 1 cross-field effect/idempotency/recovery contract.
 *
 * This helper is deliberately dependency-free and does not inspect graph state,
 * capabilities, retry counts, executor implementation, or runtime history.
 * Determinism is intentionally orthogonal to repeat safety: deterministic output
 * does not make an external write safe to repeat, and a nondeterministic read can
 * still be side-effect-idempotent.
 *
 * Effect-aware retry rules remain a separate policy layer. In particular, this
 * function does not decide whether `retry.maxAttempts` is safe for an effect.
 */
export function checkNodeBehaviorPolicy(behavior: NodeBehavior): NodeBehaviorPolicyResult {
  const violations: NodeBehaviorPolicyViolation[] = [];
  const executable = behavior.executionMode !== "none";

  if (behavior.effect === "none") {
    if (behavior.primitiveFamily === "effect") {
      violations.push({
        code: "NODE_BEHAVIOR_EFFECT_FAMILY_MISMATCH",
        field: "primitiveFamily",
        message: "Primitive family 'effect' requires an external effect class.",
      });
    }

    if (behavior.idempotency !== "not-applicable") {
      violations.push({
        code: "NODE_BEHAVIOR_IDEMPOTENCY_INVALID",
        field: "idempotency",
        message: "A node with effect class 'none' must use idempotency 'not-applicable'.",
      });
    }
  } else {
    if (behavior.primitiveFamily !== "effect") {
      violations.push({
        code: "NODE_BEHAVIOR_EFFECT_FAMILY_MISMATCH",
        field: "effect",
        message: `External effect '${behavior.effect}' requires primitive family 'effect'.`,
      });
    }

    if (!executable) {
      violations.push({
        code: "NODE_BEHAVIOR_EFFECT_EXECUTION_MODE_INVALID",
        field: "executionMode",
        message: `External effect '${behavior.effect}' requires a runtime execution mode.`,
      });
    }

    if (behavior.effect === "external-read" && behavior.idempotency !== "idempotent") {
      violations.push({
        code: "NODE_BEHAVIOR_IDEMPOTENCY_INVALID",
        field: "idempotency",
        message:
          "An external read must declare side-effect idempotency 'idempotent'; result determinism is separate.",
      });
    }

    if (behavior.effect === "external-write" && behavior.idempotency === "not-applicable") {
      violations.push({
        code: "NODE_BEHAVIOR_IDEMPOTENCY_INVALID",
        field: "idempotency",
        message:
          "An external write must declare idempotency as 'idempotent', 'idempotency-key', or 'unknown'.",
      });
    }
  }

  if (!executable) {
    if (behavior.recovery !== "not-applicable") {
      violations.push({
        code: "NODE_BEHAVIOR_RECOVERY_INVALID",
        field: "recovery",
        message: "A node without a runtime execution mode must use recovery 'not-applicable'.",
      });
    }
  } else if (behavior.recovery === "not-applicable") {
    violations.push({
      code: "NODE_BEHAVIOR_RECOVERY_INVALID",
      field: "recovery",
      message: "An executable node must declare an explicit recovery policy.",
    });
  }

  if (behavior.recovery === "reconcile" && behavior.effect !== "external-write") {
    violations.push({
      code: "NODE_BEHAVIOR_RECOVERY_INVALID",
      field: "recovery",
      message: "Recovery policy 'reconcile' is valid only for an external write.",
    });
  }

  if (
    behavior.effect === "external-write" &&
    behavior.idempotency === "unknown" &&
    behavior.recovery === "rerun"
  ) {
    violations.push({
      code: "NODE_BEHAVIOR_RECOVERY_UNSAFE",
      field: "recovery",
      message: "An external write with unknown idempotency cannot use automatic 'rerun' recovery.",
    });
  }

  return { valid: violations.length === 0, violations };
}

/** Boolean convenience wrapper for the shared behavior policy. */
export function validateNodeBehaviorPolicy(behavior: NodeBehavior): boolean {
  return checkNodeBehaviorPolicy(behavior).valid;
}
