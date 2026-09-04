import type { JsonObject, JsonSchema, JsonValue } from "@zet-harness/plugin-api";

import type {
  GraphControlEdgeV1,
  GraphEdgeV1,
  GraphEntrypointV1,
  GraphInputBindingV1,
  GraphInputPortV1,
  GraphNodeV1,
  GraphOutputPortV1,
  GraphPoliciesV1,
  GraphSemanticsV1,
} from "./graph-json-v1.js";
import type {
  GraphResolvedNodePinV1,
  GraphResolvedPluginPinV1,
} from "./graph-json-v1-normalization.js";
import type { GraphCompilerSourceV1 } from "./graph-json-v1-ui-metadata.js";

export interface CanonicalGraphCompilerSourceV1 {
  /** Executable Graph JSON v1 semantics only: no graph/revision/human/editor metadata. */
  readonly semantics: GraphSemanticsV1;
  /** Deterministic Harness canonical JSON serialization of `semantics`. */
  readonly canonicalSemanticsJson: string;
  /** Registry provenance retained for later compiler/registry identity, not semantic hashing. */
  readonly nodePins: readonly GraphResolvedNodePinV1[];
  readonly pluginPins: readonly GraphResolvedPluginPinV1[];
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function encodeJsonPrimitive(value: string | number | boolean | null): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Harness canonical JSON requires finite JSON numbers.");
  }

  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("Harness canonical JSON received a non-JSON primitive.");
  }
  return encoded;
}

/**
 * Deterministic Harness JSON serialization used as the byte-domain precursor to
 * later hashes. Object keys are ordered lexically by JavaScript UTF-16 string
 * comparison. Array order is preserved. Primitive encoding delegates to the
 * Node/ECMAScript JSON encoder.
 *
 * This is intentionally named as a Harness v1 contract rather than claiming a
 * broader standards profile. 2.21 owns hashing; this function computes no hash.
 */
export function stringifyCanonicalJsonV1(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return encodeJsonPrimitive(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCanonicalJsonV1(item)).join(",")}]`;
  }

  const object = value as JsonObject;
  const entries = Object.keys(object)
    .sort(compareText)
    .map((key) => {
      const item = object[key];
      if (item === undefined) {
        throw new TypeError(`Harness canonical JSON key '${key}' resolved to undefined.`);
      }
      return `${encodeJsonPrimitive(key)}:${stringifyCanonicalJsonV1(item)}`;
    });

  return `{${entries.join(",")}}`;
}

/** Deep-copy JSON while canonicalizing object-key insertion order; arrays stay ordered. */
export function canonicalizeJsonValueV1(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Harness canonical JSON requires finite JSON numbers.");
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeJsonValueV1(item));
  }

  const object = value as JsonObject;
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(object).sort(compareText)) {
    const item = object[key];
    if (item === undefined) {
      throw new TypeError(`Harness canonical JSON key '${key}' resolved to undefined.`);
    }
    result[key] = canonicalizeJsonValueV1(item);
  }
  return result;
}

function canonicalizeSchema(schema: JsonSchema): JsonSchema {
  return typeof schema === "boolean" ? schema : (canonicalizeJsonValueV1(schema) as JsonObject);
}

function canonicalizeInput(input: GraphInputPortV1): GraphInputPortV1 {
  return {
    id: input.id,
    schema: canonicalizeSchema(input.schema),
    ...(input.required === undefined ? {} : { required: input.required }),
    ...(input.default === undefined ? {} : { default: canonicalizeJsonValueV1(input.default) }),
  };
}

function canonicalizeOutput(output: GraphOutputPortV1): GraphOutputPortV1 {
  return {
    id: output.id,
    schema: canonicalizeSchema(output.schema),
    source: { nodeId: output.source.nodeId, port: output.source.port },
  };
}

function canonicalizeBinding(binding: GraphInputBindingV1): GraphInputBindingV1 {
  switch (binding.kind) {
    case "literal":
      return {
        kind: "literal",
        port: binding.port,
        value: canonicalizeJsonValueV1(binding.value),
      };
    case "graph-input":
      return { kind: "graph-input", port: binding.port, input: binding.input };
    case "secret":
      return { kind: "secret", port: binding.port, secretRef: binding.secretRef };
  }
}

function canonicalizeNode(node: GraphNodeV1): GraphNodeV1 {
  return {
    id: node.id,
    type: node.type,
    version: node.version,
    config: canonicalizeJsonValueV1(node.config) as JsonObject,
    ...(node.bindings === undefined
      ? {}
      : { bindings: node.bindings.map((binding) => canonicalizeBinding(binding)) }),
  };
}

function canonicalizeControlEndpoint(
  endpoint: GraphControlEdgeV1["from"],
): GraphControlEdgeV1["from"] {
  return {
    nodeId: endpoint.nodeId,
    ...(endpoint.port === undefined ? {} : { port: endpoint.port }),
  };
}

function canonicalizeEdge(edge: GraphEdgeV1): GraphEdgeV1 {
  if (edge.kind === "data") {
    return {
      id: edge.id,
      kind: "data",
      from: { nodeId: edge.from.nodeId, port: edge.from.port },
      to: { nodeId: edge.to.nodeId, port: edge.to.port },
    };
  }

  return {
    id: edge.id,
    kind: "control",
    from: canonicalizeControlEndpoint(edge.from),
    to: canonicalizeControlEndpoint(edge.to),
  };
}

function canonicalizeEntrypoint(entrypoint: GraphEntrypointV1): GraphEntrypointV1 {
  return {
    id: entrypoint.id,
    nodeId: entrypoint.nodeId,
    ...(entrypoint.port === undefined ? {} : { port: entrypoint.port }),
  };
}

function canonicalizePolicies(policies: GraphPoliciesV1 | undefined): GraphPoliciesV1 | undefined {
  if (policies === undefined) return undefined;

  const capabilities = policies.capabilities;
  return {
    ...(policies.maxNodeExecutions === undefined
      ? {}
      : { maxNodeExecutions: policies.maxNodeExecutions }),
    ...(policies.maxParallelism === undefined ? {} : { maxParallelism: policies.maxParallelism }),
    ...(policies.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: policies.maxWallTimeMs }),
    ...(capabilities === undefined
      ? {}
      : {
          capabilities: {
            ...(capabilities.required === undefined
              ? {}
              : { required: [...capabilities.required].sort(compareText) }),
            ...(capabilities.optional === undefined
              ? {}
              : { optional: [...capabilities.optional].sort(compareText) }),
            ...(capabilities.deny === undefined
              ? {}
              : { deny: [...capabilities.deny].sort(compareText) }),
          },
        }),
  };
}

function sortById<T extends { readonly id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => compareText(left.id, right.id));
}

function sortNodePins(pins: readonly GraphResolvedNodePinV1[]): GraphResolvedNodePinV1[] {
  return [...pins].sort((left, right) => compareText(left.nodeId, right.nodeId));
}

function sortPluginPins(pins: readonly GraphResolvedPluginPinV1[]): GraphResolvedPluginPinV1[] {
  return [...pins].sort((left, right) => {
    const idOrder = compareText(left.id, right.id);
    return idOrder === 0 ? compareText(left.version, right.version) : idOrder;
  });
}

/**
 * Project 2.18 compiler source into deterministic executable Graph JSON v1 semantics.
 *
 * Frozen 2.19 ordering rules:
 * - graph inputs/outputs/nodes/edges/entrypoints are identity-addressed sets and
 *   are ordered by their stable `id`;
 * - capability intent buckets are sets and are ordered lexically;
 * - arbitrary JSON arrays in config/schema/literal values stay ordered;
 * - node `bindings` stay ordered because v1 has not declared multi-source
 *   aggregation commutative; 2.20+ may lower that explicit sequence.
 *
 * `graphId`, `revisionId`, human metadata, and editor metadata are excluded from
 * `semantics` by the already-frozen GraphSemanticsV1 hash domain. Node/plugin
 * provenance is retained separately for later registry/compiler identity and is
 * not included in `canonicalSemanticsJson`.
 *
 * This function is pure and computes no digest/hash and no Execution IR.
 */
export function canonicalizeGraphJsonV1Semantics(
  source: GraphCompilerSourceV1,
): CanonicalGraphCompilerSourceV1 {
  const document = source.document;
  const policies = canonicalizePolicies(document.policies);

  const semantics: GraphSemanticsV1 = {
    schemaVersion: document.schemaVersion,
    inputs: sortById(document.inputs).map((input) => canonicalizeInput(input)),
    outputs: sortById(document.outputs).map((output) => canonicalizeOutput(output)),
    nodes: sortById(document.nodes).map((node) => canonicalizeNode(node)),
    edges: sortById(document.edges).map((edge) => canonicalizeEdge(edge)),
    entrypoints: sortById(document.entrypoints).map((entrypoint) =>
      canonicalizeEntrypoint(entrypoint),
    ),
    ...(policies === undefined ? {} : { policies }),
    ...(document.options === undefined
      ? {}
      : {
          options:
            document.options.defaultEntrypoint === undefined
              ? {}
              : { defaultEntrypoint: document.options.defaultEntrypoint },
        }),
  };

  return {
    semantics,
    canonicalSemanticsJson: stringifyCanonicalJsonV1(semantics as unknown as JsonValue),
    nodePins: sortNodePins(source.nodePins),
    pluginPins: sortPluginPins(source.pluginPins),
  };
}
