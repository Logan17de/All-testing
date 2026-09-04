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
Phase 1  Plugin API + universal node      🚧 WE ARE HERE
           ├─ 1.1 plugin-api package       ✅
           ├─ 1.2 public primitives        ✅
           ├─ 1.3 plugin lifecycle         ✅
           ├─ 1.4 plugin host              ✅
           ├─ 1.5 typed registry            ✅
           ├─ 1.6 node contract             ✅
           └─ 1.7 node schemas              ▶ CURRENT
Phase 2  Graph JSON + compiler + IR        ⏳
Phase 3  In-memory DAG scheduler           ⏳
Phase 4  Runtime daemon + SQLite           ⏳
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
| **1 — Plugin API + universal node contract** | freeze the tiny public extension boundary, plugin lifecycle, registry, node manifests, built-in/external plugin parity | 🚧 In progress — **1.7 current** |
| **2 — Graph JSON + Compiler + Execution IR** | define portable graph source, semantic validation, deterministic compilation, canonical hashes, compact immutable IR | ⏳ Next architecture layer |
| **3 — In-memory DAG Scheduler** | readiness queue, bounded concurrency, routers, activation-aware joins, cancellation, timeout, retry, runtime events | ⏳ Planned |
| **4 — Runtime daemon + SQLite durability** | long-lived Node runtime, HTTP/SSE, `node:sqlite`, WAL, events, checkpoints, blobs, crash recovery, lightweight baseline | ⏳ Planned |
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

A node manifest must be inspectable without executing plugin code and eventually carries schemas, versions, capabilities, effect/recovery metadata, timeout/retry defaults, and execution mode.

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

Initial control-flow rule:

```text
DAG
+ router
+ activation-aware join
+ explicit bounded loop regions later
+ human interrupt
+ subgraph
```

No arbitrary visual cycles initially. Every executable loop needs compiler-visible hard bounds.

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

Side effects are explicit. The contract must distinguish determinism, effect class, idempotency, and recovery policy. Never claim exactly-once execution for arbitrary third-party effects.

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

> **Phase 1 / Item 1.7 — Include node input/config/output schemas in the manifest.**
