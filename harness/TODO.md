# Zet Harness — Ordered TODO

This is the strict implementation order. `PLAN.md` explains the architecture; this file is the execution checklist.

Do not jump ahead unless an earlier item is blocked.

## Phase 0 — Foundation closeout

Historical items already completed remain checked so progress is never lost.

- [x] 0.1 Create `harness/package.json` and workspace layout.
- [x] 0.2 Add TypeScript, linting, formatting, and test configuration.
- [x] 0.3 Create `apps/web` Next.js app.
- [x] 0.4 Create `packages/core`, `packages/db`, `packages/models`, `packages/tools`, and `packages/shared`.
- [x] 0.5 Add `.env.example` with placeholders only.
- [x] 0.6 Add `.gitignore` rules for local DB, runtime state, logs, and secrets.
- [x] 0.7 Add `/api/health`.
- [x] 0.8 Add basic startup test.
- [x] 0.9 Fix the root typecheck so each workspace owns its own TypeScript configuration.
- [x] 0.10 Commit `package-lock.json`; pin Node 24.20.0 LTS and npm 12.0.2; enforce both through `.npmrc` engine strictness.
- [x] 0.11 Add Linux + Windows CI for clean install, typecheck, lint, format check, tests, startup smoke, and build.
- [x] 0.12 Add `data/.gitkeep` with matching ignore rules, plus `tests/`.
- [x] 0.13 Add Next Core Web Vitals rules and type-checked TypeScript linting.
- [x] 0.14 Add a project `LICENSE`.
- [x] 0.15 Wire one internal package into `apps/web` and add `transpilePackages` to prove the workspace graph.
- [x] 0.16 Remove the unrelated physical-safety research artifact.
- [x] 0.22 Decide runtime ownership: a long-lived lightweight Node daemon owns durable execution; web is a client.

Moved from the old Phase 0 ordering:

- runtime/database health expansion → Phase 4
- plugin API/host/smoke → Phase 1
- lightweight baseline → Phase 4

**Checkpoint:** final Phase 0 head passes Linux + Windows `npm ci → typecheck → lint → format → tests → startup smoke → build`.

---

## Phase 1 — Public plugin and universal node contract

Goal: freeze the smallest stable extension boundary before graph/runtime code depends on it.

- [x] 1.1 Create `packages/plugin-api` with zero/near-zero runtime dependencies.
- [x] 1.2 Define public `Json`, schema reference, diagnostic, capability, and version primitives.
- [x] 1.3 Define `HarnessPlugin` lifecycle: load/activate → tracked registrations → dispose.
- [x] 1.4 Implement the plugin host in `packages/core`.
- [ ] 1.5 Add a generic typed registry primitive used by plugin-provided capabilities.
- [ ] 1.6 Freeze the universal `NodeDefinition`/`NodeManifest` contract.
- [ ] 1.7 Include node input/config/output schemas in the manifest.
- [ ] 1.8 Include node behavior metadata: primitive family, determinism, effect/idempotency, recovery, timeout/retry defaults, execution mode, required capabilities.
- [ ] 1.9 Ensure manifests can be inspected without executing plugin node code.
- [ ] 1.10 Prove one built-in plugin and one external/local test plugin use the exact same host/registry path.
- [ ] 1.11 Add plugin lifecycle/unload tests.
- [ ] 1.12 Add plugin smoke to CI.

**Checkpoint:** built-in and local/external test plugins register the same kind of node through the same public path and unload cleanly.

---

## Phase 2 — Graph JSON v1, validator, compiler, Execution IR v1

Goal: freeze what workflows mean before adding durable execution.

- [ ] 2.1 Create a lightweight `packages/graph` workspace for Graph source, compiler, and IR modules.
- [ ] 2.2 Define Graph JSON v1: graph metadata, nodes, ports/bindings, edges, policies, options, editor-only metadata.
- [ ] 2.3 Choose JSON Schema Draft 2020-12 as the public shape-validation format.
- [ ] 2.4 Add Ajv only if its compiled validation materially simplifies the boundary; keep it out of runtime scheduling logic.
- [ ] 2.5 Add shape/schema validation.
- [ ] 2.6 Add semantic validation for unique IDs and node type/version resolution.
- [ ] 2.7 Add port existence, cardinality, and binding validation.
- [ ] 2.8 Add deliberately constrained port type compatibility; do not attempt arbitrary JSON-Schema implication.
- [ ] 2.9 Add reachability/liveness validation.
- [ ] 2.10 Reject arbitrary cycles/SCCs in the initial executable graph.
- [ ] 2.11 Reserve explicit structured control contracts for router, join, loop, human interrupt, and subgraph.
- [ ] 2.12 Require compiler-visible bounds for executable loops when loop execution lands.
- [ ] 2.13 Add compile-time capability/policy validation.
- [ ] 2.14 Add compile-time side-effect/retry/recovery validation.
- [ ] 2.15 Reject literal secrets where a secret reference is required.
- [ ] 2.16 Return structured diagnostics with codes plus node/edge/path references.
- [ ] 2.17 Normalize defaults and pin resolved node/plugin versions.
- [ ] 2.18 Strip UI-only metadata during compilation.
- [ ] 2.19 Canonicalize source semantics deterministically.
- [ ] 2.20 Define compact immutable Execution IR v1 with indexed ops and resolved references.
- [ ] 2.21 Record graph/source hash, IR hash, compiler version, registry hash, and pinned node versions.
- [ ] 2.22 Lower basic DAG dependencies, routers, and join descriptors into the IR.
- [ ] 2.23 Add stable canonical hash tests.
- [ ] 2.24 Add invalid-graph golden diagnostic tests.
- [ ] 2.25 Add generated-graph compiler stress tests.

**Checkpoint:** same Graph JSON + same registry/compiler produces the same canonical IR/hash; invalid graphs fail before execution with useful diagnostics.

---

## Phase 3 — Framework-free in-memory DAG scheduler

Goal: prove execution semantics without persistence hiding scheduler bugs.

- [ ] 3.1 Add run-local op status state machine: pending/ready/running/completed/skipped/waiting/retry-wait/failed/cancelled.
- [ ] 3.2 Add readiness queue and dependency counters.
- [ ] 3.3 Add bounded global/per-run concurrency using native Promises/semaphores.
- [ ] 3.4 Execute independent DAG branches concurrently.
- [ ] 3.5 Add router branch activation.
- [ ] 3.6 Add control-edge runtime states: unresolved/active/skipped/completed.
- [ ] 3.7 Add activation-aware `all-active` joins.
- [ ] 3.8 Add explicit `any`/quorum semantics only after `all-active` is solid.
- [ ] 3.9 Add run cancellation with `AbortController`/`AbortSignal`.
- [ ] 3.10 Add node timeouts.
- [ ] 3.11 Add bounded retry scheduling with backoff/jitter hooks.
- [ ] 3.12 Ensure adapter-reported internal retries are not accidentally doubled.
- [ ] 3.13 Add small typed runtime event emitter.
- [ ] 3.14 Separate transient stream events from events intended for durable storage.
- [ ] 3.15 Add deterministic mock nodes/executors.
- [ ] 3.16 Add offline scheduler tests for chain, fan-out/fan-in, router/join, timeout, retry, cancellation, and failure propagation.
- [ ] 3.17 Add scheduler stress/race tests.

**Checkpoint:** deterministic mock graphs execute correctly and concurrently entirely in memory with no database or model dependency.

---

## Phase 4 — Long-lived runtime daemon + SQLite durability

Goal: make the scheduler durable without changing Graph/IR semantics.

- [ ] 4.1 Create `apps/runtime` as a long-lived Node process.
- [ ] 4.2 Bind the local API to loopback by default using built-in `node:http` where practical.
- [ ] 4.3 Add SSE event streaming with reconnect cursor/`Last-Event-ID` support.
- [ ] 4.4 Add SQLite through Node 24 `node:sqlite`; no ORM initially.
- [ ] 4.5 Add a tiny ordered SQL migration runner + `schema_migrations`.
- [ ] 4.6 Enable foreign keys and WAL mode.
- [ ] 4.7 Define durable graph/source and compiled-plan identity records.
- [ ] 4.8 Define runs and nullable `parent_run_id`/fork metadata.
- [ ] 4.9 Define node attempts including iteration, attempt, status, timing, input/output refs, errors, usage, and stable logical effect/idempotency ID.
- [ ] 4.10 Define append-only durable events with schema versions.
- [ ] 4.11 Define sparse checkpoints/frontier state.
- [ ] 4.12 Add a filesystem content-addressed blob store for large immutable values.
- [ ] 4.13 Keep short SQLite writes serialized through one clear commit path.
- [ ] 4.14 Commit node completion + output reference + terminal event atomically.
- [ ] 4.15 Make downstream work runnable only after the durable completion commit succeeds.
- [ ] 4.16 Reconstruct the execution frontier after process restart.
- [ ] 4.17 Classify pre-crash running nodes by recovery policy instead of blindly replaying them.
- [ ] 4.18 Add backup/restore using SQLite/file-level facilities.
- [ ] 4.19 Expand `/api/health` with runtime/database checks.
- [ ] 4.20 Add random/fault-injection kill/restart tests around node and commit transitions.
- [ ] 4.21 Add the lightweight baseline: startup latency, idle RSS, direct runtime dependency count, compiler overhead, scheduler overhead, SQLite commit latency.
- [ ] 4.22 Record/check the baseline in CI without making noisy machine-specific thresholds brittle.

**Checkpoint:** kill the runtime during a deterministic graph → restart → committed outputs are reused and unfinished work is safely classified/resumed.

---

## Phase 5 — Effects, permissions, approvals, human interrupts

Goal: make side effects and privilege boundaries explicit before broad real-world tool use.

- [ ] 5.1 Freeze exact node enums/contracts for determinism, effect class, idempotency, and recovery policy.
- [ ] 5.2 Generate a stable logical effect/idempotency ID that survives retry attempts.
- [ ] 5.3 Add effect-aware retry rules; never infer that an uncertain external write is safe to repeat.
- [ ] 5.4 Add reconciliation/manual-review outcomes for ambiguous external writes.
- [ ] 5.5 Add capability-based permission policy.
- [ ] 5.6 Enforce graph/node capabilities at compile time.
- [ ] 5.7 Re-check actual capability use at invocation time.
- [ ] 5.8 Ensure a model/plugin cannot grant itself capabilities.
- [ ] 5.9 Add secret references/secret provider boundary; never put secret values in Graph JSON, IR, checkpoints, or logs.
- [ ] 5.10 Add first-class approval records.
- [ ] 5.11 Add durable human interrupt node/state.
- [ ] 5.12 Persist checkpoint + suspend so the runtime may terminate while waiting for approval.
- [ ] 5.13 Add idempotent resume tokens/payload handling.
- [ ] 5.14 Return machine-readable permission denials with stable code, safe reason, and remediation metadata.
- [ ] 5.15 Add payload/log redaction registry and secret deny list.
- [ ] 5.16 Add origin/CSRF protection where applicable for the local UI/API boundary.

**Checkpoint:** a privileged effect can pause for approval, survive process shutdown, resume once, and cannot exceed compiled/runtime capabilities.

---

## Phase 6 — Model and tool adapters

Goal: prove provider/tool neutrality through plugins, not core branches.

- [ ] 6.1 Define public `ModelAdapter` contract in the plugin API.
- [ ] 6.2 Define public `ToolAdapter`/tool manifest contract in the plugin API.
- [ ] 6.3 Add model/tool registries as plugin services.
- [ ] 6.4 Add scripted/mock model and tool adapters for deterministic tests.
- [ ] 6.5 Implement the generic OpenAI-compatible model adapter as a first-party plugin.
- [ ] 6.6 Add provider-specific OpenAI adapter only where current OpenAI behavior requires it.
- [ ] 6.7 Support custom base URL and credential references.
- [ ] 6.8 Add model capability metadata: tools, vision, structured output, context, reasoning/options when supported.
- [ ] 6.9 Add capability-based model selection/routing; record the routing decision in the run trace.
- [ ] 6.10 Add streamed model events without durably storing every token.
- [ ] 6.11 Capture token/usage/cost metadata when exposed.
- [ ] 6.12 Prove llama.cpp/Ollama through local HTTP/OpenAI-compatible configuration rather than embedding model runtimes.
- [ ] 6.13 Add safe `fs.list` and `fs.read` through a first-party native-tools plugin.
- [ ] 6.14 Add project-root path resolution and traversal/symlink protection.
- [ ] 6.15 Implement Windows containment rules: junctions, case folding, short names, UNC/drive-relative paths.
- [ ] 6.16 Add controlled `fs.write`.
- [ ] 6.17 Add safe read-only command allowlist and controlled `shell.run`.
- [ ] 6.18 Add process-tree cancellation and output/time limits.
- [ ] 6.19 Add `git.status`, `git.diff`, and approval-gated `git.commit`.
- [ ] 6.20 Record file changes for writes using path + before/after hashes.
- [ ] 6.21 Detect/report Windows long-path limitations at runtime startup.

**Checkpoint:** the same compiled graph runs with mock, cloud/OpenAI-compatible, and local OpenAI-compatible model endpoints, while tool calls share the same capability/trace path.

---

## Phase 7 — Visual graph editor and run inspector

Goal: make the stable graph/compiler/runtime usable without letting the UI become execution architecture.

- [ ] 7.1 Add React Flow (`@xyflow/react`) only to the web/editor side and lazy-load it.
- [ ] 7.2 Implement node palette and graph canvas backed by Harness Graph JSON, not React Flow persistence types.
- [ ] 7.3 Render plugin node definitions/manifests in the palette.
- [ ] 7.4 Generate basic node configuration forms from schemas.
- [ ] 7.5 Add ports/connections with compiler-backed validation.
- [ ] 7.6 Show diagnostics directly on nodes/edges.
- [ ] 7.7 Add compile/run controls.
- [ ] 7.8 Overlay live node state on the graph.
- [ ] 7.9 Add run timeline.
- [ ] 7.10 Add node inspector: inputs, config, outputs, attempts, model route, tokens/cost, tools, permissions, retries, logs, checkpoints, errors, artifacts, sanitized raw events.
- [ ] 7.11 Add approval/resume cards.

**Checkpoint / Harness v0.1 boundary:** draw/load graph → compile → run → pause/resume → restart → inspect durable execution end to end.

---

## Phase 8 — Structured loops, subgraphs, projects/goals/todos, agent mode

Goal: build autonomous agents on the same scheduler rather than creating a second engine.

- [ ] 8.1 Implement explicit bounded loop regions.
- [ ] 8.2 Require independent hard bounds such as iterations/model calls/tool calls/tokens/cost/wall time.
- [ ] 8.3 Preserve exact loop iteration/attempt identity in durability records.
- [ ] 8.4 Add subgraph compile-time lowering/namespacing; reject uncontrolled recursion initially.
- [ ] 8.5 Add project schema/CRUD.
- [ ] 8.6 Add conversations/messages using structured message parts and nullable `parent_message_id` for edit/retry branches.
- [ ] 8.7 Add goal/todo schema/CRUD and valid status transitions.
- [ ] 8.8 Add sortable IDs and UTC epoch-millisecond timestamps consistently.
- [ ] 8.9 Add deterministic next-runnable-todo selection.
- [ ] 8.10 Add context builder with hard byte/token-budget hooks.
- [ ] 8.11 Add model-visible goal/todo actions.
- [ ] 8.12 Express the bounded model→tool→model agent loop through the same structured loop/scheduler semantics.
- [ ] 8.13 Add blocked state and goal-completion logic.
- [ ] 8.14 Add chat/project/goals/todos UI.
- [ ] 8.15 Add multi-step coding integration test using the scripted provider.
- [ ] 8.16 Add golden trace assertion for a complete deterministic goal run.
- [ ] 8.17 Add per-project run lock before two autonomous runs can mutate one project concurrently.

**Checkpoint:** three-todo coding goal progresses to completion, survives restart, and emits reproducible durable trace ordering.

---

## Phase 9 — Replay/fork, memory, triggers, external clients

- [ ] 9.1 Add read-only recorded trace replay with no external/model/tool invocation.
- [ ] 9.2 Add execution fork from a checkpoint; keep historical run immutable.
- [ ] 9.3 Record parent run + fork checkpoint metadata.
- [ ] 9.4 Add graph/run identity checks so edited graphs do not silently resume old runs.
- [ ] 9.5 Add project memory CRUD and pinned memory.
- [ ] 9.6 Add recent/pinned retrieval and context-budget accounting.
- [ ] 9.7 Add conversation summarization only when needed.
- [ ] 9.8 Add SQLite FTS only if simple retrieval is insufficient.
- [ ] 9.9 Add manual/cron/webhook/API triggers using one durable run-creation path.
- [ ] 9.10 Add trigger dedupe receipts and durable future `not_before` scheduling instead of long-lived timers.
- [ ] 9.11 Add authenticated external client/session ingress and safe wake/resume behavior.
- [ ] 9.12 Add Copycat/client bridge path.

---

## Phase 10 — MCP, custom-node SDK, trust tiers

- [ ] 10.1 Add plugin config and enable/disable list.
- [ ] 10.2 Add local folder/package plugin loading.
- [ ] 10.3 Add MCP client/config/discovery.
- [ ] 10.4 Translate MCP tool schemas into the normal tool/plugin registry rather than a separate tool engine.
- [ ] 10.5 Apply normal capability, approval, and tracing rules to MCP tools.
- [ ] 10.6 Add custom-node SDK around the frozen public contracts.
- [ ] 10.7 Add plugin/package manifests with integrity, license, minimum harness version, node list, and requested capabilities.
- [ ] 10.8 Keep installation separate from capability granting.
- [ ] 10.9 Add execution trust tiers: trusted in-process, process-isolated, optional WASI for untrusted portable compute.
- [ ] 10.10 Add WASI sandbox only after the capability broker is mature.
- [ ] 10.11 Add npm/Git plugin installation only after local loading is solid.

---

## Phase 11 — Packaging and optional scale-out

- [ ] 11.1 Add Windows-friendly install/start flow.
- [ ] 11.2 Add config wizard.
- [ ] 11.3 Add backup/export/import UI/CLI.
- [ ] 11.4 Add optional desktop shell only if it improves distribution.
- [ ] 11.5 Add graph/node semantic versioning and diff UX.
- [ ] 11.6 Add optional Postgres `RunStore` only when single-host limits are measured.
- [ ] 11.7 Add optional remote executor/workers without changing Graph JSON/IR.
- [ ] 11.8 Add stronger optional Linux sandbox adapters only for workloads that need them.
- [ ] 11.9 Add marketplace/signatures/revocation only after permissions, trust tiers, and package integrity are mature.

---

## Explicitly deferred from the default core

Do not add until a measured need exists:

```text
Redis
Kafka/message broker
required Postgres
required Docker/Kubernetes
vector DB dependency
arbitrary graph cycles
multi-agent framework
microservices
active-active multi-host scheduler
CRDT graph collaboration
automatic marketplace installs
microVM sandbox by default
```

---

## Next action

**1.5 — Add a generic typed registry primitive used by plugin-provided capabilities.**