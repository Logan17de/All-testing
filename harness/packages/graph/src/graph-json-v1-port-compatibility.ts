import type { JsonObject, JsonSchema, JsonValue, NodeManifest } from "@zet-harness/plugin-api";

import type { GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

export type JsonPrimitiveSchemaType =
  | "array"
  | "boolean"
  | "integer"
  | "null"
  | "number"
  | "object"
  | "string";

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

function jsonValuesExactlyEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((value, index) => jsonValuesExactlyEqual(value, right[index]!));
  }

  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftObject = left as JsonObject;
  const rightObject = right as JsonObject;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();

  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }

  return leftKeys.every((key) =>
    jsonValuesExactlyEqual(leftObject[key]!, rightObject[key]!),
  );
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
 * Deliberately constrained Graph JSON v1 schema compatibility.
 *
 * `source` is compatible with `target` only when v1 can establish safety using
 * one of these explicit rules:
 *
 * 1. schemas are structurally identical, ignoring only JSON object key order;
 * 2. `false` source schema (no possible values) is compatible with any target;
 * 3. `true` or annotation-only target accepts every JSON value;
 * 4. source declares one primitive `type` and target is an unconstrained schema
 *    for that same primitive type; or
 * 5. source declares `integer` and target is unconstrained `number`.
 *
 * Source-side constraints are safe in rule 4/5 because an explicit single
 * `type` still bounds every value the source may emit. Target-side assertion
 * keywords are never reasoned about. V1 therefore does not attempt implication
 * for enum/const/ranges/patterns/object properties/arrays/combinators/$ref/etc.
 */
export function isJsonSchemaPortCompatible(source: JsonSchema, target: JsonSchema): boolean {
  if (schemasExactlyEqual(source, target)) {
    return true;
  }

  if (source === false || target === true) {
    return true;
  }

  if (typeof target !== "boolean" && isAnnotationOnlySchema(target)) {
    return true;
  }

  if (typeof source === "boolean" || typeof target === "boolean") {
    return false;
  }

  const sourceType = getSinglePrimitiveType(source);
  const targetType = getUnconstrainedPrimitiveTargetType(target);

  if (sourceType === undefined || targetType === undefined) {
    return false;
  }

  return sourceType === targetType || (sourceType === "integer" && targetType === "number");
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

/**
 * Validate only schema-to-schema value-flow compatibility for Graph JSON v1.
 *
 * This pass is intentionally separate from 2.6-2.7 semantic validation. It
 * checks graph-output declarations, public graph-input bindings, and data edges.
 * Literal values are value-validation inputs rather than schema implication;
 * secret references have no public value schema in v1. Control edges carry no
 * value and are therefore outside this pass.
 *
 * Callers should run shape validation and 2.6-2.7 semantic validation first.
 * Missing references defensively return false here but are owned diagnostically
 * by the earlier semantic layer.
 */
export function validateGraphJsonV1PortCompatibility(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): boolean {
  const manifests = resolveManifests(graph, resolver);
  if (manifests === undefined) {
    return false;
  }

  const graphInputs = new Map(graph.inputs.map((input) => [input.id, input] as const));

  for (const output of graph.outputs) {
    const manifest = manifests.get(output.source.nodeId);
    const sourcePort = manifest?.outputs[output.source.port];

    if (
      sourcePort === undefined ||
      !isJsonSchemaPortCompatible(sourcePort.schema, output.schema)
    ) {
      return false;
    }
  }

  for (const node of graph.nodes) {
    const manifest = manifests.get(node.id);
    if (manifest === undefined) {
      return false;
    }

    for (const binding of node.bindings ?? []) {
      if (binding.kind !== "graph-input") {
        continue;
      }

      const graphInput = graphInputs.get(binding.input);
      const targetPort = manifest.inputs[binding.port];

      if (
        graphInput === undefined ||
        targetPort === undefined ||
        !isJsonSchemaPortCompatible(graphInput.schema, targetPort.schema)
      ) {
        return false;
      }
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind !== "data") {
      continue;
    }

    const sourcePort = manifests.get(edge.from.nodeId)?.outputs[edge.from.port];
    const targetPort = manifests.get(edge.to.nodeId)?.inputs[edge.to.port];

    if (
      sourcePort === undefined ||
      targetPort === undefined ||
      !isJsonSchemaPortCompatible(sourcePort.schema, targetPort.schema)
    ) {
      return false;
    }
  }

  return true;
}
