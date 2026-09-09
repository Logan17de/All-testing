# Phase 5.8 — Capability authority provenance

## Contract

The host owns permission authority. Plugin manifests, node manifests, Graph JSON, model-proposed
configuration, and execution results are data or capability demand, never sources of grants.

- Plugin and node manifests are cloned and recursively frozen before the host trusts their metadata.
  A plugin's inspected capability declarations are an audit ceiling for its registered nodes, not
  permission to perform those operations. Registration remains the same for built-in and external
  plugins, and activation failure rolls back partial registrations.
- The activation context and its node-registration facade are frozen before plugin code receives
  them. They expose registration and cleanup, not host policy, a grant mutator, or the node catalog.
  Configuration remains JSON data; permission-shaped keys do not become authority.
- Permission lookup sets live in JavaScript private slots. Freezing an object containing ordinary
  Set properties is insufficient because Set.add/delete/clear would still be reachable at runtime.
  Public policy snapshots remain frozen; default deny, exact matching, and explicit-deny precedence
  are unchanged.
- The scheduler pins the host-selected evaluator function and its receiver at run construction.
  Replacing a retained options reference, injecting an authority after construction, or replacing
  the authority's evaluate method cannot change the selected grant source. The evaluator is kept
  in a private slot and is not exposed to executor code.
- Decisions are not cached: the pinned evaluator is called before each invocation attempt. Trusted
  host-owned revocation state is still observed, including between retries. A denial is terminal
  before consuming another attempt, invoking effect-retry proof, or calling the executor.

## Preserved validation boundary

Graph shape and semantic validation still belong to the compiler. The scheduler consumes immutable
IR and enforces invocation policy; it does not reimplement graph validation or add Graph-to-Core
coupling. Compile-time authorization is not an execution-time grant. A previously compiled graph
must still satisfy current host authority when invoked.

A host that needs revocation can supply one stable evaluator that reads its current policy:

```ts
let currentPolicy = new CapabilityPermissionPolicy({ granted: ["fs:read"] });
const authority = {
  evaluate(capability: string) {
    return currentPolicy.evaluate(capability);
  },
};

// Supply authority when constructing the run. Keep these references host-owned.
// Revocation changes host state, not the evaluator or the retained run options.
currentPolicy = new CapabilityPermissionPolicy();
```

## Regression coverage

`scripts/capability-self-grant-enforcement.test.ts` exercises the actual Core, Graph, and Scheduler
boundaries together. It covers reflected policy mutation, the frozen activation facade, forged
plugin/config/graph grants, compile-to-runtime authority separation, retained-options replacement,
evaluator-method replacement, late authority injection, and receiver-preserving revocation.

Existing plugin-host and node-catalog tests continue to cover manifest mutation and activation
rollback. Existing compile and invocation tests continue to cover exact matching, explicit denials,
missing authority, graph restrictions, and rejection before effect execution.

Run from `harness/`:

```sh
npm test -- scripts/capability-self-grant-enforcement.test.ts
npm run typecheck
npm run lint
npm run format:check
npm test
```

The existing Ubuntu and Windows CI also runs plugin/startup smoke tests, the build, and the baseline.

## Trust limit

This is an authority-provenance boundary for supported Harness APIs, not an operating-system
sandbox. In-process plugins are trusted code sharing the runtime process and can call native Node
APIs outside Harness. Do not give hostile code a host policy, runtime instance, or privileged
closure. Process/WASI isolation and brokered native tools remain separate roadmap work. This step
adds no process-isolation claim, model adapter, approval API, database migration, or dependency.
