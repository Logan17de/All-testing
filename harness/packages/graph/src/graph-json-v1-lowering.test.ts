import { describe, expect, it } from "vitest";

import type {
  NodeBehavior,
  NodeManifest,
  NodeStructuredControlContract,
} from "@zet-harness/plugin-api";

import { canonicalizeGraphJsonV1Semantics } from "./graph-json-v1-canonical.js";
import { lowerCanonicalGraphJsonV1ToExecutionIr } from "./graph-json-v1-lowering.js";
import type { GraphCompilerSourceV1 } from "./graph-json-v1-ui-metadata.js";
import type { NodeResolutionResolver } from "./graph-json-v1-normalization.js";

const executableBehavior: NodeBehavior = {
  primitiveFamily: "pure",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "rerun",
  executionMode: "in-process",
  retry: { maxAttempts: 2, backoffMs: 5 },
  requiredCapabilities: [],
};

const controlBehavior: NodeBehavior = {
  primitiveFamily: "control",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "not-applicable",
  executionMode: "none",
  requiredCapabilities: [],
};

function manifest(
  type: string,
  options: {
    readonly inputs?: NodeManifest["inputs"];
    readonly outputs?: NodeManifest["outputs"];
    readonly behavior?: NodeBehavior;
    readonly control?: NodeStructuredControlContract;
  } = {},
): NodeManifest {
  return {
    type,
    version: "1",
    title: type,
    inputs: options.inputs ?? {},
    outputs: options.outputs ?? {},
    configSchema: { type: "object" },
    behavior: options.behavior ?? executableBehavior,
    ...(options.control === undefined ? {} : { control: options.control }),
  };
}

const manifests: readonly NodeManifest[] = [
  manifest("source", { outputs: { out: { schema: { type: "string" } } } }),
  manifest("aggregate", {
    inputs: { item: { schema: { type: "string" }, multiple: true } },
    outputs: { out: { schema: { type: "string" } } },
  }),
  manifest("branch", {}),
  manifest("finish", {
    inputs: {
      body: { schema: { type: "string" } },
      token: { schema: { type: "string" }, secret: true },
    },
    outputs: { out: { schema: { type: "string" } } },
    behavior: { ...executableBehavior, requiredCapabilities: ["network:http"] },
  }),
  manifest("router", {
    behavior: controlBehavior,
    control: { kind: "router", entry: "in", branches: ["yes", "no"] },
  }),
  manifest("join", {
    behavior: controlBehavior,
    control: {
      kind: "join",
      inputs: ["left", "right"],
      output: "out",
      mode: "all-active",
    },
  }),
];

function resolver(pluginVersion = "3"): NodeResolutionResolver {
  return {
    getManifest(type, version) {
      return version === "1" ? manifests.find((item) => item.type === type) : undefined;
    },
    getResolution(type, version) {
      const resolved = version === "1" ? manifests.find((item) => item.type === type) : undefined;
      return resolved === undefined
        ? undefined
        : { manifest: resolved, plugin: { id: "test.plugin", version: pluginVersion } };
    },
  };
}

function compilerSource(): GraphCompilerSourceV1 {
  const nodePins = [
    "route",
    "source-z",
    "aggregate",
    "finish",
    "left",
    "join",
    "source-a",
    "right",
  ].map((nodeId) => {
    const type =
      nodeId === "route"
        ? "router"
        : nodeId === "join"
          ? "join"
          : nodeId === "aggregate"
            ? "aggregate"
            : nodeId === "finish"
              ? "finish"
              : nodeId === "left" || nodeId === "right"
                ? "branch"
                : "source";
    return {
      nodeId,
      type,
      version: "1",
      pluginId: "test.plugin",
      pluginVersion: "3",
    };
  });

  return {
    document: {
      schemaVersion: 1,
      graphId: "lowering-test",
      revisionId: "rev-1",
      metadata: { title: "ignored by semantic lowering" },
      inputs: [{ id: "prompt", schema: { type: "string" }, required: true }],
      outputs: [
        {
          id: "result",
          schema: { type: "string" },
          source: { nodeId: "finish", port: "out" },
        },
      ],
      nodes: [
        { id: "route", type: "router", version: "1", config: {}, bindings: [] },
        { id: "source-z", type: "source", version: "1", config: {}, bindings: [] },
        {
          id: "aggregate",
          type: "aggregate",
          version: "1",
          config: { sequence: ["keep", "ordered"] },
          bindings: [
            { kind: "literal", port: "item", value: "literal-first" },
            { kind: "graph-input", port: "item", input: "prompt" },
          ],
        },
        {
          id: "finish",
          type: "finish",
          version: "1",
          config: { endpoint: "example" },
          bindings: [{ kind: "secret", port: "token", secretRef: "publish-token" }],
        },
        { id: "left", type: "branch", version: "1", config: {}, bindings: [] },
        { id: "join", type: "join", version: "1", config: {}, bindings: [] },
        { id: "source-a", type: "source", version: "1", config: {}, bindings: [] },
        { id: "right", type: "branch", version: "1", config: {}, bindings: [] },
      ],
      edges: [
        {
          id: "z-finish-data",
          kind: "data",
          from: { nodeId: "aggregate", port: "out" },
          to: { nodeId: "finish", port: "body" },
        },
        {
          id: "g-join-finish",
          kind: "control",
          from: { nodeId: "join", port: "out" },
          to: { nodeId: "finish" },
        },
        {
          id: "f-right-join",
          kind: "control",
          from: { nodeId: "right" },
          to: { nodeId: "join", port: "right" },
        },
        {
          id: "e-left-join",
          kind: "control",
          from: { nodeId: "left" },
          to: { nodeId: "join", port: "left" },
        },
        {
          id: "d-route-right",
          kind: "control",
          from: { nodeId: "route", port: "no" },
          to: { nodeId: "right" },
        },
        {
          id: "c-route-left",
          kind: "control",
          from: { nodeId: "route", port: "yes" },
          to: { nodeId: "left" },
        },
        {
          id: "b-aggregate-route",
          kind: "control",
          from: { nodeId: "aggregate" },
          to: { nodeId: "route", port: "in" },
        },
        {
          id: "b-data-a",
          kind: "data",
          from: { nodeId: "source-a", port: "out" },
          to: { nodeId: "aggregate", port: "item" },
        },
        {
          id: "a-data-z",
          kind: "data",
          from: { nodeId: "source-z", port: "out" },
          to: { nodeId: "aggregate", port: "item" },
        },
      ],
      entrypoints: [
        { id: "z-start", nodeId: "source-z" },
        { id: "a-start", nodeId: "source-a" },
      ],
      policies: {
        maxNodeExecutions: 20,
        maxParallelism: 4,
        capabilities: {
          required: ["network:http"],
          optional: ["telemetry:write"],
          deny: ["fs:write"],
        },
      },
      options: { defaultEntrypoint: "a-start" },
    },
    nodePins,
    pluginPins: [{ id: "test.plugin", version: "3" }],
  };
}

function canonicalSource() {
  return canonicalizeGraphJsonV1Semantics(compilerSource());
}

describe("Graph JSON v1 -> Execution IR v1 lowering", () => {
  it("uses canonical node/input/entrypoint order as numeric IR index domains", () => {
    const ir = lowerCanonicalGraphJsonV1ToExecutionIr(canonicalSource(), resolver());

    expect(ir.ops.map(({ sourceNodeId }) => sourceNodeId)).toEqual([
      "aggregate",
      "finish",
      "join",
      "left",
      "right",
      "route",
      "source-a",
      "source-z",
    ]);
    expect(ir.graphInputs).toEqual([{ id: "prompt", required: true }]);
    expect(ir.entrypoints).toEqual([
      { id: "a-start", op: 6 },
      { id: "z-start", op: 7 },
    ]);
    expect(ir.defaultEntrypoint).toBe(0);
    expect(ir.graphOutputs).toEqual([{ id: "result", source: { op: 1, port: "out" } }]);
    expect(Object.isFrozen(ir)).toBe(true);
  });

  it("lowers data edges into value sources plus DAG dependencies with explicit multi-source order", () => {
    const ir = lowerCanonicalGraphJsonV1ToExecutionIr(canonicalSource(), resolver());
    const aggregate = ir.ops[0];
    const finish = ir.ops[1];

    expect(aggregate?.inputs).toEqual([
      { port: "item", source: { kind: "literal", value: "literal-first" } },
      { port: "item", source: { kind: "graph-input", input: 0 } },
      { port: "item", source: { kind: "op-output", op: 7, port: "out" } },
      { port: "item", source: { kind: "op-output", op: 6, port: "out" } },
    ]);
    expect(aggregate?.dependencies).toEqual([6, 7]);

    expect(finish?.inputs).toEqual([
      { port: "token", source: { kind: "secret", secretRef: "publish-token" } },
      { port: "body", source: { kind: "op-output", op: 0, port: "out" } },
    ]);
    expect(finish?.dependencies).toEqual([0, 2]);
    expect(finish?.behavior.requiredCapabilities).toEqual(["network:http"]);
  });

  it("lowers ported control edges plus router and all-active join descriptors", () => {
    const ir = lowerCanonicalGraphJsonV1ToExecutionIr(canonicalSource(), resolver());

    expect(ir.ops[5]?.control).toEqual({
      kind: "router",
      entry: "in",
      branches: ["yes", "no"],
    });
    expect(ir.ops[2]?.control).toEqual({
      kind: "join",
      inputs: ["left", "right"],
      output: "out",
      mode: "all-active",
    });
    expect(ir.ops[3]?.dependencies).toEqual([5]);
    expect(ir.ops[4]?.dependencies).toEqual([5]);
    expect(ir.ops[2]?.dependencies).toEqual([3, 4]);
    expect(ir.controlEdges).toEqual([
      { from: { op: 0 }, to: { op: 5, port: "in" } },
      { from: { op: 5, port: "yes" }, to: { op: 3 } },
      { from: { op: 5, port: "no" }, to: { op: 4 } },
      { from: { op: 3 }, to: { op: 2, port: "left" } },
      { from: { op: 4 }, to: { op: 2, port: "right" } },
      { from: { op: 2, port: "out" }, to: { op: 1 } },
    ]);
  });

  it("copies graph runtime policy intent without embedding external grants", () => {
    const ir = lowerCanonicalGraphJsonV1ToExecutionIr(canonicalSource(), resolver());

    expect(ir.policies).toEqual({
      maxNodeExecutions: 20,
      maxParallelism: 4,
      capabilities: {
        required: ["network:http"],
        optional: ["telemetry:write"],
        deny: ["fs:write"],
      },
    });
    expect(ir.policies).not.toHaveProperty("grantedCapabilities");
    expect(ir.policies).not.toHaveProperty("effectiveCapabilities");
  });

  it("rejects registry provenance drift as a compiler invariant instead of silently lowering", () => {
    expect(() =>
      lowerCanonicalGraphJsonV1ToExecutionIr(canonicalSource(), resolver("4")),
    ).toThrow(/resolved plugin provenance changed during lowering/);
  });

  it("does not lower later loop/human/subgraph execution semantics in 2.22", () => {
    const laterManifests: readonly NodeManifest[] = [
      manifest("loop-node", {
        behavior: controlBehavior,
        control: {
          kind: "loop",
          entry: "entry",
          continue: "continue",
          body: "body",
          exit: "exit",
        },
      }),
      {
        ...manifest("human-node", {
          behavior: { ...controlBehavior, primitiveFamily: "interrupt" },
          control: { kind: "human-interrupt", entry: "wait", outcomes: ["approved"] },
        }),
      },
      manifest("subgraph-node", {
        behavior: controlBehavior,
        control: { kind: "subgraph", entry: "call", exits: ["done"] },
      }),
    ];
    const laterResolver: NodeResolutionResolver = {
      getManifest(type) {
        return laterManifests.find((item) => item.type === type);
      },
      getResolution(type) {
        const resolved = laterManifests.find((item) => item.type === type);
        return resolved === undefined
          ? undefined
          : { manifest: resolved, plugin: { id: "later.plugin", version: "1" } };
      },
    };
    const source: GraphCompilerSourceV1 = {
      document: {
        schemaVersion: 1,
        graphId: "later-control",
        revisionId: "1",
        inputs: [],
        outputs: [],
        nodes: laterManifests.map((item) => ({
          id: item.type,
          type: item.type,
          version: "1",
          config: item.type === "loop-node" ? { maxIterations: 3 } : {},
          bindings: [],
        })),
        edges: [],
        entrypoints: [],
        policies: { capabilities: { required: [], optional: [], deny: [] } },
        options: {},
      },
      nodePins: laterManifests.map((item) => ({
        nodeId: item.type,
        type: item.type,
        version: "1",
        pluginId: "later.plugin",
        pluginVersion: "1",
      })),
      pluginPins: [{ id: "later.plugin", version: "1" }],
    };

    const ir = lowerCanonicalGraphJsonV1ToExecutionIr(
      canonicalizeGraphJsonV1Semantics(source),
      laterResolver,
    );
    expect(ir.ops.map((op) => op.control)).toEqual([undefined, undefined, undefined]);
  });
});
