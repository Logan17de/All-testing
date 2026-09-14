import { describe, expect, it } from "vitest";

import type {
  NodeBehavior,
  NodeManifest,
  NodeStructuredControlContract,
} from "@zet-harness/plugin-api";

import { checkGraphJsonV1Diagnostics } from "./graph-json-v1-diagnostics.js";
import { expandGraphJsonV1Subgraphs, type GraphSourceResolver } from "./graph-json-v1-subgraphs.js";
import type { NodeManifestResolver } from "./graph-json-v1-semantic-validator.js";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";

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
  manifest("pass", {
    inputs: { value: { schema: { type: "string" }, required: true } },
    outputs: { value: text },
  }),
  manifest("subgraph", {
    behavior: CONTROL,
    control: { kind: "subgraph", entry: "in", exits: ["done"] },
  }),
];

const resolver: NodeManifestResolver = {
  getManifest(type, version) {
    return version === "1" ? manifests.find((item) => item.type === type) : undefined;
  },
};

function document(overrides: Partial<GraphJsonV1>): GraphJsonV1 {
  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "parent",
    revisionId: "r1",
    inputs: [],
    outputs: [],
    nodes: [],
    edges: [],
    entrypoints: [],
    policies: { capabilities: { required: [], optional: [], deny: [] } },
    ...overrides,
  };
}

/** A saved graph: input `text` → a → b → output `result`. */
const CHILD = document({
  graphId: "child",
  revisionId: "r1",
  inputs: [{ id: "text", schema: { type: "string" }, required: true }],
  outputs: [{ id: "result", schema: { type: "string" }, source: { nodeId: "b", port: "value" } }],
  nodes: [
    {
      id: "a",
      type: "pass",
      version: "1",
      config: {},
      bindings: [{ kind: "graph-input", port: "value", input: "text" }],
    },
    { id: "b", type: "pass", version: "1", config: {} },
  ],
  edges: [
    {
      id: "a-b",
      kind: "data",
      from: { nodeId: "a", port: "value" },
      to: { nodeId: "b", port: "value" },
    },
  ],
  entrypoints: [{ id: "main", nodeId: "a" }],
});

function library(...graphs: readonly GraphJsonV1[]): GraphSourceResolver {
  return {
    getGraph: (graphId, revisionId) =>
      graphs.find((graph) => graph.graphId === graphId && graph.revisionId === revisionId),
  };
}

function call(config: Record<string, string>, id = "call") {
  return { id, type: "subgraph", version: "1", config };
}

/** src → call(child@r1) → sink */
function parent(overrides: Partial<GraphJsonV1> = {}): GraphJsonV1 {
  return document({
    nodes: [
      { id: "src", type: "source", version: "1", config: {} },
      call({ graphId: "child", revisionId: "r1" }),
      { id: "sink", type: "pass", version: "1", config: {} },
    ],
    edges: [
      {
        id: "in",
        kind: "data",
        from: { nodeId: "src", port: "value" },
        to: { nodeId: "call", port: "text" },
      },
      {
        id: "out",
        kind: "data",
        from: { nodeId: "call", port: "result" },
        to: { nodeId: "sink", port: "value" },
      },
    ],
    entrypoints: [{ id: "main", nodeId: "src" }],
    ...overrides,
  });
}

describe("expanding subgraphs", () => {
  it("splices the saved graph in under the subgraph node's id and rewires its ports", () => {
    const result = expandGraphJsonV1Subgraphs(parent(), resolver, library(CHILD));

    expect(result.valid).toBe(true);
    expect(result.references).toEqual([{ graphId: "child", revisionId: "r1" }]);
    expect(result.graph.nodes.map((node) => node.id)).toEqual(["src", "sink", "call/a", "call/b"]);
    expect(result.graph.edges).toEqual([
      {
        id: "call/a-b",
        kind: "data",
        from: { nodeId: "call/a", port: "value" },
        to: { nodeId: "call/b", port: "value" },
      },
      {
        id: "in/call/a/value",
        kind: "data",
        from: { nodeId: "src", port: "value" },
        to: { nodeId: "call/a", port: "value" },
      },
      { id: "in/start/call/a", kind: "control", from: { nodeId: "src" }, to: { nodeId: "call/a" } },
      {
        id: "out",
        kind: "data",
        from: { nodeId: "call/b", port: "value" },
        to: { nodeId: "sink", port: "value" },
      },
    ]);
  });

  it("produces a graph the whole diagnostics stack accepts", () => {
    const expanded = expandGraphJsonV1Subgraphs(parent(), resolver, library(CHILD)).graph;
    expect(
      checkGraphJsonV1Diagnostics(expanded, {
        resolver,
        capabilityAuthority: { evaluate: () => ({ decision: "allow" }) },
      }),
    ).toEqual({ valid: true, diagnostics: [] });
  });

  it("adds the saved graph's node-execution budget to the parent's", () => {
    const budget = (maxNodeExecutions: number) => ({
      maxNodeExecutions,
      capabilities: { required: [], optional: [], deny: [] },
    });
    const child = { ...CHILD, policies: budget(2) };

    const expanded = expandGraphJsonV1Subgraphs(
      parent({ policies: budget(3) }),
      resolver,
      library(child),
    );
    const unbudgeted = expandGraphJsonV1Subgraphs(
      parent({ policies: budget(3) }),
      resolver,
      library(CHILD),
    );

    expect(expanded.graph.policies?.maxNodeExecutions).toBe(5);
    expect(unbudgeted.graph.policies?.maxNodeExecutions).toBe(3);
  });

  it("passes a value set on the subgraph node to the saved graph's input", () => {
    const graph = parent({
      nodes: [
        { id: "src", type: "source", version: "1", config: {} },
        {
          ...call({ graphId: "child", revisionId: "r1" }),
          bindings: [{ kind: "literal", port: "text", value: "hi" }],
        },
        { id: "sink", type: "pass", version: "1", config: {} },
      ],
      edges: [
        {
          id: "out",
          kind: "data",
          from: { nodeId: "call", port: "result" },
          to: { nodeId: "sink", port: "value" },
        },
      ],
    });
    const node = expandGraphJsonV1Subgraphs(graph, resolver, library(CHILD)).graph.nodes.find(
      (candidate) => candidate.id === "call/a",
    );
    expect(node?.bindings).toEqual([{ kind: "literal", port: "value", value: "hi" }]);
  });

  it("falls back to an input's default and reports a required input left unset", () => {
    const withDefault = document({
      ...CHILD,
      inputs: [{ id: "text", schema: { type: "string" }, default: "fallback" }],
    });
    const unfed = parent({ edges: [] });
    const defaulted = expandGraphJsonV1Subgraphs(unfed, resolver, library(withDefault));
    expect(defaulted.graph.nodes.find((node) => node.id === "call/a")?.bindings).toEqual([
      { kind: "literal", port: "value", value: "fallback" },
    ]);

    expect(expandGraphJsonV1Subgraphs(unfed, resolver, library(CHILD)).diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_SUBGRAPH_INPUT_UNBOUND",
        nodeId: "call",
        port: "text",
      }),
    ]);
  });

  it("reports ports the saved graph does not have", () => {
    const graph = parent({
      edges: [
        {
          id: "in",
          kind: "data",
          from: { nodeId: "src", port: "value" },
          to: { nodeId: "call", port: "missing" },
        },
        {
          id: "out",
          kind: "data",
          from: { nodeId: "call", port: "nothing" },
          to: { nodeId: "sink", port: "value" },
        },
      ],
    });
    expect(
      expandGraphJsonV1Subgraphs(graph, resolver, library(CHILD)).diagnostics.map(
        ({ code, edgeId }) => [code, edgeId],
      ),
    ).toEqual([
      ["GRAPH_SUBGRAPH_PORT_UNKNOWN", "in"],
      ["GRAPH_SUBGRAPH_PORT_UNKNOWN", "out"],
      ["GRAPH_SUBGRAPH_INPUT_UNBOUND", undefined],
    ]);
  });

  it("makes work after the subgraph wait for every final node of the saved graph", () => {
    const graph = parent({
      edges: [
        {
          id: "in",
          kind: "data",
          from: { nodeId: "src", port: "value" },
          to: { nodeId: "call", port: "text" },
        },
        {
          id: "after",
          kind: "control",
          from: { nodeId: "call", port: "done" },
          to: { nodeId: "sink" },
        },
      ],
    });
    const edges = expandGraphJsonV1Subgraphs(graph, resolver, library(CHILD)).graph.edges;
    expect(edges).toContainEqual({
      id: "after/call/b",
      kind: "control",
      from: { nodeId: "call/b" },
      to: { nodeId: "sink" },
    });
  });

  it("starts the saved graph when an entrypoint sits on the subgraph node", () => {
    const withDefault = document({
      ...CHILD,
      inputs: [{ id: "text", schema: { type: "string" }, default: "x" }],
    });
    const graph = document({
      nodes: [call({ graphId: "child", revisionId: "r1" })],
      entrypoints: [{ id: "main", nodeId: "call" }],
      options: { defaultEntrypoint: "main" },
    });
    expect(
      expandGraphJsonV1Subgraphs(graph, resolver, library(withDefault)).graph.entrypoints,
    ).toEqual([{ id: "main", nodeId: "call/a" }]);
  });

  it("expands nested subgraphs with nested namespaces", () => {
    const middle = document({
      graphId: "middle",
      revisionId: "r1",
      inputs: [{ id: "text", schema: { type: "string" }, required: true }],
      outputs: [
        { id: "result", schema: { type: "string" }, source: { nodeId: "inner", port: "result" } },
      ],
      nodes: [
        {
          ...call({ graphId: "child", revisionId: "r1" }, "inner"),
          bindings: [{ kind: "graph-input", port: "text", input: "text" }],
        },
      ],
      entrypoints: [{ id: "main", nodeId: "inner" }],
    });
    const graph = parent({
      nodes: [
        { id: "src", type: "source", version: "1", config: {} },
        call({ graphId: "middle", revisionId: "r1" }),
        { id: "sink", type: "pass", version: "1", config: {} },
      ],
    });

    const result = expandGraphJsonV1Subgraphs(graph, resolver, library(CHILD, middle));

    expect(result.diagnostics).toEqual([]);
    expect(result.graph.nodes.map((node) => node.id)).toEqual([
      "src",
      "sink",
      "call/inner/a",
      "call/inner/b",
    ]);
    expect(result.references).toEqual([
      { graphId: "middle", revisionId: "r1" },
      { graphId: "child", revisionId: "r1" },
    ]);
  });

  it("refuses a graph that runs itself", () => {
    const loopy = document({
      graphId: "child",
      revisionId: "r2",
      nodes: [call({ graphId: "parent", revisionId: "r1" }, "back")],
    });
    const graph = parent({
      nodes: [
        { id: "src", type: "source", version: "1", config: {} },
        call({ graphId: "child", revisionId: "r2" }),
        { id: "sink", type: "pass", version: "1", config: {} },
      ],
      edges: [],
    });

    expect(expandGraphJsonV1Subgraphs(graph, resolver, library(loopy)).diagnostics).toEqual([
      expect.objectContaining({ code: "GRAPH_SUBGRAPH_RECURSION", nodeId: "call/back" }),
    ]);
  });

  it("reports a missing saved graph and a malformed reference", () => {
    const graph = document({
      nodes: [
        call({ graphId: "nowhere", revisionId: "r9" }, "lost"),
        call({ graphId: "child" }, "broken"),
      ],
    });
    expect(
      expandGraphJsonV1Subgraphs(graph, resolver, library(CHILD)).diagnostics.map(
        ({ code, nodeId }) => [code, nodeId],
      ),
    ).toEqual([
      ["GRAPH_SUBGRAPH_NOT_FOUND", "lost"],
      ["GRAPH_SUBGRAPH_REFERENCE_INVALID", "broken"],
    ]);
  });

  it("leaves a graph without subgraph nodes untouched", () => {
    const plain = document({ nodes: [{ id: "src", type: "source", version: "1", config: {} }] });
    const result = expandGraphJsonV1Subgraphs(plain, resolver, library());
    expect(result.graph).toBe(plain);
    expect(result.references).toEqual([]);
  });
});
