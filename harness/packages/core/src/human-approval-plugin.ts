import { PLUGIN_API_VERSION, type HarnessPlugin } from "@zet-harness/plugin-api";

export const HUMAN_APPROVAL_NODE_TYPE = "harness.human-approval" as const;

/**
 * Linear human gate. Registration is identical to any external plugin.
 * The durable host dispatcher consumes the interrupt primitive; it must not call
 * execute() or treat a model-produced output as an approval. Multi-outcome control
 * ports remain a separate structured-control feature, not implicit branch logic.
 */
export function createHumanApprovalPlugin(): HarnessPlugin {
  return {
    manifest: {
      id: "harness.human-approval-plugin",
      name: "Human approval",
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
    },
    activate(context) {
      context.nodes.register({
        manifest: {
          type: HUMAN_APPROVAL_NODE_TYPE,
          version: "1",
          title: "Human approval",
          inputs: {},
          outputs: { response: { schema: true } },
          configSchema: {
            type: "object",
            properties: { prompt: { type: "string", minLength: 1 } },
            required: ["prompt"],
            additionalProperties: false,
          },
          behavior: {
            primitiveFamily: "interrupt",
            determinism: "nondeterministic",
            effect: "none",
            idempotency: "not-applicable",
            recovery: "manual",
            executionMode: "in-process",
            requiredCapabilities: [],
          },
        },
        execute() {
          throw new Error("Human approval must use the durable host interrupt boundary.");
        },
      });
    },
  };
}
