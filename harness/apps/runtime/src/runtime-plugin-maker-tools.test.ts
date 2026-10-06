import { PluginHost } from "@zet-harness/core";
import { expect, it, vi } from "vitest";
import type { AdapterInvocationContext, PluginContext, ToolAdapter } from "@zet-harness/plugin-api";
import { createRuntimePluginMaker } from "./runtime-plugin-maker.js";
import { createPluginMakerPlugin } from "./runtime-plugin-maker-tools.js";
it("is an actual native plugin exposing only inert authoring tools, never review/enable/materialize", async () => {
  const write = vi.fn(() => Promise.resolve());
  const maker = createRuntimePluginMaker({ write }, {});
  const plugin = createPluginMakerPlugin(maker);
  const tools: ToolAdapter[] = [];
  const context: PluginContext = {
    nodes: { register: () => {} },
    models: { register: () => {} },
    tools: {
      register: (t) => {
        tools.push(t);
      },
    },
    onDispose: () => {},
  };
  await plugin.activate(context);
  expect(plugin.manifest.id).toBe("zet.plugin-maker");
  expect(plugin.manifest.capabilities).toEqual([{ id: "plugin:author" }]);
  expect(tools.map((t) => t.manifest.id)).toEqual(
    ["scaffold", "edit", "inspect", "validate", "test"].map((a) => `harness.plugin-maker.${a}`),
  );
  const invocation = { signal: new AbortController().signal } as AdapterInvocationContext;
  const result = await tools[0]!.invoke({ id: "example.native", name: "Native" }, invocation);
  expect(result.value).toHaveProperty("result.enabled", false);
  expect(() =>
    tools[0]!.invoke({ id: "example.native", name: "Native", enable: true }, invocation),
  ).toThrow();
  expect(write).not.toHaveBeenCalled();
});

it("registers with the real native plugin host and preserves owner provenance without generated imports", async () => {
  const maker = createRuntimePluginMaker({ write: () => Promise.resolve() }, {});
  const host = new PluginHost();
  await host.activate(createPluginMakerPlugin(maker));
  expect(host.tools.getResolution("harness.plugin-maker.scaffold", "1")?.plugin).toEqual({
    id: "zet.plugin-maker",
    version: "1.0.0",
  });
  expect(host.models.listManifests()).toEqual([]);
  await host.unload("zet.plugin-maker");
  expect(host.tools.getResolution("harness.plugin-maker.scaffold", "1")).toBeUndefined();
});
