import { describe, expect, it } from "vitest";

import type { NodeManifest } from "@zet-harness/plugin-api";

import {
  GRAPH_COMPILER_VERSION,
  recordGraphCompilerIdentityV1,
} from "./compiler-identity-v1.js";
import { canonicalizeGraphJsonV1Semantics } from "./graph-json-v1-canonical.js";
import { lowerCanonicalGraphJsonV1ToExecutionIr } from "./graph-json-v1-lowering.js";
import type {
  NodeResolutionResolver,
  NormalizedGraphJsonV1,
} from "./graph-json-v1-normalization.js";
import { stripGraphJsonV1UiMetadata } from "./graph-json-v1-ui-metadata.js";

const GOLDEN = Object.freeze({
  documentHash: "sha256:6434ef1c3ce41b4adb13a1194091c9e7f16340b6f7ada80b6df46b47176e9a34",
  semanticHash: "sha256:90dde150b843b2edd3f22b11a8e48a459d63a738b34a636b9e29873474a4dafb",
  registryHash: "sha256:aeb174c35782fddeb3b259c6a27f7400dc31314f7cc11997f987523027acf168",
  irHash: "sha256:23acf902edad93c6dd1eff53dc15245e16dfe61a70633e31e68f34fe151cecb7",
});

const echoManifest: NodeManifest = {
  type: "test.echo",
  version: "1",
  title: "Echo",
  inputs: {
    prompt: { schema: { type: "string" } },
  },
  outputs: {
    result: { schema: { type: "string" } },
  },
  configSchema: { type: "object" },
  behavior: {
    primitiveFamily: "pure",
    determinism: "deterministic",
    effect: "none",
    idempotency: "not-applicable",
    recovery: "rerun",
    executionMode: "in-process",
    requiredCapabilities: [],
  },
};

const resolver: NodeResolutionResolver = {
  getManifest(type, version) {
    return type === echoManifest.type && version === echoManifest.version ? echoManifest : undefined;
  },
  getResolution(type, version) {
    return type === echoManifest.type && version === echoManifest.version
      ? {
          manifest: echoManifest,
          plugin: { id: "test.plugin", version: "3" },
        }
      : undefined;
  },
};

function normalizedFixture(): NormalizedGraphJsonV1 {
  return {
    document: {
      schemaVersion: 1,
      graphId: "identity-test",
      revisionId: "rev-1",
      metadata: { title: "Identity test", labels: ["two", "one"] },
      inputs: [{ id: "prompt", schema: { type: "string" }, required: false }],
      outputs: [
        {
          id: "result",
          schema: { type: "string" },
          source: { nodeId: "echo", port: "result" },
        },
      ],
      nodes: [
        {
          id: "echo",
          type: "test.echo",
          version: "1",
          config: { mode: "plain" },
          bindings: [{ kind: "graph-input", port: "prompt", input: "prompt" }],
        },
      ],
      edges: [],
      entrypoints: [{ id: "start", nodeId: "echo" }],
      policies: {
        maxNodeExecutions: 4,
        capabilities: { required: [], optional: [], deny: [] },
      },
      options: { defaultEntrypoint: "start" },
      editor: {
        viewport: { x: 10, y: 20, zoom: 1 },
        nodes: { echo: { position: { x: 50, y: 70 } } },
      },
    },
    nodePins: [
      {
        nodeId: "echo",
        type: "test.echo",
        version: "1",
        pluginId: "test.plugin",
        pluginVersion: "3",
      },
    ],
    pluginPins: [{ id: "test.plugin", version: "3" }],
  };
}

async function compileIdentity(normalized: NormalizedGraphJsonV1) {
  const canonical = canonicalizeGraphJsonV1Semantics(stripGraphJsonV1UiMetadata(normalized));
  const ir = lowerCanonicalGraphJsonV1ToExecutionIr(canonical, resolver);
  const identity = await recordGraphCompilerIdentityV1({ normalized, canonical, ir });
  return { canonical, ir, identity };
}

describe("Graph compiler canonical hash golden vectors", () => {
  it("locks the complete v1 document/semantic/registry/IR SHA-256 vector", async () => {
    const { identity } = await compileIdentity(normalizedFixture());

    expect(identity.compilerVersion).toBe(GRAPH_COMPILER_VERSION);
    expect(identity.compilerVersion).toBe("harness.compiler/v1");
    expect(identity).toMatchObject(GOLDEN);
  });

  it("recompiles the same source and registry to byte-identical canonical IR and hashes", async () => {
    const source = normalizedFixture();
    const first = await compileIdentity(source);
    const second = await compileIdentity(structuredClone(source));

    expect(second.canonical.canonicalSemanticsJson).toBe(first.canonical.canonicalSemanticsJson);
    expect(second.ir).toEqual(first.ir);
    expect(second.identity).toEqual(first.identity);
    expect(second.identity).toMatchObject(GOLDEN);
  });

  it("keeps authoring-only editor changes outside semantic, registry, and IR golden domains", async () => {
    const source = normalizedFixture();
    const changed: NormalizedGraphJsonV1 = {
      ...source,
      document: {
        ...source.document,
        editor: {
          viewport: { x: -999, y: 400, zoom: 2 },
          nodes: { echo: { position: { x: 999, y: -500 }, collapsed: true } },
        },
      },
    };

    const baseline = await compileIdentity(source);
    const after = await compileIdentity(changed);

    expect(after.identity.documentHash).not.toBe(GOLDEN.documentHash);
    expect(after.identity.semanticHash).toBe(GOLDEN.semanticHash);
    expect(after.identity.registryHash).toBe(GOLDEN.registryHash);
    expect(after.identity.irHash).toBe(GOLDEN.irHash);
    expect(after.canonical.canonicalSemanticsJson).toBe(baseline.canonical.canonicalSemanticsJson);
    expect(after.ir).toEqual(baseline.ir);
  });
});
