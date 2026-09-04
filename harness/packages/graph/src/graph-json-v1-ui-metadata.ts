import type { GraphJsonV1 } from "./graph-json-v1.js";
import type {
  GraphResolvedNodePinV1,
  GraphResolvedPluginPinV1,
  NormalizedGraphJsonV1,
} from "./graph-json-v1-normalization.js";

/**
 * Compiler-facing normalized source after removing authoring-only UI state.
 *
 * Human document identity/metadata remain present here. 2.19 owns deterministic
 * canonicalization/source-semantic projection, and 2.21 owns the distinct
 * document/semantic/IR hash domains.
 */
export type GraphJsonV1WithoutEditor = Omit<GraphJsonV1, "editor">;

export interface GraphCompilerSourceV1 {
  readonly document: GraphJsonV1WithoutEditor;
  readonly nodePins: readonly GraphResolvedNodePinV1[];
  readonly pluginPins: readonly GraphResolvedPluginPinV1[];
}

/**
 * Strip only the top-level Graph JSON v1 `editor` bucket.
 *
 * This is a pure compiler stage over 2.17 normalized output. It deliberately
 * does not recursively remove properties named `editor`, strip human metadata,
 * reorder collections, canonicalize JSON, hash content, or lower Execution IR.
 */
export function stripGraphJsonV1UiMetadata(
  normalized: NormalizedGraphJsonV1,
): GraphCompilerSourceV1 {
  const source = normalized.document;
  const document: GraphJsonV1WithoutEditor = {
    schemaVersion: source.schemaVersion,
    graphId: source.graphId,
    revisionId: source.revisionId,
    ...(source.metadata === undefined ? {} : { metadata: source.metadata }),
    inputs: source.inputs,
    outputs: source.outputs,
    nodes: source.nodes,
    edges: source.edges,
    entrypoints: source.entrypoints,
    ...(source.policies === undefined ? {} : { policies: source.policies }),
    ...(source.options === undefined ? {} : { options: source.options }),
  };

  return {
    document,
    nodePins: normalized.nodePins,
    pluginPins: normalized.pluginPins,
  };
}
