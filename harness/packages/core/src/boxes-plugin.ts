import { PLUGIN_API_VERSION, type HarnessPlugin, type NodeBehavior } from "@zet-harness/plugin-api";

export const BOXES_PLUGIN_ID = "harness.boxes-plugin" as const;
export const TEXT_BOX_NODE_TYPE = "harness.text-box" as const;
export const OUTPUT_BOX_NODE_TYPE = "harness.output-box" as const;
export const ASK_MODEL_NODE_TYPE = "harness.ask-model" as const;

/**
 * Every port here carries plain text, declared once, so any output connects to
 * any input: a box into a model, a model into a model, a model into a box.
 */
const TEXT = { type: "string" } as const;

const PURE: NodeBehavior = {
  primitiveFamily: "pure",
  determinism: "deterministic",
  effect: "none",
  idempotency: "not-applicable",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

/**
 * Asking a model reads from outside the graph and changes nothing there, so a
 * retried attempt may simply ask again; its answer is not expected to match.
 */
const MODEL_CALL: NodeBehavior = {
  primitiveFamily: "effect",
  determinism: "nondeterministic",
  effect: "external-read",
  idempotency: "idempotent",
  recovery: "rerun",
  executionMode: "in-process",
  requiredCapabilities: [],
};

function hostOnly(): never {
  throw new Error("A model step runs through the runtime, which holds the models and their keys.");
}

/**
 * The plainest way to use a model: text in, text out.
 *
 * A Text box holds what a person typed, a Model answers whatever text reaches its
 * prompt, and an Output box shows what reaches it once the graph has run. None of
 * them needs a project or a conversation, so a graph of three boxes is a complete
 * workflow, and a model's text can feed another model's prompt.
 */
export function createBoxesPlugin(): HarnessPlugin {
  return {
    manifest: {
      id: BOXES_PLUGIN_ID,
      name: "Boxes",
      version: "1",
      apiVersion: PLUGIN_API_VERSION,
    },
    activate(context) {
      context.nodes.register({
        manifest: {
          type: TEXT_BOX_NODE_TYPE,
          version: "1",
          title: "Text box",
          description: "Text you type here. Connect it to a model's prompt, or anywhere text goes.",
          inputs: {},
          outputs: { text: { schema: TEXT } },
          configSchema: {
            type: "object",
            properties: { text: { type: "string", maxLength: 100_000 } },
            additionalProperties: false,
          },
          behavior: PURE,
        },
        execute: ({ config }) => ({
          outputs: { text: typeof config["text"] === "string" ? config["text"] : "" },
        }),
      });

      context.nodes.register({
        manifest: {
          type: OUTPUT_BOX_NODE_TYPE,
          version: "1",
          title: "Output box",
          description:
            "Shows the text that reaches it once the graph has run, and passes it on unchanged.",
          inputs: { text: { schema: TEXT, required: true } },
          outputs: { text: { schema: TEXT } },
          configSchema: { type: "object", properties: {}, additionalProperties: false },
          behavior: PURE,
        },
        execute: ({ inputs }) => ({
          outputs: { text: typeof inputs["text"] === "string" ? inputs["text"] : "" },
        }),
      });

      context.nodes.register({
        manifest: {
          type: ASK_MODEL_NODE_TYPE,
          version: "1",
          title: "Model",
          description:
            "Sends the text on its prompt to a model and outputs the answer. Leave the model empty to use any connected model.",
          inputs: { prompt: { schema: TEXT, required: true } },
          outputs: { text: { schema: TEXT } },
          configSchema: {
            type: "object",
            properties: {
              modelId: { type: "string", minLength: 1 },
              instructions: { type: "string", maxLength: 20_000 },
              maxOutputTokens: { type: "integer", minimum: 1 },
            },
            additionalProperties: false,
          },
          behavior: MODEL_CALL,
        },
        execute: hostOnly,
      });
    },
  };
}
