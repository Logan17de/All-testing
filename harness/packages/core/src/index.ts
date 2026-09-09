// Phase 5.5 owns permission semantics; Phase 5.6 compiles against them, Phase 5.7 re-checks them at invocation time, and Phase 5.8 pins authority provenance. Phase 5.9 keeps secret material behind a host-owned node-scoped provider boundary.
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
