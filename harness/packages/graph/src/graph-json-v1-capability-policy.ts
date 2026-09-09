import type { CapabilityId, NodeManifest } from "@zet-harness/plugin-api";

import { GRAPH_LOOP_MAX_ITERATIONS_CONFIG_KEY } from "./graph-json-v1-loop-bounds.js";
import type { GraphJsonV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

export type GraphCapabilityAuthorityEvaluation =
  | { readonly decision: "allow" }
  | {
      readonly decision: "deny";
      readonly denialReason: "explicitly-denied" | "not-granted";
    };

/**
 * Narrow host-authority contract consumed by compilation.
 *
 * `CapabilityPermissionPolicy` from `@zet-harness/core` satisfies this interface
 * structurally. Graph JSON, node manifests, plugins, models, and tools only
 * declare capability demand; none of them are authority sources.
 */
export interface GraphCapabilityAuthority {
  evaluate(capability: CapabilityId): GraphCapabilityAuthorityEvaluation;
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

function appendExternalAuthorityDiagnostic(
  diagnostics: GraphCapabilityPolicyDiagnostic[],
  capability: CapabilityId,
  evaluation: GraphCapabilityAuthorityEvaluation,
  subject: "graph" | "node",
  nodeId?: string,
): void {
  if (evaluation.decision === "allow") {
    return;
  }

  if (evaluation.denialReason === "explicitly-denied") {
    diagnostics.push({
      code: "GRAPH_CAPABILITY_REQUIRED_DENIED",
      message:
        subject === "graph"
          ? `Graph-required capability '${capability}' is explicitly denied by external compile authority.`
          : `Node '${nodeId}' requires capability '${capability}', but external compile authority explicitly denies it.`,
      capability,
      ...(nodeId === undefined ? { policyField: "required" as const } : { nodeId }),
    });
    return;
  }

  diagnostics.push({
    code: "GRAPH_CAPABILITY_REQUIRED_UNAVAILABLE",
    message:
      subject === "graph"
        ? `Graph-required capability '${capability}' is not present in external compile authority.`
        : `Node '${nodeId}' requires capability '${capability}', but external compile authority does not grant it.`,
    capability,
    ...(nodeId === undefined ? { policyField: "required" as const } : { nodeId }),
  });
}

/**
 * Run the narrow capability/policy compile-time stage.
 *
 * Hard demand is the union of graph `required` requests and capabilities required
 * by resolved node manifests. Graph `optional` requests never make compilation
 * fail merely because host authority is absent. Graph `deny` is a one-way
 * self-restriction and can never add authority.
 *
 * Phase 5.6 consumes a host-owned authority evaluator rather than a raw grant
 * list. Each capability is evaluated at most once per validation pass, so even
 * an accidentally stateful caller cannot make one compile observe conflicting
 * decisions for the same capability. The immutable `CapabilityPermissionPolicy`
 * from `@zet-harness/core` is the intended authority implementation.
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

  const denied = new Set(graphDeny);
  const authorityEvaluations = new Map<CapabilityId, GraphCapabilityAuthorityEvaluation>();
  const evaluateAuthority = (capability: CapabilityId): GraphCapabilityAuthorityEvaluation => {
    const cached = authorityEvaluations.get(capability);
    if (cached !== undefined) {
      return cached;
    }

    const evaluation = authority.evaluate(capability);
    authorityEvaluations.set(capability, evaluation);
    return evaluation;
  };

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
    } else {
      appendExternalAuthorityDiagnostic(
        diagnostics,
        capability,
        evaluateAuthority(capability),
        "graph",
      );
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
      } else {
        appendExternalAuthorityDiagnostic(
          diagnostics,
          capability,
          evaluateAuthority(capability),
          "node",
          node.id,
        );
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
    if (!denied.has(capability) && evaluateAuthority(capability).decision === "allow") {
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

/** Boolean convenience wrapper for the separate capability/policy stage. */
export function validateGraphJsonV1CapabilityPolicy(
  graph: GraphJsonV1,
  resolver: NodeManifestResolver,
  authority: GraphCapabilityAuthority,
): boolean {
  return checkGraphJsonV1CapabilityPolicy(graph, resolver, authority).valid;
}
