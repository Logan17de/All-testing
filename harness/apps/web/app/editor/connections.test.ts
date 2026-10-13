import { describe, expect, it } from "vitest";

import {
  addControlEdge,
  addDataEdge,
  addNode,
  emptyGraph,
  type PaletteEntry,
} from "../../lib/graph-document";
import { connectionIssue } from "./connections";

const entry: PaletteEntry = {
  pluginId: "test",
  isolated: false,
  manifest: {
    type: "text",
    version: "1",
    title: "Text",
    inputs: { input: { schema: { type: "string" } } },
    outputs: { output: { schema: { type: "string" } } },
    configSchema: {},
    behavior: {
      primitiveFamily: "pure",
      effect: "none",
      idempotency: "not-applicable",
      recovery: "rerun",
      requiredCapabilities: [],
    },
  },
};
const palette = [entry];
let graph = emptyGraph("connections-test");
for (const id of ["a", "b", "c"]) graph = addNode(graph, id, "text", "1", { x: 0, y: 0 });
const connection = { source: "a", sourceHandle: "output", target: "b", targetHandle: "input" };

describe("connection safety for canvas and keyboard form", () => {
  it("accepts real data ports and rejects unavailable ports or nodes", () => {
    expect(connectionIssue(graph, palette, connection)).toBeNull();
    expect(connectionIssue(graph, palette, { ...connection, sourceHandle: "missing" })).toContain(
      "no longer available",
    );
    expect(connectionIssue(graph, palette, { ...connection, target: "missing" })).toContain(
      "enabled plugin",
    );
    expect(connectionIssue(graph, [], connection)).toContain("enabled plugin");
  });
  it("blocks self-wiring and data/control mixtures", () => {
    expect(connectionIssue(graph, palette, { ...connection, target: "a" })).toContain(
      "different nodes",
    );
    expect(connectionIssue(graph, palette, { ...connection, targetHandle: "ctl:" })).toContain(
      "data ports",
    );
  });
  it("prevents duplicate edges and requires explicit disconnection of occupied single inputs", () => {
    const connected = addDataEdge(
      graph,
      { nodeId: "a", port: "output" },
      { nodeId: "b", port: "input" },
    );
    expect(connectionIssue(connected, palette, connection)).toContain("already connected");
    expect(connectionIssue(connected, palette, { ...connection, source: "c" })).toContain(
      "Disconnect it first",
    );
    const multiple: PaletteEntry = {
      ...entry,
      manifest: { ...entry.manifest, inputs: { input: { schema: {}, multiple: true } } },
    };
    expect(connectionIssue(connected, [multiple], { ...connection, source: "c" })).toBeNull();
  });
  it("accepts unnamed control ports and rejects duplicate order edges", () => {
    const control = { ...connection, sourceHandle: "ctl:", targetHandle: "ctl:" };
    expect(connectionIssue(graph, palette, control)).toBeNull();
    const connected = addControlEdge(graph, { nodeId: "a" }, { nodeId: "b" });
    expect(connectionIssue(connected, palette, control)).toContain("already connected");
  });
});
