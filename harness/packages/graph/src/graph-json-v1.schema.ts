import { JSON_SCHEMA_DIALECT_URI } from "@zet-harness/plugin-api";

import { GRAPH_JSON_VERSION } from "./graph-json-v1.js";

const nonEmptyString = { type: "string", minLength: 1 } as const;

/**
 * Draft 2020-12 schema for the portable Graph JSON v1 document boundary.
 *
 * This intentionally validates only structure and local value constraints.
 * Duplicate IDs, registry resolution, port meaning, graph topology, capability
 * semantics, and other Harness meaning belong to later semantic passes.
 */
export const GRAPH_JSON_V1_SCHEMA = {
  $schema: JSON_SCHEMA_DIALECT_URI,
  type: "object",
  properties: {
    schemaVersion: { const: GRAPH_JSON_VERSION },
    graphId: nonEmptyString,
    revisionId: nonEmptyString,
    metadata: { $ref: "#/$defs/metadata" },
    inputs: {
      type: "array",
      items: { $ref: "#/$defs/graphInput" },
    },
    outputs: {
      type: "array",
      items: { $ref: "#/$defs/graphOutput" },
    },
    nodes: {
      type: "array",
      items: { $ref: "#/$defs/node" },
    },
    edges: {
      type: "array",
      items: { $ref: "#/$defs/edge" },
    },
    entrypoints: {
      type: "array",
      items: { $ref: "#/$defs/entrypoint" },
    },
    policies: { $ref: "#/$defs/policies" },
    options: { $ref: "#/$defs/options" },
    editor: { $ref: "#/$defs/editor" },
  },
  required: [
    "schemaVersion",
    "graphId",
    "revisionId",
    "inputs",
    "outputs",
    "nodes",
    "edges",
    "entrypoints",
  ],
  additionalProperties: false,
  $defs: {
    jsonValue: {
      anyOf: [
        { type: "null" },
        { type: "boolean" },
        { type: "number" },
        { type: "string" },
        {
          type: "array",
          items: { $ref: "#/$defs/jsonValue" },
        },
        { $ref: "#/$defs/jsonObject" },
      ],
    },
    jsonObject: {
      type: "object",
      additionalProperties: { $ref: "#/$defs/jsonValue" },
    },
    jsonSchema: {
      anyOf: [{ type: "boolean" }, { $ref: "#/$defs/jsonObject" }],
    },
    metadata: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        labels: {
          type: "array",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    },
    graphInput: {
      type: "object",
      properties: {
        id: nonEmptyString,
        schema: { $ref: "#/$defs/jsonSchema" },
        required: { type: "boolean" },
        default: { $ref: "#/$defs/jsonValue" },
      },
      required: ["id", "schema"],
      additionalProperties: false,
    },
    nodeOutputRef: {
      type: "object",
      properties: {
        nodeId: nonEmptyString,
        port: nonEmptyString,
      },
      required: ["nodeId", "port"],
      additionalProperties: false,
    },
    graphOutput: {
      type: "object",
      properties: {
        id: nonEmptyString,
        schema: { $ref: "#/$defs/jsonSchema" },
        source: { $ref: "#/$defs/nodeOutputRef" },
      },
      required: ["id", "schema", "source"],
      additionalProperties: false,
    },
    literalBinding: {
      type: "object",
      properties: {
        kind: { const: "literal" },
        port: nonEmptyString,
        value: { $ref: "#/$defs/jsonValue" },
      },
      required: ["kind", "port", "value"],
      additionalProperties: false,
    },
    graphInputBinding: {
      type: "object",
      properties: {
        kind: { const: "graph-input" },
        port: nonEmptyString,
        input: nonEmptyString,
      },
      required: ["kind", "port", "input"],
      additionalProperties: false,
    },
    secretBinding: {
      type: "object",
      properties: {
        kind: { const: "secret" },
        port: nonEmptyString,
        secretRef: nonEmptyString,
      },
      required: ["kind", "port", "secretRef"],
      additionalProperties: false,
    },
    binding: {
      oneOf: [
        { $ref: "#/$defs/literalBinding" },
        { $ref: "#/$defs/graphInputBinding" },
        { $ref: "#/$defs/secretBinding" },
      ],
    },
    node: {
      type: "object",
      properties: {
        id: nonEmptyString,
        type: nonEmptyString,
        version: nonEmptyString,
        config: { $ref: "#/$defs/jsonObject" },
        bindings: {
          type: "array",
          items: { $ref: "#/$defs/binding" },
        },
      },
      required: ["id", "type", "version", "config"],
      additionalProperties: false,
    },
    dataEndpoint: {
      type: "object",
      properties: {
        nodeId: nonEmptyString,
        port: nonEmptyString,
      },
      required: ["nodeId", "port"],
      additionalProperties: false,
    },
    controlEndpoint: {
      type: "object",
      properties: {
        nodeId: nonEmptyString,
        port: nonEmptyString,
      },
      required: ["nodeId"],
      additionalProperties: false,
    },
    dataEdge: {
      type: "object",
      properties: {
        id: nonEmptyString,
        kind: { const: "data" },
        from: { $ref: "#/$defs/dataEndpoint" },
        to: { $ref: "#/$defs/dataEndpoint" },
      },
      required: ["id", "kind", "from", "to"],
      additionalProperties: false,
    },
    controlEdge: {
      type: "object",
      properties: {
        id: nonEmptyString,
        kind: { const: "control" },
        from: { $ref: "#/$defs/controlEndpoint" },
        to: { $ref: "#/$defs/controlEndpoint" },
      },
      required: ["id", "kind", "from", "to"],
      additionalProperties: false,
    },
    edge: {
      oneOf: [{ $ref: "#/$defs/dataEdge" }, { $ref: "#/$defs/controlEdge" }],
    },
    entrypoint: {
      type: "object",
      properties: {
        id: nonEmptyString,
        nodeId: nonEmptyString,
        port: nonEmptyString,
      },
      required: ["id", "nodeId"],
      additionalProperties: false,
    },
    capabilityIntent: {
      type: "object",
      properties: {
        required: {
          type: "array",
          items: nonEmptyString,
        },
        optional: {
          type: "array",
          items: nonEmptyString,
        },
        deny: {
          type: "array",
          items: nonEmptyString,
        },
      },
      additionalProperties: false,
    },
    policies: {
      type: "object",
      properties: {
        maxNodeExecutions: { type: "integer", minimum: 1 },
        maxParallelism: { type: "integer", minimum: 1 },
        maxWallTimeMs: { type: "integer", minimum: 1 },
        capabilities: { $ref: "#/$defs/capabilityIntent" },
      },
      additionalProperties: false,
    },
    options: {
      type: "object",
      properties: {
        defaultEntrypoint: nonEmptyString,
      },
      additionalProperties: false,
    },
    point: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    viewport: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        zoom: { type: "number", exclusiveMinimum: 0 },
      },
      required: ["x", "y", "zoom"],
      additionalProperties: false,
    },
    editorNodeState: {
      type: "object",
      properties: {
        position: { $ref: "#/$defs/point" },
        collapsed: { type: "boolean" },
      },
      required: ["position"],
      additionalProperties: false,
    },
    annotation: {
      type: "object",
      properties: {
        id: nonEmptyString,
        text: { type: "string" },
        position: { $ref: "#/$defs/point" },
      },
      required: ["id", "text", "position"],
      additionalProperties: false,
    },
    editor: {
      type: "object",
      properties: {
        viewport: { $ref: "#/$defs/viewport" },
        nodes: {
          type: "object",
          additionalProperties: { $ref: "#/$defs/editorNodeState" },
        },
        annotations: {
          type: "array",
          items: { $ref: "#/$defs/annotation" },
        },
        data: { $ref: "#/$defs/jsonObject" },
      },
      additionalProperties: false,
    },
  },
} as const;
