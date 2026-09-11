/**
 * A complete Zet Harness plugin.
 *
 * This file has no dependencies and no build step on purpose: the floor for
 * writing a plugin should be one JSON file and one JavaScript file. TypeScript
 * authors can install `@zet-harness/plugin-sdk` for typed `definePureNode` and
 * `definePlugin` helpers, but nothing here requires it.
 *
 * The plugin declares no capabilities because it touches nothing outside
 * itself. A plugin that reads files or the network must request those
 * capabilities in `zet-plugin.json` - and the host still decides separately
 * whether to grant them.
 */

/** One node: reverses the text on its input port. */
const reverseText = {
  manifest: {
    type: "example.reverse-text",
    version: "1",
    title: "Reverse text",
    description: "Reverses the characters of the input string.",
    inputs: {
      text: { schema: { type: "string" }, required: true },
    },
    outputs: {
      text: { schema: { type: "string" }, required: true },
    },
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        // Configuration is plain data. It never conveys permission.
        separator: { type: "string", maxLength: 8 },
      },
    },
    behavior: {
      // A pure node computes from its inputs alone, so the scheduler may rerun
      // it freely after a crash without any risk of a duplicated side effect.
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
    const value = request.inputs.text;
    if (typeof value !== "string") {
      throw new TypeError("example.reverse-text expects a string on its 'text' input.");
    }
    const separator = typeof request.config.separator === "string" ? request.config.separator : "";
    return { outputs: { text: [...value].reverse().join(separator) } };
  },
};

export default {
  manifest: {
    id: "com.example.hello",
    name: "Hello Example",
    version: "1.0.0",
    apiVersion: 1,
    capabilities: [],
  },
  activate(context) {
    context.nodes.register(reverseText);
  },
};
