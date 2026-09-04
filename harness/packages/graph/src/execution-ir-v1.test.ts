import { describe, expect, it } from "vitest";

import type { ExecutionIrControlDescriptorV1, ExecutionIrV1 } from "./execution-ir-v1.js";
import { createExecutionIrV1, EXECUTION_IR_FORMAT } from "./execution-ir-v1.js";

function candidate(): ExecutionIrV1 {
  return {
    format: EXECUTION_IR_FORMAT,
    graphInputs: [
      { id: "prompt", required: true },
      { id: "temperature", required: false, default: 0.2 },
    ],
    graphOutputs: [{ id: "result", source: { op: 1, port: "result" } }],
    ops: [
      {
        sourceNodeId: "prepare",
        type: "test.prepare",
        version: "1",
        config: { ordered: ["first", "second"], nested: { z: 1, a: 2 } },
        inputs: [
          { port: "prompt", source: { kind: "graph-input", input: 0 } },
          { port: "mode", source: { kind: "literal", value: "short" } },
        ],
        dependencies: [],
        behavior: {
          primitiveFamily: "pure",
          determinism: "deterministic",
          effect: "none",
          idempotency: "not-applicable",
          recovery: "rerun",
          executionMode: "in-process",
          retry: { maxAttempts: 2, backoffMs: 10 },
          requiredCapabilities: [],
        },
      },
      {
        sourceNodeId: "publish",
        type: "test.publish",
        version: "7",
        config: { endpoint: "example" },
        inputs: [
          { port: "body", source: { kind: "op-output", op: 0, port: "prepared" } },
          { port: "token", source: { kind: "secret", secretRef: "publisher-token" } },
          { port: "temperature", source: { kind: "graph-input", input: 1 } },
        ],
        dependencies: [0],
        behavior: {
          primitiveFamily: "effect",
          determinism: "nondeterministic",
          effect: "external-write",
          idempotency: "idempotency-key",
          recovery: "reconcile",
          executionMode: "in-process",
          timeoutMs: 30_000,
          retry: { maxAttempts: 3, backoffMs: 250 },
          requiredCapabilities: ["network:http"],
        },
      },
    ],
    controlEdges: [{ from: { op: 0 }, to: { op: 1 } }],
    entrypoints: [{ id: "start", op: 0 }],
    defaultEntrypoint: 0,
    policies: {
      maxNodeExecutions: 20,
      maxParallelism: 4,
      maxWallTimeMs: 60_000,
      capabilities: {
        required: ["network:http"],
        optional: ["telemetry:write"],
        deny: ["fs:write"],
      },
    },
  };
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;

  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) expectDeepFrozen(item);
  } else {
    for (const item of Object.values(value as Record<string, unknown>)) expectDeepFrozen(item);
  }
}

describe("Execution IR v1", () => {
  it("uses a self-identifying v1 format and array position as compact op identity", () => {
    const ir = createExecutionIrV1(candidate());

    expect(ir.format).toBe("harness.ir/v1");
    expect(ir.ops).toHaveLength(2);
    expect(ir.ops[0]).not.toHaveProperty("index");
    expect(ir.ops[1]?.inputs[0]?.source).toEqual({
      kind: "op-output",
      op: 0,
      port: "prepared",
    });
    expect(ir.graphOutputs[0]?.source).toEqual({ op: 1, port: "result" });
    expect(ir.entrypoints[0]).toEqual({ id: "start", op: 0 });
    expect(ir.defaultEntrypoint).toBe(0);
  });

  it("deep-clones and freezes the executable plan without mutating the candidate", () => {
    const source = candidate();
    const sourceConfig = source.ops[0]?.config;
    const ir = createExecutionIrV1(source);

    expect(ir).not.toBe(source);
    expect(ir.ops[0]?.config).not.toBe(sourceConfig);
    expect(Object.isFrozen(source)).toBe(false);
    expect(Object.isFrozen(source.ops)).toBe(false);
    expectDeepFrozen(ir);
  });

  it("keeps runtime-needed behavior/policy data but no source schemas, hashes, compiler identity, or grants", () => {
    const ir = createExecutionIrV1(candidate());

    expect(ir.graphInputs[0]).toEqual({ id: "prompt", required: true });
    expect(ir.graphInputs[0]).not.toHaveProperty("schema");
    expect(ir.ops[1]?.behavior).toMatchObject({
      effect: "external-write",
      idempotency: "idempotency-key",
      recovery: "reconcile",
      executionMode: "in-process",
      requiredCapabilities: ["network:http"],
    });
    expect(ir.policies.capabilities).toEqual({
      required: ["network:http"],
      optional: ["telemetry:write"],
      deny: ["fs:write"],
    });
    expect(ir).not.toHaveProperty("documentHash");
    expect(ir).not.toHaveProperty("semanticHash");
    expect(ir).not.toHaveProperty("irHash");
    expect(ir).not.toHaveProperty("registryHash");
    expect(ir).not.toHaveProperty("compilerVersion");
    expect(ir).not.toHaveProperty("nodePins");
    expect(ir).not.toHaveProperty("pluginPins");
    expect(ir.policies).not.toHaveProperty("grantedCapabilities");
    expect(ir.policies).not.toHaveProperty("effectiveCapabilities");
  });

  it("reserves all structured-control descriptor families without granting runtime behavior", () => {
    const descriptors: readonly ExecutionIrControlDescriptorV1[] = [
      { kind: "router", entry: "entry", branches: ["left", "right"] },
      { kind: "join", inputs: ["left", "right"], output: "next", mode: "all-active" },
      { kind: "loop", entry: "entry", continue: "continue", body: "body", exit: "exit" },
      { kind: "human-interrupt", entry: "entry", outcomes: ["approved", "denied"] },
      { kind: "subgraph", entry: "entry", exits: ["done", "failed"] },
    ];

    expect(descriptors.map(({ kind }) => kind)).toEqual([
      "router",
      "join",
      "loop",
      "human-interrupt",
      "subgraph",
    ]);
  });

  it("rejects unresolved op, graph-input, control-edge, entrypoint, and default-entrypoint indexes", () => {
    const base = candidate();

    expect(() =>
      createExecutionIrV1({
        ...base,
        graphOutputs: [{ id: "result", source: { op: 99, port: "result" } }],
      }),
    ).toThrow(/graphOutputs\[0\]\.source\.op/);

    expect(() =>
      createExecutionIrV1({
        ...base,
        ops: [
          {
            ...base.ops[0]!,
            inputs: [{ port: "prompt", source: { kind: "graph-input", input: 99 } }],
          },
          base.ops[1]!,
        ],
      }),
    ).toThrow(/source\.input/);

    expect(() =>
      createExecutionIrV1({
        ...base,
        controlEdges: [{ from: { op: 0 }, to: { op: 99 } }],
      }),
    ).toThrow(/controlEdges\[0\]\.to\.op/);

    expect(() =>
      createExecutionIrV1({
        ...base,
        entrypoints: [{ id: "start", op: 99 }],
      }),
    ).toThrow(/entrypoints\[0\]\.op/);

    expect(() => createExecutionIrV1({ ...base, defaultEntrypoint: 99 })).toThrow(
      /defaultEntrypoint/,
    );
  });

  it("requires dependency indexes to be valid, non-self, unique, and strictly increasing", () => {
    const base = candidate();

    expect(() =>
      createExecutionIrV1({
        ...base,
        ops: [base.ops[0]!, { ...base.ops[1]!, dependencies: [99] }],
      }),
    ).toThrow(/dependencies/);

    expect(() =>
      createExecutionIrV1({
        ...base,
        ops: [{ ...base.ops[0]!, dependencies: [0] }, base.ops[1]!],
      }),
    ).toThrow(/cannot depend on itself/);

    expect(() =>
      createExecutionIrV1({
        ...base,
        ops: [base.ops[0]!, { ...base.ops[1]!, dependencies: [0, 0] }],
      }),
    ).toThrow(/strictly increasing and unique/);
  });
});
