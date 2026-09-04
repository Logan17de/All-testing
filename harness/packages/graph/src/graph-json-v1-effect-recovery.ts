import type { NodeBehavior, NodeManifest } from "@zet-harness/plugin-api";

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

function validateBehavior(
  nodeId: string,
  behavior: NodeBehavior,
  diagnostics: GraphEffectRecoveryDiagnostic[],
): void {
  const executable = behavior.executionMode !== "none";

  if (behavior.effect === "none") {
    if (behavior.primitiveFamily === "effect") {
      diagnostics.push({
        code: "GRAPH_EFFECT_FAMILY_MISMATCH",
        message: `Node '${nodeId}' declares primitive family 'effect' but effect class 'none'.`,
        nodeId,
        field: "primitiveFamily",
      });
    }

    if (behavior.idempotency !== "not-applicable") {
      diagnostics.push({
        code: "GRAPH_EFFECT_IDEMPOTENCY_INVALID",
        message: `Node '${nodeId}' has no external effect, so idempotency must be 'not-applicable'.`,
        nodeId,
        field: "idempotency",
      });
    }
  } else {
    if (behavior.primitiveFamily !== "effect") {
      diagnostics.push({
        code: "GRAPH_EFFECT_FAMILY_MISMATCH",
        message: `Node '${nodeId}' declares external effect '${behavior.effect}' but primitive family '${behavior.primitiveFamily}'.`,
        nodeId,
        field: "effect",
      });
    }

    if (!executable) {
      diagnostics.push({
        code: "GRAPH_EFFECT_RECOVERY_INVALID",
        message: `Node '${nodeId}' declares external effect '${behavior.effect}' but has execution mode 'none'.`,
        nodeId,
        field: "executionMode",
      });
    }

    if (behavior.effect === "external-read" && behavior.idempotency !== "idempotent") {
      diagnostics.push({
        code: "GRAPH_EFFECT_IDEMPOTENCY_INVALID",
        message: `Node '${nodeId}' is an external read; repeated reads may differ in result, but must be side-effect-idempotent.`,
        nodeId,
        field: "idempotency",
      });
    }

    if (behavior.effect === "external-write" && behavior.idempotency === "not-applicable") {
      diagnostics.push({
        code: "GRAPH_EFFECT_IDEMPOTENCY_INVALID",
        message: `Node '${nodeId}' is an external write and must declare idempotency as 'idempotent', 'idempotency-key', or 'unknown'.`,
        nodeId,
        field: "idempotency",
      });
    }
  }

  if (!executable) {
    if (behavior.recovery !== "not-applicable") {
      diagnostics.push({
        code: "GRAPH_EFFECT_RECOVERY_INVALID",
        message: `Node '${nodeId}' has no runtime executor, so recovery must be 'not-applicable'.`,
        nodeId,
        field: "recovery",
      });
    }

    if (behavior.retry !== undefined) {
      diagnostics.push({
        code: "GRAPH_EFFECT_RETRY_INVALID",
        message: `Node '${nodeId}' has no runtime executor and cannot declare retry defaults.`,
        nodeId,
        field: "retry",
      });
    }
  } else if (behavior.recovery === "not-applicable") {
    diagnostics.push({
      code: "GRAPH_EFFECT_RECOVERY_INVALID",
      message: `Executable node '${nodeId}' must declare an explicit recovery policy.`,
      nodeId,
      field: "recovery",
    });
  }

  if (behavior.recovery === "reconcile" && behavior.effect !== "external-write") {
    diagnostics.push({
      code: "GRAPH_EFFECT_RECOVERY_INVALID",
      message: `Node '${nodeId}' may use 'reconcile' recovery only for an external write.`,
      nodeId,
      field: "recovery",
    });
  }

  if (
    behavior.effect === "external-write" &&
    behavior.idempotency === "unknown" &&
    behavior.recovery === "rerun"
  ) {
    diagnostics.push({
      code: "GRAPH_EFFECT_RECOVERY_INVALID",
      message: `Node '${nodeId}' is an external write with unknown idempotency and cannot recover by automatic rerun.`,
      nodeId,
      field: "recovery",
    });
  }

  const retry = behavior.retry;
  if (retry === undefined) {
    return;
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
 * Run the narrow 2.14 side-effect/retry/recovery consistency stage.
 *
 * This stage validates static manifest promises only. It deliberately keeps
 * determinism separate from idempotency: deterministic output does not make an
 * external write safe to repeat, and a nondeterministic external read can still
 * be side-effect-idempotent.
 *
 * In particular, automatic retries/reruns for external writes require an
 * idempotency promise. An `unknown` write may use reconcile/manual-style
 * recovery, but the Harness must not infer exactly-once execution.
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
        message: `Node '${node.id}' must resolve before 2.14 side-effect/retry/recovery validation.`,
        nodeId: node.id,
      });
      continue;
    }

    validateBehavior(node.id, manifest.behavior, diagnostics);
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

/** Boolean convenience wrapper for the separate 2.14 effect/recovery stage. */
export function validateGraphJsonV1EffectRecovery(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): boolean {
  return checkGraphJsonV1EffectRecovery(graph, resolver).valid;
}
