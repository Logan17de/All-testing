import { describe, expect, it } from "vitest";

import {
  PLUGIN_API_VERSION,
  type HarnessPlugin,
  type NodeDefinition,
} from "@zet-harness/plugin-api";

import { PluginHost } from "./plugin-host.js";

function makePureEchoNode(type: string, title: string): NodeDefinition {
  return {
    manifest: {
      type,
      version: "1",
      title,
      inputs: {
        value: { schema: true },
      },
      outputs: {
        value: { schema: true },
      },
      configSchema: true,
      behavior: {
        primitiveFamily: "pure",
        determinism: "deterministic",
        effect: "none",
        idempotency: "not-applicable",
        recovery: "rerun",
        executionMode: "in-process",
        requiredCapabilities: [],
      },
    },
    execute(request) {
      return { outputs: request.inputs };
    },
  };
}

const builtInPlugin: HarnessPlugin = {
  manifest: {
    id: "builtin.test-parity",
    name: "Built-in parity test plugin",
    version: "1",
    apiVersion: PLUGIN_API_VERSION,
  },
  activate(context) {
    context.nodes.register(makePureEchoNode("builtin.test.echo", "Built-in Echo"));
  },
};

async function loadExternalLocalPlugin(): Promise<HarnessPlugin> {
  const source = `
    export default {
      manifest: {
        id: "local.external-parity",
        name: "External local parity test plugin",
        version: "1",
        apiVersion: 1
      },
      activate(context) {
        context.nodes.register({
          manifest: {
            type: "local.external.echo",
            version: "1",
            title: "External Local Echo",
            inputs: {
              value: { schema: true }
            },
            outputs: {
              value: { schema: true }
            },
            configSchema: true,
            behavior: {
              primitiveFamily: "pure",
              determinism: "deterministic",
              effect: "none",
              idempotency: "not-applicable",
              recovery: "rerun",
              executionMode: "in-process",
              requiredCapabilities: []
            }
          },
          execute(request) {
            return { outputs: request.inputs };
          }
        });
      }
    };
  `;

  const moduleUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
  const imported: unknown = await import(moduleUrl);

  if (typeof imported !== "object" || imported === null || !("default" in imported)) {
    throw new Error("External local plugin module did not export a default plugin.");
  }

  return imported.default as HarnessPlugin;
}

describe("built-in and external/local plugin parity", () => {
  it("routes both origins through the same PluginHost and NodeCatalog path", async () => {
    const host = new PluginHost();
    const externalPlugin = await loadExternalLocalPlugin();

    await host.activate(builtInPlugin);
    await host.activate(externalPlugin);

    expect(host.listManifests().map(({ id }) => id)).toEqual([
      "builtin.test-parity",
      "local.external-parity",
    ]);
    expect(host.nodes.requireManifest("builtin.test.echo", "1").title).toBe("Built-in Echo");
    expect(host.nodes.requireManifest("local.external.echo", "1").title).toBe(
      "External Local Echo",
    );
    expect(host.nodes.requireManifest("builtin.test.echo", "1").inputs.value).toEqual({
      schema: true,
    });

    await host.unload("builtin.test-parity");

    expect(host.nodes.has("builtin.test.echo", "1")).toBe(false);
    expect(host.nodes.has("local.external.echo", "1")).toBe(true);

    await host.dispose();

    expect(host.size).toBe(0);
    expect(host.nodes.size).toBe(0);
  });
});
