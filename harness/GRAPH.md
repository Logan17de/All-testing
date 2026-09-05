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

2.15 is validation only. It does not normalize, redact, encrypt, materialize, or persist secret values.

### Graph JSON v1 structured diagnostics

2.16 introduces the stable compiler/editor-facing `GraphDiagnostic` boundary and `checkGraphJsonV1Diagnostics(value, context)`. Every emitted diagnostic has a Harness-owned `code`, safe `message`, and validation `stage`. When one precise source location exists, `path` is a JSON Pointer into Graph JSON; direct `nodeId`, `edgeId`, `entrypointId`, `graphPortId`, and `port` references are preserved when available. Multi-object findings such as SCCs use `relatedNodeIds`/`relatedEdgeIds` rather than pretending one source path owns the whole error.

Shape validation now normalizes internal Draft 2020-12 engine failures into stable Harness codes such as `GRAPH_SHAPE_REQUIRED_PROPERTY`, `GRAPH_SHAPE_ADDITIONAL_PROPERTY`, and `GRAPH_SHAPE_INVALID_VALUE`; Ajv error objects, keyword names, and params remain private. The 2.6-2.7 semantic stage now also has structured codes for duplicate IDs, unresolved exact manifests/references, unknown ports, missing required inputs, and cardinality excess while preserving the existing boolean API. Existing 2.8-2.15 codes and semantics are not renamed or broadened.

The unified facade short-circuits on shape failure, then on semantic failure, so later passes do not flood callers with derivative prerequisite errors. After those prerequisites succeed, 2.8-2.15 run in frozen order and are normalized into the common location model. Diagnostic ordering is deterministic, secret material is never added to normalized output, and this stage performs no source normalization or IR lowering. Those begin with 2.17.

2.24 freezes this public diagnostic behavior with exact golden invalid-graph tests rather than introducing another diagnostic layer. `graph-json-v1-diagnostics.golden.test.ts` asserts the complete diagnostic objects for an unsupported shape property, a duplicate-node semantic failure, and a compiler-facing graph containing an SCC cycle plus unavailable graph-required capability and a literal source targeting a secret-only input. This locks shape/semantic short-circuit behavior, later-stage ordering (`acyclicity` before `capability-policy` before `secret-bindings` for that fixture), stable messages/codes, JSON Pointer locations, SCC related-node/edge sets, byte-for-byte repeatability, and secret non-leakage. 2.24 required no production validator changes; future changes to this frozen public diagnostic surface must be deliberate rather than silently rewriting expected output.

Ajv error objects are not part of any public contract. Replacing Ajv later must not require changing Graph JSON, plugin manifests, compiler semantics, scheduler behavior, runtime records, or the Harness diagnostic contract.

### Graph JSON v1 normalization and resolved version pins

2.17 is the first source-normalization stage and runs only after the frozen validation stack succeeds. `normalizeGraphJsonV1(graph, resolver)` is pure: it returns a new normalized document plus resolved pins and does not mutate the editable Graph JSON. The registry-neutral `NodeResolutionResolver` extends exact manifest lookup with the active plugin provenance for that node registration. `PluginHost` supplies `{ pluginId, pluginVersion }` to `NodeCatalog` internally when a plugin registers a node; the public plugin registration API remains unchanged and `packages/graph` does not depend on `packages/core`. Direct low-level catalog registrations without plugin provenance may still be inspected, but cannot satisfy compiler normalization/pinning.

The closed v1 defaults materialized here are intentionally small: omitted graph-input `required` becomes `false`, omitted node `bindings` becomes `[]`, omitted graph capability buckets become empty arrays, and omitted `policies`/`options` become explicit normalized containers. Explicit source values are preserved. JSON Schema `default` remains an annotation and is not applied to node config; executable config defaults would require a separate explicit Harness contract rather than silently redefining JSON Schema behavior.

Each normalized node records `nodeId`, exact `type`, exact node `version`, owning `pluginId`, and exact `pluginVersion`. A deduplicated plugin-pin list is also produced. Resolution must match the source `type@version`; plugin id/version must be non-empty; and one normalized graph cannot resolve two versions of the same active plugin id. Normalization failures use the common 2.16 diagnostic vocabulary with `stage: "normalization"` and JSON Pointer node paths.

2.17 deliberately preserves graph/editor metadata and source collection order. 2.18 owns removal of UI-only editor state, while 2.19 owns deterministic canonical ordering/serialization. This stage does not compute package digests, registry/compiler hashes, semantic/document hashes, or Execution IR; those remain later compiler items.

### Graph JSON v1 compiler UI-metadata stripping

2.18 introduces `stripGraphJsonV1UiMetadata(normalized)`, a pure compiler stage over 2.17 output. It returns `GraphCompilerSourceV1`, carrying the normalized document without its top-level `editor` property plus the exact node/plugin pins established by 2.17. The editable/normalized source is not mutated.

The stripping rule is deliberately narrow: the entire top-level `GraphEditorMetadataV1` bucket is excluded, including viewport, node positions/collapse state, annotations, and arbitrary editor `data`. Human-facing `metadata`, `graphId`, `revisionId`, policies/options, executable node config, bindings, edges, entrypoints, and resolved pins remain present. A property named `editor` inside node config is ordinary executable config and is not recursively removed. Therefore two normalized sources that differ only in top-level editor state produce the same 2.18 compiler-facing source.

2.18 does not canonicalize or reorder collections, project `GraphSemanticsV1`, compute document/semantic/registry/IR hashes, or lower Execution IR. Source order is preserved for 2.19, which owns deterministic canonical source semantics. The separate document-hash domain remains free to cover the complete normalized editable document, while executable semantic identity will exclude editor state by construction.

### Graph JSON v1 canonical source semantics

2.19 introduces `canonicalizeGraphJsonV1Semantics(source)` over 2.18 compiler source. It projects exactly the frozen `GraphSemanticsV1` executable domain, so `graphId`, `revisionId`, human-facing metadata, and editor metadata are absent. Resolved node/plugin provenance remains beside the semantic projection for later registry/compiler identity and is not included in `canonicalSemanticsJson`. No hash is computed here.

Canonical ordering is intentionally semantic, not a blanket rule that every array is a set. Graph inputs, outputs, nodes, edges, and entrypoints are identity-addressed collections with validated stable ids, so 2.19 sorts each by `id`. Graph capability `required`, `optional`, and `deny` buckets are sets and are sorted lexically. Node pins are sorted by `nodeId`; plugin pins by plugin id then version. In contrast, arbitrary JSON arrays inside schemas, config, defaults, and literal values remain in source order, and node `bindings` remain ordered because v1 has not declared multi-source aggregation commutative.

`stringifyCanonicalJsonV1` defines the Harness-owned deterministic JSON byte precursor for later hashing. JSON object keys are ordered by lexical JavaScript UTF-16 string comparison, arrays retain their established order, and primitive encoding delegates to ECMAScript `JSON.stringify`. This contract deliberately does not claim an external canonical-JSON standard profile. Non-finite numbers are rejected defensively even though valid Graph JSON has already excluded them. Equivalent executable semantics therefore produce identical `canonicalSemanticsJson` despite source object-key insertion order, identity-collection ordering, or graph/revision/human metadata differences.

2.19 remains pre-IR and pre-hash: 2.20 owns compact immutable Execution IR v1, while 2.21 owns document hash, semantic hash, registry/compiler identity, and IR hash.

### Execution IR v1

2.20 introduces the internal `ExecutionIrV1` contract, self-identified by `format: "harness.ir/v1"`. It is executable-plan state rather than a second Graph JSON document. The zero-based position inside `ops`, `graphInputs`, and `entrypoints` is the authoritative index; there is deliberately no redundant `index` field that could disagree with array position. `sourceNodeId` remains on each op only for tracing/inspection. Internal graph-input references use graph-input indexes, node-to-node value flow uses `{ kind: "op-output", op, port }`, graph outputs point to op indexes, control endpoints point to op indexes, entrypoints point to op indexes, and `defaultEntrypoint` is an entrypoint index.

Each op retains the runtime material already proven safe by earlier compiler stages: pinned source `type@version`, executable config, ordered resolved value sources, precomputed predecessor indexes, scheduler/effect/retry/recovery/execution behavior, required capabilities, and an optional static structured-control descriptor. Graph-level runtime policy retains resource ceilings plus required/optional/deny capability intent. External capability grants/effective authority are never embedded because Graph JSON cannot self-grant and runtime policy may be stricter. JSON Schemas/manifests and graph/revision/human/editor metadata are not duplicated into the compact IR core; durable source and registry identity remain separate records/domains.

`ExecutionIrControlDescriptorV1` reserves the already-frozen router, all-active join, loop, human-interrupt, and subgraph control shapes, while indexed `controlEdges` preserve activation/ordering endpoints. 2.22 now lowers only the initial DAG/router/join slice: router manifests become `{ kind: "router", entry, branches }`, all-active join manifests become `{ kind: "join", inputs, output, mode: "all-active" }`, and ported control edges retain their named indexed endpoints. Loop, human-interrupt, and subgraph descriptors remain reserved by the IR type but are deliberately omitted by the 2.22 lowerer until their later execution phases. This does not weaken 2.10 SCC rejection or add branch-selection/join-runtime behavior; Phase 3 owns scheduling semantics.

`createExecutionIrV1(candidate)` is an internal invariant boundary, not a new Graph validation pass. It checks that every op/graph-input/control/entrypoint numeric reference is in range, requires dependency lists to be strictly increasing and unique, rejects self-dependencies, then `structuredClone`s and deeply freezes the plan. The caller's candidate is not mutated or frozen. Invalid references at this point indicate a compiler bug because user-facing shape/semantic/policy validation has already succeeded.

### Graph JSON v1 to Execution IR v1 lowering

2.22 introduces `lowerCanonicalGraphJsonV1ToExecutionIr(canonical, resolver)`. The already-canonical node array defines op indexes, graph inputs define graph-input indexes, and entrypoints define entrypoint indexes. Graph outputs, entrypoints, default entrypoint, graph-input bindings, op-output value sources, and control endpoints are resolved to those numeric domains. Every data or control edge adds its source op to the target's scheduler dependency set; dependencies are deduplicated and sorted numerically before the immutable IR boundary. Data edges additionally become `{ kind: "op-output", op, port }` input sources. For each op, authored non-edge bindings preserve their frozen order first, followed by incoming data edges in canonical edge-id order, so v1 multi-source sequence is explicit rather than accidentally commutative.

Lowering copies the already-validated runtime material from the exact resolved manifest: executable config, static behavior, retry/recovery/effect information, required capabilities, and the initial router/join control descriptor. Graph hard resource ceilings and capability request/self-deny intent are copied, while external grants/effective authority remain absent. The lowerer re-resolves each `type@version` through `NodeResolutionResolver` and requires the owning plugin id/version to match the canonical node pin. Missing or drifted resolution is a compiler invariant failure, not a new Graph diagnostic, preventing a registry change from silently altering compilation after the 2.21 provenance snapshot.

2.22 is the first deterministic lowering implementation identified by `harness.compiler/v1`; no version bump is needed merely to fill in that initially reserved v1 behavior. Future changes to these frozen lowering semantics must bump compiler identity. Loop, human-interrupt, and subgraph execution remain later work. 2.23 owns fixed canonical hash vectors and stability tests.

2.20 deliberately contains no document hash, semantic hash, registry hash, compiler version, IR hash, or provenance pins; 2.21 owns those identities. 2.22 now owns the basic Graph-to-IR DAG/router/join transformation.

### Generated-graph compiler stress boundary

2.25 closes Phase 2 with deterministic stress tests over the entire frozen compiler pipeline rather than adding another compiler stage. `graph-json-v1-compiler.stress.test.ts` generates seeded valid DAGs with a guaranteed data chain plus extra forward-only data/control edges, public graph inputs, ordered literal/graph-input/opaque-secret bindings on ordinary ports, multiple graph outputs, policies, and editor metadata. The 8/32/96/192-node family is compiled twice from cloned source and must produce byte-identical canonical semantics, immutable Execution IR, and compiler identity.

A separate 256-node fixture shuffles identity-addressed source collections before recompilation. Its normalized saved-document order changes `documentHash`, while canonical semantic JSON, `semanticHash`, `registryHash`, `irHash`, and the full Execution IR remain identical. The largest fixture compiles 512 ops with mixed data/control dependencies and asserts every lowered dependency is unique, numerically sorted, and topologically earlier than its target; every op-output source also points backward in the DAG. There are deliberately no wall-clock thresholds, so the suite tests correctness/scale invariants rather than runner speed.

2.25 required no production compiler changes. With its Ubuntu and Windows CI pass, the Phase 2 checkpoint is frozen: validated Graph JSON plus the same registry/compiler deterministically produces the same canonical Execution IR and identity, while invalid source fails before execution through the stable diagnostic boundary. Phase 3 now owns in-memory execution semantics.

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

2.21 implements these identities with `recordGraphCompilerIdentityV1`. All content hashes use SHA-256 with explicit Harness v1 domain separation and are serialized as `sha256:<64 lowercase hex digits>`. Hashing uses Web Crypto (`crypto.subtle`) so the graph package does not gain a Node-only crypto import. The compiler behavior identity is the explicit constant `harness.compiler/v1`; it is recorded separately and must be bumped when deterministic lowering semantics change.

`documentHash` hashes the complete 2.17 normalized authoring document. It therefore includes `graphId`, `revisionId`, human metadata, editor state, semantic source, and normalized Harness-owned defaults. Object-key insertion order is removed by `stringifyCanonicalJsonV1`, while authoring/source arrays remain ordered so the document hash continues to identify the exact normalized saved document. `semanticHash` hashes only the 2.19 `canonicalSemanticsJson`, so graph/revision/human/editor-only changes cannot alter executable semantic identity.

`registryHash` hashes the canonical resolved registry slice used by compilation: sorted per-node pins (`nodeId`, node `type@version`, owning plugin id/version) plus deduplicated/sorted plugin pins. A plugin resolution/version change can therefore alter registry identity without altering the graph's semantic source. The immutable identity record also carries those exact node/plugin pins directly for provenance. `irHash` hashes only serialized `ExecutionIrV1` content, so it remains a pure content identity rather than a compound provenance key.

The frozen relationship is therefore unchanged:

```text
semanticHash + registryHash + compilerVersion
                    ↓
            deterministic compile
                    ↓
              canonical IR
                    ↓
                 irHash
```

2.21 does not lower Graph JSON into IR; 2.22 owns DAG/router/join lowering. 2.23 now freezes exact `harness.compiler/v1` hash vectors in `compiler-identity-v1.golden.test.ts` using the real canonicalization and lowering pipeline. The fixture locks all four domain-separated SHA-256 outputs, proves cloned identical input produces identical canonical semantics/IR/identity, and proves editor-only changes affect `documentHash` while the semantic, registry, and IR golden hashes remain unchanged. This adds no new production hash semantics; a future intentional canonical-byte or lowering change must update the compatibility/version contract rather than casually rewriting the vectors.

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
