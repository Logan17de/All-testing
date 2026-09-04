import type {
  CapabilityId,
  JsonObject,
  JsonValue,
  NodeDeterminism,
  NodeEffectClass,
  NodeExecutionMode,
  NodeIdempotency,
  NodePortName,
  NodePrimitiveFamily,
  NodeRecoveryPolicy,
  NodeType,
  Version,
} from "@zet-harness/plugin-api";

import type { GraphEntrypointId, GraphNodeId, GraphPortId } from "./graph-json-v1.js";

/** Self-identifying serialized format tag for the first immutable execution plan. */
export const EXECUTION_IR_FORMAT = "harness.ir/v1" as const;

export type ExecutionIrFormat = typeof EXECUTION_IR_FORMAT;

/**
 * Zero-based indexes are the compact identity domain inside Execution IR v1.
 * The op/input/entrypoint array position is authoritative; redundant index fields
 * are deliberately omitted so serialized plans cannot contain conflicting IDs.
 */
export type ExecutionIrOpIndex = number;
export type ExecutionIrGraphInputIndex = number;
export type ExecutionIrEntrypointIndex = number;

export interface ExecutionIrOpOutputRefV1 {
  readonly op: ExecutionIrOpIndex;
  readonly port: NodePortName;
}

export interface ExecutionIrControlEndpointV1 {
  readonly op: ExecutionIrOpIndex;
  readonly port?: NodePortName;
}

/** Indexed control dependency retained for activation/ordering semantics. */
export interface ExecutionIrControlEdgeV1 {
  readonly from: ExecutionIrControlEndpointV1;
  readonly to: ExecutionIrControlEndpointV1;
}

export interface ExecutionIrLiteralSourceV1 {
  readonly kind: "literal";
  readonly value: JsonValue;
}

export interface ExecutionIrGraphInputSourceV1 {
  readonly kind: "graph-input";
  readonly input: ExecutionIrGraphInputIndex;
}

export interface ExecutionIrSecretSourceV1 {
  readonly kind: "secret";
  readonly secretRef: string;
}

export interface ExecutionIrOpOutputSourceV1 extends ExecutionIrOpOutputRefV1 {
  readonly kind: "op-output";
}

/** Every runtime value source is resolved; graph node/input IDs are no longer used internally. */
export type ExecutionIrValueSourceV1 =
  | ExecutionIrLiteralSourceV1
  | ExecutionIrGraphInputSourceV1
  | ExecutionIrSecretSourceV1
  | ExecutionIrOpOutputSourceV1;

/**
 * One resolved source feeding a semantic node input port.
 *
 * Repeated entries for the same port are permitted because a manifest may mark
 * that port `multiple`. Their order remains explicit rather than being silently
 * treated as commutative by the IR contract.
 */
export interface ExecutionIrInputV1 {
  readonly port: NodePortName;
  readonly source: ExecutionIrValueSourceV1;
}

export interface ExecutionIrRetryV1 {
  readonly maxAttempts: number;
  readonly backoffMs?: number;
}

/** Scheduler/runtime behavior copied from the already-resolved node manifest. */
export interface ExecutionIrBehaviorV1 {
  readonly primitiveFamily: NodePrimitiveFamily;
  readonly determinism: NodeDeterminism;
  readonly effect: NodeEffectClass;
  readonly idempotency: NodeIdempotency;
  readonly recovery: NodeRecoveryPolicy;
  readonly executionMode: NodeExecutionMode;
  readonly timeoutMs?: number;
  readonly retry?: ExecutionIrRetryV1;
  readonly requiredCapabilities: readonly CapabilityId[];
}

export interface ExecutionIrRouterControlV1 {
  readonly kind: "router";
  readonly entry: NodePortName;
  readonly branches: readonly NodePortName[];
}

export interface ExecutionIrJoinControlV1 {
  readonly kind: "join";
  readonly inputs: readonly NodePortName[];
  readonly output: NodePortName;
  readonly mode: "all-active";
}

export interface ExecutionIrLoopControlV1 {
  readonly kind: "loop";
  readonly entry: NodePortName;
  readonly continue: NodePortName;
  readonly body: NodePortName;
  readonly exit: NodePortName;
}

export interface ExecutionIrHumanInterruptControlV1 {
  readonly kind: "human-interrupt";
  readonly entry: NodePortName;
  readonly outcomes: readonly NodePortName[];
}

export interface ExecutionIrSubgraphControlV1 {
  readonly kind: "subgraph";
  readonly entry: NodePortName;
  readonly exits: readonly NodePortName[];
}

/**
 * Static structured-control descriptor carried by an op.
 *
 * 2.20 only freezes this representation. Mapping validated graph control edges
 * into DAG/router/join descriptors is owned by 2.22; executable loop semantics
 * remain later work and this union grants no cycle exception.
 */
export type ExecutionIrControlDescriptorV1 =
  | ExecutionIrRouterControlV1
  | ExecutionIrJoinControlV1
  | ExecutionIrLoopControlV1
  | ExecutionIrHumanInterruptControlV1
  | ExecutionIrSubgraphControlV1;

/** One compact executable operation. Its array position is its `ExecutionIrOpIndex`. */
export interface ExecutionIrOpV1 {
  /** Source identity retained only for tracing/inspection; internal references use indexes. */
  readonly sourceNodeId: GraphNodeId;
  readonly type: NodeType;
  readonly version: Version;
  readonly config: JsonObject;
  readonly inputs: readonly ExecutionIrInputV1[];
  /** Precomputed predecessor op indexes used by the scheduler readiness counter. */
  readonly dependencies: readonly ExecutionIrOpIndex[];
  readonly behavior: ExecutionIrBehaviorV1;
  readonly control?: ExecutionIrControlDescriptorV1;
}

/** Public invocation boundary. Schemas were compile-time concerns and are not copied into the IR. */
export interface ExecutionIrGraphInputV1 {
  readonly id: GraphPortId;
  readonly required: boolean;
  readonly default?: JsonValue;
}

/** Public result boundary resolved directly to an op output. */
export interface ExecutionIrGraphOutputV1 {
  readonly id: GraphPortId;
  readonly source: ExecutionIrOpOutputRefV1;
}

/** Named run entry resolved from source node identity to one op index. */
export interface ExecutionIrEntrypointV1 {
  readonly id: GraphEntrypointId;
  readonly op: ExecutionIrOpIndex;
  readonly port?: NodePortName;
}

export interface ExecutionIrCapabilityIntentV1 {
  readonly required: readonly CapabilityId[];
  readonly optional: readonly CapabilityId[];
  readonly deny: readonly CapabilityId[];
}

/** Runtime-visible hard limits and capability intent. Authority itself is never embedded here. */
export interface ExecutionIrPoliciesV1 {
  readonly maxNodeExecutions?: number;
  readonly maxParallelism?: number;
  readonly maxWallTimeMs?: number;
  readonly capabilities: ExecutionIrCapabilityIntentV1;
}

/**
 * Compact immutable executable plan for one compiled Graph JSON v1 program.
 *
 * Deliberately absent in 2.20:
 * - graph/revision/human/editor metadata;
 * - JSON Schemas and manifest documents already consumed by compilation;
 * - external capability grants (graph requests never become grants);
 * - document/semantic/registry/IR hashes, compiler version, and provenance pins
 *   owned by 2.21.
 *
 * `ops`, `graphInputs`, and `entrypoints` are index domains. All internal graph
 * node/input references are resolved to those numeric positions before an IR can
 * be considered executable.
 */
export interface ExecutionIrV1 {
  readonly format: ExecutionIrFormat;
  readonly graphInputs: readonly ExecutionIrGraphInputV1[];
  readonly graphOutputs: readonly ExecutionIrGraphOutputV1[];
  readonly ops: readonly ExecutionIrOpV1[];
  readonly controlEdges: readonly ExecutionIrControlEdgeV1[];
  readonly entrypoints: readonly ExecutionIrEntrypointV1[];
  readonly defaultEntrypoint?: ExecutionIrEntrypointIndex;
  readonly policies: ExecutionIrPoliciesV1;
}

function assertIndex(label: string, index: number, length: number): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
    throw new TypeError(`${label} index ${String(index)} is outside [0, ${String(length)}).`);
  }
}

function assertCanonicalDependencies(opIndex: number, dependencies: readonly number[]): void {
  let previous = -1;
  for (const dependency of dependencies) {
    if (!Number.isSafeInteger(dependency) || dependency < 0) {
      throw new TypeError(`ops[${String(opIndex)}].dependencies contains an invalid index.`);
    }
    if (dependency === opIndex) {
      throw new TypeError(`ops[${String(opIndex)}] cannot depend on itself.`);
    }
    if (dependency <= previous) {
      throw new TypeError(
        `ops[${String(opIndex)}].dependencies must be strictly increasing and unique.`,
      );
    }
    previous = dependency;
  }
}

function assertResolvedIndexes(ir: ExecutionIrV1): void {
  const opCount = ir.ops.length;
  const graphInputCount = ir.graphInputs.length;
  const entrypointCount = ir.entrypoints.length;

  ir.graphOutputs.forEach((output, index) => {
    assertIndex(`graphOutputs[${String(index)}].source.op`, output.source.op, opCount);
  });

  ir.ops.forEach((op, opIndex) => {
    assertCanonicalDependencies(opIndex, op.dependencies);
    for (const dependency of op.dependencies) {
      assertIndex(`ops[${String(opIndex)}].dependencies`, dependency, opCount);
    }

    op.inputs.forEach((input, inputIndex) => {
      switch (input.source.kind) {
        case "graph-input":
          assertIndex(
            `ops[${String(opIndex)}].inputs[${String(inputIndex)}].source.input`,
            input.source.input,
            graphInputCount,
          );
          break;
        case "op-output":
          assertIndex(
            `ops[${String(opIndex)}].inputs[${String(inputIndex)}].source.op`,
            input.source.op,
            opCount,
          );
          break;
        case "literal":
        case "secret":
          break;
      }
    });
  });

  ir.controlEdges.forEach((edge, edgeIndex) => {
    assertIndex(`controlEdges[${String(edgeIndex)}].from.op`, edge.from.op, opCount);
    assertIndex(`controlEdges[${String(edgeIndex)}].to.op`, edge.to.op, opCount);
  });

  ir.entrypoints.forEach((entrypoint, index) => {
    assertIndex(`entrypoints[${String(index)}].op`, entrypoint.op, opCount);
  });

  if (ir.defaultEntrypoint !== undefined) {
    assertIndex("defaultEntrypoint", ir.defaultEntrypoint, entrypointCount);
  }
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) {
      deepFreeze(item);
    }
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreeze(item);
    }
  }

  Object.freeze(value);
}

/**
 * Seal a compiler-produced IR candidate into runtime-immutable Execution IR v1.
 *
 * Invalid numeric references are compiler invariant failures, not Graph JSON user
 * diagnostics: all user-facing validation already happened before lowering. The
 * input is never frozen or mutated; a structured clone is validated and deeply
 * frozen before it is returned.
 */
export function createExecutionIrV1(candidate: ExecutionIrV1): ExecutionIrV1 {
  const clone = structuredClone(candidate);
  assertResolvedIndexes(clone);
  deepFreeze(clone);
  return clone;
}
