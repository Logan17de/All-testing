import { describe, expect, it } from "vitest";

import {
  defineEffectNode,
  definePlugin,
  definePureNode,
  describeNodesForManifest,
} from "./define-node.js";

const execute = (): { outputs: Record<string, never> } => ({ outputs: {} });

describe("definePureNode", () => {
  it("fills in safe behavior metadata", () => {
    const node = definePureNode({ type: "vendor.thing", title: "Thing", execute });
    expect(node.manifest.behavior).toMatchObject({
      primitiveFamily: "pure",
      determinism: "deterministic",
      effect: "none",
      recovery: "rerun",
      requiredCapabilities: [],
    });
  });

  it("defaults the version to 1", () => {
    expect(definePureNode({ type: "vendor.thing", title: "T", execute }).manifest.version).toBe(
      "1",
    );
  });

  it("keeps an explicit version", () => {
    const node = definePureNode({ type: "vendor.thing", version: "3", title: "T", execute });
    expect(node.manifest.version).toBe("3");
  });

  it("supplies an empty config schema by default", () => {
    const node = definePureNode({ type: "vendor.thing", title: "T", execute });
    expect(node.manifest.configSchema).toMatchObject({ type: "object" });
  });

  it("freezes the definition and its manifest", () => {
    const node = definePureNode({ type: "vendor.thing", title: "T", execute });
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node.manifest)).toBe(true);
  });

  it("passes inputs, config and signal to the author's function", async () => {
    let seen: unknown;
    const node = definePureNode({
      type: "vendor.thing",
      title: "T",
      execute: (args) => {
        seen = args;
        return { outputs: {} };
      },
    });
    const controller = new AbortController();
    await node.execute?.({ inputs: { a: 1 }, config: { b: 2 } }, { signal: controller.signal });
    expect(seen).toMatchObject({ inputs: { a: 1 }, config: { b: 2 } });
  });

  it("returns the author's outputs", async () => {
    const node = definePureNode({
      type: "vendor.upper",
      title: "Upper",
      execute: ({ inputs }) => {
        const text = inputs["text"];
        return { outputs: { text: typeof text === "string" ? text.toUpperCase() : "" } };
      },
    });
    const result = await node.execute?.(
      { inputs: { text: "hi" }, config: {} },
      { signal: new AbortController().signal },
    );
    expect(result?.outputs).toEqual({ text: "HI" });
  });
});

describe("node type discipline", () => {
  it.each(["thing", "Vendor.Thing", "vendor thing", "vendor/thing", ""])(
    "refuses type %s",
    (type) => {
      expect(() => definePureNode({ type, title: "T", execute })).toThrow(TypeError);
    },
  );

  it("accepts a namespaced type", () => {
    expect(() => definePureNode({ type: "vendor.thing", title: "T", execute })).not.toThrow();
  });

  it("accepts deeper namespaces", () => {
    expect(() => definePureNode({ type: "vendor.group.thing", title: "T", execute })).not.toThrow();
  });

  it("requires a title", () => {
    expect(() => definePureNode({ type: "vendor.thing", title: "  ", execute })).toThrow(TypeError);
  });

  it("requires execute to be a function", () => {
    expect(() =>
      definePureNode({
        type: "vendor.thing",
        title: "T",
        execute: undefined as unknown as typeof execute,
      }),
    ).toThrow(TypeError);
  });

  it("requires each port to declare a schema", () => {
    expect(() =>
      definePureNode({
        type: "vendor.thing",
        title: "T",
        inputs: { a: {} as never },
        execute,
      }),
    ).toThrow(TypeError);
  });
});

describe("defineEffectNode", () => {
  it("requires an explicit effect class", () => {
    expect(() =>
      defineEffectNode({
        type: "vendor.writer",
        title: "W",
        effect: "none" as never,
        idempotency: "idempotent",
        recovery: "rerun",
        execute,
      }),
    ).toThrow(TypeError);
  });

  it("records the declared effect, idempotency and recovery", () => {
    const node = defineEffectNode({
      type: "vendor.writer",
      title: "W",
      effect: "external-write",
      idempotency: "unknown",
      recovery: "manual",
      execute,
    });
    expect(node.manifest.behavior).toMatchObject({
      primitiveFamily: "effect",
      effect: "external-write",
      idempotency: "unknown",
      recovery: "manual",
    });
  });

  it("refuses reuse recovery for an external write", () => {
    expect(() =>
      defineEffectNode({
        type: "vendor.writer",
        title: "W",
        effect: "external-write",
        idempotency: "idempotent",
        recovery: "reuse",
        execute,
      }),
    ).toThrow(/no stored output to reuse/u);
  });

  it("defaults determinism to nondeterministic", () => {
    const node = defineEffectNode({
      type: "vendor.reader",
      title: "R",
      effect: "external-read",
      idempotency: "idempotent",
      recovery: "rerun",
      execute,
    });
    expect(node.manifest.behavior.determinism).toBe("nondeterministic");
  });

  it("carries declared capability requirements", () => {
    const node = defineEffectNode({
      type: "vendor.reader",
      title: "R",
      effect: "external-read",
      idempotency: "idempotent",
      recovery: "rerun",
      requiredCapabilities: ["fs:read"],
      execute,
    });
    expect(node.manifest.behavior.requiredCapabilities).toEqual(["fs:read"]);
  });
});

describe("definePlugin", () => {
  const pure = definePureNode({ type: "vendor.thing", title: "Thing", execute });

  it("builds a plugin manifest at the supported API version", () => {
    const plugin = definePlugin({ id: "com.example.p", name: "P", version: "1.0.0" });
    expect(plugin.manifest.apiVersion).toBe(1);
  });

  it("registers its nodes on activation", async () => {
    const registered: string[] = [];
    const plugin = definePlugin({
      id: "com.example.p",
      name: "P",
      version: "1.0.0",
      nodes: [pure],
    });
    await plugin.activate({
      nodes: { register: (definition) => registered.push(definition.manifest.type) },
      models: { register: () => undefined },
      tools: { register: () => undefined },
      onDispose: () => undefined,
    });
    expect(registered).toEqual(["vendor.thing"]);
  });

  it("runs the author's extra activation work", async () => {
    let ran = false;
    const plugin = definePlugin({
      id: "com.example.p",
      name: "P",
      version: "1.0.0",
      activate: () => {
        ran = true;
      },
    });
    await plugin.activate({
      nodes: { register: () => undefined },
      models: { register: () => undefined },
      tools: { register: () => undefined },
      onDispose: () => undefined,
    });
    expect(ran).toBe(true);
  });

  it("refuses a node requiring a capability the plugin does not declare", () => {
    const effectNode = defineEffectNode({
      type: "vendor.reader",
      title: "R",
      effect: "external-read",
      idempotency: "idempotent",
      recovery: "rerun",
      requiredCapabilities: ["fs:read"],
      execute,
    });
    expect(() =>
      definePlugin({ id: "com.example.p", name: "P", version: "1.0.0", nodes: [effectNode] }),
    ).toThrow(/does not declare/u);
  });

  it("accepts a node whose capability the plugin declares", () => {
    const effectNode = defineEffectNode({
      type: "vendor.reader",
      title: "R",
      effect: "external-read",
      idempotency: "idempotent",
      recovery: "rerun",
      requiredCapabilities: ["fs:read"],
      execute,
    });
    expect(() =>
      definePlugin({
        id: "com.example.p",
        name: "P",
        version: "1.0.0",
        capabilities: ["fs:read"],
        nodes: [effectNode],
      }),
    ).not.toThrow();
  });

  it("refuses two nodes with the same type and version", () => {
    expect(() =>
      definePlugin({ id: "com.example.p", name: "P", version: "1.0.0", nodes: [pure, pure] }),
    ).toThrow(/twice/u);
  });

  it("requires an id and a version", () => {
    expect(() => definePlugin({ id: "", name: "P", version: "1.0.0" })).toThrow(TypeError);
    expect(() => definePlugin({ id: "a", name: "P", version: "" })).toThrow(TypeError);
  });

  it("declares capabilities as requests, which carry no authority", () => {
    const plugin = definePlugin({
      id: "com.example.p",
      name: "P",
      version: "1.0.0",
      capabilities: ["fs:write"],
    });
    // The manifest records the request; nothing here can grant it.
    expect(plugin.manifest.capabilities).toEqual([{ id: "fs:write" }]);
  });
});

describe("describeNodesForManifest", () => {
  it("produces package-manifest node declarations from definitions", () => {
    const nodes = [
      definePureNode({ type: "vendor.a", title: "A", execute }),
      definePureNode({ type: "vendor.b", version: "2", title: "B", execute }),
    ];
    expect(describeNodesForManifest(nodes)).toEqual([
      { type: "vendor.a", version: "1", title: "A" },
      { type: "vendor.b", version: "2", title: "B" },
    ]);
  });

  it("returns a frozen list", () => {
    expect(Object.isFrozen(describeNodesForManifest([]))).toBe(true);
  });
});
