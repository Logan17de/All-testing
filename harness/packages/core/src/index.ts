// Phase 5.5 owns permission semantics; Phase 5.6 compiles against them and Phase 5.7 re-checks them at invocation time; Phase 5.8 next hardens authority provenance.
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
