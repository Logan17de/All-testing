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

## Separate data and control edges

Do not make one arrow mean two things.

- **Data edge**: moves a typed value from an output port to an input port.
- **Control edge**: determines scheduling/control flow and carries no value.

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

## Graph JSON v1

`@zet-harness/graph` defines the portable source contract. The top-level shape is:

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
  "id": "control-a-b",
  "kind": "control",
  "from": { "nodeId": "a", "port": "success" },
  "to": { "nodeId": "b" }
}
```

Named control ports are reserved for later structured router/join/loop/human/subgraph semantics. Graph JSON v1 does not grant models arbitrary jump-to-node behavior.

### Policies and options

Graph-local policies may carry hard execution limits such as:

- maximum node executions;
- maximum parallelism;
- maximum wall time;
- capability allow/deny constraints.

The host/runtime may always impose stricter limits.

The initial options surface contains only a default entrypoint selection. Additional execution semantics should be added deliberately, not as an open bag of runtime flags.

### Editor-only metadata

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
