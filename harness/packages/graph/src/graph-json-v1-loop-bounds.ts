import type { JsonValue, NodeManifest } from "@zet-harness/plugin-api";

import type { GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

/**
 * Harness-reserved top-level config key for one loop invocation's hard bound.
 *
 * The key is interpreted only when the resolved manifest declares
 * `control.kind === "loop"`; ordinary node configs may use the same text without
 * acquiring loop semantics.
 */
export const GRAPH_LOOP_MAX_ITERATIONS_CONFIG_KEY = "maxIterations" as const;

/** Optional per-invocation wall-time bound for one loop, in milliseconds (8.2). */
export const GRAPH_LOOP_MAX_WALL_TIME_CONFIG_KEY = "maxWallTimeMs" as const;

export type GraphLoopBoundDiagnosticCode =
  "GRAPH_LOOP_BOUND_PREREQUISITE_FAILED" | "GRAPH_LOOP_BOUND_REQUIRED" | "GRAPH_LOOP_BOUND_INVALID";

export interface GraphLoopBoundDiagnostic {
  readonly code: GraphLoopBoundDiagnosticCode;
  readonly message: string;
  readonly nodeId?: string;
  readonly configKey?: string;
  readonly value?: JsonValue;
}

export interface GraphLoopBoundResult {
  readonly valid: boolean;
  readonly diagnostics: readonly GraphLoopBoundDiagnostic[];
}

function hasOwnConfigKey(config: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(config, key);
}

function isValidMaxIterations(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * Run the narrow 2.12 compiler-visible loop-bound stage.
 *
 * Every graph node whose resolved manifest declares a structured `loop` contract
 * must carry a top-level `config.maxIterations` value that is a positive safe
 * integer. The value is per graph-node invocation, so separate loop instances
 * may have different hard bounds while the compiler still reads one fixed,
 * deterministic source location.
 *
 * An optional `config.maxWallTimeMs` must be a positive safe integer too (8.2).
 * This stage only validates the bounds; 8.1 lowers them into the loop
 * descriptor, and the runtime enforces them.
 */
export function checkGraphJsonV1LoopBounds(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): GraphLoopBoundResult {
  const diagnostics: GraphLoopBoundDiagnostic[] = [];

  for (const node of graph.nodes) {
    const manifest: NodeManifest | undefined = resolver.getManifest(node.type, node.version);

    if (manifest === undefined) {
      diagnostics.push({
        code: "GRAPH_LOOP_BOUND_PREREQUISITE_FAILED",
        message: `Node '${node.id}' must resolve before 2.12 loop-bound validation.`,
        nodeId: node.id,
      });
      continue;
    }

    if (manifest.control?.kind !== "loop") {
      continue;
    }

    const key = GRAPH_LOOP_MAX_ITERATIONS_CONFIG_KEY;

    if (!hasOwnConfigKey(node.config, key)) {
      diagnostics.push({
        code: "GRAPH_LOOP_BOUND_REQUIRED",
        message: `Loop node '${node.id}' must declare a compiler-visible hard bound at config.${key}.`,
        nodeId: node.id,
        configKey: key,
      });
      continue;
    }

    const value = node.config[key];

    if (!isValidMaxIterations(value)) {
      diagnostics.push({
        code: "GRAPH_LOOP_BOUND_INVALID",
        message: `Loop node '${node.id}' config.${key} must be a positive safe integer.`,
        nodeId: node.id,
        configKey: key,
        ...(value === undefined ? {} : { value }),
      });
    }

    const wallTimeKey = GRAPH_LOOP_MAX_WALL_TIME_CONFIG_KEY;
    const wallTime = node.config[wallTimeKey];
    if (hasOwnConfigKey(node.config, wallTimeKey) && !isValidMaxIterations(wallTime)) {
      diagnostics.push({
        code: "GRAPH_LOOP_BOUND_INVALID",
        message: `Loop node '${node.id}' config.${wallTimeKey} must be a positive safe integer of milliseconds.`,
        nodeId: node.id,
        configKey: wallTimeKey,
        ...(wallTime === undefined ? {} : { value: wallTime }),
      });
    }
  }

  return { valid: diagnostics.length === 0, diagnostics };
}

/** Boolean convenience wrapper for the separate 2.12 loop-bound stage. */
export function validateGraphJsonV1LoopBounds(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
): boolean {
  return checkGraphJsonV1LoopBounds(graph, resolver).valid;
}
