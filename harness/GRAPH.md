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
Draft graph document
    ↓ validate
Semantic graph revision
    ↓ compile
Execution plan / IR
    ↓
Harness scheduler
    ├─ model plugin
    ├─ tool plugin
    ├─ transform/node plugin
    └─ subgraph
```

## Three graph representations

### 1. Draft document

UI/editor state. It may contain:

- node positions
- zoom/viewport
- comments
- collapsed panels
- temporary invalid wiring
- editor-only metadata

Changing layout must not change runtime semantics.

### 2. Semantic graph revision

Immutable, portable execution definition.

Store it as versioned canonical JSON. It contains only execution-relevant information:

- nodes
- typed ports
- data edges
- control edges
- node configuration
- required capabilities
- graph policies
- entrypoints / outputs

### 3. Compiled execution plan

Small normalized IR used by the scheduler. It resolves:

- port bindings
- executor IDs
- branch transitions
- loop boundaries
- joins
- retry / timeout policy
- required plugin capabilities

The compiler output is runtime data, not an editor format.

## Separate data and control edges

Do not make one arrow mean two things.

- **Data edge**: moves a typed value from an output port to an input port.
- **Control edge**: determines which node may execute next.

This makes conditionals, loops, joins, retries and debugging much easier to reason about.

## Initial node language

The first graph language should be deliberately small:

1. Input
2. Transform
3. Model Call
4. Conditional
5. Loop
6. Join
7. Tool Call
8. Subgraph
9. Output

No unrestricted Code node in the first version.

## Plugin-first node model

Graph nodes are another plugin surface.

A plugin may register a `GraphNodeType` describing:

```ts
interface GraphNodeType {
  type: string;
  version: number;
  title: string;
  inputs: PortDefinition[];
  outputs: PortDefinition[];
  configSchema: JsonSchema;
  requiredCapabilities?: string[];
  executor: string;
}
```

The core graph/compiler package does not import provider or tool implementations. It only resolves registered node types/executors through public registries.

Examples:

- OpenAI-compatible plugin registers a model-call executor/provider capability.
- native-tools plugin registers tool-call capabilities.
- ComfyUI plugin can register image/video generation nodes later.
- Blender plugin can register render/import/export nodes later.
- an MCP bridge can expose selected MCP tools as graph-callable nodes.

Disabled plugins contribute no active executors.

## Graph editor

Use **React Flow** as the preferred editor layer when we implement the graphical UI.

Important boundary:

> React Flow handles are UI objects. Harness ports are semantic objects.

React Flow must never become the persisted graph contract or execution engine.

To protect the lightweight base install:

- keep React Flow in the web/editor package only;
- lazy-load the graph editor route;
- the headless runtime must not depend on React Flow or DOM packages;
- a user who never opens/installs the visual editor pays no runtime cost in the harness daemon.

## Persistence

Canonical JSON is the public graph format.

Suggested minimal shape:

```json
{
  "schemaVersion": 1,
  "graphId": "example",
  "revisionId": "...",
  "nodes": [],
  "edges": [],
  "entrypoints": [],
  "outputs": [],
  "policies": {
    "maxNodeExecutions": 100,
    "maxParallelism": 4,
    "maxWallTimeMs": 300000
  }
}
```

The database stores drafts and immutable revisions, but saved graph meaning must not depend on a third-party framework's internal object model.

## Deterministic scheduler boundary

A Conditional node evaluates a harness-owned predicate/result and selects a declared edge.

A model-driven router is allowed only as an explicit model node with schema-constrained output, e.g.:

```json
{ "route": "research" }
```

The harness validates that value against the allowed routes and then selects the edge. The model never receives permission to jump to arbitrary node IDs.

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

## What we deliberately do not adopt from the research baseline

The research report recommends a production-heavy stack including FastAPI/Python, PostgreSQL, Temporal, WebSockets, Yjs and container/microVM infrastructure.

Those are useful references, not our baseline.

Zet Harness v1 stays:

- TypeScript / Node
- built-in `node:sqlite`
- HTTP + SSE
- one lightweight runtime daemon
- optional Next.js web UI
- in-process trusted plugins

Add Temporal/Postgres/Yjs/isolated workers only if concrete usage requires them.

## Implementation timing

Do **not** build the visual editor before the plugin host and deterministic run engine are stable.

Order:

```text
plugin kernel
→ persistence
→ model/tool registries
→ deterministic agent/run engine
→ graph schema/compiler
→ graph executor adapter
→ React Flow editor
```

This keeps graphical authoring as a powerful front-end to the harness rather than a second runtime competing with it.
