import { describe, expect, it } from "vitest";

import { checkNodeBehaviorPolicy } from "@zet-harness/plugin-api/node-behavior-policy";

import { AGENT_MODEL_NODE_TYPE, AGENT_TOOLS_NODE_TYPE, createAgentPlugin } from "./agent-plugin.js";
import { PluginHost } from "./plugin-host.js";

describe("agent plugin", () => {
  it("registers the agent model and tools steps, which only the host agent executor runs", async () => {
    const host = new PluginHost();
    await host.activate(createAgentPlugin());
    try {
      for (const type of [AGENT_MODEL_NODE_TYPE, AGENT_TOOLS_NODE_TYPE]) {
        const definition = host.nodes.getDefinition(type, "1");
        if (definition === undefined) throw new Error(`${type} was not registered.`);
        expect(checkNodeBehaviorPolicy(definition.manifest.behavior).valid).toBe(true);
        expect(() =>
          definition.execute?.(
            { inputs: {}, config: {} },
            { signal: new AbortController().signal },
          ),
        ).toThrow(/host agent executor/u);
      }
    } finally {
      await host.dispose();
    }
  });
});
