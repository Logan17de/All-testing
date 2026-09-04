import type { CapabilityId, NodeManifest } from "@zet-harness/plugin-api";

import { GRAPH_LOOP_MAX_ITERATIONS_CONFIG_KEY } from "./graph-json-v1-loop-bounds.js";
import type { GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

/** External authority supplied to compilation. Graph JSON never grants itself authority. */
export interface GraphCapabilityAuthority {
  readonly granted: readonly CapabilityId[];
}

export type GraphCapabilityPolicyDiagnosticCode =
  | "GRAPH_CAPABILITY_POLICY_PREREQUISITE_FAILED"
  | "GRAPH_CAPABILITY_INTENT_DUPLICATE"
  | "GRAPH_CAPABILITY_INTENT_CONFLICT"
  | "GRAPH_CAPABILITY_REQUIRED_DENIED"
  | "GRAPH_CAPABILITY_REQUIRED_UNAVAILABLE"
  | "GRAPH_POLICY_LOOP_BOUND_EXCEEDS_MAX_NODE_EXECUTIONS";

export interface GraphCapabilityPolicyDiagnostic {
  readonly code: GraphCapabilityPolicyDiagnosticCode;
  readonly message: string;
  readonly capability?: CapabilityId;
  readonly nodeId?: string;
  readonly policyField?: "required" | "optional" | "deny" | "maxNodeExecutions";
}

export interface GraphCapabilityPolicyResult {
  readonly valid: boolean;
  readonly requiredCapabilities: readonly CapabilityId[];
  readonly optionalCapabilities: readonly CapabilityId[];
  readonly effectiveCapabilities: readonly CapabilityId[];
  readonly diagnostics: readonly GraphCapabilityPolicyDiagnostic[];
}

function pushUnique(
  target: CapabilityId[],
  seen: Set<CapabilityId>,
  capability: CapabilityId,
): void {
  if (!seen.has(capability)) {
    seen.add(capability);
    target.push(capability);
  }
}

function collectDuplicates(
  values: readonly CapabilityId[],
  field: "required" | "optional" | "deny",
  diagnostics: GraphCapabilityPolicyDiagnostic[],
): void {
  const seen = new Set<CapabilityId>();

  for (const capability of values) {
    if (seen.has(capability)) {
      diagnostics.push({
        code: "GRAPH_CAPABILITY_INTENT_DUPLICATE",
        message: `Capability '${capability}' appears more than once in graph policy '${field}'.`,
        capability,
        policyField: field,
      });
      continue;
    }

    seen.add(capability);
  }
}

/**
 * Run the narrow 2.13 capability/policy compile-time stage.
 *
 * Hard demand is the union of graph `required` requests and capabilities required
 * by resolved node manifests. Graph `optional` requests never make compilation
 * fail merely because external authority is absent. Graph `deny` is a one-way
 * self-restriction and can never add authority.
 *
 * Effective capability authority is therefore requested capability intent,
 * intersected with externally supplied grants, minus graph self-denials. Runtime
 * policy may always be stricter than this compile-time view.
 */
export function checkGraphJsonV1CapabilityPolicy(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
  authority: GraphCapabilityAuthority,
): GraphCapabilityPolicyResult {
  const diagnostics: GraphCapabilityPolicyDiagnostic[] = [];
  const intent = graph.policies?.capabilities;
  const graphRequired = intent?.required ?? [];
  const graphOptional = intent?.optional ?? [];
  const graphDeny = intent?.deny ?? [];

  collectDuplicates(graphRequired, "required", diagnostics);
  collectDuplicates(graphOptional, "optional", diagnostics);
  collectDuplicates(graphDeny, "deny", diagnostics);

  const fieldByCapability = new Map<CapabilityId, "required" | "optional" | "deny">();
  for (const [field, values] of [
    ["required", graphRequired],
    ["optional", graphOptional],
    ["deny", graphDeny],
  ] as const) {
    for (const capability of values) {
      const previous = fieldByCapability.get(capability);
      if (previous !== undefined && previous !== field) {
        diagnostics.push({
          code: "GRAPH_CAPABILITY_INTENT_CONFLICT",
          message: `Capability '${capability}' cannot appear in both graph policy '${previous}' and '${field}'.`,
          capability,
          policyField: field,
        });
        continue;
      }
      fieldByCapability.set(capability, field);
    }
  }

  const granted = new Set(authority.granted);
  const denied = new Set(graphDeny);
  const requiredCapabilities: CapabilityId[] = [];
  const requiredSeen = new Set<CapabilityId>();
  const optionalCapabilities: CapabilityId[] = [];
  const optionalSeen = new Set<CapabilityId>();

  for (const capability of graphRequired) {
    pushUnique(requiredCapabilities, requiredSeen, capability);

    if (denied.has(capability)) {
      diagnostics.push({
        code: "GRAPH_CAPABILITY_REQUIRED_DENIED",
        message: `Graph-required capability '${capability}' is blocked by the graph's own deny policy.`,
        capability,
        policyField: "required",
      });
    } else if (!granted.has(capability)) {
      diagnostics.push({
        code: "GRAPH_CAPABILITY_REQUIRED_UNAVAILABLE",
        message: `Graph-required capability '${capability}' is not present in external compile authority.`,
        capability,
        policyField: "required",
      });
    }
  }

  for (const capability of graphOptional) {
    pushUnique(optionalCapabilities, optionalSeen, capability);
  }

  const maxNodeExecutions = graph.policies?.maxNodeExecutions;

  for (const node of graph.nodes) {
    const manifest: NodeManifest | undefined = resolver.getManifest(node.type, node.version);

    if (manifest === undefined) {
      diagnostics.push({
        code: "GRAPH_CAPABILITY_POLICY_PREREQUISITE_FAILED",
        message: `Node '${node.id}' must resolve before 2.13 capability/policy validation.`,
        nodeId: node.id,
      });
      continue;
    }

    for (const capability of manifest.behavior.requiredCapabilities) {
      pushUnique(requiredCapabilities, requiredSeen, capability);

      if (denied.has(capability)) {
        diagnostics.push({
          code: "GRAPH_CAPABILITY_REQUIRED_DENIED",
          message: `Node '${node.id}' requires capability '${capability}', but the graph explicitly denies it.`,
          capability,
          nodeId: node.id,
          policyField: "deny",
        });
      } else if (!granted.has(capability)) {
        diagnostics.push({
          code: "GRAPH_CAPABILITY_REQUIRED_UNAVAILABLE",
          message: `Node '${node.id}' requires capability '${capability}', but external compile authority does not grant it.`,
          capability,
          nodeId: node.id,
        });
      }
    }

    if (manifest.control?.kind === "loop" && maxNodeExecutions !== undefined) {
      const bound = node.config[GRAPH_LOOP_MAX_ITERATIONS_CONFIG_KEY];
      if (
        typeof bound === "number" &&
        Number.isSafeInteger(bound) &&
        bound >= 1 &&
        bound > maxNodeExecutions
      ) {
        diagnostics.push({
          code: "GRAPH_POLICY_LOOP_BOUND_EXCEEDS_MAX_NODE_EXECUTIONS",
          message: `Loop node '${node.id}' maxIterations (${bound}) exceeds graph maxNodeExecutions (${maxNodeExecutions}).`,
          nodeId: node.id,
          policyField: "maxNodeExecutions",
        });
      }
    }
  }

  const effectiveCapabilities: CapabilityId[] = [];
  const effectiveSeen = new Set<CapabilityId>();
  for (const capability of [...requiredCapabilities, ...optionalCapabilities]) {
    if (granted.has(capability) && !denied.has(capability)) {
      pushUnique(effectiveCapabilities, effectiveSeen, capability);
    }
  }

  return {
    valid: diagnostics.length === 0,
    requiredCapabilities,
    optionalCapabilities,
    effectiveCapabilities,
    diagnostics,
  };
}

/** Boolean convenience wrapper for the separate 2.13 capability/policy stage. */
export function validateGraphJsonV1CapabilityPolicy(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
  authority: GraphCapabilityAuthority,
): boolean {
  return checkGraphJsonV1CapabilityPolicy(graph, resolver, authority).valid;
}
