import { describe, expect, it } from "vitest";

import type {
  NodeBehavior,
  NodeManifest,
  NodeStructuredControlContract,
} from "@zet-harness/plugin-api";

import { createExecutionIrV1, EXECUTION_IR_FORMAT, type ExecutionIrV1 } from "./execution-ir-v1.js";
import { checkGraphJsonV1Acyclicity } from "./graph-json-v1-acyclicity.js";
import { canonicalizeGraphJsonV1Semantics } from "./graph-json-v1-canonical.js";
import { checkGraphJsonV1Diagnostics } from "./graph-json-v1-diagnostics.js";
import { findGraphJsonV1LoopRegions } from "./graph-json-v1-loop-regions.js";
import { lowerCanonicalGraphJsonV1ToExecutionIr } from "./graph-json-v1-lowering.js";
import type { NodeResolutionResolver } from "./graph-json-v1-normalization.js";
import { GRAPH_JSON_VERSION, type GraphEdgeV1, type GraphJsonV1 } from "./graph-json-v1.js";

const PURE: NodeBehavior = {
  primitiveFamily: "pure",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

const CONTROL: NodeBehavior = {
  primitiveFamily: "control",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "not-applicable",
  executionMode: "none",
  requiredCapabilities: [],
};

const text = { schema: { type: "string" } } as const;
const requiredText = { schema: { type: "string" }, required: true } as const;

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
    behavior: options.behavior ?? PURE,
    ...(options.control === undefined ? {} : { control: options.control }),
  };
}

const manifests: readonly NodeManifest[] = [
  manifest("source", { outputs: { value: text } }),
  manifest("pass", { inputs: { value: requiredText }, outputs: { value: text } }),
  manifest("sink", { inputs: { value: requiredText } }),
  manifest("loop", {
    inputs: { again: { schema: true } },
    behavior: CONTROL,
    control: { kind: "loop", entry: "enter", continue: "continue", body: "body", exit: "exit" },
  }),
];

const resolver: NodeResolutionResolver = {
  getManifest(type, version) {
    return version === "1" ? manifests.find((item) => item.type === type) : undefined;
  },
  getResolution(type, version) {
    const found = version === "1" ? manifests.find((item) => item.type === type) : undefined;
    return found === undefined
      ? undefined
      : { manifest: found, plugin: { id: "test.plugin", version: "1" } };
  },
};

function data(id: string, from: string, fromPort: string, to: string, toPort: string): GraphEdgeV1 {
  return {
    id,
    kind: "data",
    from: { nodeId: from, port: fromPort },
    to: { nodeId: to, port: toPort },
  };
}

function control(
  id: string,
  from: string,
  to: string,
  ports: { readonly from?: string; readonly to?: string } = {},
): GraphEdgeV1 {
  return {
    id,
    kind: "control",
    from: ports.from === undefined ? { nodeId: from } : { nodeId: from, port: ports.from },
    to: ports.to === undefined ? { nodeId: to } : { nodeId: to, port: ports.to },
  };
}

function node(id: string, type: string, config: GraphJsonV1["nodes"][number]["config"] = {}) {
  return { id, type, version: "1", config, bindings: [] };
}

const LOOP_NODES = [
  node("start", "source"),
  node("loop", "loop", { maxIterations: 3 }),
  node("step", "pass"),
  node("check", "pass"),
  node("after", "sink"),
];

const LOOP_EDGES: readonly GraphEdgeV1[] = [
  control("enter", "start", "loop", { to: "enter" }),
  data("seed", "start", "value", "step", "value"),
  control("body", "loop", "step", { from: "body" }),
  data("step-check", "step", "value", "check", "value"),
  control("continue", "check", "loop", { to: "continue" }),
  data("again", "check", "value", "loop", "again"),
  control("exit", "loop", "after", { from: "exit" }),
  data("final", "check", "value", "after", "value"),
];

/**
 * start → loop ─body→ step → check ─continue→ loop, check.value → loop.again,
 * loop ─exit→ after, which reads check's final value.
 */
function loopGraph(overrides: Partial<GraphJsonV1> = {}): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "loop-graph",
    revisionId: "rev-1",
    inputs: [],
    outputs: [],
    nodes: LOOP_NODES,
    edges: LOOP_EDGES,
    entrypoints: [{ id: "main", nodeId: "start" }],
    policies: {
      maxNodeExecutions: 20,
      maxParallelism: 2,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
    ...overrides,
  };
}

function codesOf(graph: GraphJsonV1): readonly string[] {
  return checkGraphJsonV1Acyclicity(graph, resolver).diagnostics.map(({ code }) => code);
}

describe("loop body regions", () => {
  it("finds the body between a loop's body and continue ports", () => {
    expect(findGraphJsonV1LoopRegions(loopGraph(), resolver)).toEqual({
      regions: [
        {
          loopNodeId: "loop",
          control: {
            kind: "loop",
            entry: "enter",
            continue: "continue",
            body: "body",
            exit: "exit",
          },
          regionNodeIds: ["step", "check"],
          backEdgeIds: ["continue", "again"],
        },
      ],
      diagnostics: [],
    });
  });

  it("accepts the loop cycle only when the resolver identifies the loop node", () => {
    expect(checkGraphJsonV1Acyclicity(loopGraph(), resolver)).toEqual({
      valid: true,
      diagnostics: [],
    });
    expect(checkGraphJsonV1Acyclicity(loopGraph()).diagnostics).toEqual([
      expect.objectContaining({ code: "GRAPH_CYCLE_DETECTED" }),
    ]);
  });

  it("passes the whole diagnostics stack", () => {
    const result = checkGraphJsonV1Diagnostics(loopGraph(), {
      resolver,
      capabilityAuthority: { evaluate: () => ({ decision: "allow" }) },
    });
    expect(result).toEqual({ valid: true, diagnostics: [] });
  });

  it("keeps per-iteration side work inside the body", () => {
    const graph = loopGraph({
      nodes: [...LOOP_NODES, node("log", "sink")],
      edges: [...LOOP_EDGES, data("log-step", "step", "value", "log", "value")],
    });
    expect(findGraphJsonV1LoopRegions(graph, resolver).regions[0]?.regionNodeIds).toEqual([
      "step",
      "check",
      "log",
    ]);
    expect(codesOf(graph)).toEqual([]);
  });

  it("reports a loop with no way back into its continue port", () => {
    const graph = loopGraph({
      edges: LOOP_EDGES.filter((edge) => edge.id !== "continue" && edge.id !== "again"),
    });
    expect(codesOf(graph)).toEqual(["GRAPH_LOOP_REGION_INCOMPLETE"]);
  });

  it("refuses a body that re-enters the loop other than through continue or data", () => {
    const graph = loopGraph({
      edges: [...LOOP_EDGES, control("reenter", "check", "loop", { to: "enter" })],
    });
    expect(codesOf(graph)).toEqual(["GRAPH_LOOP_BACK_EDGE_INVALID", "GRAPH_CYCLE_DETECTED"]);
  });

  it("refuses a continue edge that does not come from the body", () => {
    const graph = loopGraph({
      edges: [...LOOP_EDGES, control("shortcut", "start", "loop", { to: "continue" })],
    });
    expect(checkGraphJsonV1Acyclicity(graph, resolver).diagnostics).toEqual([
      expect.objectContaining({ code: "GRAPH_LOOP_BACK_EDGE_INVALID", edgeId: "shortcut" }),
    ]);
  });

  it("refuses body work that orders work after the loop instead of passing it a value", () => {
    const graph = loopGraph({
      edges: [...LOOP_EDGES, control("early", "check", "after")],
    });
    expect(checkGraphJsonV1Acyclicity(graph, resolver).diagnostics).toEqual([
      expect.objectContaining({ code: "GRAPH_LOOP_REGION_ESCAPE", edgeId: "early" }),
    ]);
  });

  it("refuses nested loops for now", () => {
    const graph = loopGraph({
      nodes: [...LOOP_NODES, node("inner", "loop", { maxIterations: 2 })],
      edges: [...LOOP_EDGES, control("to-inner", "step", "inner", { to: "enter" })],
    });
    expect(codesOf(graph)).toContain("GRAPH_LOOP_REGION_NESTED");
  });

  it("refuses an entrypoint inside a body", () => {
    const graph = loopGraph({
      entrypoints: [
        { id: "main", nodeId: "start" },
        { id: "inside", nodeId: "step" },
      ],
    });
    expect(checkGraphJsonV1Acyclicity(graph, resolver).diagnostics).toEqual([
      expect.objectContaining({ code: "GRAPH_LOOP_REGION_ENTRYPOINT", entrypointId: "inside" }),
    ]);
  });

  it("still rejects any other cycle", () => {
    const graph = loopGraph({
      nodes: [...LOOP_NODES, node("a", "pass"), node("b", "pass")],
      edges: [
        ...LOOP_EDGES,
        data("a-b", "a", "value", "b", "value"),
        data("b-a", "b", "value", "a", "value"),
      ],
    });
    expect(checkGraphJsonV1Acyclicity(graph, resolver).diagnostics).toEqual([
      expect.objectContaining({ code: "GRAPH_CYCLE_DETECTED", nodeIds: ["a", "b"] }),
    ]);
  });
});

describe("lowering a loop", () => {
  function lowered(): ExecutionIrV1 {
    const document = loopGraph();
    return lowerCanonicalGraphJsonV1ToExecutionIr(
      canonicalizeGraphJsonV1Semantics({
        document,
        nodePins: document.nodes.map((item) => ({
          nodeId: item.id,
          type: item.type,
          version: item.version,
          pluginId: "test.plugin",
          pluginVersion: "1",
        })),
        pluginPins: [{ id: "test.plugin", version: "1" }],
      }),
      resolver,
    );
  }

  it("carries the body region and hard bound on the loop op", () => {
    const ir = lowered();
    expect(ir.ops.map(({ sourceNodeId }) => sourceNodeId)).toEqual([
      "after",
      "check",
      "loop",
      "start",
      "step",
    ]);
    expect(ir.ops[2]?.control).toEqual({
      kind: "loop",
      entry: "enter",
      continue: "continue",
      body: "body",
      exit: "exit",
      region: [1, 4],
      maxIterations: 3,
    });
  });

  it("never makes the loop wait on its own body, but keeps the values and edges", () => {
    const ir = lowered();
    expect(ir.ops[2]?.dependencies).toEqual([3]);
    expect(ir.ops[2]?.inputs).toEqual([
      { port: "again", source: { kind: "op-output", op: 1, port: "value" } },
    ]);
    expect(ir.ops[4]?.dependencies).toEqual([2, 3]);
    expect(ir.ops[1]?.dependencies).toEqual([4]);
    expect(ir.ops[0]?.dependencies).toEqual([1, 2]);
    expect(ir.controlEdges).toHaveLength(4);
  });

  it("refuses an IR whose loop region includes the loop op itself", () => {
    const ir = lowered();
    const loop = ir.ops[2]!;
    const broken: ExecutionIrV1 = {
      ...ir,
      format: EXECUTION_IR_FORMAT,
      ops: ir.ops.map((op, index) =>
        index === 2 && loop.control?.kind === "loop"
          ? { ...op, control: { ...loop.control, region: [1, 2, 4] } }
          : op,
      ),
    };
    expect(() => createExecutionIrV1(broken)).toThrow(
      "ops[2].control.region must be strictly increasing and exclude the loop op.",
    );
  });
});

describe("lowering a loop's wall-time bound", () => {
  it("carries an optional wall-time bound on the loop descriptor", () => {
    const document = loopGraph({
      nodes: LOOP_NODES.map((item) =>
        item.id === "loop" ? node("loop", "loop", { maxIterations: 3, maxWallTimeMs: 500 }) : item,
      ),
    });
    const ir = lowerCanonicalGraphJsonV1ToExecutionIr(
      canonicalizeGraphJsonV1Semantics({
        document,
        nodePins: document.nodes.map((item) => ({
          nodeId: item.id,
          type: item.type,
          version: item.version,
          pluginId: "test.plugin",
          pluginVersion: "1",
        })),
        pluginPins: [{ id: "test.plugin", version: "1" }],
      }),
      resolver,
    );
    expect(ir.ops[2]?.control).toMatchObject({
      kind: "loop",
      maxIterations: 3,
      maxWallTimeMs: 500,
    });
  });
});
