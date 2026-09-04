import type { JsonObject, JsonSchema, JsonValue, NodeManifest } from "@zet-harness/plugin-api";

import type { GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

export type JsonPrimitiveSchemaType =
  "array" | "boolean" | "integer" | "null" | "number" | "object" | "string";

export type JsonSchemaPortCompatibilityReason =
  | "exact"
  | "impossible-source"
  | "universal-target"
  | "same-primitive"
  | "integer-to-number"
  | "incompatible-primitive"
  | "unsupported-inference";

export interface JsonSchemaPortCompatibilityDecision {
  readonly compatible: boolean;
  readonly reason: JsonSchemaPortCompatibilityReason;
}

export type GraphPortCompatibilityDiagnosticCode =
  | "GRAPH_PORT_TYPE_INCOMPATIBLE"
  | "GRAPH_PORT_COMPATIBILITY_UNSUPPORTED"
  | "GRAPH_PORT_COMPATIBILITY_PREREQUISITE_FAILED";

export interface GraphPortCompatibilityDiagnostic {
  readonly code: GraphPortCompatibilityDiagnosticCode;
  readonly message: string;
  readonly edgeId?: string;
  readonly nodeId?: string;
  readonly port?: string;
  readonly graphPortId?: string;
}

export interface GraphPortCompatibilityResult {
  readonly valid: boolean;
  readonly diagnostics: readonly GraphPortCompatibilityDiagnostic[];
}

const PRIMITIVE_SCHEMA_TYPES = new Set<JsonPrimitiveSchemaType>([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

/**
 * Draft 2020-12 annotations that do not constrain the accepted instance set.
 *
 * Keeping this list explicit is part of the 2.8 compatibility boundary. New
 * schema keywords do not silently become compatibility rules.
 */
const NON_CONSTRAINING_TARGET_KEYS = new Set([
  "$comment",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function jsonValuesExactlyEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }

  if (isJsonArray(left) || isJsonArray(right)) {
    if (!isJsonArray(left) || !isJsonArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => jsonValuesExactlyEqual(value, right[index]!));
  }

  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftObject: JsonObject = left;
  const rightObject: JsonObject = right;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();

  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }

  return leftKeys.every((key) => jsonValuesExactlyEqual(leftObject[key]!, rightObject[key]!));
}

function schemasExactlyEqual(source: JsonSchema, target: JsonSchema): boolean {
  if (typeof source === "boolean" || typeof target === "boolean") {
    return source === target;
  }

  return jsonValuesExactlyEqual(source, target);
}

function getSinglePrimitiveType(schema: JsonObject): JsonPrimitiveSchemaType | undefined {
  const type = schema.type;

  if (typeof type !== "string" || !PRIMITIVE_SCHEMA_TYPES.has(type as JsonPrimitiveSchemaType)) {
    return undefined;
  }

  return type as JsonPrimitiveSchemaType;
}

function isAnnotationOnlySchema(schema: JsonObject): boolean {
  return Object.keys(schema).every((key) => NON_CONSTRAINING_TARGET_KEYS.has(key));
}

function getUnconstrainedPrimitiveTargetType(
  schema: JsonObject,
): JsonPrimitiveSchemaType | undefined {
  const type = getSinglePrimitiveType(schema);
  if (type === undefined) {
    return undefined;
  }

  for (const key of Object.keys(schema)) {
    if (key !== "type" && !NON_CONSTRAINING_TARGET_KEYS.has(key)) {
      return undefined;
    }
  }

  return type;
}

/**
 * Classify the deliberately constrained Graph JSON v1 schema compatibility rule.
 *
 * This function never treats unknown compatibility as compatible. When the
 * frozen v1 rules cannot establish safety, the result is `unsupported-inference`
 * rather than an attempt to reason about arbitrary JSON Schema implication.
 */
export function classifyJsonSchemaPortCompatibility(
  source: JsonSchema,
  target: JsonSchema,
): JsonSchemaPortCompatibilityDecision {
  if (schemasExactlyEqual(source, target)) {
    return { compatible: true, reason: "exact" };
  }

  if (source === false) {
    return { compatible: true, reason: "impossible-source" };
  }

  if (target === true || (typeof target !== "boolean" && isAnnotationOnlySchema(target))) {
    return { compatible: true, reason: "universal-target" };
  }

  if (source === true) {
    return { compatible: false, reason: "incompatible-primitive" };
  }

  if (typeof source === "boolean" || typeof target === "boolean") {
    return { compatible: false, reason: "unsupported-inference" };
  }

  const sourceType = getSinglePrimitiveType(source);
  const targetType = getUnconstrainedPrimitiveTargetType(target);

  if (sourceType === undefined || targetType === undefined) {
    return { compatible: false, reason: "unsupported-inference" };
  }

  if (sourceType === targetType) {
    return { compatible: true, reason: "same-primitive" };
  }

  if (sourceType === "integer" && targetType === "number") {
    return { compatible: true, reason: "integer-to-number" };
  }

  return { compatible: false, reason: "incompatible-primitive" };
}

/**
 * Boolean convenience wrapper around the classified compatibility decision.
 * Unknown/unsupported inference always returns false.
 */
export function isJsonSchemaPortCompatible(source: JsonSchema, target: JsonSchema): boolean {
  return classifyJsonSchemaPortCompatibility(source, target).compatible;
}

function resolveManifests(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): Map<string, NodeManifest> | undefined {
  const manifests = new Map<string, NodeManifest>();

  for (const node of graph.nodes) {
    const manifest = resolver.getManifest(node.type, node.version);
    if (manifest === undefined) {
      return undefined;
    }
    manifests.set(node.id, manifest);
  }

  return manifests;
}

function compatibilityDiagnostic(
  decision: JsonSchemaPortCompatibilityDecision,
  messagePrefix: string,
  location: Omit<GraphPortCompatibilityDiagnostic, "code" | "message">,
): GraphPortCompatibilityDiagnostic | undefined {
  if (decision.compatible) {
    return undefined;
  }

  if (decision.reason === "unsupported-inference") {
    return {
      code: "GRAPH_PORT_COMPATIBILITY_UNSUPPORTED",
      message: `${messagePrefix}: compatibility requires JSON-Schema reasoning that Harness v1 deliberately does not perform.`,
      ...location,
    };
  }

  return {
    code: "GRAPH_PORT_TYPE_INCOMPATIBLE",
    message: `${messagePrefix}: source and target port schemas are incompatible under Harness v1 rules.`,
    ...location,
  };
}

/**
 * Run only the 2.8 schema-to-schema value-flow compatibility stage.
 *
 * This remains separate from the 2.6-2.7 semantic validator. It reports
 * incompatible versus deliberately unsupported inference without broadening the
 * compatibility model. Literal values, secret references, control edges,
 * reachability/liveness, and impossible-producer diagnostics are owned elsewhere.
 */
export function checkGraphJsonV1PortCompatibility(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): GraphPortCompatibilityResult {
  const manifests = resolveManifests(graph, resolver);
  if (manifests === undefined) {
    return {
      valid: false,
      diagnostics: [
        {
          code: "GRAPH_PORT_COMPATIBILITY_PREREQUISITE_FAILED",
          message: "Port compatibility requires all graph nodes to resolve before 2.8 runs.",
        },
      ],
    };
  }

  const diagnostics: GraphPortCompatibilityDiagnostic[] = [];
  const graphInputs = new Map(graph.inputs.map((input) => [input.id, input] as const));

  for (const output of graph.outputs) {
    const sourcePort = manifests.get(output.source.nodeId)?.outputs[output.source.port];

    if (sourcePort === undefined) {
      diagnostics.push({
        code: "GRAPH_PORT_COMPATIBILITY_PREREQUISITE_FAILED",
        message: `Graph output '${output.id}' references an unresolved source port; 2.6-2.7 must succeed before 2.8.`,
        nodeId: output.source.nodeId,
        port: output.source.port,
        graphPortId: output.id,
      });
      continue;
    }

    const diagnostic = compatibilityDiagnostic(
      classifyJsonSchemaPortCompatibility(sourcePort.schema, output.schema),
      `Graph output '${output.id}' from '${output.source.nodeId}.${output.source.port}'`,
      {
        nodeId: output.source.nodeId,
        port: output.source.port,
        graphPortId: output.id,
      },
    );

    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    }
  }

  for (const node of graph.nodes) {
    const manifest = manifests.get(node.id);
    if (manifest === undefined) {
      continue;
    }

    for (const binding of node.bindings ?? []) {
      if (binding.kind !== "graph-input") {
        continue;
      }

      const graphInput = graphInputs.get(binding.input);
      const targetPort = manifest.inputs[binding.port];

      if (graphInput === undefined || targetPort === undefined) {
        diagnostics.push({
          code: "GRAPH_PORT_COMPATIBILITY_PREREQUISITE_FAILED",
          message: `Graph-input binding '${binding.input}' -> '${node.id}.${binding.port}' is unresolved; 2.6-2.7 must succeed before 2.8.`,
          nodeId: node.id,
          port: binding.port,
          graphPortId: binding.input,
        });
        continue;
      }

      const diagnostic = compatibilityDiagnostic(
        classifyJsonSchemaPortCompatibility(graphInput.schema, targetPort.schema),
        `Graph input '${binding.input}' to '${node.id}.${binding.port}'`,
        {
          nodeId: node.id,
          port: binding.port,
          graphPortId: binding.input,
        },
      );

      if (diagnostic !== undefined) {
        diagnostics.push(diagnostic);
      }
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind !== "data") {
      continue;
    }

    const sourcePort = manifests.get(edge.from.nodeId)?.outputs[edge.from.port];
    const targetPort = manifests.get(edge.to.nodeId)?.inputs[edge.to.port];

    if (sourcePort === undefined || targetPort === undefined) {
      diagnostics.push({
        code: "GRAPH_PORT_COMPATIBILITY_PREREQUISITE_FAILED",
        message: `Data edge '${edge.id}' contains an unresolved port; 2.6-2.7 must succeed before 2.8.`,
        edgeId: edge.id,
      });
      continue;
    }

    const diagnostic = compatibilityDiagnostic(
      classifyJsonSchemaPortCompatibility(sourcePort.schema, targetPort.schema),
      `Data edge '${edge.id}' from '${edge.from.nodeId}.${edge.from.port}' to '${edge.to.nodeId}.${edge.to.port}'`,
      { edgeId: edge.id, nodeId: edge.to.nodeId, port: edge.to.port },
    );

    if (diagnostic !== undefined) {
      diagnostics.push(diagnostic);
    }
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

/** Boolean convenience wrapper for the separate 2.8 compatibility stage. */
export function validateGraphJsonV1PortCompatibility(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): boolean {
  return checkGraphJsonV1PortCompatibility(graph, resolver).valid;
}
