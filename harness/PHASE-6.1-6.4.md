# Phase 6.1–6.4 — Provider-neutral adapters and offline fixtures

## Public contracts

`packages/plugin-api/src/adapter-contract.ts` contains dependency-free structural types exported
from the existing public API. Model requests use structured role/part messages: text, host-managed
image references, tool calls, and tool results. Results carry a final assistant message and finish
reason; usage/cost is optional and must never be fabricated. Transient stream events distinguish
text deltas, complete tool calls, usage, and completion. These types do not themselves implement
persistence, HTTP streaming, model routing, or provider-specific options.

`AdapterInvocationContext` carries host-derived execution identity, cancellation signal, the same
shared retry budget as the scheduler, and an optional node-scoped secret accessor. It contains no
permission mutator, host policy, database connection, or general-purpose secret provider. A future
invocation broker must derive this context itself, not trust model-proposed fields with those names.

Tool manifests reuse `NodeBehavior` and the existing effect/idempotency/recovery invariant helper.
They add inspectable input/output schemas, not a second policy language or a second schema engine.
Model feature flags are explicit metadata rather than capability grants. Actual provider feature
negotiation and capture remain 6.8–6.11 work alongside transport implementation.

## Host registration services

`PluginContext.models.register` and `.tools.register` join the existing node registration surface.
All three facades are frozen and closed after activation. The host tracks disposers in one reverse
cleanup stack; failed activation rolls back all successful service registrations. Existing plugins
that use only nodes keep the same activation path. These are additive API-v1 host services.

`ModelCatalog` and `ToolCatalog` are host-owned exact ID/version registries. Their manifest-only
inspection path clones/freezes metadata and never calls an adapter. Captured implementation
functions are bound to their original receivers so replacing a method later does not change the
registered implementation. Host plugin provenance is retained separately from adapter declarations.
Each requirement must be inside the owning plugin's already-inspected capability ceiling.

Registration **is not invocation authorization**. Direct host catalog access remains trusted. The
future adapter-node/invocation broker must check selected adapter demand against the compiled node
and current host authority, apply schema validation at that boundary, and use existing durable and
redaction sinks. A catalog is not an OS sandbox, and tool declarations alone cannot constrain an
arbitrary in-process JavaScript implementation.

## Scripted adapters

`createScriptedModelAdapter` and `createScriptedToolAdapter` live in the existing models/tools
workspaces. They clone a finite response script, reserve responses deterministically, and reject
exhaustion rather than falling through to network or silently retrying. No timers, network, native
tools, or external dependencies are introduced.

The model's `generate` and `stream` share one cursor. A stream consumes a response when iteration
begins; a pre-aborted invocation consumes nothing. Cancellation after reservation does not rewind
the script, and no completion event is emitted after cancellation. Tool calls in a model response
are data only; the mock model does not execute tools itself. Returned results/events are isolated
from caller-owned script arrays and other stream events. Scripted tools declare nondeterministic
output because the response depends on the cursor, despite the script's reproducible test order.

## Tests and next boundary

`adapter-contract-integration.test.ts` exercises the real plugin services, reverse rollback,
closed activation contexts, metadata and method replacement, versioned identity, capability
self-grant rejection, the shared effect-policy rule, streaming cancellation, output isolation,
finite scripts, and denial before invoking a registered tool.

6.1–6.4 are complete. **6.5 is next:** a generic OpenAI-compatible first-party transport, followed by
current provider specifics only where needed, secret references/base URLs, routing, transient event
wiring and usage capture, then contained filesystem/shell/git tools. There is no claim that these
contracts alone already make cloud/local model endpoints or native tools usable end to end.
