/**
 * JSON-safe values that may cross the public Harness/plugin boundary.
 *
 * Keep this structural and dependency-free. Runtime validation belongs to the
 * compiler/runtime boundary, not to this package.
 */
export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonArray = readonly JsonValue[];

export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** A JSON Schema `$ref` URI or fragment. */
export interface SchemaReference {
  readonly $ref: string;
}

/** Version identifiers stay strings so plugins are not forced into one scheme. */
export type Version = string;

/** Generic identity for a versioned public contract or extension. */
export interface VersionedId {
  readonly id: string;
  readonly version: Version;
}

/** Stable capability identifier, for example `fs:read` or `network:http`. */
export type CapabilityId = string;

/** A capability requested by a plugin, node, model, or tool contract. */
export interface CapabilityRequirement {
  readonly id: CapabilityId;
  readonly optional?: boolean;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticPathSegment = string | number;

/**
 * Generic diagnostic location. Graph-specific node/edge helpers can be layered
 * on top later without changing the base diagnostic contract.
 */
export interface DiagnosticLocation {
  readonly path?: readonly DiagnosticPathSegment[];
  readonly entityKind?: string;
  readonly entityId?: string;
}

/** Machine-readable diagnostic returned by public validation/compiler APIs. */
export interface Diagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly location?: DiagnosticLocation;
  readonly details?: JsonObject;
}
