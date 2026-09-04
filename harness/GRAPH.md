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

`multiple` is input connection/binding cardinality metadata. Its deterministic aggregation behavior is enforced when port/cardinality validation lands.

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
graph required/optional requests
        ∩
user/project/runtime grants
        −
graph self-deny
        ↓
effective authority
```

`required` means compilation/execution must fail if the external authority is unavailable. `optional` may be used only when externally granted. `deny` is a graph self-restriction and can only reduce authority.

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
