import type { JsonValue } from "@zet-harness/plugin-api";

import type { CanonicalGraphCompilerSourceV1 } from "./graph-json-v1-canonical.js";
import { stringifyCanonicalJsonV1 } from "./graph-json-v1-canonical.js";
import type {
  GraphResolvedNodePinV1,
  GraphResolvedPluginPinV1,
  NormalizedGraphJsonV1,
} from "./graph-json-v1-normalization.js";
import type { ExecutionIrV1 } from "./execution-ir-v1.js";

/** Explicit compiler behavior identity. Bump whenever deterministic lowering semantics change. */
export const GRAPH_COMPILER_VERSION = "harness.compiler/v1" as const;
export type GraphCompilerVersion = typeof GRAPH_COMPILER_VERSION;

export const GRAPH_HASH_ALGORITHM = "sha256" as const;
export type GraphHashAlgorithm = typeof GRAPH_HASH_ALGORITHM;
export type GraphContentHashV1 = `sha256:${string}`;

const DOCUMENT_HASH_DOMAIN = "harness.document/v1";
const SEMANTIC_HASH_DOMAIN = "harness.semantics/v1";
const REGISTRY_HASH_DOMAIN = "harness.registry/v1";
const IR_HASH_DOMAIN = "harness.ir-content/v1";

export interface GraphCompilerIdentityInputV1 {
  /** 2.17 normalized authoring document; editor/human/document identity is retained here. */
  readonly normalized: NormalizedGraphJsonV1;
  /** 2.19 canonical executable semantics plus sorted resolved registry pins. */
  readonly canonical: CanonicalGraphCompilerSourceV1;
  /** Already-formed 2.20 immutable execution-plan content. */
  readonly ir: ExecutionIrV1;
}

/**
 * Immutable provenance recorded beside a compiled Execution IR.
 *
 * Hash domains intentionally remain independent:
 * - documentHash = exact normalized authoring document content;
 * - semanticHash = executable GraphSemanticsV1 content only;
 * - registryHash = exact resolved node/plugin pin snapshot used by compilation;
 * - irHash = ExecutionIrV1 content only.
 *
 * compilerVersion is separate input provenance. It is not folded into semantic,
 * registry, or IR content hashes, preserving the frozen compile identity model:
 * semanticHash + registryHash + compilerVersion -> deterministic compilation.
 */
export interface GraphCompilerIdentityV1 {
  readonly compilerVersion: GraphCompilerVersion;
  readonly hashAlgorithm: GraphHashAlgorithm;
  readonly documentHash: GraphContentHashV1;
  readonly semanticHash: GraphContentHashV1;
  readonly registryHash: GraphContentHashV1;
  readonly irHash: GraphContentHashV1;
  readonly nodePins: readonly GraphResolvedNodePinV1[];
  readonly pluginPins: readonly GraphResolvedPluginPinV1[];
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashCanonicalJsonV1(
  domain: string,
  canonicalJson: string,
): Promise<GraphContentHashV1> {
  const bytes = new TextEncoder().encode(`${domain}\u0000${canonicalJson}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `${GRAPH_HASH_ALGORITHM}:${toHex(new Uint8Array(digest))}`;
}

function cloneNodePins(pins: readonly GraphResolvedNodePinV1[]): readonly GraphResolvedNodePinV1[] {
  return Object.freeze(pins.map((pin) => Object.freeze({ ...pin })));
}

function clonePluginPins(
  pins: readonly GraphResolvedPluginPinV1[],
): readonly GraphResolvedPluginPinV1[] {
  return Object.freeze(pins.map((pin) => Object.freeze({ ...pin })));
}

/**
 * Record the 2.21 content/provenance identities for one already-compiled IR.
 *
 * This function performs no Graph-to-IR lowering and does not mutate any input.
 * The document hash uses canonical JSON object-key ordering while preserving the
 * normalized authoring document's arrays/editor/human metadata. Semantic
 * canonicalization and unordered graph collection ordering were already frozen
 * by 2.19. Registry pins are likewise consumed in 2.19 canonical order.
 *
 * SHA-256 runs through Web Crypto, keeping this package free of a Node-only crypto
 * import while remaining available in the Node 24 runtime and future editor-side
 * verification contexts.
 */
export async function recordGraphCompilerIdentityV1(
  input: GraphCompilerIdentityInputV1,
): Promise<GraphCompilerIdentityV1> {
  const documentJson = stringifyCanonicalJsonV1(
    input.normalized.document as unknown as JsonValue,
  );
  const registryJson = stringifyCanonicalJsonV1({
    nodePins: input.canonical.nodePins,
    pluginPins: input.canonical.pluginPins,
  } as unknown as JsonValue);
  const irJson = stringifyCanonicalJsonV1(input.ir as unknown as JsonValue);

  const [documentHash, semanticHash, registryHash, irHash] = await Promise.all([
    hashCanonicalJsonV1(DOCUMENT_HASH_DOMAIN, documentJson),
    hashCanonicalJsonV1(SEMANTIC_HASH_DOMAIN, input.canonical.canonicalSemanticsJson),
    hashCanonicalJsonV1(REGISTRY_HASH_DOMAIN, registryJson),
    hashCanonicalJsonV1(IR_HASH_DOMAIN, irJson),
  ]);

  const identity: GraphCompilerIdentityV1 = {
    compilerVersion: GRAPH_COMPILER_VERSION,
    hashAlgorithm: GRAPH_HASH_ALGORITHM,
    documentHash,
    semanticHash,
    registryHash,
    irHash,
    nodePins: cloneNodePins(input.canonical.nodePins),
    pluginPins: clonePluginPins(input.canonical.pluginPins),
  };

  return Object.freeze(identity);
}
