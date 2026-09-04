import type { GraphJsonV1 } from "./graph-json-v1.js";
import { GRAPH_JSON_V1_SCHEMA } from "./graph-json-v1.schema.js";
import { createDraft202012SchemaEngine } from "./schema-engine.js";

const schemaEngine = createDraft202012SchemaEngine();
const validateGraphJsonV1Document = schemaEngine.compile<GraphJsonV1>(GRAPH_JSON_V1_SCHEMA);

export type GraphShapeDiagnosticCode =
  | "GRAPH_SHAPE_REQUIRED_PROPERTY"
  | "GRAPH_SHAPE_ADDITIONAL_PROPERTY"
  | "GRAPH_SHAPE_INVALID_VALUE";

/** Harness-owned shape diagnostic. Ajv details never cross this boundary. */
export interface GraphShapeDiagnostic {
  readonly code: GraphShapeDiagnosticCode;
  readonly message: string;
  /** JSON Pointer into the submitted Graph JSON value. */
  readonly path: string;
}

export interface GraphShapeValidationResult {
  readonly valid: boolean;
  readonly diagnostics: readonly GraphShapeDiagnostic[];
}

interface InternalSchemaError {
  readonly keyword: string;
  readonly instancePath: string;
  readonly params: unknown;
}

function escapeJsonPointerToken(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function readStringParam(params: unknown, key: string): string | undefined {
  if (params === null || typeof params !== "object") {
    return undefined;
  }

  const value = (params as Readonly<Record<string, unknown>>)[key];
  return typeof value === "string" ? value : undefined;
}

function appendPath(path: string, token: string | undefined): string {
  if (token === undefined) {
    return path;
  }

  return `${path}/${escapeJsonPointerToken(token)}`;
}

function normalizeSchemaError(error: InternalSchemaError): GraphShapeDiagnostic {
  if (error.keyword === "required") {
    const property = readStringParam(error.params, "missingProperty");
    return {
      code: "GRAPH_SHAPE_REQUIRED_PROPERTY",
      message:
        property === undefined
          ? "Graph JSON is missing a required property."
          : `Graph JSON is missing required property '${property}'.`,
      path: appendPath(error.instancePath, property),
    };
  }

  if (error.keyword === "additionalProperties") {
    const property = readStringParam(error.params, "additionalProperty");
    return {
      code: "GRAPH_SHAPE_ADDITIONAL_PROPERTY",
      message:
        property === undefined
          ? "Graph JSON contains an unsupported property."
          : `Graph JSON contains unsupported property '${property}'.`,
      path: appendPath(error.instancePath, property),
    };
  }

  return {
    code: "GRAPH_SHAPE_INVALID_VALUE",
    message: "Graph JSON value does not satisfy the v1 shape contract.",
    path: error.instancePath,
  };
}

function dedupeShapeDiagnostics(
  diagnostics: readonly GraphShapeDiagnostic[],
): readonly GraphShapeDiagnostic[] {
  const seen = new Set<string>();
  const unique: GraphShapeDiagnostic[] = [];

  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.path}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(diagnostic);
  }

  return unique;
}

/**
 * Return Harness-owned diagnostics for the portable Graph JSON v1 shape gate.
 *
 * Ajv remains an internal Draft 2020-12 engine. Its keyword names, error-object
 * layout, and messages are normalized here so callers depend only on stable
 * Harness codes plus JSON Pointer source locations.
 */
export function checkGraphJsonV1Shape(value: unknown): GraphShapeValidationResult {
  if (validateGraphJsonV1Document(value)) {
    return { valid: true, diagnostics: [] };
  }

  const diagnostics = dedupeShapeDiagnostics(
    (validateGraphJsonV1Document.errors ?? []).map((error) => normalizeSchemaError(error)),
  );

  return { valid: false, diagnostics };
}

/**
 * Validate only the portable Graph JSON v1 document shape and local constraints.
 *
 * This is deliberately a type-guard boundary, not the semantic validator. A
 * structurally valid graph may still contain duplicate IDs, unresolved nodes,
 * nonexistent ports, incompatible connections, cycles, or invalid policies.
 * Those concerns belong to later deterministic Harness validation passes.
 */
export function validateGraphJsonV1Shape(value: unknown): value is GraphJsonV1 {
  return checkGraphJsonV1Shape(value).valid;
}
