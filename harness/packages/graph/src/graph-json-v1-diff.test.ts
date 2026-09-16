import { describe, expect, it } from "vitest";

import { diffGraphJsonV1 } from "./graph-json-v1-diff.js";
import { GRAPH_JSON_VERSION, type GraphJsonV1 } from "./graph-json-v1.js";

const BASE: GraphJsonV1 = {
  schemaVersion: GRAPH_JSON_VERSION,
  graphId: "pipeline",
  revisionId: "rev-1",
  inputs: [],
  outputs: [{ id: "result", schema: true, source: { nodeId: "shout", port: "value" } }],
  nodes: [
    {
      id: "source",
      type: "example.emit",
      version: "1",
      config: { value: "hi" },
      bindings: [],
    },
    { id: "shout", type: "example.shout", version: "1", config: {}, bindings: [] },
  ],
  edges: [
    {
      id: "value",
      kind: "data",
      from: { nodeId: "source", port: "value" },
      to: { nodeId: "shout", port: "value" },
    },
  ],
  entrypoints: [{ id: "main", nodeId: "source" }],
  policies: {
    maxNodeExecutions: 10,
    maxParallelism: 1,
    capabilities: { required: [], optional: [], deny: [] },
  },
  options: { defaultEntrypoint: "main" },
};

function revision(revisionId: string, changes: Partial<GraphJsonV1> = {}): GraphJsonV1 {
  return { ...BASE, revisionId, ...changes };
}

describe("comparing two revisions of a graph (11.5)", () => {
  it("says nothing changed when nothing did", () => {
    const diff = diffGraphJsonV1(BASE, revision("rev-1"));
    expect(diff).toMatchObject({ identical: true, sameSemantics: true, summary: "No changes." });
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.sectionsChanged).toEqual([]);
  });

  it("separates a move on the canvas from a change to what runs", () => {
    const moved = revision("rev-2", {
      editor: { nodes: { source: { position: { x: 40, y: 80 } } } },
    });
    const diff = diffGraphJsonV1(BASE, moved);

    expect(diff.sameSemantics).toBe(true);
    expect(diff.identical).toBe(false);
    expect(diff.sectionsChanged).toEqual(["editor"]);
    expect(diff.summary).toBe("Only editor details changed.");
  });

  it("names the nodes added, removed and changed", () => {
    const changed = revision("rev-2", {
      nodes: [
        { id: "source", type: "example.emit", version: "2", config: { value: "hi" }, bindings: [] },
        { id: "shout", type: "example.shout", version: "1", config: { loud: true }, bindings: [] },
        { id: "finish", type: "example.emit", version: "1", config: { value: "done" } },
      ],
    });

    const diff = diffGraphJsonV1(BASE, changed);

    expect(diff.nodesAdded.map((node) => node.id)).toEqual(["finish"]);
    expect(diff.nodesRemoved).toEqual([]);
    expect(diff.nodesChanged).toEqual([
      {
        nodeId: "source",
        changes: ["version"],
        before: { type: "example.emit", version: "1" },
        after: { type: "example.emit", version: "2" },
      },
      {
        nodeId: "shout",
        changes: ["config"],
        before: { type: "example.shout", version: "1" },
        after: { type: "example.shout", version: "1" },
      },
    ]);
    expect(diff.sameSemantics).toBe(false);
    expect(diff.summary).toBe("1 node added, 2 nodes changed.");
  });

  it("notices a node that was replaced by a different type, and one that is gone", () => {
    const replaced = revision("rev-2", {
      nodes: [{ id: "source", type: "example.read-file", version: "1", config: {}, bindings: [] }],
      edges: [],
      outputs: [{ id: "result", schema: true, source: { nodeId: "source", port: "value" } }],
    });

    const diff = diffGraphJsonV1(BASE, replaced);

    expect(diff.nodesRemoved.map((node) => node.id)).toEqual(["shout"]);
    expect(diff.nodesChanged[0]).toMatchObject({ nodeId: "source", changes: ["type", "config"] });
    expect(diff.edgesRemoved).toEqual([
      { id: "value", kind: "data", label: "source.value → shout.value" },
    ]);
    expect(diff.sectionsChanged).toContain("outputs");
    expect(diff.summary).toContain("1 node removed");
  });

  it("notices an edge that kept its id but was rewired", () => {
    const rewired = revision("rev-2", {
      nodes: [
        ...BASE.nodes,
        { id: "other", type: "example.emit", version: "1", config: { value: "other" } },
      ],
      edges: [
        {
          id: "value",
          kind: "data",
          from: { nodeId: "other", port: "value" },
          to: { nodeId: "shout", port: "value" },
        },
      ],
    });

    const diff = diffGraphJsonV1(BASE, rewired);

    // The edge is neither added nor removed, so the change is in the edges as a whole.
    expect(diff.edgesAdded).toEqual([]);
    expect(diff.edgesRemoved).toEqual([]);
    expect(diff.sectionsChanged).toContain("edges");
    expect(diff.sameSemantics).toBe(false);
  });

  it("notices a policy change, which changes how the graph runs", () => {
    const stricter = revision("rev-2", {
      policies: {
        maxNodeExecutions: 2,
        maxParallelism: 1,
        capabilities: { required: [], optional: [], deny: [] },
      },
    });

    const diff = diffGraphJsonV1(BASE, stricter);

    expect(diff.sectionsChanged).toEqual(["policies"]);
    expect(diff.sameSemantics).toBe(false);
    expect(diff.summary).toBe("policies changed.");
  });
});
