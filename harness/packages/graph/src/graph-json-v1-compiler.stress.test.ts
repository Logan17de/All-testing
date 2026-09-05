import { describe, expect, it } from "vitest";

import type { NodeManifest } from "@zet-harness/plugin-api";

import { recordGraphCompilerIdentityV1 } from "./compiler-identity-v1.js";
import { canonicalizeGraphJsonV1Semantics } from "./graph-json-v1-canonical.js";
import { checkGraphJsonV1Diagnostics } from "./graph-json-v1-diagnostics.js";
import { lowerCanonicalGraphJsonV1ToExecutionIr } from "./graph-json-v1-lowering.js";
import {
  normalizeGraphJsonV1,
  type NodeResolutionResolver,
} from "./graph-json-v1-normalization.js";
import { stripGraphJsonV1UiMetadata } from "./graph-json-v1-ui-metadata.js";
import {
  GRAPH_JSON_VERSION,
  type GraphEdgeV1,
  type GraphInputBindingV1,
  type GraphJsonV1,
  type GraphNodeV1,
} from "./graph-json-v1.js";

const stressManifest: NodeManifest = {
  type: "stress.pass",
  version: "1.0.0",
  title: "Stress pass",
  inputs: {
    in: {
      schema: { type: "string" },
      multiple: true,
    },
  },
  outputs: {
    out: { schema: { type: "string" } },
  },
  configSchema: { type: "object" },
  behavior: {
    primitiveFamily: "pure",
    determinism: "deterministic",
    effect: "none",
    idempotency: "not-applicable",
    recovery: "rerun",
    executionMode: "in-process",
    retry: { maxAttempts: 1 },
    requiredCapabilities: [],
  },
};

const resolver: NodeResolutionResolver = {
  getManifest(type, version) {
    return type === stressManifest.type && version === stressManifest.version
      ? stressManifest
      : undefined;
  },
  getResolution(type, version) {
    return type === stressManifest.type && version === stressManifest.version
      ? {
          manifest: stressManifest,
          plugin: { id: "stress.plugin", version: "1.0.0" },
        }
      : undefined;
  },
};

function createRng(seed: number): () => number {
  let state = seed % 2_147_483_647;
  if (state <= 0) state += 2_147_483_646;

  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

function shuffled<T>(items: readonly T[], rng: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    const current = result[index]!;
    result[index] = result[swapIndex]!;
    result[swapIndex] = current;
  }
  return result;
}

function nodeId(index: number): string {
  return `node-${index.toString().padStart(4, "0")}`;
}

function edgeId(index: number): string {
  return `edge-${index.toString().padStart(6, "0")}`;
}

function generateGraph(nodeCount: number, seed: number): GraphJsonV1 {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 2) {
    throw new RangeError("stress graph nodeCount must be a safe integer >= 2");
  }

  const rng = createRng(seed);
  const nodes: GraphNodeV1[] = [];
  const editorNodes: Record<string, { position: { x: number; y: number }; collapsed?: boolean }> =
    {};

  for (let index = 0; index < nodeCount; index += 1) {
    const id = nodeId(index);
    const bindings: GraphInputBindingV1[] = [];

    if (index === 0) {
      bindings.push({ kind: "graph-input", port: "in", input: "seed-a" });
      bindings.push({ kind: "literal", port: "in", value: "bootstrap" });
    }
    if (index === 1) {
      bindings.push({ kind: "graph-input", port: "in", input: "seed-b" });
    }
    if (index > 0 && index % 17 === 0) {
      bindings.push({ kind: "literal", port: "in", value: `literal-${index}` });
    }
    if (index > 0 && index % 31 === 0) {
      bindings.push({ kind: "secret", port: "in", secretRef: `stress/secret/${index}` });
    }

    nodes.push({
      id,
      type: stressManifest.type,
      version: stressManifest.version,
      config: {
        ordinal: index,
        nested: {
          seed,
          sequence: [index, index + 1],
        },
      },
      ...(bindings.length === 0 ? {} : { bindings }),
    });

    editorNodes[id] = {
      position: { x: (index % 16) * 180, y: Math.floor(index / 16) * 100 },
      ...(index % 19 === 0 ? { collapsed: true } : {}),
    };
  }

  const edges: GraphEdgeV1[] = [];
  let nextEdge = 0;
  const pushEdge = (edge: Omit<GraphEdgeV1, "id">): void => {
    edges.push({ id: edgeId(nextEdge), ...edge } as GraphEdgeV1);
    nextEdge += 1;
  };

  for (let target = 1; target < nodeCount; target += 1) {
    pushEdge({
      kind: "data",
      from: { nodeId: nodeId(target - 1), port: "out" },
      to: { nodeId: nodeId(target), port: "in" },
    });

    const extraDataEdges = Math.floor(rng() * 3);
    for (let extra = 0; extra < extraDataEdges; extra += 1) {
      const source = Math.floor(rng() * target);
      pushEdge({
        kind: "data",
        from: { nodeId: nodeId(source), port: "out" },
        to: { nodeId: nodeId(target), port: "in" },
      });
    }

    if (target % 7 === 0) {
      pushEdge({
        kind: "control",
        from: { nodeId: nodeId(target - 1) },
        to: { nodeId: nodeId(target) },
      });
    }

    if (target >= 3 && target % 11 === 0) {
      const source = Math.floor(rng() * target);
      pushEdge({
        kind: "control",
        from: { nodeId: nodeId(source) },
        to: { nodeId: nodeId(target) },
      });
    }
  }

  const outputNodeIndexes = [
    ...new Set([nodeCount - 1, Math.floor(nodeCount / 2), Math.floor(nodeCount / 4)]),
  ];

  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: `stress.generated.${nodeCount}.${seed}`,
    revisionId: "rev-stress-001",
    metadata: {
      title: `Generated stress graph ${nodeCount}`,
      labels: ["generated", "stress", `seed-${seed}`],
    },
    inputs: [
      { id: "seed-b", schema: { type: "string" }, required: true },
      { id: "seed-a", schema: { type: "string" }, required: true },
    ],
    outputs: outputNodeIndexes.map((index, outputIndex) => ({
      id: `result-${outputIndex}`,
      schema: { type: "string" },
      source: { nodeId: nodeId(index), port: "out" },
    })),
    nodes,
    edges,
    entrypoints: [{ id: "start", nodeId: nodeId(0) }],
    policies: {
      maxNodeExecutions: nodeCount * 4,
      maxParallelism: 32,
      maxWallTimeMs: 60_000,
      capabilities: {
        required: [],
        optional: [],
        deny: [],
      },
    },
    options: { defaultEntrypoint: "start" },
    editor: {
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: editorNodes,
      data: { seed, nodeCount },
    },
  };
}

function permutePresentation(graph: GraphJsonV1, seed: number): GraphJsonV1 {
  const rng = createRng(seed);
  return {
    ...structuredClone(graph),
    inputs: shuffled(graph.inputs, rng),
    outputs: shuffled(graph.outputs, rng),
    nodes: shuffled(graph.nodes, rng),
    edges: shuffled(graph.edges, rng),
    entrypoints: shuffled(graph.entrypoints, rng),
  };
}

async function compileGraph(graph: GraphJsonV1) {
  const diagnostics = checkGraphJsonV1Diagnostics(graph, {
    resolver,
    capabilityAuthority: { granted: [] },
  });
  if (!diagnostics.valid) {
    throw new Error(
      `generated graph failed validation: ${JSON.stringify(diagnostics.diagnostics)}`,
    );
  }

  const normalization = normalizeGraphJsonV1(graph, resolver);
  if (!normalization.valid || normalization.normalized === undefined) {
    throw new Error(
      `generated graph failed normalization: ${JSON.stringify(normalization.diagnostics)}`,
    );
  }

  const compilerSource = stripGraphJsonV1UiMetadata(normalization.normalized);
  const canonical = canonicalizeGraphJsonV1Semantics(compilerSource);
  const ir = lowerCanonicalGraphJsonV1ToExecutionIr(canonical, resolver);
  const identity = await recordGraphCompilerIdentityV1({
    normalized: normalization.normalized,
    canonical,
    ir,
  });

  return { canonical, identity, ir };
}

function expectTopologicalIr(ir: Awaited<ReturnType<typeof compileGraph>>["ir"]): void {
  ir.ops.forEach((op, opIndex) => {
    expect(op.dependencies).toEqual([...op.dependencies].sort((left, right) => left - right));
    expect(new Set(op.dependencies).size).toBe(op.dependencies.length);
    expect(op.dependencies.every((dependency) => dependency < opIndex)).toBe(true);

    for (const input of op.inputs) {
      if (input.source.kind === "op-output") {
        expect(input.source.op).toBeLessThan(opIndex);
      }
    }
  });
}

describe("Graph JSON v1 generated compiler stress", () => {
  it("recompiles deterministic generated DAG families to identical canonical IR and identity", async () => {
    const cases = [
      { nodeCount: 8, seed: 17 },
      { nodeCount: 32, seed: 99 },
      { nodeCount: 96, seed: 2_026 },
      { nodeCount: 192, seed: 65_537 },
    ] as const;

    for (const testCase of cases) {
      const graph = generateGraph(testCase.nodeCount, testCase.seed);
      const first = await compileGraph(graph);
      const second = await compileGraph(structuredClone(graph));

      expect(first.ir.ops).toHaveLength(testCase.nodeCount);
      expect(first.ir).toEqual(second.ir);
      expect(first.canonical.canonicalSemanticsJson).toBe(second.canonical.canonicalSemanticsJson);
      expect(first.identity).toEqual(second.identity);
      expect(Object.isFrozen(first.ir)).toBe(true);
      expectTopologicalIr(first.ir);
    }
  });

  it("keeps executable identity invariant under generated source collection permutations", async () => {
    const graph = generateGraph(256, 314_159);
    const permuted = permutePresentation(graph, 271_828);

    const original = await compileGraph(graph);
    const reordered = await compileGraph(permuted);

    expect(reordered.identity.documentHash).not.toBe(original.identity.documentHash);
    expect(reordered.identity.semanticHash).toBe(original.identity.semanticHash);
    expect(reordered.identity.registryHash).toBe(original.identity.registryHash);
    expect(reordered.identity.irHash).toBe(original.identity.irHash);
    expect(reordered.canonical.canonicalSemanticsJson).toBe(
      original.canonical.canonicalSemanticsJson,
    );
    expect(reordered.ir).toEqual(original.ir);
    expectTopologicalIr(reordered.ir);
  });

  it("compiles a 512-op generated DAG with mixed data/control dependencies without recursion or index failures", async () => {
    const graph = generateGraph(512, 1_234_567);
    const compiled = await compileGraph(graph);

    expect(graph.edges.length).toBeGreaterThan(512);
    expect(compiled.ir.ops).toHaveLength(512);
    expect(compiled.ir.graphInputs).toHaveLength(2);
    expect(compiled.ir.graphOutputs.length).toBeGreaterThanOrEqual(3);
    expect(compiled.identity.documentHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(compiled.identity.semanticHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(compiled.identity.registryHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(compiled.identity.irHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expectTopologicalIr(compiled.ir);
  });
});
