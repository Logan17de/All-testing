import { PLUGIN_API_VERSION, type HarnessPlugin, type NodeBehavior } from "@zet-harness/plugin-api";

export const AGENT_PLUGIN_ID = "harness.agent-plugin" as const;
export const AGENT_MODEL_NODE_TYPE = "harness.agent-model" as const;
export const AGENT_TOOLS_NODE_TYPE = "harness.agent-tools" as const;

/**
 * Agent steps append conversation messages. Each step is recorded against its
 * logical effect id, so a retried attempt answers from the record and repeating
 * it is safe.
 */
const AGENT_STEP: NodeBehavior = {
  primitiveFamily: "effect",
  determinism: "nondeterministic",
  effect: "external-write",
  idempotency: "idempotent",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

const SORTABLE_ID_SCHEMA = {
  type: "string",
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
};

function hostOnly(): never {
  throw new Error("Agent steps run through the durable host agent executor.");
}

/**
 * The two steps of the bounded model→tool→model loop.
 *
 * They register like any plugin node so graphs that use them compile, validate and
 * lower normally, and they sit inside a structured Loop whose `maxIterations` is the
 * hard bound. Only the runtime's agent executor can run them, because a step needs
 * the run's own identity: its conversation, its logical effect id and its retry
 * budget.
 */
export function createAgentPlugin(): HarnessPlugin {
  return {
    manifest: {
      id: AGENT_PLUGIN_ID,
      name: "Agent",
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
    },
    activate(context) {
      context.nodes.register({
        manifest: {
          type: AGENT_MODEL_NODE_TYPE,
          version: "1",
          title: "Agent model step",
          description:
            "Asks a model for the next step of a conversation, offering the project's goal and todo actions as tools. Place it inside a Loop and feed its again output back to the loop.",
          inputs: {},
          outputs: {
            again: { schema: { type: "boolean" } },
            finishReason: { schema: { type: "string" } },
            blocked: { schema: { type: "boolean" } },
          },
          configSchema: {
            type: "object",
            properties: {
              conversationId: SORTABLE_ID_SCHEMA,
              systemPrompt: { type: "string", minLength: 1, maxLength: 20_000 },
              reserveOutputTokens: { type: "integer", minimum: 1 },
              maxOutputTokens: { type: "integer", minimum: 1 },
              maxContextBytes: { type: "integer", minimum: 1 },
              maxMemories: { type: "integer", minimum: 0, maximum: 100 },
              modelId: { type: "string", minLength: 1 },
              modelVersion: { type: "string", minLength: 1 },
              maxModelCalls: { type: "integer", minimum: 1 },
              maxTokens: { type: "integer", minimum: 1 },
              maxCost: {
                type: "object",
                properties: {
                  amountDecimal: {
                    type: "string",
                    pattern: "^(?:0|[1-9][0-9]{0,30})(?:\\.[0-9]{1,18})?$",
                  },
                  currency: { type: "string", pattern: "^[A-Z]{3}$" },
                },
                required: ["amountDecimal", "currency"],
                additionalProperties: false,
              },
            },
            required: ["conversationId", "systemPrompt"],
            additionalProperties: false,
          },
          behavior: AGENT_STEP,
        },
        execute: hostOnly,
      });

      context.nodes.register({
        manifest: {
          type: AGENT_TOOLS_NODE_TYPE,
          version: "1",
          title: "Agent tools step",
          description:
            "Runs the tool calls in the conversation's latest model message and records their results for the next model step.",
          inputs: {},
          outputs: { calls: { schema: { type: "integer", minimum: 0 } } },
          configSchema: {
            type: "object",
            properties: {
              conversationId: SORTABLE_ID_SCHEMA,
              maxToolCalls: { type: "integer", minimum: 1 },
              allowedTools: {
                type: "array",
                items: { type: "string", minLength: 1 },
                maxItems: 200,
              },
            },
            required: ["conversationId"],
            additionalProperties: false,
          },
          behavior: AGENT_STEP,
        },
        execute: hostOnly,
      });
    },
  };
}
