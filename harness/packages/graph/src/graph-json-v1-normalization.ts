import type { NodeManifest, NodeType, Version } from "@zet-harness/plugin-api";

import type { GraphJsonV1, GraphPoliciesV1 } from "./graph-json-v1.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";

export interface GraphResolvedPluginPinV1 {
  readonly id: string;
  readonly version: Version;
}

export interface GraphResolvedNodeRegistrationV1 {
  readonly manifest: NodeManifest;
  readonly plugin: GraphResolvedPluginPinV1;
}

/**
 * Registry-neutral compiler resolver that adds plugin provenance to manifest lookup.
 *
 * `NodeCatalog` satisfies this structurally for registrations made through
 * `PluginHost`; packages/graph still does not depend on packages/core.
 */
export interface NodeResolutionResolver extends NodeManifestResolver {
  getResolution(type: NodeType, version: Version): GraphResolvedNodeRegistrationV1 | undefined;
}

export interface GraphResolvedNodePinV1 {
  readonly nodeId: string;
  readonly type: NodeType;
  readonly version: Version;
  readonly pluginId: string;
  readonly pluginVersion: Version;
}

export interface NormalizedGraphJsonV1 {
  readonly document: GraphJsonV1;
  readonly nodePins: readonly GraphResolvedNodePinV1[];
  readonly pluginPins: readonly GraphResolvedPluginPinV1[];
}

export type GraphNormalizationDiagnosticCode =
  | "GRAPH_NORMALIZATION_RESOLUTION_REQUIRED"
  | "GRAPH_NORMALIZATION_NODE_IDENTITY_MISMATCH"
  | "GRAPH_NORMALIZATION_PLUGIN_IDENTITY_INVALID"
  | "GRAPH_NORMALIZATION_PLUGIN_VERSION_CONFLICT";

export interface GraphNormalizationDiagnostic {
  readonly code: GraphNormalizationDiagnosticCode;
  readonly message: string;
  readonly path: string;
  readonly nodeId?: string;
}

export interface GraphNormalizationResult {
  readonly valid: boolean;
  readonly normalized?: NormalizedGraphJsonV1;
  readonly diagnostics: readonly GraphNormalizationDiagnostic[];
}

function normalizePolicies(policies: GraphPoliciesV1 | undefined): GraphPoliciesV1 {
  const capabilities = policies?.capabilities;

  return {
    ...(policies?.maxNodeExecutions === undefined
      ? {}
      : { maxNodeExecutions: policies.maxNodeExecutions }),
    ...(policies?.maxParallelism === undefined ? {} : { maxParallelism: policies.maxParallelism }),
    ...(policies?.maxWallTimeMs === undefined ? {} : { maxWallTimeMs: policies.maxWallTimeMs }),
    capabilities: {
      required: capabilities?.required ?? [],
      optional: capabilities?.optional ?? [],
      deny: capabilities?.deny ?? [],
    },
  };
}

/**
 * Normalize only Harness-owned Graph JSON v1 defaults and record exact registry pins.
 *
 * This function assumes shape/semantic/compiler-facing validation has already
 * succeeded. It is a pure source-normalization step and does not mutate the input.
 * It does not repeat validation rules, strip editor metadata, reorder source
 * arrays/objects, canonicalize JSON, hash anything, or lower IR.
 *
 * Closed v1 default materialization:
 * - graph input `required` omission -> false;
 * - node `bindings` omission -> [];
 * - graph capability buckets omission -> [];
 * - top-level `policies`/`options` omission -> explicit empty/default containers.
 *
 * JSON Schema `default` remains an annotation and is deliberately not applied to
 * node config here. If executable config defaults are ever desired, they need an
 * explicit Harness contract rather than silently changing JSON Schema meaning.
 */
export function normalizeGraphJsonV1(
  graph: GraphJsonV1,
  resolver: NodeResolutionResolver,
): GraphNormalizationResult {
  const diagnostics: GraphNormalizationDiagnostic[] = [];
  const nodePins: GraphResolvedNodePinV1[] = [];
  const pluginPins: GraphResolvedPluginPinV1[] = [];
  const pluginVersionById = new Map<string, Version>();

  graph.nodes.forEach((node, index) => {
    const resolution = resolver.getResolution(node.type, node.version);
    if (resolution === undefined) {
      diagnostics.push({
        code: "GRAPH_NORMALIZATION_RESOLUTION_REQUIRED",
        message: `Node '${node.id}' requires exact node/plugin provenance before normalization.`,
        path: `/nodes/${index}`,
        nodeId: node.id,
      });
      return;
    }

    if (resolution.manifest.type !== node.type || resolution.manifest.version !== node.version) {
      diagnostics.push({
        code: "GRAPH_NORMALIZATION_NODE_IDENTITY_MISMATCH",
        message: `Node '${node.id}' resolved manifest identity does not match source '${node.type}@${node.version}'.`,
        path: `/nodes/${index}`,
        nodeId: node.id,
      });
      return;
    }

    const pluginId = resolution.plugin.id;
    const pluginVersion = resolution.plugin.version;
    if (pluginId.trim().length === 0 || pluginVersion.trim().length === 0) {
      diagnostics.push({
        code: "GRAPH_NORMALIZATION_PLUGIN_IDENTITY_INVALID",
        message: `Node '${node.id}' resolved from a plugin with an invalid id/version.`,
        path: `/nodes/${index}`,
        nodeId: node.id,
      });
      return;
    }

    const previousVersion = pluginVersionById.get(pluginId);
    if (previousVersion !== undefined && previousVersion !== pluginVersion) {
      diagnostics.push({
        code: "GRAPH_NORMALIZATION_PLUGIN_VERSION_CONFLICT",
        message: `Plugin '${pluginId}' resolved multiple versions ('${previousVersion}' and '${pluginVersion}') in one normalized graph.`,
        path: `/nodes/${index}`,
        nodeId: node.id,
      });
      return;
    }

    if (previousVersion === undefined) {
      pluginVersionById.set(pluginId, pluginVersion);
      pluginPins.push({ id: pluginId, version: pluginVersion });
    }

    nodePins.push({
      nodeId: node.id,
      type: node.type,
      version: node.version,
      pluginId,
      pluginVersion,
    });
  });

  if (diagnostics.length > 0) {
    return { valid: false, diagnostics };
  }

  const document: GraphJsonV1 = {
    schemaVersion: graph.schemaVersion,
    graphId: graph.graphId,
    revisionId: graph.revisionId,
    ...(graph.metadata === undefined ? {} : { metadata: graph.metadata }),
    inputs: graph.inputs.map((input) => ({
      ...input,
      required: input.required ?? false,
    })),
    outputs: graph.outputs.map((output) => ({ ...output })),
    nodes: graph.nodes.map((node) => ({
      ...node,
      bindings: node.bindings ?? [],
    })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    entrypoints: graph.entrypoints.map((entrypoint) => ({ ...entrypoint })),
    policies: normalizePolicies(graph.policies),
    options:
      graph.options?.defaultEntrypoint === undefined
        ? {}
        : { defaultEntrypoint: graph.options.defaultEntrypoint },
    ...(graph.editor === undefined ? {} : { editor: graph.editor }),
  };

  return {
    valid: true,
    normalized: { document, nodePins, pluginPins },
    diagnostics: [],
  };
}
