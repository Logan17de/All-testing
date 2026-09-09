import type { NodeBehavior, NodeManifest } from "@zet-harness/plugin-api";
import {
  checkNodeBehaviorPolicy,
  type NodeBehaviorPolicyViolation,
} from "@zet-harness/plugin-api/node-behavior-policy";

import type { GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

export type GraphEffectRecoveryDiagnosticCode =
  | "GRAPH_EFFECT_RECOVERY_PREREQUISITE_FAILED"
  | "GRAPH_EFFECT_FAMILY_MISMATCH"
  | "GRAPH_EFFECT_IDEMPOTENCY_INVALID"
  | "GRAPH_EFFECT_RECOVERY_INVALID"
  | "GRAPH_EFFECT_RETRY_INVALID"
  | "GRAPH_EFFECT_RETRY_UNSAFE";

export interface GraphEffectRecoveryDiagnostic {
  readonly code: GraphEffectRecoveryDiagnosticCode;
  readonly message: string;
  readonly nodeId: string;
  readonly field?:
    "primitiveFamily" | "effect" | "idempotency" | "recovery" | "executionMode" | "retry";
}

export interface GraphEffectRecoveryResult {
  readonly valid: boolean;
  readonly diagnostics: readonly GraphEffectRecoveryDiagnostic[];
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function graphDiagnosticCode(
  violation: NodeBehaviorPolicyViolation,
): GraphEffectRecoveryDiagnosticCode {
  switch (violation.code) {
    case "NODE_BEHAVIOR_EFFECT_FAMILY_MISMATCH":
      return "GRAPH_EFFECT_FAMILY_MISMATCH";
    case "NODE_BEHAVIOR_IDEMPOTENCY_INVALID":
      return "GRAPH_EFFECT_IDEMPOTENCY_INVALID";
    case "NODE_BEHAVIOR_EFFECT_EXECUTION_MODE_INVALID":
    case "NODE_BEHAVIOR_RECOVERY_INVALID":
    case "NODE_BEHAVIOR_RECOVERY_UNSAFE":
      return "GRAPH_EFFECT_RECOVERY_INVALID";
  }
}

function validateBehavior(
  nodeId: string,
  behavior: NodeBehavior,
  diagnostics: GraphEffectRecoveryDiagnostic[],
): void {
  for (const violation of checkNodeBehaviorPolicy(behavior).violations) {
    diagnostics.push({
      code: graphDiagnosticCode(violation),
      message: `Node '${nodeId}' violates behavior policy: ${violation.message}`,
      nodeId,
      field: violation.field,
    });
  }

  const executable = behavior.executionMode !== "none";
  const retry = behavior.retry;
  if (retry === undefined) {
    return;
  }

  if (!executable) {
    diagnostics.push({
      code: "GRAPH_EFFECT_RETRY_INVALID",
      message: `Node '${nodeId}' has no runtime executor and cannot declare retry defaults.`,
      nodeId,
      field: "retry",
    });
  }

  if (!isPositiveSafeInteger(retry.maxAttempts)) {
    diagnostics.push({
      code: "GRAPH_EFFECT_RETRY_INVALID",
      message: `Node '${nodeId}' retry.maxAttempts must be a positive safe integer.`,
      nodeId,
      field: "retry",
    });
  }

  if (retry.backoffMs !== undefined && !isNonNegativeSafeInteger(retry.backoffMs)) {
    diagnostics.push({
      code: "GRAPH_EFFECT_RETRY_INVALID",
      message: `Node '${nodeId}' retry.backoffMs must be a non-negative safe integer.`,
      nodeId,
      field: "retry",
    });
  }

  if (
    isPositiveSafeInteger(retry.maxAttempts) &&
    retry.maxAttempts > 1 &&
    behavior.effect === "external-write" &&
    behavior.idempotency === "unknown"
  ) {
    diagnostics.push({
      code: "GRAPH_EFFECT_RETRY_UNSAFE",
      message: `Node '${nodeId}' is an external write with unknown idempotency and cannot declare automatic retry beyond one attempt.`,
      nodeId,
      field: "retry",
    });
  }
}

/**
 * Run the narrow side-effect/retry/recovery consistency stage.
 *
 * Phase 5.1 owns the shared cross-field effect/idempotency/recovery contract via
 * `checkNodeBehaviorPolicy(...)`; this graph stage delegates those invariants to
 * the public policy helper and adds graph/compiler-specific retry validation.
 * Determinism remains separate from idempotency, and effect-aware retry policy is
 * intentionally kept distinct for the later Phase 5 retry work.
 */
export function checkGraphJsonV1EffectRecovery(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): GraphEffectRecoveryResult {
  const diagnostics: GraphEffectRecoveryDiagnostic[] = [];

  for (const node of graph.nodes) {
    const manifest: NodeManifest | undefined = resolver.getManifest(node.type, node.version);

    if (manifest === undefined) {
      diagnostics.push({
        code: "GRAPH_EFFECT_RECOVERY_PREREQUISITE_FAILED",
        message: `Node '${node.id}' must resolve before side-effect/retry/recovery validation.`,
        nodeId: node.id,
      });
      continue;
    }

    validateBehavior(node.id, manifest.behavior, diagnostics);
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

/** Boolean convenience wrapper for the graph effect/recovery stage. */
export function validateGraphJsonV1EffectRecovery(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): boolean {
  return checkGraphJsonV1EffectRecovery(graph, resolver).valid;
}
