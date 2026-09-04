import type { GraphJsonV1 } from "./graph-json-v1.js";
import { GRAPH_JSON_V1_SCHEMA } from "./graph-json-v1.schema.js";
import { createDraft202012SchemaEngine } from "./schema-engine.js";

const schemaEngine = createDraft202012SchemaEngine();
const validateGraphJsonV1Document = schemaEngine.compile<GraphJsonV1>(GRAPH_JSON_V1_SCHEMA);

/**
 * Validate only the portable Graph JSON v1 document shape and local constraints.
 *
 * This is deliberately a type-guard boundary, not the semantic validator. A
 * structurally valid graph may still contain duplicate IDs, unresolved nodes,
 * nonexistent ports, incompatible connections, cycles, or invalid policies.
 * Those concerns belong to later deterministic Harness validation passes.
 *
 * Structured Harness diagnostics are added separately in Phase 2.16; Ajv error
 * objects are intentionally not exposed as public API here.
 */
export function validateGraphJsonV1Shape(value: unknown): value is GraphJsonV1 {
  return validateGraphJsonV1Document(value);
}
