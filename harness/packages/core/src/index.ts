// Host authority, public plugin registration, and scoped secret access remain distinct boundaries.
export {
  CapabilityPermissionPolicy,
  type CapabilityPermissionBatchResult,
  type CapabilityPermissionDecision,
  type CapabilityPermissionDenialReason,
  type CapabilityPermissionEvaluation,
  type CapabilityPermissionPolicyConfig,
} from "./capability-permission-policy.js";
export {
  NodeCatalog,
  type NodeCatalogPluginPin,
  type NodeCatalogResolution,
} from "./node-catalog.js";
export {
  NodeSecretResolutionError,
  createNodeSecretAccessor,
  type NodeSecretBinding,
  type NodeSecretResolutionErrorCode,
} from "./node-secret-accessor.js";
export { PluginHost } from "./plugin-host.js";
export { TypedRegistry, type RegistryDisposer, type RegistryEntry } from "./typed-registry.js";
export { HUMAN_APPROVAL_NODE_TYPE, createHumanApprovalPlugin } from "./human-approval-plugin.js";
export {
  CONDITION_NODE_TYPE,
  CONDITION_OPERATORS,
  CONTROL_FLOW_PLUGIN_ID,
  JOIN_ALL_NODE_TYPE,
  JOIN_ANY_NODE_TYPE,
  ROUTE_NODE_TYPE,
  createControlFlowPlugin,
  evaluateCondition,
  type ConditionOperator,
} from "./control-flow-plugin.js";
export {
  ModelCatalog,
  ToolCatalog,
  type AdapterPluginPin,
  type AdapterResolution,
} from "./adapter-catalog.js";
export {
  MODEL_ROUTING_DECISION_EVENT_TYPE,
  MODEL_ROUTING_DECISION_SCHEMA_VERSION,
  routeModel,
  type ModelCandidateEvaluation,
  type ModelRejectionReason,
  type ModelRequirements,
  type ModelRoutingDecision,
  type ModelRoutingOutcome,
  type RouteModelOptions,
} from "./model-router.js";
export {
  ModelStreamError,
  accumulateUsage,
  consumeModelStream,
  type ConsumedModelStream,
  type ModelStreamObserver,
  type ModelStreamStatistics,
  type UsageTotals,
} from "./model-stream-sink.js";
export {
  PLUGIN_PACKAGE_MANIFEST_FILENAME,
  PLUGIN_PACKAGE_MANIFEST_VERSION,
  reconcilePluginGrants,
  validatePluginPackageManifest,
  type DeclaredPluginNode,
  type PluginInstallRecord,
  type PluginManifestDefect,
  type PluginManifestDefectCode,
  type PluginManifestValidation,
  type PluginPackageIntegrity,
  type PluginPackageManifest,
} from "./plugin-package-manifest.js";
export {
  findPluginConfig,
  pluginCapabilityPolicy,
  validatePluginConfig,
  type PluginConfigDefect,
  type PluginConfigDefectCode,
  type PluginConfigDocument,
  type PluginConfigEntry,
  type PluginConfigValidation,
  type ResolvedPluginConfig,
} from "./plugin-config.js";
