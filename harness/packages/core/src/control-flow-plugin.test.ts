import { describe, expect, it } from "vitest";

import type { JsonValue, NodeExecutionContext } from "@zet-harness/plugin-api";

import {
  CONDITION_NODE_TYPE,
  JOIN_ALL_NODE_TYPE,
  JOIN_ANY_NODE_TYPE,
  LOOP_NODE_TYPE,
  ROUTE_NODE_TYPE,
  createControlFlowPlugin,
  evaluateCondition,
  type ConditionOperator,
} from "./control-flow-plugin.js";
import { NodeCatalog } from "./node-catalog.js";
import { PluginHost } from "./plugin-host.js";

async function catalog(): Promise<NodeCatalog> {
  const nodes = new NodeCatalog();
  await new PluginHost(nodes).activate(createControlFlowPlugin());
  return nodes;
}

function context(): NodeExecutionContext {
  return { signal: new AbortController().signal };
}

describe("built-in control-flow nodes", () => {
  it("registers through the public plugin path like any third-party plugin", async () => {
    const nodes = await catalog();
    expect(
      nodes
        .listManifests()
        .map((manifest) => manifest.type)
        .sort(),
    ).toEqual([
      CONDITION_NODE_TYPE,
      JOIN_ALL_NODE_TYPE,
      JOIN_ANY_NODE_TYPE,
      LOOP_NODE_TYPE,
      ROUTE_NODE_TYPE,
    ]);
  });

  it("declares Route and the joins as scheduler-owned control with fixed port names", async () => {
    const nodes = await catalog();
    const route = nodes.requireManifest(ROUTE_NODE_TYPE, "1");
    expect(route.behavior.executionMode).toBe("none");
    expect(route.control).toEqual({ kind: "router", entry: "in", branches: ["yes", "no"] });
    expect(nodes.requireManifest(JOIN_ALL_NODE_TYPE, "1").control).toEqual({
      kind: "join",
      inputs: ["a", "b"],
      output: "out",
      mode: "all-active",
    });
    expect(nodes.requireManifest(JOIN_ANY_NODE_TYPE, "1").control).toMatchObject({ mode: "any" });
    expect(nodes.getDefinition(ROUTE_NODE_TYPE, "1")?.execute).toBeUndefined();
  });

  it("outputs the branch name a Route node follows", async () => {
    const nodes = await catalog();
    const execute = nodes.getDefinition(CONDITION_NODE_TYPE, "1")?.execute;
    expect(execute).toBeDefined();

    const yes = await execute!(
      { inputs: { value: "approved" }, config: { operator: "equals", compare: "approved" } },
      context(),
    );
    const no = await execute!(
      { inputs: { value: "rejected" }, config: { operator: "equals", compare: "approved" } },
      context(),
    );

    expect(yes.outputs).toEqual({ branch: "yes", matched: true });
    expect(no.outputs).toEqual({ branch: "no", matched: false });
  });

  it("refuses an operator it does not know", async () => {
    const nodes = await catalog();
    const execute = nodes.getDefinition(CONDITION_NODE_TYPE, "1")?.execute;
    await expect(
      Promise.resolve().then(() =>
        execute!({ inputs: { value: 1 }, config: { operator: "greater-than" } }, context()),
      ),
    ).rejects.toThrow("Condition operator must be one of");
  });
});

describe("evaluating a condition", () => {
  const cases: readonly [
    ConditionOperator,
    JsonValue | undefined,
    JsonValue | undefined,
    boolean,
  ][] = [
    ["equals", { a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }, true],
    ["equals", [1, 2], [2, 1], false],
    ["not-equals", "a", "b", true],
    ["contains", "hello world", "world", true],
    ["contains", [1, { x: 2 }], { x: 2 }, true],
    ["contains", 5, 5, false],
    ["truthy", "", undefined, false],
    ["truthy", [], undefined, false],
    ["truthy", { a: 1 }, undefined, true],
    ["truthy", 0, undefined, false],
    ["falsy", null, undefined, true],
    ["falsy", "no", undefined, false],
  ];

  it.each(cases)("%s %j against %j is %s", (operator, value, compare, expected) => {
    expect(evaluateCondition(operator, value, compare)).toBe(expected);
  });
});
