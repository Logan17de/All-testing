# Zet Harness — Visual Graph Architecture

This document distills the graphical-workflow research into a design that preserves Zet Harness's two hard constraints:

1. the runtime must stay lightweight;
2. the extension surface must stay wide enough for DeepSeek-Harness-style plugins.

## Core rule

The graph is **not** the runtime and the model does **not** decide how to follow it.

The user edits a graph. The harness validates and compiles that graph into a small execution plan. The scheduler owns control flow. A model node only receives the inputs/instructions for that node and returns a typed result.

```text
Graph editor
    ↓
Graph JSON source
    ↓ validate
Semantic graph revision
    ↓ compile
Execution IR
    ↓
Harness scheduler
    ├─ model plugin
    ├─ tool plugin
    ├─ transform/node plugin
    └─ subgraph
```

## Three graph representations

### 1. Source/editor document

Portable Graph JSON plus optional editor-only state. It may contain:

- node positions
- zoom/viewport
- comments/annotations
- collapsed panels
- editor-only metadata

Changing layout must not change runtime semantics.

### 2. Semantic graph revision

Immutable, portable execution definition produced after validation/normalization.

It contains only execution-relevant information:

- pinned node types/versions
- public graph inputs/outputs
- node configuration
- literal/graph-input/secret bindings
- data edges
- control edges
- graph policies/options
- entrypoints

### 3. Compiled Execution IR

Small normalized IR used by the scheduler. It eventually resolves:

- port bindings
- executor identities
- branch transitions
- structured control regions
- joins
- retry/timeout policy
- required plugin capabilities

The compiler output is runtime data, not an editor format.

## First-class node ports

Graph JSON names ports explicitly, so node manifests must expose those ports explicitly too. The compiler must never infer a port model by reverse-engineering arbitrary object-shaped JSON Schema.

The public node contract therefore has compiler-readable input/output maps:

```ts
interface NodeInputPort {
  schema: JsonSchema;
  required?: boolean;
  multiple?: boolean;
  secret?: boolean;
}

interface NodeOutputPort {
  schema: JsonSchema;
  required?: boolean;
}

interface NodeManifest {
  type: NodeType;
  version: Version;
  title: string;
  inputs: Readonly<Record<string, NodeInputPort>>;
  outputs: Readonly<Record<string, NodeOutputPort>>;
  configSchema: JsonSchema;
  behavior: NodeBehavior;
}
```

`multiple` is input connection/binding cardinality metadata. The 2.7 semantic pass enforces it deterministically across both non-edge bindings and incoming data edges.

A secret-only input such as:

```ts
apiKey: {
  schema: { type: "string" },
  required: true,
  secret: true
}
```

must eventually reject literal, public graph-input, and node-data-edge bindings. Only an opaque secret reference may bind it. Secret material itself never belongs in Graph JSON.

## Separate data and control edges

Do not make one arrow mean two things, but also do not require two arrows for ordinary value flow.

- **Data edge**: moves a typed value **and creates an execution dependency**. The target cannot consume that input before the source produces it.
- **Control edge**: adds ordering/activation semantics without carrying a value.

Therefore this is enough for an ordinary pipeline:

```text
A.response ──data──> B.prompt
```

There is no duplicate `A ─control→ B` requirement.

Control edges are reserved for things such as:

- router/conditional activation;
- joins;
- human approval/interrupt flow;
- ordering where no data moves.

Node-to-node values are expressed only with data edges. Node input `bindings` are reserved for literals, public graph inputs, and secret references. This prevents two competing representations of the same dependency.

## Plugin-first node model

Graph nodes resolve against the universal public `NodeManifest`/`NodeDefinition` contract from `@zet-harness/plugin-api`.

The graph package stores only a pinned node `type` + `version` and source configuration/bindings. It does not import provider/tool implementations.

Examples:

- an OpenAI-compatible plugin can register model-call nodes;
- native tools can register filesystem/shell/Git nodes;
- ComfyUI can register image/video generation nodes later;
- Blender can register render/import/export nodes later;
- an MCP bridge can expose selected tools as graph-callable nodes later.

Disabled plugins contribute no active definitions/executors.

## Public JSON Schema dialect

Zet Harness v1 uses **JSON Schema Draft 2020-12** for every public schema surface. The public plugin API exports the canonical dialect URI:

```ts
JSON_SCHEMA_DIALECT_URI = "https://json-schema.org/draft/2020-12/schema"
```

This single dialect applies to:

- node input-port schemas;
- node output-port schemas;
- node config schemas;
- graph public input schemas;
- graph public output schemas.

V1 does not negotiate or mix schema dialects per plugin, node, port, or graph field. JSON Schema is used for **shape/value validation**. Port-to-port compatibility remains a separate Harness compiler rule with a deliberately small, deterministic compatibility model; the compiler must not attempt arbitrary JSON-Schema implication/theorem proving.

Validator implementation is an internal graph-package choice and must never leak into scheduler/runtime semantics.

### Validation ownership rule

> **Validate each concern at the narrowest layer that actually owns it. Never promote a runtime concern into the schema validator, and never turn semantic validation into general-purpose schema reasoning.**

```text
JSON Schema validation
= shape + local value constraints

Graph semantic validation
= harness meaning

Port compatibility
= small deterministic rules only

Runtime validation
= actual execution-time conditions
```

Examples:

- JSON Schema may require a timeout value to be a positive integer.
- Semantic validation checks that referenced node IDs, versions, ports, entrypoints, and graph relationships exist and are meaningful.
- Port compatibility checks only explicitly supported relationships such as exact or known-safe primitive compatibility. It does not try to prove that arbitrary schema A mathematically implies schema B.
- Runtime validation checks facts that cannot be established statically, such as whether a secret resolves or an external endpoint is reachable.

This boundary keeps diagnostics explainable, the compiler deterministic, and the default dependency/runtime surface small.

### Ajv boundary decision

Zet Harness v1 uses **Ajv 8.20.0** as the internal Draft 2020-12 engine for graph-package shape/value validation.

The dependency boundary is intentionally narrow:

```text
@zet-harness/plugin-api
  exposes JsonSchema only

@zet-harness/graph
  owns Ajv internally
  ↓
  shape/value validation
  ↓
  Harness diagnostics

scheduler/runtime/port compatibility
  do not depend on Ajv
```

The internal engine is created with strict schema checking, all-errors collection, and format assertions disabled. Draft 2020-12 treats formats as annotations unless an assertion vocabulary is deliberately enabled, so v1 does not add `ajv-formats` without a concrete product need.

### Graph JSON v1 shape validator

`@zet-harness/graph` exports the Draft 2020-12 `GRAPH_JSON_V1_SCHEMA` plus `validateGraphJsonV1Shape(value)`. The validator accepts `unknown` and narrows it to `GraphJsonV1` only when the portable document structure and local value constraints are valid.

This pass intentionally does **not** reject duplicate IDs, unresolved node references, nonexistent ports, incompatible connections, cycles, or policy semantics. Those belong to later semantic passes. Ajv error objects also remain private implementation details here; stable Harness diagnostics are introduced separately in item 2.16.

### Graph JSON v1 semantic validator

`validateGraphJsonV1Semantics(graph, resolver)` owns the narrow 2.6–2.7 semantic layer. IDs must be unique inside each semantic namespace (`inputs`, `outputs`, `nodes`, `edges`, and `entrypoints`), every node must resolve an exact pinned `type@version`, graph outputs/data edges/bindings must reference existing declared ports or public graph inputs, entrypoint references must resolve, and `options.defaultEntrypoint` must name an existing entrypoint. IDs are not globally unique across namespaces.

For each manifest input, 2.7 counts all non-edge bindings plus incoming data edges as input sources. `required: true` requires at least one source; ports without `multiple: true` reject more than one source. Multiple-input ports may accept more than one source. The validator is read-only and never normalizes or rewrites Graph JSON.

The resolver remains a small structural `NodeManifestResolver` interface rather than a dependency on `packages/core`, so the graph/compiler package stays registry-implementation-neutral.

### Graph JSON v1 port compatibility

2.8 is a separate compiler-facing stage/API and is not merged into the 2.6–2.7 semantic validator. Its v1 rules are intentionally closed: exact schema equality, an impossible (`false`) source, a universal target, the same explicitly declared primitive type into an unconstrained target, and `integer` → `number`. Anything requiring JSON-Schema implication reasoning — including `enum`, numeric/string constraints, `allOf`, `$ref`, or constrained targets — is rejected as `GRAPH_PORT_COMPATIBILITY_UNSUPPORTED` unless the schemas are exactly equal. Unknown compatibility is never silently accepted.

An impossible (`false`) source is mathematically compatible with any target, but that says nothing about whether the producer can ever yield a live value. Reachability/liveness owns that question in 2.9; compatibility must not hide or absorb it.

### Graph JSON v1 reachability/liveness

2.9 is a separate potential-reachability/liveness stage. Starting from declared entrypoints, both data and control edges contribute directed potential reachability. It rejects unreachable nodes/outputs and live value flows backed by literal `false` source schemas. It deliberately does not interpret control-port names, branch satisfiability, or structured loop semantics.

### Graph JSON v1 acyclicity

2.10 is a separate acyclicity stage over the executable dependency graph. Both data and control edges participate. Every strongly connected component with more than one node is rejected, as is any one-node self-loop. No control-port name, node family, or loop-looking marker grants an exception in the initial executable graph. SCC diagnostics are deterministic in graph source order, and the implementation uses iterative traversal rather than recursive DFS.

### Graph JSON v1 structured control contracts

2.11 reserves structured control semantics statically on `NodeManifest.control`, not in arbitrary node config. The closed v1 contract kinds are `router`, `join`, `loop`, `human-interrupt`, and `subgraph`. Router contracts declare one entry plus named branch outputs. Join contracts declare named incoming lanes, one output, and only `all-active` mode; `any` and quorum semantics are not part of 2.11. Loop contracts reserve `entry`, `continue`, `body`, and `exit` ports only. Human-interrupt contracts reserve one entry and named resume outcomes. Subgraph contracts reserve one entry and named exits.

`checkGraphJsonV1StructuredControl(graph, resolver)` validates those static declarations and their use by control edges/entrypoints. Structured endpoints require explicit declared control ports. Ordinary nodes may still use unported control edges for generic ordering/activation, but arbitrary named control ports on ordinary nodes are rejected. Structured control nodes use primitive family `control`, except human interrupts which use `interrupt`.

This stage is reservation/validation only: it does not choose router branches, execute joins, run loops, suspend/resume humans, invoke subgraphs, or lower structured control into IR. A loop contract does not make a graph cycle legal; 2.10 continues to reject SCCs/self-loops.

### Graph JSON v1 compiler-visible loop bounds

2.12 is a separate static stage. Every graph node whose resolved manifest declares `control.kind === "loop"` must carry a top-level `config.maxIterations` value. The value is per node invocation and must be a positive JavaScript safe integer. Missing bounds fail as `GRAPH_LOOP_BOUND_REQUIRED`; malformed bounds fail as `GRAPH_LOOP_BOUND_INVALID`. Unresolved node manifests fail the stage prerequisite explicitly.

The `maxIterations` key has Harness loop meaning only for nodes resolved to a structured loop contract; ordinary node configuration may use the same text without becoming a loop. The fixed top-level location keeps the future compiler deterministic and avoids JSONPath/dynamic-expression inference. 2.12 does not execute loops, interpret stop conditions, lower loop regions into IR, or compare the local bound with graph resource limits. A valid bound still does not legalize a cycle: 2.10 continues to reject every SCC/self-loop until executable loop lowering lands later.

### Graph JSON v1 capability/policy validation

2.13 is a separate compile-time stage with explicit external authority input. Hard capability demand is the union of graph `capabilities.required` and every resolved node manifest's `behavior.requiredCapabilities`. Graph `capabilities.optional` is opportunistic and does not fail compilation merely because a grant is absent. Graph `capabilities.deny` is a self-restriction only: it can remove authority but can never add it. Duplicate entries inside a capability bucket and capabilities declared across multiple graph intent buckets are rejected rather than normalized silently.

Effective compile-time authority is requested hard/optional capability intent intersected with external grants, minus graph self-denials. A graph-required or node-required capability that is absent externally fails compilation; a self-denied hard requirement also fails. Unrequested external grants do not become graph effective capabilities merely because the compiler context has them. The host/runtime may always impose stricter policy later.

2.13 also performs the first deliberately narrow resource-policy cross-check promised by 2.12: when `policies.maxNodeExecutions` exists, a valid structured-loop `config.maxIterations` greater than that ceiling is rejected because the graph already contradicts its own hard execution budget. No scheduler accounting, wall-time prediction, or parallelism simulation is attempted here.

### Graph JSON v1 side-effect/retry/recovery validation

2.14 is a separate compile-time stage over resolved `NodeManifest.behavior`. Effect class and primitive family must agree: `effect: none` cannot masquerade as an effect-family operation, while `external-read`/`external-write` require the effect primitive family and a runtime execution mode. No-effect nodes use `idempotency: not-applicable`; external reads are treated as side-effect-idempotent even when their returned data is nondeterministic; external writes must explicitly declare `idempotent`, `idempotency-key`, or `unknown`.

Determinism and repeat safety are intentionally independent. A deterministic external write with unknown idempotency is still unsafe to repeat. If an external write declares `idempotency: unknown`, automatic retry beyond one attempt is rejected and `recovery: rerun` is rejected. `reconcile` recovery is meaningful only for external writes. Nodes with `executionMode: none` must use `recovery: not-applicable` and cannot declare runtime retry defaults; executable nodes must declare a non-`not-applicable` recovery policy. Retry `maxAttempts` must be a positive safe integer and optional `backoffMs` a non-negative safe integer.

This stage validates manifest promises only. It does not execute retries, generate idempotency keys, reconcile external systems, decide durable resume state, or claim exactly-once behavior. Those runtime mechanics remain later phases.

### Graph JSON v1 secret-only binding validation

2.15 is a separate compile-time stage over resolved input-port contracts. A node input marked `secret: true` may receive only a `kind: "secret"` binding carrying an opaque `secretRef`. Literal bindings, public `graph-input` forwarding, and node data edges into that port are rejected as `GRAPH_SECRET_REFERENCE_REQUIRED`. Missing node manifests are reported as a stage prerequisite failure.

The rule is contract-driven, not heuristic: the compiler does not scan strings or ordinary inputs to decide whether something looks secret, and an opaque secret reference may still be supplied to an ordinary non-secret input when a graph author chooses that source form. The stage never resolves a secret provider and never includes literal values or `secretRef` contents in its diagnostics. Required-input/cardinality and unknown-port validation remain owned by 2.7; secret-provider existence, authorization, retrieval, redaction, and runtime use remain later security/runtime concerns.

2.15 is validation only. It does not normalize, redact, encrypt, materialize, or persist secret values. Generalized stable diagnostics with common node/edge/path locations remain 2.16.

Ajv error objects are not part of any public contract. Stable Harness-owned diagnostics are introduced in item 2.16. Replacing Ajv later must not require changing Graph JSON, plugin manifests, compiler semantics, scheduler behavior, or runtime records.

## Graph JSON v1

`@zet-harness/graph` defines the portable source contract. The implementation lives in `packages/graph/src/graph-json-v1.ts` and is re-exported from the package entrypoint.

The top-level shape is:

```json
{
  "schemaVersion": 1,
  "graphId": "example",
  "revisionId": "rev-001",
  "metadata": {},
  "inputs": [],
  "outputs": [],
  "nodes": [],
  "edges": [],
  "entrypoints": [],
  "policies": {},
  "options": {},
  "editor": {}
}
```

### Nodes

Every node invocation pins the plugin-defined identity it was authored against:

```json
{
  "id": "summarize",
  "type": "provider.model.summarize",
  "version": "1.2.0",
  "config": {},
  "bindings": []
}
```

Node versions are never implicit in Graph JSON v1.

### Bindings

Non-edge node inputs use explicit tagged bindings:

```text
literal      → JSON value embedded in the graph
graph-input  → public graph input
secret       → opaque secret reference only
```

Secret material itself must never be embedded in the graph source.

### Edges

Edges are tagged and semantically separate:

```json
{
  "id": "data-a-b",
  "kind": "data",
  "from": { "nodeId": "a", "port": "result" },
  "to": { "nodeId": "b", "port": "input" }
}
```

```json
{
  "id": "control-b-audit",
  "kind": "control",
  "from": { "nodeId": "b", "port": "success" },
  "to": { "nodeId": "audit" }
}
```

Named control ports are reserved for later structured router/join/loop/human/subgraph semantics. Graph JSON v1 does not grant models arbitrary jump-to-node behavior.

## Capability semantics: request, never grant

A graph document may be untrusted, so Graph JSON can **request authority but cannot grant itself authority**.

Graph capability intent is:

```ts
interface GraphCapabilityIntentV1 {
  required?: CapabilityId[];
  optional?: CapabilityId[];
  deny?: CapabilityId[];
}
```

Semantics:

```text
graph required + node manifest hard requirements
                + graph optional requests
                          ∩
              external compile grants
                          −
                 graph self-deny
                          ↓
                 effective authority
```

Graph `required` means compilation must fail if the external authority is unavailable. Node manifest `requiredCapabilities` are hard requirements even if the graph omits them. Graph `optional` may be used only when externally granted. Graph `deny` is a self-restriction and can only reduce authority; denying a hard node/graph requirement makes the graph invalid.

There is deliberately no graph-level `allow` field that grants power.

The host/runtime may always impose stricter policy.

## Document hash, semantic hash, and IR hash

Executable identity must not change because somebody dragged a box around or renamed a workflow.

Graph JSON therefore defines two source hash domains:

### Document hash

Covers the canonical normalized authoring document, including:

```text
graphId
revisionId
metadata
editor state
semantic source
```

This identifies an exact saved document/revision.

### Semantic hash

Covers only the canonical normalized `GraphSemanticsV1` projection:

```text
schemaVersion
public inputs/outputs
pinned nodes + configs + bindings
data/control edges
entrypoints
execution policies
execution options
```

It explicitly excludes:

```text
graphId
revisionId
title/description/labels
editor positions/viewport/annotations
```

Therefore moving a node 30 pixels or saving the same behavior under another revision does not change executable identity.

The deterministic compile identity is:

```text
semanticHash + registryHash + compilerVersion
                    ↓
            deterministic compile
                    ↓
              canonical IR
```

The canonical IR then receives its **own content hash** (`irHash`). This keeps the IR hash about IR content while still recording the semantic source, registry, and compiler provenance separately.

Actual canonicalization/hash computation lands later in Phase 2; this section freezes which fields belong to each domain now.

## Policies and options

Graph-local policies may carry hard execution limits such as:

- maximum node executions;
- maximum parallelism;
- maximum wall time;
- capability requests/self-restrictions.

The initial options surface contains only a default entrypoint selection. Additional execution semantics should be added deliberately, not as an open bag of runtime flags.

## Editor-only metadata

All authoring/layout state lives under the top-level `editor` bucket:

- viewport;
- node positions/collapse state;
- annotations;
- optional JSON editor data.

The compiler must discard this entire bucket before creating immutable execution semantics. React Flow objects are never persisted directly as the public graph contract.

## Graph editor

Use **React Flow** as the preferred editor layer when we implement the graphical UI.

Important boundary:

> React Flow handles are UI objects. Harness ports are semantic objects.

To protect the lightweight base install:

- keep React Flow in the web/editor package only;
- lazy-load the graph editor route;
- the headless runtime must not depend on React Flow or DOM packages;
- users who never open the visual editor pay no runtime cost in the daemon.

## Deterministic scheduler boundary

A Conditional/router node eventually evaluates a harness-owned or schema-constrained result and selects only a declared control edge.

A model-driven router may produce something like:

```json
{ "route": "research" }
```

The harness validates that value against declared routes and chooses the matching edge. The model never receives permission to jump to arbitrary node IDs.

## Execution and debugging

Every node execution should eventually expose:

- node ID
- status
- attempt
- compiled inputs
- request/prompt preview where safe
- output
- selected control edge
- state diff
- start/end/duration
- retry history
- artifacts
- trace/event IDs

Graph runs use the same durable event stream as ordinary agent runs.

## Lightweight boundary

Zet Harness v1 stays:

- TypeScript / Node
- built-in `node:sqlite`
- HTTP + SSE
- one lightweight runtime daemon
- optional Next.js web UI
- in-process trusted plugins by default

Add heavier infrastructure only when concrete usage requires it.

## Implementation order

```text
plugin + node contract
→ Graph JSON source contract
→ semantic validator + compiler + Execution IR
→ in-memory scheduler
→ durable runtime
→ visual editor
```

This keeps graphical authoring as a front-end to one deterministic harness runtime rather than creating a second execution engine.
