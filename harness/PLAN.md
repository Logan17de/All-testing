# Zet Harness — Master Plan

> **Authoritative roadmap.** This file replaces the older milestone ordering. Research reports are inputs, not architecture authority. `TODO.md` is the strict implementation checklist.

## 1. Product goal

Zet Harness is a **lightweight, local-first, provider-neutral AI workflow and agent runtime** with a very small core and a very wide plugin surface.

The three central rules are:

> **The model does not own workflow state. The harness does.**

> **The visual graph is source code. The Execution IR is the executable. The event journal is runtime truth.**

> **Built-ins and third-party extensions must enter through the same public registration path.**

The first useful product should run on one machine without requiring Redis, Postgres, Kafka, Docker, Kubernetes, a vector database, or a workflow control plane.

Default hard dependency floor:

```text
Node.js 24 LTS
+ SQLite via node:sqlite
+ filesystem
```

The web UI is a client. A long-lived Node runtime owns durable execution.

---

## 2. Current status

### Completed foundation

The following work is already implemented and verified:

| Original item | Status | Result |
|---|---:|---|
| 0.1 | ✅ | npm workspace layout created |
| 0.2 | ✅ | TypeScript, ESLint, Prettier, Vitest configuration |
| 0.3 | ✅ | minimal Next.js App Router web app |
| 0.4 | ✅ | `core`, `db`, `models`, `tools`, `shared` workspaces |
| 0.5 | ✅ | safe `.env.example` |
| 0.6 | ✅ | secret/runtime/build `.gitignore` rules |
| 0.7 | ✅ | `/api/health` |
| 0.8 | ✅ | startup smoke test |
| 0.9 | ✅ | workspace-owned TypeScript typechecking |
| 0.10 | ✅ | lockfile + Node/npm pins + engine strictness |
| 0.11 | ✅ | Linux + Windows CI |
| 0.12 | ✅ | tracked `data/` and `tests/` skeletons |
| 0.13 | ✅ | Next Core Web Vitals + type-aware TS linting |
| 0.16 | ✅ | unrelated research artifact removed |
| 0.22 | ✅ | runtime ownership decided: long-lived Node daemon |
| 3.0 | ✅ | durable agent loop location decided: runtime daemon |

Current CI verifies on **Ubuntu and Windows**:

```text
npm ci
→ typecheck
→ lint
→ format check
→ tests
→ startup smoke
→ build
```

### Immediate remaining foundation work

Before the new architecture work starts:

1. **0.14** add the project license.
2. **0.15** wire one internal package into the web app and prove workspace transpilation.

The old deferred health expansion, plugin smoke, and lightweight baseline are retained but moved to the phases where the runtime/plugin system actually exists.

---

## 3. Architecture after Research #4

Research #4 confirms the lightweight direction and improves the dependency order.

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

The compiler/runtime must not depend on React Flow. React Flow is only an editor implementation.

---

## 4. What we build ourselves

These are the product-defining pieces:

```text
Node/plugin contracts
Graph semantics
Semantic validator
Compiler
Execution IR
Scheduler
Persistence protocol
Permission broker
Replay/fork model
Observability model
```

Everything integration-specific should be an adapter/plugin where practical:

```text
OpenAI
OpenAI-compatible endpoints
llama.cpp
Ollama
vLLM
SGLang
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

## 5. Public contracts to freeze first

We must freeze these in dependency order before broad runtime implementation.

### 5.1 Plugin lifecycle

A tiny public `@zet-harness/plugin-api` package defines the stable extension boundary.

Conceptual lifecycle:

```text
load
→ activate(ctx)
→ register capabilities/services/nodes
→ run
→ dispose
```

Every registration must be tracked so unloading a plugin removes what it registered.

The plugin API should have no or near-zero runtime dependencies.

### 5.2 Universal node definition

The runtime should understand a small universal lifecycle instead of ten unrelated node engines.

Primitive behavior families:

```text
pure
 effect
control
interrupt
```

User-facing node families can map onto those primitives:

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

A node manifest must be inspectable without executing plugin code. It should carry schemas, version, capabilities, effect/recovery metadata, timeout/retry defaults, and execution mode.

### 5.3 Graph JSON v1

Graph JSON is the public, portable source format.

It contains semantic nodes, ports, edges, policies, versions, and configuration. UI-only metadata such as position, dimensions, selection, colors, and collapsed groups never becomes runtime semantics.

Graph sources may later come from:

```text
React Flow
JSON/YAML
CLI/SDK
AI-generated workflows
```

All sources compile to the same IR.

### 5.4 Execution IR v1

The IR is immutable after a run begins.

It records at minimum:

```text
IR version
graph/source hash
IR hash
compiler version
registry hash
pinned node versions
indexed operations
resolved bindings
dependencies
normalized policies
compiled capabilities
control-flow metadata
```

Resume requires a compatible plan identity; editing a graph creates a new graph version/fork rather than silently changing a running program.

---

## 6. Graph/compiler rules

Compilation fails before execution whenever the defect is statically knowable.

Validation layers:

```text
shape/schema
identity + versions
ports + bindings
types
reachability/liveness
control flow
permissions
side-effect/recovery policy
timeout/retry policy
secrets
resource limits
```

### Structured control flow

Do **not** allow arbitrary visual cycles in the first implementation.

Initial rule:

```text
DAG
+ router
+ activation-aware join
+ explicit bounded loop regions later
+ human interrupt
+ subgraph
```

Arbitrary strongly connected components are compile errors.

Every executable loop must have compiler-visible termination limits such as:

```text
maxIterations
maxModelCalls
maxToolCalls
maxTokens
maxEstimatedCost
maxWallTime
```

### Activation-aware joins

A join waits for branches that were actually activated, not every physical incoming edge.

Runtime control-edge state may be:

```text
unresolved
active
skipped
completed
```

This prevents conditional branches from deadlocking joins.

### Deterministic compilation

Canonicalization strips editor metadata, normalizes defaults, resolves node versions, orders maps deterministically, and hashes the result.

Acceptance property:

```text
same source + same registry/compiler
→ same canonical IR
→ same IR hash
```

---

## 7. Execution and recovery semantics

The scheduler is a small readiness-driven async engine.

```text
PENDING
→ READY
→ RUNNING
   ├→ COMPLETED
   ├→ SKIPPED
   ├→ WAITING
   ├→ RETRY_WAIT → READY
   ├→ FAILED
   └→ CANCELLED
```

Use native Promises and bounded semaphores. Do not add a queue service.

Use `AbortController` / `AbortSignal` for cooperative cancellation. Worker threads are for real CPU-heavy work, not every node.

### Side effects are first-class

The node contract must distinguish:

```text
determinism
external effect
idempotency
recovery policy
```

Exact enum names are frozen with the node contract, but the scheduler must be able to distinguish at least:

```text
pure/read/write
safe rerun/reuse/reconcile/manual
idempotent/non-idempotent
```

A retry attempt must reuse a stable logical effect/idempotency identity.

The harness must never claim exactly-once execution for arbitrary third-party side effects.

### Three different replay concepts

Do not collapse these into one "replay" button:

1. **Resume** — continue unfinished work using durable completed outputs.
2. **Recorded replay** — replay control logic while substituting recorded external/model/tool/human results.
3. **Fork** — create a new run from a prior checkpoint and deliberately execute downstream work again.

Historical runs remain immutable.

---

## 8. Persistence doctrine

Use Node 24 `node:sqlite` directly; no ORM initially.

Enable WAL and keep write transactions short.

Durable runtime data will include:

```text
graph/source versions
compiled plans
runs
node attempts
append-only durable events
checkpoints
approvals
projects/goals/todos
conversations/messages
artifact metadata
```

Large immutable values go to a filesystem content-addressed blob store:

```text
data/blobs/<prefix>/<sha256>
```

SQLite stores metadata and references rather than giant images/video/model outputs.

A node completion becomes runnable downstream **only after** its durable completion transaction commits.

The persistence layer sits behind narrow interfaces so a future Postgres/remote implementation does not change Graph JSON or IR semantics.

---

## 9. Observability doctrine

Durability events are also the source of audit/debug information.

Persist meaningful state transitions, not every streamed token.

Examples:

```text
run.created
run.started
run.waiting
run.resumed
run.completed
run.failed
node.ready
node.started
node.completed
node.failed
node.retry_scheduled
model.routed
model.completed
tool.requested
tool.completed
permission.denied
checkpoint.created
human.requested
human.responded
```

Fine-grained streaming is live/transient; durable history stores coalesced/summarized events.

Default logging must not store secrets or raw sensitive payloads.

---

## 10. Ordered milestones

### M0 — Foundation closeout — **IN PROGRESS**

Remaining:

- license
- one real workspace dependency wired into the web app

Exit:

```text
Linux + Windows CI green on final Phase 0 tree
```

### M1 — Plugin + Node Contract — **NOT STARTED**

Deliver:

- `@zet-harness/plugin-api`
- JSON value/schema/diagnostic primitives
- universal node manifest/definition
- plugin host lifecycle
- registry
- built-in and external/local plugin through the exact same path
- plugin smoke test in CI

Exit:

```text
one built-in node plugin
+
one local/external test plugin
→ identical registration/execution path
```

### M2 — Graph JSON + Compiler + IR — **NOT STARTED**

Deliver:

- Graph JSON v1 schema
- one deliberate JSON-schema validator dependency if needed (Ajv is the current candidate)
- semantic validation
- node/port diagnostics
- registry/version resolution
- control-flow analysis
- permission/effect analysis
- canonicalization
- Execution IR v1
- graph/IR/registry hashing
- deterministic compiler tests

Exit:

```text
invalid graphs fail deterministically with useful diagnostics
valid graph → stable canonical IR/hash
```

### M3 — In-memory DAG Scheduler — **NOT STARTED**

Deliver:

- ready queue
- bounded concurrency
- dependency tracking
- routers
- activation-aware joins
- cancellation
- timeouts
- retry scheduling
- typed runtime events
- deterministic mock-node stress tests

No SQLite is required to prove this milestone.

Exit:

```text
A→B→C
A→[B,C]→D
router→branch→join
cancel/timeout/retry
all pass offline
```

### M4 — Runtime Daemon + SQLite Durability — **NOT STARTED**

Deliver:

- `apps/runtime`
- loopback `node:http` API + SSE
- `node:sqlite`
- ordered migrations
- WAL
- run/node/event/checkpoint storage
- content-addressed blob store
- atomic completion transactions
- crash/resume reconstruction
- backup/restore
- runtime/database health checks
- fault-injection restart tests
- lightweight baseline measurement

Exit:

```text
kill runtime during execution
→ restart
→ committed work is reused
→ unfinished work is classified and resumed safely
```

### M5 — Effects + Permission Broker + Human Interrupts — **NOT STARTED**

Deliver:

- effect/idempotency/recovery policy enforcement
- stable logical idempotency IDs
- compile-time capability checks
- runtime capability broker
- secret references
- structured denial results
- approval records
- durable human interrupt/resume
- redaction
- loopback/origin protections

Exit:

```text
external write pauses/approves/executes
crash ambiguity is reconciled or surfaced for review
model cannot grant itself capabilities
```

### M6 — Model + Tool Adapters — **NOT STARTED**

Deliver:

- model adapter contract
- tool adapter contract
- scripted/mock adapter
- generic OpenAI-compatible adapter
- first-party OpenAI adapter where provider-specific behavior is needed
- capability-based model routing
- local endpoint path for llama.cpp/Ollama
- safe filesystem read tools
- controlled shell/Git tools
- provider usage/cost metadata

Later adapters such as vLLM/SGLang remain external integration work, not core runtime dependencies.

Exit:

```text
same graph
→ mock provider
→ cloud/OpenAI-compatible provider
→ local OpenAI-compatible endpoint
without core-code changes
```

### M7 — Visual Graph Editor + Run Inspector — **NOT STARTED**

Deliver:

- React Flow as UI-only dependency
- node palette
- schema-derived basic config forms
- ports/connections
- compile diagnostics overlays
- run button
- live graph status
- node inspector
- approval/resume UI

Exit:

```text
draw graph
→ compile
→ run
→ inspect every durable node transition
```

This is the first strong **Harness v0.1** product boundary when combined with M0–M6.

### M8 — Structured Loops, Subgraphs, Projects, Goals, Todos, Agent Mode — **NOT STARTED**

Deliver:

- bounded loop regions
- subgraph lowering/namespacing
- projects
- conversations + structured messages
- goals/todos
- deterministic next-todo selection
- context builder with hard budget hooks
- model-visible task actions
- bounded agent loop expressed through the same scheduler
- multi-step golden trace test

Exit:

```text
three-todo coding goal
→ model/tool loop
→ persistent progress
→ restart-safe completion
```

### M9 — Replay, Fork, Memory, Triggers, External Clients — **NOT STARTED**

Deliver:

- recorded replay
- checkpoint fork
- semantic run/graph diff foundations
- lightweight project memory
- SQLite FTS only if needed
- cron/webhook/API triggers
- trigger dedupe receipts
- authenticated external client sessions/events
- Copycat/client bridge path

### M10 — MCP + Custom Node SDK + Sandboxed Extensions — **NOT STARTED**

Deliver:

- MCP adapter
- local folder/package plugin loading
- custom-node SDK
- package manifests
- generated editor forms from schemas
- execution trust tiers
- optional WASI sandbox for untrusted portable compute

A plugin marketplace does **not** open before capability and sandbox foundations are mature.

### M11 — Packaging + Optional Scale-Out — **LATER**

Deliver when real usage demands it:

- Windows installer/start flow
- config wizard
- export/import/backup
- optional desktop shell
- optional Postgres `RunStore`
- optional remote executor/worker
- optional stronger Linux sandboxes
- marketplace/signatures/revocation

The same Graph JSON/IR must remain valid when these are added.

---

## 11. Lightweight budget

Before v0.1, measure the harness separately from model inference:

```text
runtime startup latency
idle RSS
compiler latency at 10/100/1000 nodes
scheduler overhead
SQLite commit latency
direct runtime dependency count
```

Do not optimize from vibes. Add a dependency only when it buys enough correctness or developer value to justify its installation/runtime cost.

Current policy:

```text
No Redis
No Kafka
No required Postgres
No required Docker
No ORM initially
No vector DB in core
No mandatory MCP
No general embedded eval
No arbitrary cycles initially
No multi-agent framework in core
No distributed scheduler in v0.1
```

---

## 12. Definition of v0.1 success

Zet Harness v0.1 succeeds when a user can:

1. launch it locally;
2. visually create or load a graph;
3. compile it into a stable IR;
4. run independent nodes concurrently;
5. call a mock, cloud, or local model through adapters;
6. call capability-gated tools;
7. pause for human approval;
8. kill/restart the runtime without losing committed work;
9. inspect what happened from durable events;
10. do all of the above with one runtime process, SQLite, and filesystem as the default infrastructure.

After v0.1, agent/project features build on the same execution engine rather than creating a second orchestration path.

---

## 13. Next action

The immediate next implementation item remains:

> **0.14 — Add the project `LICENSE`.**

Then finish 0.15 and begin M1: the public plugin/node contract.
