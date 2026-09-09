// Phase 5.5 owns permission semantics; Phase 5.6 now applies them at compile time.
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
export { PluginHost } from "./plugin-host.js";
export { TypedRegistry, type RegistryDisposer, type RegistryEntry } from "./typed-registry.js";
