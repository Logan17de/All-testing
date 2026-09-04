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
2.12 compiler-visible loop bounds ✅
2.13 capability/policy validation ✅
2.14 side-effect/retry/recovery   ✅
2.15 secret-only enforcement       ✅
2.16 structured diagnostics         ✅
2.17 normalization/version pins       ✅
2.18 UI metadata stripping            ✅
2.19 canonical source semantics       ✅
2.20 Execution IR v1                  ✅
2.21 hashes/compiler identity         ✅
2.22 DAG/router/join lowering         ✅
2.23 canonical hash tests             ✅
2.24 golden diagnostic tests          ▶ CURRENT
2.25 compiler stress tests            ⏳
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

The 2.6–2.7 semantic pass uses a registry-neutral `NodeManifestResolver`: semantic IDs are unique only within their own namespaces, every graph node resolves an exact pinned `type@version`, static node/port and graph-input references must exist, and required/single-vs-multiple input cardinality is enforced across bindings plus data edges. The pass is read-only and remains independent of private core registry implementations. 2.8 remains a separate compiler-facing compatibility stage: exact schemas, universal targets, same primitive types, impossible sources, and integer→number are the only accepted cases. Unsupported inference is rejected with an explicit compatibility diagnostic rather than guessed. 2.9 separately owns potential reachability/liveness, including impossible live sources. 2.10 separately rejects every executable SCC/self-loop across data and control edges. 2.11 reserves explicit manifest-level structured-control contracts for router, all-active join, loop, human interrupt, and subgraph, and validates named control ports without adding runtime behavior or IR lowering. Loop contracts do not override 2.10 cycle rejection. 2.12 requires every structured loop invocation to carry a compiler-visible `config.maxIterations` positive safe integer. The bound is per invocation and does not make cycles executable. 2.13 separately validates capability/policy semantics: hard capability demand is graph `required` plus manifest `requiredCapabilities`; graph `optional` is opportunistic; graph `deny` only subtracts authority; and all requested authority is intersected with explicit external compile grants. Graph JSON never self-grants. Duplicate/cross-bucket capability intent is rejected, and a loop bound already exceeding graph `maxNodeExecutions` is rejected as a static policy contradiction. Runtime policy may always be stricter. 2.14 separately validates node side-effect/idempotency/retry/recovery consistency: determinism never grants retry safety, external reads must be side-effect-idempotent, external writes must explicitly declare idempotency, unknown-idempotency writes cannot auto-retry or recover by rerun, reconcile is reserved for external writes, compile-only nodes cannot carry runtime retry/recovery policy, and retry numeric bounds are validated without normalization. The Harness still never claims exactly-once execution for arbitrary external effects. 2.15 separately enforces secret-only input sources: an input declared `secret: true` may receive only an opaque `secret` binding; literal values, public graph inputs, and node data edges are rejected. The pass never scans ordinary values to guess secrets, never resolves secret references, and never echoes literal values or secret refs in diagnostics. Required/cardinality rules remain 2.7, while provider existence/authorization/resolution remain runtime concerns. 2.16 adds one stable compiler/editor diagnostic facade over the frozen validation stack. `checkGraphJsonV1Diagnostics` returns Harness-owned codes, safe messages, stage names, JSON Pointer source paths when one precise location exists, direct node/edge/entrypoint/graph-port references, and related node/edge sets for multi-object findings such as SCCs. Shape/Ajv failures are normalized before exposure, 2.6-2.7 now have structured semantic diagnostics, existing 2.8-2.15 diagnostic codes remain unchanged, and shape/semantic prerequisite failures short-circuit derivative stages to avoid diagnostic cascades. 2.17 begins source normalization after validation: `normalizeGraphJsonV1` materializes only closed Harness-owned defaults, records exact per-node node/plugin version pins plus deduplicated plugin pins, and requires plugin provenance supplied by the host registry. `PluginHost` attaches plugin id/version to `NodeCatalog` registrations internally without changing the public plugin registration API. JSON Schema `default` annotations are not applied to node config, source order is preserved for 2.19 canonicalization, and editor metadata remains present until 2.18. Normalization diagnostics extend the 2.16 contract with `stage: "normalization"`. No digest, hash, UI stripping, canonical ordering, or IR lowering is performed here. 2.18 then creates compiler-facing source with `stripGraphJsonV1UiMetadata`: it removes only the top-level semantically inert `editor` bucket while preserving graph/revision identity, human metadata, normalized executable fields, node/plugin pins, and source ordering. Editor-like keys inside node config are not recursively stripped. Inputs that differ only in editor state therefore produce identical 2.18 compiler source. 2.19 then projects exact `GraphSemanticsV1` and makes that executable source deterministic: `graphId`, `revisionId`, human metadata, and editor state are outside the semantic domain; identity-addressed graph collections are sorted by stable id; capability buckets are sorted lexically; arbitrary JSON arrays plus node binding sequence remain order-sensitive; and object keys use the Harness v1 canonical JSON serializer with lexical JavaScript string ordering. Resolved node/plugin pins are sorted separately for later registry identity and are not folded into `canonicalSemanticsJson`. 2.19 computes no hashes and lowers no IR. 2.20 now freezes the compact immutable `harness.ir/v1` contract: array position is the authoritative zero-based identity for ops, graph inputs, and entrypoints; graph node/input references inside execution data are resolved to numeric indexes; op-output, control-edge, graph-output, entrypoint, and default-entrypoint references are range-checked; dependency indexes must be strictly increasing, unique, and non-self; runtime-needed config, input sources, behavior, resource/capability intent, and structured-control descriptors remain; source schemas, graph/revision/human/editor metadata, external capability grants, hashes/compiler identity, and provenance pins are not copied into the 2.20 plan. `createExecutionIrV1` structured-clones and deeply freezes an internal compiler-produced candidate, so bad indexes are compiler invariant failures rather than new user-facing Graph diagnostics. 2.20 defines no Graph-to-IR lowering; 2.22 owns DAG/router/join lowering. 2.21 now records the independent compiler identity domains using domain-separated SHA-256 through Web Crypto: `documentHash` covers the complete 2.17 normalized authoring document including document/human/editor identity while canonical JSON removes object-key serialization noise; `semanticHash` hashes only 2.19 `canonicalSemanticsJson`; `registryHash` hashes the canonical resolved node/plugin pin snapshot; and `irHash` hashes only the 2.20 Execution IR content. The explicit compiler identity is `harness.compiler/v1`, recorded separately so the frozen compile formula remains `semanticHash + registryHash + compilerVersion → deterministic compile → canonical IR → irHash`. The identity record also carries immutable exact node/plugin pins. 2.23 now freezes exact end-to-end v1 digest vectors over the real normalized-source → UI-strip → canonical-semantics → 2.22 lowering → identity pipeline. The golden fixture locks document, semantic, registry, and IR SHA-256 values, proves repeated compilation produces byte-identical canonical semantics/IR/identity, and proves editor-only changes alter only document identity. These are contract tests rather than new production behavior: future canonical byte or lowering changes must be deliberate and must revisit compiler/hash-version compatibility. 2.22 now supplies the deterministic Graph-to-IR lowering step with `lowerCanonicalGraphJsonV1ToExecutionIr`: canonical node/input/entrypoint order defines numeric IR indexes; every data/control edge contributes a scheduler dependency; data edges additionally become `op-output` input sources; dependencies are deduplicated and numerically sorted; authored bindings stay first and incoming data-edge sources follow in canonical edge-id order; indexed control edges preserve structured port names; and router plus all-active join contracts become IR descriptors. Lowering re-resolves exact node/plugin provenance and treats any drift from the canonical pin snapshot as a compiler invariant failure rather than silently compiling against a different registry. Loop, human-interrupt, and subgraph descriptors remain reserved but are not lowered by 2.22. `harness.compiler/v1` remains the compiler behavior identity because 2.22 is its first lowering implementation, not a semantic change after v1 was established.

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
