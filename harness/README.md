# Zet Harness

A lightweight, local-first, model-agnostic AI agent harness owned by us.

This project is intentionally separate from the existing DeepSeek Harness experiments under `llm/`. Those experiments remain useful reference implementations and provider bridges, but Zet Harness does not depend on DeepSeek Harness internally.

## Goal

Build one small persistent runtime that can sit between a user and multiple AI models, tools, plugins, memories, projects, goals, and long-running tasks.

The harness owns durable workflow state. Models and integrations are replaceable workers/extensions.

## v1 principles

1. **Lightweight core** — one Node.js process and one local SQLite file before any distributed machinery.
2. **Wide plugin door** — built-ins and third-party extensions use the same public registration APIs wherever practical.
3. **Local-first** — no Redis, Docker, database server, vector DB, or mandatory cloud service for the base install.
4. **Model-agnostic** — model providers register behind capability-aware contracts.
5. **Tool-agnostic** — native tools and plugin tools share the same execution, approval, and trace path.
6. **Persistent state** — goals, todos, runs, messages, tool calls, and memories survive restarts.
7. **Safe execution** — the harness enforces workspace boundaries and approval rules around model-requested actions.
8. **Observable** — important model/tool/state transitions are traceable.
9. **Lazy integrations** — disabled plugins should add effectively zero runtime work.
10. **Plain TypeScript first** — no agent framework, workflow engine, or multi-agent framework before the basic runtime works extremely well.

## Planned v1 stack

- Node.js 24 LTS
- TypeScript
- lightweight long-lived Node runtime daemon using built-in APIs where practical
- Next.js local web UI as a client of the runtime
- built-in `node:sqlite` + small SQL repository/migration layer
- tiny native plugin kernel
- portable Graph JSON compiled into immutable Execution IR
- framework-free async scheduler
- OpenAI-compatible model plugin first
- SSE for streamed events
- native files/shell/Git tools first
- optional MCP and external integrations through plugins later

The base runtime should not require Python, Docker, Redis, a native database addon, or a vector database.

## Plugin direction

The kernel owns only lifecycle/registration/configuration/security primitives. Plugins may eventually add:

- node definitions
- model providers
- tools
- auth/subscription providers
- services
- hooks/events
- memory providers
- settings
- API routes
- UI contributions
- external workers/event sources

A small public `@zet-harness/plugin-api` package keeps third-party plugins away from private core internals.

Trusted in-process plugins stay extremely cheap. A truly isolated plugin mode can be added later for untrusted/community extensions without forcing every plugin into a subprocess today.

## Execution doctrine

```text
Visual/JSON/SDK graph
        ↓
Graph JSON
        ↓
Validator + Compiler
        ↓
Execution IR
        ↓
Tiny Scheduler
        ↓
Runtime daemon
        ↓
SQLite journal + blob store
```

The visual/editor representation is source code, not runtime state. The scheduler executes immutable compiled semantics, and SQLite records what actually happened.

## Documentation

- [`PLAN.md`](./PLAN.md) — **authoritative master architecture and milestone roadmap**, including completed and remaining work.
- [`TODO.md`](./TODO.md) — strict implementation order; we complete these items one by one.
- [`LIGHTWEIGHT.md`](./LIGHTWEIGHT.md) — lightweight runtime profile.
- [`PLUGINS.md`](./PLUGINS.md) — plugin architecture and extension direction.
- [`RUNTIME.md`](./RUNTIME.md) — durable runtime ownership and process boundaries.
- [`GRAPH.md`](./GRAPH.md) — visual graph/source/IR design notes.
- [`GAPS.md`](./GAPS.md) — historical gap review and deferred decisions.
- Research reports — reference inputs only; accepted decisions are promoted into `PLAN.md`/`TODO.md`.

## Status

Phase 0 and Phase 1 are complete. Phase 2 is now in progress on `zet-harness-v1`:

```text
Phase 1 plugin + node contract  ✅ COMPLETE

2.1 graph workspace             ✅
2.2 Graph JSON v1               ✅
2.3 JSON Schema Draft 2020-12   ✅
2.4 Ajv boundary decision       ✅
2.5 shape/schema validation     ✅
2.6 semantic IDs/node resolution ✅
2.7 ports/cardinality/bindings  ✅
2.8 port compatibility           ✅
2.9 reachability/liveness        ✅
2.10 cycle/SCC rejection         ✅
2.11 structured control contracts ✅
2.12 compiler-visible loop bounds ▶ CURRENT
2.13+ compiler/IR                ⏳
```

The Graph JSON v1 freeze now includes:

```text
first-class node ports
document hash and semantic hash as separate domains
graph capability requests/self-restrictions, never self-grants
data edges = value + execution dependency
control edges = activation/ordering only
```

All public v1 `JsonSchema` surfaces use **JSON Schema Draft 2020-12**. JSON Schema is for shape/value validation; port compatibility remains a deliberately small deterministic Harness compiler rule rather than arbitrary schema implication.

Ajv is confined to `@zet-harness/graph` as an internal Draft 2020-12 shape/value engine. Ajv types and errors do not cross public contracts, and the scheduler/runtime do not depend on it.

`GRAPH_JSON_V1_SCHEMA` plus `validateGraphJsonV1Shape(value)` form the 2.5 outer gate: they accept `unknown` and establish only Graph JSON structure/local constraints. Semantic meaning and stable Harness diagnostics remain separate later passes.

The 2.6–2.7 semantic pass uses a registry-neutral `NodeManifestResolver`: semantic IDs are unique only within their own namespaces, every graph node resolves an exact pinned `type@version`, static node/port and graph-input references must exist, and required/single-vs-multiple input cardinality is enforced across bindings plus data edges. The pass is read-only and remains independent of private core registry implementations. 2.8 remains a separate compiler-facing compatibility stage: exact schemas, universal targets, same primitive types, impossible sources, and integer→number are the only accepted cases. Unsupported inference is rejected with an explicit compatibility diagnostic rather than guessed. 2.9 separately owns potential reachability/liveness, including impossible live sources. 2.10 separately rejects every executable SCC/self-loop across data and control edges. 2.11 reserves explicit manifest-level structured-control contracts for router, all-active join, loop, human interrupt, and subgraph, and validates named control ports without adding runtime behavior or IR lowering. Loop contracts do not override 2.10 cycle rejection. Compiler-visible executable loop bounds are 2.12.

Validation ownership is permanently separated:

```text
JSON Schema validation   = shape + local value constraints
Graph semantic validation = harness meaning
Port compatibility       = small deterministic rules only
Runtime validation       = execution-time conditions
```

Each concern stays at the narrowest layer that owns it. Static validation must not absorb runtime checks, and semantic validation must not become general-purpose JSON-Schema theorem proving.

Then:

```text
Graph JSON + compiler + Execution IR
→ in-memory scheduler
→ durable Node + SQLite runtime
```
