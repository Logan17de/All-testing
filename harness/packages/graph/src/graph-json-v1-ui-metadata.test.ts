import { describe, expect, it } from "vitest";

import type { GraphEditorMetadataV1, GraphMetadataV1 } from "./graph-json-v1.js";
import type { NormalizedGraphJsonV1 } from "./graph-json-v1-normalization.js";
import { stripGraphJsonV1UiMetadata } from "./graph-json-v1-ui-metadata.js";

function normalized(
  editor: GraphEditorMetadataV1 | undefined = {
    viewport: { x: 10, y: 20, zoom: 1.5 },
    nodes: { first: { position: { x: 100, y: 200 }, collapsed: true } },
    annotations: [{ id: "note", text: "UI only", position: { x: 1, y: 2 } }],
    data: { panel: "open" },
  },
  metadata: GraphMetadataV1 | undefined = {
    title: "Human title",
    description: "Preserve me",
  },
): NormalizedGraphJsonV1 {
  return {
    document: {
      schemaVersion: 1,
      graphId: "graph-a",
      revisionId: "rev-7",
      ...(metadata === undefined ? {} : { metadata }),
      inputs: [{ id: "prompt", schema: true, required: false }],
      outputs: [{ id: "result", schema: true, source: { nodeId: "first", port: "value" } }],
      nodes: [
        {
          id: "first",
          type: "test.echo",
          version: "2",
          config: { editor: { thisIsExecutableConfig: true } },
          bindings: [],
        },
      ],
      edges: [],
      entrypoints: [{ id: "start", nodeId: "first" }],
      policies: { capabilities: { required: [], optional: [], deny: [] } },
      options: { defaultEntrypoint: "start" },
      ...(editor === undefined ? {} : { editor }),
    },
    nodePins: [
      {
        nodeId: "first",
        type: "test.echo",
        version: "2",
        pluginId: "plugin.echo",
        pluginVersion: "4.0.0",
      },
    ],
    pluginPins: [{ id: "plugin.echo", version: "4.0.0" }],
  };
}

describe("Graph JSON v1 UI metadata stripping", () => {
  it("removes the entire top-level editor bucket and preserves compiler source", () => {
    const source = normalized();
    const sourceBefore = structuredClone(source);

    const result = stripGraphJsonV1UiMetadata(source);

    expect("editor" in result.document).toBe(false);
    expect(result.document.metadata).toEqual({
      title: "Human title",
      description: "Preserve me",
    });
    expect(result.document.graphId).toBe("graph-a");
    expect(result.document.revisionId).toBe("rev-7");
    expect(result.document.nodes[0]?.config).toEqual({
      editor: { thisIsExecutableConfig: true },
    });
    expect(result.nodePins).toEqual(source.nodePins);
    expect(result.pluginPins).toEqual(source.pluginPins);
    expect(source).toEqual(sourceBefore);
  });

  it("makes compiler source invariant to editor-only changes", () => {
    const left = normalized({ viewport: { x: 0, y: 0, zoom: 1 } });
    const right = normalized({
      viewport: { x: 999, y: -42, zoom: 3 },
      annotations: [{ id: "different", text: "changed", position: { x: 9, y: 8 } }],
    });

    expect(stripGraphJsonV1UiMetadata(left)).toEqual(stripGraphJsonV1UiMetadata(right));
  });

  it("does not erase human metadata or recursively strip keys named editor", () => {
    const withMetadata = normalized(undefined, { title: "Keep human metadata" });
    const withoutMetadata = normalized(undefined, undefined);

    expect(stripGraphJsonV1UiMetadata(withMetadata)).not.toEqual(
      stripGraphJsonV1UiMetadata(withoutMetadata),
    );
    expect(stripGraphJsonV1UiMetadata(withMetadata).document.nodes[0]?.config).toHaveProperty(
      "editor",
    );
  });

  it("preserves source and pin ordering for 2.19 canonicalization", () => {
    const source = normalized();
    const result = stripGraphJsonV1UiMetadata(source);

    expect(result.document.nodes.map(({ id }) => id)).toEqual(["first"]);
    expect(result.nodePins.map(({ nodeId }) => nodeId)).toEqual(["first"]);
    expect(result.pluginPins.map(({ id }) => id)).toEqual(["plugin.echo"]);
  });
});
