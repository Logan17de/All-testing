import { describe, expect, it } from "vitest";

import { canonicalizeGraphJsonV1Semantics } from "./graph-json-v1-canonical.js";
import type { NormalizedGraphJsonV1 } from "./graph-json-v1-normalization.js";
import { stripGraphJsonV1UiMetadata } from "./graph-json-v1-ui-metadata.js";
import {
  GRAPH_COMPILER_VERSION,
  GRAPH_HASH_ALGORITHM,
  recordGraphCompilerIdentityV1,
} from "./compiler-identity-v1.js";
import { createExecutionIrV1, type ExecutionIrV1 } from "./execution-ir-v1.js";

function normalizedSource(): NormalizedGraphJsonV1 {
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

function canonicalSource(normalized: NormalizedGraphJsonV1) {
  return canonicalizeGraphJsonV1Semantics(stripGraphJsonV1UiMetadata(normalized));
}

function executionIr(configMode = "plain"): ExecutionIrV1 {
  return createExecutionIrV1({
    format: "harness.ir/v1",
    graphInputs: [{ id: "prompt", required: false }],
    graphOutputs: [{ id: "result", source: { op: 0, port: "result" } }],
    ops: [
      {
        sourceNodeId: "echo",
        type: "test.echo",
        version: "1",
        config: { mode: configMode },
        inputs: [{ port: "prompt", source: { kind: "graph-input", input: 0 } }],
        dependencies: [],
        behavior: {
          primitiveFamily: "pure",
          determinism: "deterministic",
          effect: "none",
          idempotency: "not-applicable",
          recovery: "rerun",
          executionMode: "in-process",
          requiredCapabilities: [],
        },
      },
    ],
    controlEdges: [],
    entrypoints: [{ id: "start", op: 0 }],
    defaultEntrypoint: 0,
    policies: {
      maxNodeExecutions: 4,
      capabilities: { required: [], optional: [], deny: [] },
    },
  });
}

async function identityFor(normalized = normalizedSource(), ir = executionIr()) {
  return recordGraphCompilerIdentityV1({
    normalized,
    canonical: canonicalSource(normalized),
    ir,
  });
}

describe("Graph compiler identity v1", () => {
  it("records domain-separated SHA-256 identities, compiler version, and exact resolved pins", async () => {
    const identity = await identityFor();
    const hashes = [
      identity.documentHash,
      identity.semanticHash,
      identity.registryHash,
      identity.irHash,
    ];

    expect(identity.compilerVersion).toBe(GRAPH_COMPILER_VERSION);
    expect(identity.compilerVersion).toBe("harness.compiler/v1");
    expect(identity.hashAlgorithm).toBe(GRAPH_HASH_ALGORITHM);
    expect(identity.hashAlgorithm).toBe("sha256");
    for (const hash of hashes) {
      expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(identity.nodePins).toEqual([
      {
        nodeId: "echo",
        type: "test.echo",
        version: "1",
        pluginId: "test.plugin",
        pluginVersion: "3",
      },
    ]);
    expect(identity.pluginPins).toEqual([{ id: "test.plugin", version: "3" }]);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.nodePins)).toBe(true);
    expect(Object.isFrozen(identity.nodePins[0])).toBe(true);
  });

  it("changes document identity for authoring/document changes while preserving executable semantic identity", async () => {
    const original = normalizedSource();
    const changed: NormalizedGraphJsonV1 = {
      ...original,
      document: {
        ...original.document,
        graphId: "same-program-new-name",
        revisionId: "rev-2",
        metadata: { title: "Renamed", labels: ["human-only"] },
        editor: {
          viewport: { x: 999, y: -200, zoom: 2 },
          nodes: { echo: { position: { x: 500, y: 700 }, collapsed: true } },
        },
      },
    };

    const before = await identityFor(original);
    const after = await identityFor(changed);

    expect(after.documentHash).not.toBe(before.documentHash);
    expect(after.semanticHash).toBe(before.semanticHash);
    expect(after.registryHash).toBe(before.registryHash);
    expect(after.irHash).toBe(before.irHash);
  });

  it("canonicalizes object-key serialization noise inside the exact document hash", async () => {
    const left = normalizedSource();
    const right: NormalizedGraphJsonV1 = {
      ...left,
      document: {
        ...left.document,
        nodes: [
          {
            ...left.document.nodes[0]!,
            config: { z: 2, a: 1 },
          },
        ],
      },
    };
    const reordered: NormalizedGraphJsonV1 = {
      ...right,
      document: {
        ...right.document,
        nodes: [
          {
            ...right.document.nodes[0]!,
            config: { a: 1, z: 2 },
          },
        ],
      },
    };

    const first = await identityFor(right, executionIr("different-ir-is-irrelevant-here"));
    const second = await identityFor(reordered, executionIr("different-ir-is-irrelevant-here"));

    expect(second.documentHash).toBe(first.documentHash);
    expect(second.semanticHash).toBe(first.semanticHash);
  });

  it("keeps registry identity separate from semantic identity", async () => {
    const original = normalizedSource();
    const changedRegistry: NormalizedGraphJsonV1 = {
      ...original,
      nodePins: original.nodePins.map((pin) => ({
        ...pin,
        pluginVersion: "4",
      })),
      pluginPins: [{ id: "test.plugin", version: "4" }],
    };

    const before = await identityFor(original);
    const after = await identityFor(changedRegistry);

    expect(after.semanticHash).toBe(before.semanticHash);
    expect(after.registryHash).not.toBe(before.registryHash);
    expect(after.nodePins[0]?.pluginVersion).toBe("4");
    expect(after.pluginPins[0]?.version).toBe("4");
  });

  it("keeps IR content identity separate from source and registry identities", async () => {
    const normalized = normalizedSource();
    const before = await identityFor(normalized, executionIr("plain"));
    const after = await identityFor(normalized, executionIr("changed"));

    expect(after.documentHash).toBe(before.documentHash);
    expect(after.semanticHash).toBe(before.semanticHash);
    expect(after.registryHash).toBe(before.registryHash);
    expect(after.irHash).not.toBe(before.irHash);
  });

  it("is deterministic across repeated recordings without hard-coding digest vectors yet", async () => {
    const normalized = normalizedSource();
    const canonical = canonicalSource(normalized);
    const ir = executionIr();

    const first = await recordGraphCompilerIdentityV1({ normalized, canonical, ir });
    const second = await recordGraphCompilerIdentityV1({ normalized, canonical, ir });

    expect(second).toEqual(first);
  });
});
