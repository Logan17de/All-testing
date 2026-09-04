import {
  checkGraphJsonV1Acyclicity,
  type GraphAcyclicityDiagnosticCode,
} from "./graph-json-v1-acyclicity.js";
import {
  checkGraphJsonV1CapabilityPolicy,
  type GraphCapabilityAuthority,
  type GraphCapabilityPolicyDiagnosticCode,
} from "./graph-json-v1-capability-policy.js";
import {
  checkGraphJsonV1EffectRecovery,
  type GraphEffectRecoveryDiagnosticCode,
} from "./graph-json-v1-effect-recovery.js";
import {
  checkGraphJsonV1Liveness,
  type GraphLivenessDiagnosticCode,
} from "./graph-json-v1-liveness.js";
import {
  checkGraphJsonV1LoopBounds,
  type GraphLoopBoundDiagnosticCode,
} from "./graph-json-v1-loop-bounds.js";
import {
  checkGraphJsonV1PortCompatibility,
  type GraphPortCompatibilityDiagnosticCode,
} from "./graph-json-v1-port-compatibility.js";
import {
  checkGraphJsonV1SecretBindings,
  type GraphSecretBindingDiagnosticCode,
} from "./graph-json-v1-secret-bindings.js";
import {
  checkGraphJsonV1Semantics,
  type GraphSemanticDiagnosticCode,
  type NodeManifestResolver,
} from "./graph-json-v1-semantic-validator.js";
import {
  checkGraphJsonV1StructuredControl,
  type GraphStructuredControlDiagnosticCode,
} from "./graph-json-v1-structured-control.js";
import { checkGraphJsonV1Shape, type GraphShapeDiagnosticCode } from "./graph-json-v1-validator.js";
import type { GraphJsonV1 } from "./graph-json-v1.js";

export type GraphDiagnosticCode =
  | GraphShapeDiagnosticCode
  | GraphSemanticDiagnosticCode
  | GraphPortCompatibilityDiagnosticCode
  | GraphLivenessDiagnosticCode
  | GraphAcyclicityDiagnosticCode
  | GraphStructuredControlDiagnosticCode
  | GraphLoopBoundDiagnosticCode
  | GraphCapabilityPolicyDiagnosticCode
  | GraphEffectRecoveryDiagnosticCode
  | GraphSecretBindingDiagnosticCode;

export type GraphDiagnosticStage =
  | "shape"
  | "semantic"
  | "port-compatibility"
  | "liveness"
  | "acyclicity"
  | "structured-control"
  | "loop-bounds"
  | "capability-policy"
  | "effect-recovery"
  | "secret-bindings";

/**
 * Stable compiler/editor-facing Graph JSON diagnostic.
 * This interface is the frozen 2.16 public diagnostic boundary.
 *
 * `path` is a JSON Pointer into Graph JSON source when one precise source
 * location exists. Multi-object findings such as SCCs use related node/edge IDs
 * instead of inventing one misleading path.
 */
export interface GraphDiagnostic {
  readonly code: GraphDiagnosticCode;
  readonly message: string;
  readonly stage: GraphDiagnosticStage;
  readonly path?: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly entrypointId?: string;
  readonly graphPortId?: string;
  readonly port?: string;
  readonly relatedNodeIds?: readonly string[];
  readonly relatedEdgeIds?: readonly string[];
}

export interface GraphJsonV1DiagnosticContext {
  readonly resolver: NodeManifestResolver;
  readonly capabilityAuthority: GraphCapabilityAuthority;
}

export interface GraphJsonV1DiagnosticResult {
  readonly valid: boolean;
  readonly diagnostics: readonly GraphDiagnostic[];
}

interface DiagnosticLike {
  readonly code: GraphDiagnosticCode;
  readonly message: string;
}

function escapeJsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly string[] | undefined {
  const value = record[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function findNodeIndex(graph: GraphJsonV1, nodeId: string): number | undefined {
  const index = graph.nodes.findIndex((node) => node.id === nodeId);
  return index >= 0 ? index : undefined;
}

function findEdgeIndex(graph: GraphJsonV1, edgeId: string): number | undefined {
  const index = graph.edges.findIndex((edge) => edge.id === edgeId);
  return index >= 0 ? index : undefined;
}

function findEntrypointIndex(graph: GraphJsonV1, entrypointId: string): number | undefined {
  const index = graph.entrypoints.findIndex((entrypoint) => entrypoint.id === entrypointId);
  return index >= 0 ? index : undefined;
}

function findGraphPortPath(graph: GraphJsonV1, graphPortId: string): string | undefined {
  const inputIndex = graph.inputs.findIndex((input) => input.id === graphPortId);
  if (inputIndex >= 0) {
    return `/inputs/${inputIndex}`;
  }

  const outputIndex = graph.outputs.findIndex((output) => output.id === graphPortId);
  return outputIndex >= 0 ? `/outputs/${outputIndex}` : undefined;
}

function findBindingPath(
  graph: GraphJsonV1,
  nodeId: string,
  port: string,
  sourceKind: string,
): string | undefined {
  if (sourceKind === "data-edge") {
    return undefined;
  }

  const nodeIndex = findNodeIndex(graph, nodeId);
  if (nodeIndex === undefined) {
    return undefined;
  }

  const bindings = graph.nodes[nodeIndex]?.bindings ?? [];
  const bindingIndex = bindings.findIndex(
    (binding) => binding.port === port && binding.kind === sourceKind,
  );

  return bindingIndex >= 0 ? `/nodes/${nodeIndex}/bindings/${bindingIndex}` : undefined;
}

function derivePath(graph: GraphJsonV1, diagnostic: DiagnosticLike): string | undefined {
  const record = diagnostic as unknown as Readonly<Record<string, unknown>>;
  const explicitPath = readString(record, "path");
  if (explicitPath !== undefined) {
    return explicitPath;
  }

  const edgeId = readString(record, "edgeId");
  if (edgeId !== undefined) {
    const edgeIndex = findEdgeIndex(graph, edgeId);
    if (edgeIndex !== undefined) {
      return `/edges/${edgeIndex}`;
    }
  }

  const entrypointId = readString(record, "entrypointId");
  if (entrypointId !== undefined) {
    const entrypointIndex = findEntrypointIndex(graph, entrypointId);
    if (entrypointIndex !== undefined) {
      return `/entrypoints/${entrypointIndex}`;
    }
  }

  const nodeId = readString(record, "nodeId");
  const port = readString(record, "port");
  const sourceKind = readString(record, "sourceKind");
  if (nodeId !== undefined && port !== undefined && sourceKind !== undefined) {
    const bindingPath = findBindingPath(graph, nodeId, port, sourceKind);
    if (bindingPath !== undefined) {
      return bindingPath;
    }
  }

  const configKey = readString(record, "configKey");
  if (nodeId !== undefined && configKey !== undefined) {
    const nodeIndex = findNodeIndex(graph, nodeId);
    if (nodeIndex !== undefined) {
      return `/nodes/${nodeIndex}/config/${escapeJsonPointerToken(configKey)}`;
    }
  }

  const graphPortId = readString(record, "graphPortId");
  if (graphPortId !== undefined) {
    const graphPortPath = findGraphPortPath(graph, graphPortId);
    if (graphPortPath !== undefined) {
      return graphPortPath;
    }
  }

  if (nodeId !== undefined) {
    const nodeIndex = findNodeIndex(graph, nodeId);
    if (nodeIndex !== undefined) {
      return `/nodes/${nodeIndex}`;
    }
  }

  const policyField = readString(record, "policyField");
  if (policyField !== undefined) {
    return policyField === "maxNodeExecutions"
      ? "/policies/maxNodeExecutions"
      : `/policies/capabilities/${escapeJsonPointerToken(policyField)}`;
  }

  return undefined;
}

function normalizeDiagnostic(
  graph: GraphJsonV1,
  stage: GraphDiagnosticStage,
  diagnostic: DiagnosticLike,
): GraphDiagnostic {
  const record = diagnostic as unknown as Readonly<Record<string, unknown>>;
  const path = derivePath(graph, diagnostic);
  const nodeId = readString(record, "nodeId");
  const edgeId = readString(record, "edgeId");
  const entrypointId = readString(record, "entrypointId");
  const graphPortId = readString(record, "graphPortId");
  const port = readString(record, "port");
  const relatedNodeIds = readStringArray(record, "nodeIds");
  const relatedEdgeIds = readStringArray(record, "edgeIds");

  return {
    code: diagnostic.code,
    message: diagnostic.message,
    stage,
    ...(path === undefined ? {} : { path }),
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(edgeId === undefined ? {} : { edgeId }),
    ...(entrypointId === undefined ? {} : { entrypointId }),
    ...(graphPortId === undefined ? {} : { graphPortId }),
    ...(port === undefined ? {} : { port }),
    ...(relatedNodeIds === undefined ? {} : { relatedNodeIds }),
    ...(relatedEdgeIds === undefined ? {} : { relatedEdgeIds }),
  };
}

function appendDiagnostics(
  target: GraphDiagnostic[],
  graph: GraphJsonV1,
  stage: GraphDiagnosticStage,
  diagnostics: readonly DiagnosticLike[],
): void {
  for (const diagnostic of diagnostics) {
    target.push(normalizeDiagnostic(graph, stage, diagnostic));
  }
}

/**
 * Run the complete frozen Graph JSON validation stack through 2.16.
 *
 * Shape failures stop before semantic validation. Semantic failures stop before
 * compiler-facing stages so callers receive primary source errors instead of a
 * cascade of derivative prerequisite failures. Once both prerequisites pass,
 * stages 2.8-2.15 run in their frozen order and their existing codes/messages are
 * normalized into one stable location model.
 */
export function checkGraphJsonV1Diagnostics(
  value: unknown,
  context: GraphJsonV1DiagnosticContext,
): GraphJsonV1DiagnosticResult {
  const shapeResult = checkGraphJsonV1Shape(value);
  if (!shapeResult.valid) {
    return {
      valid: false,
      diagnostics: shapeResult.diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        message: diagnostic.message,
        stage: "shape",
        path: diagnostic.path,
      })),
    };
  }

  const graph = value as GraphJsonV1;
  const semanticResult = checkGraphJsonV1Semantics(graph, context.resolver);
  if (!semanticResult.valid) {
    return {
      valid: false,
      diagnostics: semanticResult.diagnostics.map((diagnostic) =>
        normalizeDiagnostic(graph, "semantic", diagnostic),
      ),
    };
  }

  const diagnostics: GraphDiagnostic[] = [];

  appendDiagnostics(
    diagnostics,
    graph,
    "port-compatibility",
    checkGraphJsonV1PortCompatibility(graph, context.resolver).diagnostics,
  );
  appendDiagnostics(
    diagnostics,
    graph,
    "liveness",
    checkGraphJsonV1Liveness(graph, context.resolver).diagnostics,
  );
  appendDiagnostics(
    diagnostics,
    graph,
    "acyclicity",
    checkGraphJsonV1Acyclicity(graph).diagnostics,
  );
  appendDiagnostics(
    diagnostics,
    graph,
    "structured-control",
    checkGraphJsonV1StructuredControl(graph, context.resolver).diagnostics,
  );
  appendDiagnostics(
    diagnostics,
    graph,
    "loop-bounds",
    checkGraphJsonV1LoopBounds(graph, context.resolver).diagnostics,
  );
  appendDiagnostics(
    diagnostics,
    graph,
    "capability-policy",
    checkGraphJsonV1CapabilityPolicy(graph, context.resolver, context.capabilityAuthority)
      .diagnostics,
  );
  appendDiagnostics(
    diagnostics,
    graph,
    "effect-recovery",
    checkGraphJsonV1EffectRecovery(graph, context.resolver).diagnostics,
  );
  appendDiagnostics(
    diagnostics,
    graph,
    "secret-bindings",
    checkGraphJsonV1SecretBindings(graph, context.resolver).diagnostics,
  );

  return { valid: diagnostics.length === 0, diagnostics };
}
