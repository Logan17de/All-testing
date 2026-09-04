# Zet Harness — Plugin Architecture

Zet Harness should have a **small kernel and a wide plugin door**.

The design principle is inspired by plugin-first harnesses such as DeepSeek Harness, but Zet Harness will use a much smaller native TypeScript plugin kernel rather than adopting a large composition framework.

The key rule:

> Built-in capabilities and third-party capabilities should use the same public registration APIs whenever practical.

That prevents the core from becoming a collection of hard-coded special cases and lets us replace or extend models, tools, memory, UI, auth, and workflows without rewriting the runtime.

## 1. What the kernel owns

The non-replaceable kernel should stay tiny:

```text
plugin lifecycle
service registry
plugin API compatibility check
event dispatch
configuration loading
registration/disposal tracking
core security boundaries
```

The kernel should **not** contain provider-specific logic or integration-specific behavior.

## 2. What plugins may contribute

A plugin can eventually contribute one or more capabilities:

```text
model providers
model metadata/capabilities
tools
commands
services
runtime hooks
event subscribers
memory/retrieval providers
credential/auth providers
subscription/usage providers
settings schemas
API routes
UI panels/actions
background event sources
external workers
```

Not every extension point must be implemented on day one. The public shape should allow us to add these without breaking the kernel.

## 3. Minimal plugin contract

Conceptual TypeScript shape:

```ts
export interface HarnessPlugin {
  manifest: PluginManifest;
  activate(ctx: PluginContext): void | Promise<void>;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: 1;
  capabilities?: string[];
}

export interface PluginContext {
  services: ServiceRegistry;
  events: EventBus;
  models: ModelRegistry;
  tools: ToolRegistry;
  hooks: HookRegistry;
  config: unknown;
  onDispose(fn: () => void | Promise<void>): void;
}
```

Every registration returns or records a disposer.

When a plugin unloads, registrations are unwound in reverse order. This keeps tests, reloads, and failures deterministic.

## 4. Stable public package

Third-party plugins must not import private files from `@zet-harness/core`.

Create a small public package:

```text
@zet-harness/plugin-api
```

It should contain only:

- plugin types;
- service tokens/contracts;
- registration interfaces;
- capability identifiers;
- compatibility helpers.

It should have **zero or near-zero runtime dependencies**.

The implementation of the registries stays inside the harness core.

## 5. Built-ins use the plugin API

As the runtime grows, first-party features should register through the same mechanism.

Examples:

```text
builtin.sqlite
builtin.agent-loop
builtin.openai-compatible
builtin.native-tools
builtin.memory-basic
builtin.web
```

We do not need to convert every file into a plugin immediately. The rule is that new extension-facing capabilities should not get a private registration mechanism unavailable to third-party plugins.

## 6. Model plugins

A model/provider plugin may register one or more providers:

```text
OpenAI-compatible
Anthropic
Qwen-specific
local Ollama/vLLM
subscription-backed providers
future providers
```

The kernel sees only the common provider contract and capability metadata.

A model plugin can also contribute:

- auth flow;
- model discovery;
- reasoning-level metadata;
- usage/quota reporting;
- provider-specific settings.

This is how we leave room for subscription plugins similar in spirit to the provider plugins already used in our DeepSeek Harness experiments.

## 7. Tool plugins

A tool plugin registers tools through the normal tool registry.

The plugin does not decide whether a tool may run. The harness permission/execution path remains authoritative.

```text
plugin → register tool
model → request tool
harness → validate + permission check
harness → execute
harness → trace result
```

This ensures native tools and plugin tools appear in the same trace and approval UI.

## 8. Important security truth

An **in-process JavaScript plugin is trusted code**.

A manifest that says `permissions: ["filesystem.read"]` cannot stop malicious plugin code from importing Node filesystem APIs directly.

Therefore v1 has two explicit trust modes:

### Trusted in-process plugin

- fastest;
- lowest overhead;
- normal default for our own/local plugins;
- full Node process privileges;
- manifest capabilities are descriptive/configuration-level, not a security sandbox.

### Isolated plugin (later)

Community/untrusted plugins can later run in a child process or worker with a narrow RPC interface.

The isolated mode can enforce real resource/tool boundaries, but it is intentionally deferred because it adds process and protocol complexity.

Never claim that an in-process plugin is sandboxed when it is not.

## 9. Lazy loading

Disabled plugins should cost almost nothing.

At boot:

```text
read enabled plugin specs
→ validate manifests
→ dynamic import enabled entries
→ activate
```

Do not scan/import every installed package on every boot.

Heavy plugins should defer their own expensive initialization until their capability is first used where possible.

## 10. Plugin configuration

Keep configuration boring and inspectable.

Initial format can be JSON/JSONC rather than adding YAML machinery:

```json
{
  "plugins": [
    {
      "package": "@zet-harness/plugin-openai-compatible",
      "enabled": true,
      "config": {
        "baseUrl": "http://127.0.0.1:8000/v1"
      }
    }
  ]
}
```

Secrets should be referenced by environment/credential keys rather than stored inline.

## 11. Install sources

Eventually support:

```text
built-in plugin id
local folder
npm package
Git repository/package spec
```

Installation and execution are separate concerns. A plugin may be installed but disabled.

The first plugin milestone only needs built-ins + local path/package loading. Marketplace/discovery can come later.

## 12. Profiles

A lightweight profile is simply a named plugin/config composition.

Examples:

```text
minimal
  sqlite
  openai-compatible
  native-tools

coding
  + git
  + shell
  + github

creative
  + comfyui
  + blender

headless
  same runtime capabilities
  no web UI plugin
```

Profiles should be plain configuration, not separate runtimes.

## 13. Event and hook model

Keep two concepts separate:

### Events

Facts that already happened:

```text
run.started
model.completed
tool.completed
todo.updated
```

Multiple listeners may observe them.

### Hooks

Controlled extension points that can influence behavior:

```text
context.beforeBuild
model.beforeRequest
tool.beforeExecute
run.beforeComplete
```

Hooks must be ordered and bounded. A plugin must not be able to create an invisible infinite hook chain.

## 14. UI extensions

Do not make UI plugins block the server-side plugin system.

Server/runtime plugins come first.

Later a plugin may declare UI contributions such as:

```text
settings section
sidebar item
run-inspector panel
tool result renderer
provider login panel
```

UI code must load only when the relevant plugin is enabled.

## 15. Compatibility

Every plugin declares an API version.

For v1:

```text
apiVersion: 1
```

The host refuses incompatible plugin API versions with a clear error before activation.

Do not expose unstable internal classes as public plugin API merely because they are convenient.

## 16. Failure behavior

One bad optional plugin must not corrupt the runtime.

Activation flow:

```text
load manifest
→ validate
→ activate in tracked scope
→ if activation fails, dispose partial registrations
→ report plugin failure
```

Required/built-in plugins may fail startup. Optional plugins should normally be disabled with a visible error while the remaining harness can still start.

## 17. Plugin development experience

A plugin author should eventually need only:

```text
package.json
src/index.ts
```

and a small dependency on `@zet-harness/plugin-api`.

Target package metadata:

```json
{
  "name": "example-zet-plugin",
  "zetHarness": {
    "apiVersion": 1,
    "entry": "./dist/index.js"
  }
}
```

The exact manifest will be frozen only after the first two real plugins exist.

## 18. First proof

Before model/provider complexity grows, prove the architecture with two tiny plugins:

1. a built-in plugin that registers one service/tool;
2. an external/local test plugin using only `@zet-harness/plugin-api`.

Both should activate, register, execute, and dispose through the exact same host path.

If that works, we have the wide door without making the core heavy.
