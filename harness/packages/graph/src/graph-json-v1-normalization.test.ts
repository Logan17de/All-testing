import { describe, expect, it } from "vitest";

import type { NodeManifest } from "@zet-harness/plugin-api";

import {
  normalizeGraphJsonV1,
  type GraphResolvedNodeRegistrationV1,
  type NodeResolutionResolver,
} from "./graph-json-v1-normalization.js";
import type { GraphJsonV1 } from "./graph-json-v1.js";

function manifest(type: string, version: string): NodeManifest {
  return {
    type,
    version,
    title: `${type}@${version}`,
    inputs: {},
    outputs: { value: { schema: true } },
    configSchema: {
      type: "object",
      properties: {
        mode: { type: "string", default: "schema-default-must-not-materialize" },
      },
    },
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
}

function graph(): GraphJsonV1 {
  return {
    schemaVersion: 1,
    graphId: "normalization-test",
    revisionId: "rev-1",
    metadata: { title: "Keep me" },
    inputs: [{ id: "prompt", schema: { type: "string" } }],
    outputs: [
      {
        id: "result",
        schema: true,
        source: { nodeId: "second", port: "value" },
      },
    ],
    nodes: [
      {
        id: "first",
        type: "test.first",
        version: "2",
        config: {},
      },
      {
        id: "second",
        type: "test.second",
        version: "7",
        config: { explicit: true },
        bindings: [],
      },
    ],
    edges: [
      {
        id: "order",
        kind: "control",
        from: { nodeId: "first" },
        to: { nodeId: "second" },
      },
    ],
    entrypoints: [{ id: "start", nodeId: "first" }],
    editor: {
      viewport: { x: 10, y: 20, zoom: 1 },
    },
  };
}

function resolver(
  entries: Readonly<Record<string, GraphResolvedNodeRegistrationV1>>,
): NodeResolutionResolver {
  return {
    getManifest(type, version) {
      return entries[`${type}@${version}`]?.manifest;
    },
    getResolution(type, version) {
      return entries[`${type}@${version}`];
    },
  };
}

describe("Graph JSON v1 normalization", () => {
  it("materializes only frozen Harness defaults and records exact node/plugin pins", () => {
    const source = graph();
    const sourceBefore = structuredClone(source);
    const registrations = resolver({
      "test.first@2": {
        manifest: manifest("test.first", "2"),
        plugin: { id: "plugin.shared", version: "4.1.0" },
      },
      "test.second@7": {
        manifest: manifest("test.second", "7"),
        plugin: { id: "plugin.shared", version: "4.1.0" },
      },
    });

    const result = normalizeGraphJsonV1(source, registrations);

    expect(result.valid).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(result.normalized?.document.inputs).toEqual([
      { id: "prompt", schema: { type: "string" }, required: false },
    ]);
    expect(result.normalized?.document.nodes[0]?.bindings).toEqual([]);
    expect(result.normalized?.document.nodes[0]?.config).toEqual({});
    expect(result.normalized?.document.policies).toEqual({
      capabilities: { required: [], optional: [], deny: [] },
    });
    expect(result.normalized?.document.options).toEqual({});
    expect(result.normalized?.document.metadata).toEqual({ title: "Keep me" });
    expect(result.normalized?.document.editor).toEqual(source.editor);
    expect(result.normalized?.nodePins).toEqual([
      {
        nodeId: "first",
        type: "test.first",
        version: "2",
        pluginId: "plugin.shared",
        pluginVersion: "4.1.0",
      },
      {
        nodeId: "second",
        type: "test.second",
        version: "7",
        pluginId: "plugin.shared",
        pluginVersion: "4.1.0",
      },
    ]);
    expect(result.normalized?.pluginPins).toEqual([
      { id: "plugin.shared", version: "4.1.0" },
    ]);

    // Normalization is a pure compiler stage; source/editor state is never rewritten.
    expect(source).toEqual(sourceBefore);
  });

  it("preserves source order and first-use plugin pin order for 2.19 canonicalization later", () => {
    const source = graph();
    const registrations = resolver({
      "test.first@2": {
        manifest: manifest("test.first", "2"),
        plugin: { id: "plugin.z", version: "9" },
      },
      "test.second@7": {
        manifest: manifest("test.second", "7"),
        plugin: { id: "plugin.a", version: "1" },
      },
    });

    const result = normalizeGraphJsonV1(source, registrations);

    expect(result.normalized?.document.nodes.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(result.normalized?.document.edges.map(({ id }) => id)).toEqual(["order"]);
    expect(result.normalized?.pluginPins).toEqual([
      { id: "plugin.z", version: "9" },
      { id: "plugin.a", version: "1" },
    ]);
  });

  it("preserves explicit graph defaults instead of replacing them", () => {
    const source: GraphJsonV1 = {
      ...graph(),
      inputs: [{ id: "prompt", schema: true, required: true, default: "hello" }],
      policies: {
        maxNodeExecutions: 50,
        maxParallelism: 3,
        maxWallTimeMs: 5_000,
        capabilities: {
          required: ["network:http"],
          optional: ["model:vision"],
          deny: ["fs:write"],
        },
      },
      options: { defaultEntrypoint: "start" },
    };
    const registrations = resolver({
      "test.first@2": {
        manifest: manifest("test.first", "2"),
        plugin: { id: "plugin.first", version: "2" },
      },
      "test.second@7": {
        manifest: manifest("test.second", "7"),
        plugin: { id: "plugin.second", version: "7" },
      },
    });

    const result = normalizeGraphJsonV1(source, registrations);

    expect(result.normalized?.document.inputs[0]).toEqual({
      id: "prompt",
      schema: true,
      required: true,
      default: "hello",
    });
    expect(result.normalized?.document.policies).toEqual(source.policies);
    expect(result.normalized?.document.options).toEqual({ defaultEntrypoint: "start" });
  });

  it("rejects a node without plugin provenance", () => {
    const result = normalizeGraphJsonV1(graph(), resolver({}));

    expect(result.valid).toBe(false);
    expect(result.normalized).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({
      code: "GRAPH_NORMALIZATION_RESOLUTION_REQUIRED",
      path: "/nodes/0",
      nodeId: "first",
    });
  });

  it("rejects a resolver that returns the wrong node manifest identity", () => {
    const badResolver: NodeResolutionResolver = {
      getManifest() {
        return manifest("test.first", "2");
      },
      getResolution(type, version) {
        if (type === "test.first" && version === "2") {
          return {
            manifest: manifest("wrong.type", "999"),
            plugin: { id: "plugin.bad", version: "1" },
          };
        }
        return {
          manifest: manifest(type, version),
          plugin: { id: "plugin.other", version: "1" },
        };
      },
    };

    const result = normalizeGraphJsonV1(graph(), badResolver);

    expect(result.diagnostics[0]).toMatchObject({
      code: "GRAPH_NORMALIZATION_NODE_IDENTITY_MISMATCH",
      path: "/nodes/0",
      nodeId: "first",
    });
  });

  it("rejects empty plugin identity and conflicting versions for one plugin id", () => {
    const invalidPlugin = normalizeGraphJsonV1(
      graph(),
      resolver({
        "test.first@2": {
          manifest: manifest("test.first", "2"),
          plugin: { id: "", version: "1" },
        },
        "test.second@7": {
          manifest: manifest("test.second", "7"),
          plugin: { id: "plugin.second", version: "7" },
        },
      }),
    );

    expect(invalidPlugin.diagnostics[0]?.code).toBe(
      "GRAPH_NORMALIZATION_PLUGIN_IDENTITY_INVALID",
    );

    const conflicting = normalizeGraphJsonV1(
      graph(),
      resolver({
        "test.first@2": {
          manifest: manifest("test.first", "2"),
          plugin: { id: "plugin.same", version: "1" },
        },
        "test.second@7": {
          manifest: manifest("test.second", "7"),
          plugin: { id: "plugin.same", version: "2" },
        },
      }),
    );

    expect(conflicting.diagnostics).toEqual([
      expect.objectContaining({
        code: "GRAPH_NORMALIZATION_PLUGIN_VERSION_CONFLICT",
        path: "/nodes/1",
        nodeId: "second",
      }),
    ]);
  });
});
