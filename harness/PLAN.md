# Zet Harness — Master Plan

> **Authoritative roadmap.** `TODO.md` is the strict item-by-item execution checklist. Research reports are inputs, not architecture authority.

## 1. Product goal

Zet Harness is a **lightweight, local-first, provider-neutral AI workflow and agent runtime** with a tiny core and a very wide plugin surface.

Three rules define the architecture:

> **The model does not own workflow state. The harness does.**

> **The visual graph is source code. Execution IR is the executable. Durable events are runtime truth.**

> **Built-ins and third-party extensions use the same public registration path.**

Default hard dependency floor:

```text
Node.js 24 LTS
+ node:sqlite
+ filesystem
```

No required Redis, Postgres, Kafka, Docker, Kubernetes, vector DB, or workflow control plane.

The web app is a client. A long-lived lightweight Node daemon owns execution, persistence, plugins, permissions, and events.

---

## 2. Where we are now

```text
Phase 0  Foundation                         ✅ COMPLETE
Phase 1  Plugin API + universal node      ✅ COMPLETE
           ├─ 1.1 plugin-api package       ✅
           ├─ 1.2 public primitives        ✅
           ├─ 1.3 plugin lifecycle         ✅
           ├─ 1.4 plugin host              ✅
           ├─ 1.5 typed registry            ✅
           ├─ 1.6 node contract             ✅
           ├─ 1.7 node schemas              ✅
           ├─ 1.8 behavior metadata          ✅
           ├─ 1.9 static manifest inspection  ✅
           ├─ 1.10 built-in/external parity    ✅
           ├─ 1.11 lifecycle/unload tests      ✅
           └─ 1.12 plugin smoke in CI          ✅
Phase 2  Graph JSON + compiler + IR        ✅ COMPLETE
           ├─ 2.1 graph workspace               ✅
           ├─ 2.2 Graph JSON v1                  ✅
           ├─ 2.3 JSON Schema Draft 2020-12         ✅
           ├─ 2.4 Ajv boundary decision              ✅
           ├─ 2.5 shape/schema validation             ✅
           ├─ 2.6 semantic IDs + node resolution       ✅
           ├─ 2.7 ports/cardinality/bindings          ✅
           ├─ 2.8 constrained port compatibility      ✅
           ├─ 2.9 reachability/liveness               ✅
           ├─ 2.10 arbitrary cycle/SCC rejection      ✅
           ├─ 2.11 structured control contracts       ✅
           ├─ 2.12 compiler-visible loop bounds       ✅
           ├─ 2.13 capability/policy validation        ✅
           ├─ 2.14 side-effect/retry/recovery validation ✅
           ├─ 2.15 secret-only enforcement              ✅
           ├─ 2.16 structured diagnostics                  ✅
           ├─ 2.17 normalization/version pins                 ✅
           ├─ 2.18 UI metadata stripping                      ✅
           ├─ 2.19 canonical source semantics                   ✅
           ├─ 2.20 Execution IR v1                              ✅
           ├─ 2.21 hashes/compiler identity                         ✅
           ├─ 2.22 DAG/router/join lowering                         ✅
           ├─ 2.23 canonical hash tests                              ✅
           ├─ 2.24 golden diagnostic tests                           ✅
           └─ 2.25 generated-graph compiler stress tests                  ✅
Phase 3  In-memory DAG scheduler           ✅ COMPLETE
           ├─ 3.1 op status state machine                              ✅
           ├─ 3.2 readiness queue + dependency counters                ✅
           ├─ 3.3 bounded global/per-run concurrency                   ✅
           ├─ 3.4 concurrent DAG branches                              ✅
           ├─ 3.5 router branch activation                             ✅
           ├─ 3.6 control-edge runtime states                          ✅
           ├─ 3.7 activation-aware all-active joins                    ✅
           ├─ 3.8 explicit any/quorum join semantics                   ✅
           ├─ 3.9 run cancellation with AbortController/AbortSignal    ✅
           ├─ 3.10 node timeouts                                       ✅
           ├─ 3.11 bounded retry scheduling                            ✅
           ├─ 3.12 adapter retry accounting                            ✅
           ├─ 3.13 typed runtime event emitter                         ✅
           ├─ 3.14 transient vs durable runtime events                 ✅
           ├─ 3.15 deterministic mock nodes/executors                  ✅
           ├─ 3.16 offline scheduler scenario tests                    ✅
           └─ 3.17 scheduler stress/race tests                         ✅
Phase 4  Runtime daemon + SQLite           🚧 WE ARE HERE
           ├─ 4.1 long-lived Node runtime process                     ✅
           ├─ 4.2 loopback node:http API                              ✅
           ├─ 4.3 SSE reconnect/cursor support                        ✅
           ├─ 4.4 node:sqlite database foundation                     ✅
           ├─ 4.5 ordered SQL migration runner                        ✅
           ├─ 4.6 foreign keys + WAL                                  ✅
           ├─ 4.7 durable graph/source + compiled-plan identity        ✅
           ├─ 4.8 runs + parent/fork metadata                          ✅
           ├─ 4.9 node attempts + effect/idempotency identity          ✅
           ├─ 4.10 append-only durable events + schema versions        ✅
           ├─ 4.11 sparse checkpoints/frontier state                   ✅
           ├─ 4.12 filesystem content-addressed blob store                 ✅
           ├─ 4.13 serialized short SQLite commit path                       ✅
           ├─ 4.14 atomic node completion/output/event commit                  ✅
           ├─ 4.15 durable completion gates downstream readiness              ✅
           ├─ 4.16 restart frontier reconstruction                            ✅
           ├─ 4.17 pre-crash recovery-policy classification                   ✅
           ├─ 4.18 SQLite/file-level backup + restore                          ✅
           ├─ 4.19 runtime/database health checks                              ✅
           ├─ 4.20 kill/restart fault-injection tests                          ▶ CURRENT
           ├─ 4.21 lightweight performance baseline                            ⏳
           └─ 4.22 CI baseline check                                            ⏳
Phase 5  Effects + permissions + humans    ⏳
Phase 6  Model + tool adapters             ⏳
Phase 7  Visual graph + inspector          ⏳  ← Harness v0.1 boundary
Phase 8  Loops + projects + agent mode     ⏳
Phase 9  Replay + memory + triggers        ⏳
Phase 10 MCP + custom-node SDK + trust     ⏳
Phase 11 Packaging + optional scale-out    ⏳
```

### Phase map

| Phase | What it means | Status |
|---|---|---|
| **0 — Foundation** | repo/workspaces, Next.js shell, TS/lint/test, health check, startup smoke, lockfile/toolchain pins, Linux+Windows CI, license, proven workspace wiring | ✅ Complete |
| **1 — Plugin API + universal node contract** | freeze the tiny public extension boundary, plugin lifecycle, registry, node manifests, built-in/external plugin parity | ✅ Complete |
| **2 — Graph JSON + Compiler + Execution IR** | define portable graph source, semantic validation, deterministic compilation, canonical hashes, compact immutable IR | ✅ Complete |
| **3 — In-memory DAG Scheduler** | readiness queue, bounded concurrency, routers, activation-aware joins, cancellation, timeout, retry, runtime events | ✅ Complete |
| **4 — Runtime daemon + SQLite durability** | long-lived Node runtime, HTTP/SSE, `node:sqlite`, WAL, events, checkpoints, blobs, crash recovery, lightweight baseline | 🚧 In progress — **4.20 current** |
| **5 — Effects + Permissions + Human interrupts** | effect/idempotency/recovery rules, capability broker, secrets, approvals, structured denials, durable pause/resume | ⏳ Planned |
| **6 — Model + Tool adapters** | mock provider, generic OpenAI-compatible model plugin, local endpoints, filesystem/shell/Git tools, routing and usage metadata | ⏳ Planned |
| **7 — Visual graph editor + Run inspector** | React Flow editor only, plugin node palette, compiler diagnostics, live graph status, detailed run inspector | ⏳ **v0.1 finish line** |
| **8 — Structured loops + Projects/Goals/Todos + Agent mode** | bounded loops/subgraphs, projects, conversations, goals/todos, context builder, autonomous model→tool→model loop | ⏳ After v0.1 |
| **9 — Replay/Fork + Memory + Triggers + External clients** | recorded replay, checkpoint forks, lightweight memory, cron/webhook/API triggers, Copycat/client bridge | ⏳ Later |
| **10 — MCP + Custom-node SDK + Trust tiers** | MCP through normal tool registry, local plugin loading, SDK/package manifests, process/WASI isolation options | ⏳ Later |
| **11 — Packaging + Optional scale-out** | Windows setup, config wizard, backup/import/export, optional desktop shell, optional Postgres/remote workers | ⏳ Later |

### What “done enough to use” means

The first strong product boundary is **end of Phase 7**:

```text
Graph editor
→ compile
→ Execution IR
→ concurrent scheduler
→ durable runtime
→ model/tool plugins
→ approvals
→ crash/restart recovery
→ full run inspection
```

Phases 8–11 add autonomous-agent/product features and scale without replacing that engine.

Current CI on Ubuntu and Windows verifies:

```text
npm ci
→ typecheck
→ lint
→ format check
→ tests
→ startup smoke
→ build
```

---

## 3. Core architecture

```text
Visual editor / JSON / SDK / AI-generated graph
                    │
                    ▼
              Graph JSON v1
                    │
                    ▼
          Validator + Compiler
                    │
                    ▼
       Immutable Execution IR v1
                    │
                    ▼
          In-memory DAG Scheduler
                    │
                    ▼
        Long-lived Node Runtime
             │            │
             ▼            ▼
        SQLite journal   Blob store
             │
             ▼
       HTTP + SSE clients
```

Plugins cut across the system through stable public contracts:

```text
Plugin Host
├── node definitions
├── model adapters
├── tool adapters
├── services
├── event listeners
└── optional UI contributions later
```

React Flow never becomes execution architecture. It is only an editor/view over Harness Graph JSON.

---

## 4. What stays in the tiny core

Build ourselves because these define the product:

```text
plugin/node contracts
Graph semantics
semantic validator
compiler
Execution IR
scheduler
persistence protocol
permission broker
replay/fork model
observability model
```

Keep integration-specific behavior behind plugins/adapters where practical:

```text
OpenAI / OpenAI-compatible
Qwen / vLLM / SGLang
llama.cpp / Ollama
MCP
GitHub
browser
ComfyUI
Blender
Supabase
Vercel
custom local tools
```

---

## 5. Public contracts first

### Plugin lifecycle

`@zet-harness/plugin-api` is intentionally tiny and has zero/near-zero runtime dependencies.

Conceptual lifecycle:

```text
load
→ activate(ctx)
→ tracked registrations
→ run
→ dispose
```

Unloading a plugin must cleanly remove what it registered. Cleanup is host-owned, runs in reverse registration order, and also applies to partial activation failures.

### Universal node definition

The scheduler should understand a small set of primitive behavior families:

```text
pure
effect
control
interrupt
```

User-visible node families map onto them:

```text
LLM        → effect
Tool       → effect
API        → effect
Memory     → effect
Code       → pure/effect
Condition  → pure/control
Router     → control
Join       → control
Loop       → control
Human      → interrupt
Subgraph   → compile-time structure
```

A node manifest carries versioned identity, input/config/output schemas, primitive family, determinism, effect/idempotency and recovery policy, timeout/retry defaults, execution mode, and required capabilities. `NodeCatalog` provides a manifest-only inspection path keyed by node type + version, proven not to invoke node executors. Built-in and dynamically imported external/local JavaScript plugins register through the same public `PluginContext.nodes` → `PluginHost` → `NodeCatalog` path with host-owned cleanup. Dedicated lifecycle tests now cover reverse cleanup, partial activation rollback, duplicate activation, unload idempotence, cleanup-error aggregation, in-flight activation protection, and closed activation contexts. A focused plugin smoke gate now runs explicitly in Linux and Windows CI. Phase 1 is complete; Phase 2 has frozen Graph JSON v1 plus JSON Schema Draft 2020-12 and is moving into the validator/compiler boundary.

---

## 6. Graph/compiler rules

Graph JSON is public source. Execution IR is immutable executable state for a run.

Compilation rejects statically knowable errors before execution:

```text
shape/schema
identity + versions
ports + bindings
types
reachability/liveness
control flow
permissions
effect/recovery policy
timeout/retry policy
secrets
resource limits
```

Permanent validation-ownership rule:

> **Validate each concern at the narrowest layer that actually owns it. Never promote a runtime concern into the schema validator, and never turn semantic validation into general-purpose schema reasoning.**

```text
JSON Schema validation  = shape + local value constraints
Graph semantic validation = harness meaning
Port compatibility      = small deterministic rules only
Runtime validation      = execution-time conditions
```

The compiler must not attempt arbitrary JSON-Schema implication/theorem proving. Port compatibility is intentionally constrained to explicit, deterministic relationships.

Initial control-flow rule:

```text
DAG
+ router
+ activation-aware join
+ explicit bounded loop regions later
+ human interrupt
+ subgraph
```

No arbitrary visual cycles initially. Every executable loop needs compiler-visible hard bounds. In Graph JSON v1, a node resolved to a structured loop contract must carry a per-invocation top-level `config.maxIterations` positive safe integer. This reserves a deterministic hard ceiling for later lowering/execution without weakening current SCC rejection. Capability/policy validation is a separate compile-time stage: node manifest requirements plus graph-required capability requests must be present in external compile authority, optional requests are opportunistic, and graph deny can only reduce authority. A loop bound greater than graph `maxNodeExecutions` is rejected as a statically known policy contradiction.

Source normalization begins only after those validation stages succeed. 2.17 materializes the closed Graph JSON v1 defaults (`required: false`, empty bindings/capability buckets/options), verifies exact resolved node identity, and records the active plugin id/version that registered each node. Plugin provenance is host registry metadata, not authority authored into Graph JSON. JSON Schema `default` annotations do not mutate executable config. 2.17 does not strip editor metadata or reorder source collections; those remain 2.18 and 2.19 respectively. 2.18 removes only the top-level Graph JSON `editor` bucket from compiler-facing source; human metadata, document identity, normalized fields, resolved pins, and source ordering remain intact. The stripping stage is pure and does not recursively delete config keys named `editor`. 2.19 projects the exact executable `GraphSemanticsV1` domain and canonicalizes it deterministically. Identity-addressed graph collections are sorted by stable id and capability buckets lexically; arbitrary JSON arrays and node binding order remain significant. Canonical JSON sorts object keys using lexical JavaScript string comparison while preserving array order and ECMAScript JSON primitive encoding. Graph/revision/human/editor identity and registry provenance remain outside the canonical semantic JSON. Resolved pins are sorted separately for later registry/compiler identity. No digest is computed in 2.19. 2.20 defines `harness.ir/v1` as compact immutable executable-plan state: op, graph-input, and entrypoint array positions are authoritative index domains; internal node/input references become numeric indexes; runtime-needed config/value sources/static behavior/policies remain; control edges and structured-control contracts have indexed/compact IR shapes ready for later lowering; compiler candidates are range-checked then structured-cloned and deeply frozen. Source schemas/metadata, capability grants, hash/compiler identity, and provenance pins stay outside this 2.20 core. No Graph-to-IR lowering happens here: 2.22 owns DAG dependencies plus router/join lowering. 2.21 records the compiler provenance/content identities with domain-separated SHA-256: exact normalized authoring document, canonical executable semantics, resolved node/plugin registry pins, and Execution IR each have independent hashes; compiler version is explicitly `harness.compiler/v1`; exact node/plugin pins are carried beside the hashes; and the implementation uses Web Crypto rather than adding a Node-only crypto import. Compiler version is not folded into the content hashes, preserving `semanticHash + registryHash + compilerVersion` as the deterministic compile identity. 2.23 now locks exact end-to-end canonical hash vectors for `harness.compiler/v1`. The fixture runs the real canonicalizer and 2.22 lowerer before recording identity, asserts fixed document/semantic/registry/IR SHA-256 outputs, recompiles cloned input to identical canonical IR and hashes, and verifies editor-only changes remain outside semantic/registry/IR identity. No production hash or lowering semantics changed in 2.23. 2.22 now deterministically lowers canonical Graph semantics into `harness.ir/v1`: canonical array order becomes the op/input/entrypoint index domains; data and control edges both produce predecessor dependencies; data edges also become resolved op-output value sources; duplicate predecessors are removed and sorted numerically; binding sequence is preserved before incoming canonical edge-id order; control edges retain named structured ports; router and join manifests become IR control descriptors; and runtime config/behavior/policies flow into the immutable IR. Resolver provenance must still match the exact 2.17/2.19 node/plugin pins or lowering fails as a compiler invariant. Loop, human-interrupt, and subgraph execution remains deferred. This is the first lowering semantics under `harness.compiler/v1`, so no compiler-version bump is required.

2.25 closes the Phase 2 compiler checkpoint with deterministic generated-graph stress coverage. Seeded DAG families exercise the complete validation/normalization/canonicalization/lowering/identity path, repeated compilation, source-collection permutation invariance, dependency/index invariants, and a 512-op mixed data/control graph without adding timing-based assertions or production semantics.

Deterministic acceptance property:

```text
same source + same registry/compiler
→ same canonical IR
→ same IR hash
```

---

## 7. Execution, durability, and recovery

Run-local operation states:

```text
PENDING → READY → RUNNING
                   ├→ COMPLETED
                   ├→ SKIPPED
                   ├→ WAITING
                   ├→ RETRY_WAIT → READY
                   ├→ FAILED
                   └→ CANCELLED
```

Use native Promises, bounded semaphores, and `AbortController`; no queue service by default.

Phase 3 timeouts are execution-local: `timeoutMs` starts only after scheduler concurrency admission, aborts the op's composed executor signal without aborting the whole run, marks the timed op failed, and releases no downstream dependency. If in-process work ignores its timeout signal, its concurrency permit remains charged until the underlying Promise really settles.

Phase 3 retry scheduling is scheduler-owned and bounded: failed attempts move through `running → retry-wait → ready`, backoff/jitter are deterministic injectable hooks, retry wait does not consume a concurrency permit, and downstream dependencies release only after eventual success. A timed-out in-process attempt that ignores cancellation must actually settle before its retry can start, preventing overlapping attempts of the same logical op. The IR `maxAttempts` value is now one shared outer + adapter/internal retry budget: each scheduler attempt consumes one unit, executor/adapters receive a frozen live `retryBudget` with `remainingAttempts`, and reported internal retries consume the same ceiling rather than multiplying it. Scheduler attempt numbering remains separate from combined budget usage for tracing. Invalid, stale, or over-budget internal retry reports fail atomically and are terminal scheduler-contract errors; they never trigger another outer retry.

Phase 3 runtime event transport is a tiny dependency-free synchronous typed emitter. It accepts discriminated event unions, supports type-narrowed listeners plus catch-all listeners, invokes matching subscriptions in global registration order, returns idempotent unsubscribe handles, and snapshots subscriptions at the start of each emit so listener mutation affects only later events. Listener errors are intentionally not swallowed. Runtime events that participate in the 3.14 routing contract carry an explicit `persistence: "transient" | "durable"` classification. `RuntimeEventChannels` exposes disjoint typed transient and durable listener APIs; a persistence consumer can subscribe only to durable event types, while token/progress-style transient events cannot enter that channel accidentally at the type level. The marker expresses retention intent only: `durable` means eligible for the later journal, not already persisted. The router does not serialize, sequence, replay, buffer, retain, write SQLite, or define SSE behavior; those remain Phase 4 responsibilities.

Phase 4 runtime ownership now has a real process and transport boundary. `apps/runtime` is a dependency-light long-lived Node process with explicit lifecycle and clean shutdown behavior. Its built-in `node:http` listener binds `127.0.0.1` by default, does not report `running`/ready until `listen()` succeeds, and exposes `GET /api/health` plus `GET /api/events`. The SSE transport uses a bounded in-memory replay stream with process-local monotonic IDs, live fan-out, `?cursor=N` and `Last-Event-ID` reconnect semantics, explicit `400` malformed-cursor and `409` unavailable-cursor responses, and clean client teardown during daemon shutdown. Cursorless clients begin live from the current stream head. These process-local IDs and replay buffers intentionally reset with the process and remain distinct from the migration-v4 durable event IDs; SSE is not yet backed by SQLite. Authentication/origin policy and database health remain later Phase 4 responsibilities. `@zet-harness/db` now provides the direct Node 24 `DatabaseSync` boundary with no ORM: it owns only open/close lifecycle, supports in-memory and file-backed paths, creates parent directories when needed, and exposes the live native connection only while open. The runtime opens SQLite before binding/announcing readiness and closes it after SSE/HTTP transport shutdown; failed HTTP startup closes the database again. The default file is `data/zet-harness.sqlite`, with `ZET_RUNTIME_DB_PATH` available for explicit override. Phase 4.6 makes the connection policy explicit: every opened database enforces foreign keys, file-backed databases must successfully enter WAL mode before the connection is exposed, and `:memory:` databases retain SQLite's `memory` journal mode because WAL is unavailable there. Phase 4.5 adds a code-owned ordered SQL migration runner over the live `DatabaseSync` connection. It creates only `schema_migrations(version, name, applied_at_ms)`, requires a strictly increasing positive safe-integer catalog, treats existing migration history as an exact prefix of the runtime catalog, and applies each pending migration plus its history row in one `BEGIN IMMEDIATE` transaction with rollback on failure. Runtime startup runs migrations before binding/announcing API readiness and closes SQLite again on migration failure. The default runtime migration catalog now includes the durable identity, run, node-attempt, event-journal, and sparse-checkpoint schemas through migration v5. `graph_sources` stores exact normalized authoring-document identity (`documentHash`) beside its executable `semanticHash`, graph/revision identity, normalized document JSON, and canonical semantic JSON. `compiled_plans` keeps the deterministic compile identity `semanticHash + registryHash + compilerVersion` separate from the content-only `irHash`, so identical IR bytes produced under different provenance do not collapse into one compiler identity. `graph_compilations` links exact source documents to compatible plans and carries `semanticHash` through composite foreign keys, preventing a document from being associated with a plan for different executable semantics. Multiple metadata/editor-distinct documents may intentionally share one plan when their semantic identity is unchanged. The database records compiler outputs only; it does not recompute hashes or reinterpret Graph JSON/IR. Phase 4.8 adds durable `runs` as migration v2. Each run binds `document_hash + compiled_plan_id` to the exact 4.7 source-to-plan association, carries a constrained materialized run status plus monotonic created/started/finished timestamps, and optionally points to a preserved parent run through a self foreign key. Root runs cannot carry fork metadata and self-parenting is rejected; descendants may carry nullable opaque `fork_metadata_json`; checkpoint/fork compatibility remains a later replay-layer concern rather than something the run table guesses. Parent lineage deliberately does not require a child to reuse the parent's compiled plan. Phase 4.9 adds migration v3 with separate logical invocation and concrete attempt records. `node_invocations` assigns each `(run_id, op_index, iteration)` one non-empty harness-owned `logical_effect_id`, unique within that run, while `node_attempts` records one-based attempt number, execution-only status (`running`, `completed`, `failed`, or `cancelled`), start/finish timing, opaque input/output references, structured error JSON, and usage JSON. A composite foreign key binds every concrete retry attempt back to the exact invocation plus logical effect ID, making retry-stable identity a relational invariant instead of a caller convention. Logical effect IDs are deliberately not globally unique across runs, so 4.9 does not pre-decide later replay/fork identity semantics. The storage layer also does not decide whether an external effect is safe to retry or whether the stable identity is passed to an integration as an idempotency key; Phase 5 owns those effect semantics. Phase 4.10 adds migration v4 with an append-only `durable_events` journal. SQLite assigns a global monotonic `event_id` that is the authoritative journal order and future durable cursor; `occurred_at_ms` is timeline metadata only and may move backward relative to commit order. Each event records its owning run, non-empty event type, an explicit positive `event_schema_version` independent of database migration versions, optional op/iteration/attempt scope, and opaque non-empty payload JSON. Run ownership is foreign-key constrained; attempt-scoped events additionally reference the exact durable node attempt, while op/iteration scope may exist without an attempt for scheduler states that never create executor attempts. SQLite triggers reject UPDATE and DELETE so committed event rows remain append-only. This item defines the storage envelope only: the scheduler's durable event channel is not yet wired to SQLite, SSE still uses its process-local stream, and node completion/output/event atomicity is provided by 4.14.

Phase 4.11 adds migration v5 with immutable sparse checkpoints anchored to an exact same-run durable event cursor. `run_checkpoints` records the run, `through_event_id`, checkpoint schema version, and creation time; a composite foreign key prevents a checkpoint from claiming another run's journal cursor. Child tables store only frontier state that differs from a fresh scheduler state derived from the run's immutable Execution IR: changed op/iteration state with remaining dependency count, scheduler attempts, shared retry-budget usage, deterministic FIFO `ready_order`, and absolute `retry_not_before_ms`; non-`unresolved` control-edge states; and explicit router branch selections. Router decisions are first-class because edge state alone cannot recover a valid selected branch that has no outgoing edges. Retry waits use an absolute not-before timestamp because an in-memory relative timer has no durable meaning after a crash. Checkpoints intentionally do not duplicate Execution IR, outputs, event history, concurrency permits, or process-local ready reservations. SQLite rejects mutation of checkpoint headers and child rows, while the DB deliberately does not parse IR or validate op/edge indexes and router branch names against compiled semantics; Phase 4.16 owns reconstruction-time validation and application of the sparse patch, followed by durable events strictly after the checkpoint cursor. Checkpoint creation is not yet wired into scheduler persistence; serialized write admission is provided by 4.13, node completion/output/event atomicity is provided by 4.14, and pre-crash running-node recovery classification remains 4.17.

Phase 4.12 adds a dependency-free filesystem content-addressed blob store in `@zet-harness/db` for large immutable values. Blob identity is canonical `sha256:<64 lowercase hex>` and maps to a sharded `<root>/sha256/<first-two-hex>/<remaining-hex>` path. `putStream` hashes incrementally while writing a private temp file, fsyncs the complete bytes, then publishes with an atomic no-overwrite hard link; concurrent writers of identical content converge on the same final blob without exposing partial data. Existing blobs are verified before reuse, and hash/size mismatches raise an integrity error rather than silently repairing or overwriting content. `putBytes`, `readBytes`, and explicit verification share the same canonical ID validation, so malformed IDs cannot become filesystem traversal paths. The blob store owns immutable bytes only: SQLite output-reference wiring and node completion transactions are handled by 4.14, serialized runtime SQLite writes use the 4.13 commit path, and retention/GC plus backup orchestration are intentionally deferred.

Phase 4.13 establishes one runtime durability commit path on `SqliteDatabase`. Async callers enqueue FIFO, but each admitted write executes as a synchronous short `BEGIN IMMEDIATE` transaction; commit callbacks cannot return promises, so SQLite locks are never intentionally held across awaits. Failure rolls back the active transaction without poisoning later queued writes, nested commit admission is rejected, and `close()` refuses to discard pending serialized writes; callers can await `drainWrites()` before shutdown. Startup migration transactions remain a deliberate pre-readiness bootstrap exception, and raw connection access remains available for reads/bootstrap rather than becoming a second runtime durability path. Phase 4.14 is the first concrete durability operation built on this path.

Phase 4.14 adds `commitDurableNodeCompletion(...)` as the first concrete user of the 4.13 serialized commit path. It updates exactly one currently-running durable attempt to `completed` with opaque output/usage refs and finish time, then appends the terminal durable event in the same transaction. Event scope is derived from the attempt identity rather than caller input. If either the attempt update or event insert fails, the whole transaction rolls back, so no completed attempt becomes visible without its terminal event. Blob publication and other async work happen before this short SQLite commit; the DB does not parse output-reference JSON or define terminal event taxonomy. No schema migration is required because the v3 attempt and v4 event invariants already express the relationship. Scheduler/downstream readiness is gated by 4.15.

Phase 4.15 adds an optional persistence-neutral `completionBarrier` to `PlainDagRun`. It runs only after executor success and after the scheduler closes that attempt's retry-budget scope, but before `completeRunningOp(...)` or any dependent-edge release. A durable runtime can therefore await the 4.14 atomic completion commit at this boundary: while the commit is pending the op remains scheduler-visible as `running` and every dependent remains blocked. Barrier rejection is terminal for the run, marks the still-running op failed, and deliberately bypasses ordinary executor retry scheduling even when retry budget remains, because successful external work must not be repeated merely because local durability failed. Cancellation during the barrier likewise prevents completion/dependency release. The scheduler still imports no SQLite or database package; 4.16 owns reconstructing this durable frontier after restart.

Phase 4.16 adds a read-only runtime `reconstructExecutionFrontier(...)` reducer. For a durable run it loads the stored compiled `harness.ir/v1`, derives fresh iteration-0 dependency/ready state, overlays the latest schema-v1 sparse checkpoint, then replays only recognized schema-v1 frontier events (`harness.frontier.op`, `harness.frontier.control-edge`, and `harness.frontier.router-selection`) after the checkpoint cursor in authoritative `event_id` order; unrelated durable events remain opaque and are ignored for reconstruction. The reducer validates op/control-edge indexes, dependency and retry accounting, ready-order uniqueness, absolute retry deadlines, and router selections against the immutable IR. Durable attempts still stored as `running` override stale ready/retry state and are excluded from the recovered ready queue while being surfaced separately as `preCrashRunningAttempts`. 4.16 deliberately does not choose rerun, reconcile, or terminal-failure behavior for those attempts; Phase 4.17 classifies them from each op's recovery policy. No database migration or DB-layer semantic parsing is added.

Phase 4.17 adds pure `classifyPreCrashRunningAttempts(...)` classification over the 4.16 reconstructed frontier. It consumes only the frozen Execution IR recovery policy: `rerun` is the sole immediately rerun-eligible action, while `reuse`, `reconcile`, and `manual` become explicit `hold-for-reuse`, `hold-for-reconciliation`, and `hold-for-manual-review` outcomes. A durable attempt still marked `running` has no committed terminal result, so `reuse` never silently promotes uncertain work to success. The classifier preserves op/iteration/attempt/logical-effect identity and rejects impossible missing-op, non-executable, `not-applicable`, unknown-policy, and duplicate-running-attempt states. It does not mutate scheduler state, write SQLite, spend retry budget, or re-derive effect/idempotency safety; compiler stage 2.14 remains authoritative for those cross-field promises, and the classifier itself does not execute the chosen recovery action.

Phase 4.18 adds a dependency-free durable backup bundle combining SQLite's native online backup with the immutable filesystem blob store. A backup is staged as a directory containing `database.sqlite`, `blobs/`, and a versioned `zet-harness.backup/v1` manifest recording creation time, database SHA-256/size, the blob algorithm, and verified blob count. The runtime first drains already-queued serialized writes, then SQLite owns database snapshot consistency; current cross-store capture remains safe because blob bytes are published before durable SQLite references, are immutable after publication, and are not garbage-collected yet. Only the canonical `sha256/` tree is copied, so in-flight root temp files are excluded, and every copied blob is verified by content address before the bundle is renamed into place. Restore verifies the manifest, database digest, `PRAGMA quick_check`, and every blob; it refuses overwrite/merge destinations, stages both stores, and publishes blobs before the SQLite file so a failed restore cannot expose a database that references missing restored bytes. Restore is an explicit clean-destination/offline operation. No schema migration, archive framework, or cloud dependency is added.

Phase 4.19 turns `GET /api/health` into a cheap daemon-owned readiness check rather than a static process response. `RuntimeDaemon` supplies a synchronous health provider while the `node:http` layer owns only transport and maps healthy reports to HTTP `200` and unhealthy reports to `503`. The probe requires the runtime lifecycle to be `running`, the owned SQLite connection to be open, a read-only `SELECT 1` to succeed, and the ordered `schema_migrations(version,name)` history to exactly match the code-owned runtime migration catalog. Provider exceptions become a stable sanitized unhealthy response instead of leaking internal database details. The request path intentionally performs no writes, `PRAGMA quick_check`/`integrity_check`, blob-tree scans, provider/network checks, or recovery work; deep SQLite/blob integrity remains the explicit backup/diagnostic boundary. No migration or dependency is added.

Phase 3 deterministic scheduler fixtures live behind the explicit `@zet-harness/scheduler/testing` subpath rather than the production scheduler export. Scheduler-level mock nodes are deterministic Execution IR ops, preserving the compiler/plugin boundary instead of inventing fake `NodeDefinition` semantics. The testing surface supplies minimal IR/op builders, clock-free manual gates, and a `DeterministicPlainDagExecutor` scripted by stable `sourceNodeId` and one-based scheduler attempt. It records frozen ordered invocation/trace snapshots, exposes actual/max concurrent mock executions, can complete/fail/wait on a gate/wait cooperatively for abort, and can report adapter-internal retries through the real shared retry budget. Unscripted nodes complete immediately; explicitly scripted nodes fail loudly if execution reaches an unconfigured attempt. These fixtures are infrastructure for 3.16/3.17, not the scenario/stress coverage itself.

Phase 3 offline scheduler scenarios compose those deterministic fixtures with the real scheduler primitives rather than introducing a separate acceptance runtime. Plain DAG coverage proves strict chain ordering, concurrent fan-out/fan-in, timeout isolation, bounded retry before downstream release, cooperative cancellation, and fail-fast propagation. Structured-control coverage composes `RunRouterActivation`, `RunControlEdges`, `RunJoinActivation`, and `RunReadiness` to prove selected-branch activation, inactive-path skipping, and an activation-aware `all-active` join. The suite uses no database, model provider, wall-clock sleeps, or random behavior; timeout timing is controlled with fake timers and concurrency is controlled by manual gates.

Phase 3 closes with deterministic stress/race coverage over the real scheduler: a 256-op seeded DAG verifies exactly-once scheduler admission under bounded concurrency, a 64-op retry storm verifies shared retry ceilings under pressure, 120 semaphore waiters exercise FIFO order while many are aborted, saturated cancellation proves queued permits are released, and two simultaneous runs prove the global ceiling remains hard across run boundaries. The suite also exposed and fixed a fail-fast admission race: when a run-local limit exceeded the global limit, siblings already queued for global capacity could start after another op had failed. `PlainDagRun` now owns a separate internal work-stop signal that aborts not-yet-admitted concurrency waits and retry waits on the first terminal scheduler failure without aborting the public run cancellation signal. Already executing in-process work remains cooperative and may settle normally. This preserves the failure/cancellation boundary while preventing post-failure admission.

Side effects are explicit. The contract distinguishes determinism, effect class, idempotency, retry defaults, and recovery policy. Compile-time validation keeps determinism separate from repeat safety: a deterministic external write is not automatically safe to retry, while a nondeterministic external read may still be side-effect-idempotent. Unknown-idempotency external writes cannot declare automatic retry beyond one attempt or automatic rerun recovery; idempotent/idempotency-key writes may declare controlled retries. Reconcile recovery is reserved for external writes, and compile-time/control nodes without executors cannot carry runtime retry/recovery defaults. Never claim exactly-once execution for arbitrary third-party effects. Secret-only inputs are also compile-time constrained: only opaque secret-reference bindings may target `secret: true`; literals, public graph inputs, and node data edges are rejected without inspecting or echoing secret material. Secret-provider resolution and authorization remain runtime concerns.

Keep three concepts separate:

1. **Resume** — continue unfinished work using committed outputs.
2. **Recorded replay** — replay with recorded external/model/tool/human results.
3. **Fork** — create a new run from a checkpoint and execute downstream work again.

Persistence uses `node:sqlite` directly with WAL and short writes. Large immutable values live in a content-addressed filesystem blob store. Downstream work becomes runnable only after the upstream durable completion transaction succeeds.

---

## 8. Lightweight budget

Before v0.1 measure:

```text
runtime startup latency
idle RSS
compiler latency at 10/100/1000 nodes
scheduler overhead
SQLite commit latency
direct runtime dependency count
```

Add dependencies only when measured correctness/developer value justifies their weight.

Explicitly deferred from the default core:

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

## 9. Definition of Harness v0.1

By the end of **Phase 7**, a user can:

1. launch Zet Harness locally;
2. visually create or load a graph;
3. compile it into deterministic IR;
4. run independent nodes concurrently;
5. call mock/cloud/local models through plugins;
6. call capability-gated tools;
7. pause for human approval;
8. kill/restart without losing committed work;
9. inspect durable execution history;
10. do this with one runtime process, SQLite, and filesystem as default infrastructure.

---

## 10. Next action

> **Phase 4 / Item 4.20 — Add random/fault-injection kill/restart tests around node and commit transitions.**