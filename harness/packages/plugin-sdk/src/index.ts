// Authoring surface for third-party plugins. Built only on the frozen public
// contracts, so an external author has exactly the surface a first-party
// plugin has - no more, and no less.
export {
  defineEffectNode,
  definePlugin,
  definePureNode,
  describeNodesForManifest,
  type DefinePluginOptions,
  type EffectNodeOptions,
  type NodeExecuteArguments,
  type NodeExecuteFunction,
  type PureNodeOptions,
} from "./define-node.js";

// Re-exported so a plugin author needs one dependency, not two.
export {
  PLUGIN_API_VERSION,
  JSON_SCHEMA_DIALECT_URI,
  type CapabilityId,
  type HarnessPlugin,
  type JsonObject,
  type JsonSchema,
  type JsonValue,
  type NodeDefinition,
  type NodeExecutionResult,
  type NodeManifest,
  type PluginContext,
  type PluginManifest,
  type ToolAdapter,
  type ToolManifest,
  type ModelAdapter,
  type ModelAdapterManifest,
} from "@zet-harness/plugin-api";
