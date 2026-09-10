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
  ModelCatalog,
  ToolCatalog,
  type AdapterPluginPin,
  type AdapterResolution,
} from "./adapter-catalog.js";
