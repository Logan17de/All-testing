# Writing and installing plugins

Zet Harness is extensible by design. Everything it can do beyond its core — nodes, tools, model
adapters — arrives as a plugin, and the authoring surface an outside developer gets is exactly the
one first-party plugins use. There is no privileged path.

## Running the harness

From `harness/`:

```sh
npm ci
npm start
```

That starts the runtime daemon and the web UI together. The UI is at `http://localhost:3000`; the
daemon listens on `http://127.0.0.1:3211`. To run them separately:

```sh
npm run start --workspace @zet-harness/runtime
npm run dev --workspace @zet-harness/web
```

Set `HARNESS_RUNTIME_URL` if the daemon listens somewhere other than the default.

## Before you enable a plugin

A plugin runs in one of two tiers, and you choose which per plugin.

### Isolated (recommended for anything you did not write)

Set `"isolated": true` in your plugin configuration. The plugin then runs in its own child process
started under Node's permission model, and the capabilities you granted become the only
operating-system surfaces it has.

This is a real boundary, not a convention. A plugin that imports `node:fs` directly and calls
`writeFileSync` still fails with `ERR_ACCESS_DENIED` unless you granted `fs:write`, and a plugin
granted `fs:write` can still only reach the workspace root — not the rest of your disk. Both are
covered by tests.

| Grant | What the sandbox permits |
|---|---|
| *(none)* | Read its own package directory, and nothing else |
| `fs:read` | Read the workspace root |
| `fs:write` | Read and write the workspace root |
| `process:exec` | Start child processes |

The sandbox also receives a minimal environment, so an isolated plugin cannot read your API keys
out of `process.env`.

**One real limit:** Node's permission model does not cover network access. An isolated plugin can
still open sockets. Network capabilities are enforced at the harness's own brokered surfaces only.

### In-process (trusted)

The default. The plugin runs inside the harness with full Node privileges, which is cheap and fine
for plugins you wrote or have read. Capability grants still govern the harness's brokered
surfaces, but they do not confine the plugin's own imports.

Treat enabling an in-process plugin exactly as you would treat running any program someone sent
you. Prefer signed packages, and set `requireIntegrity` so unsigned ones are refused.

Whichever tier you choose, these are always enforced: a plugin cannot register a node it did not
declare, cannot load if its files were tampered with, cannot ship an identity different from the
one you reviewed, and cannot start at all unless you enable it.

## Installing a plugin

A plugin is a directory containing a `zet-plugin.json` manifest and an entry module. Copy it into
the harness plugins directory, then enable it in `plugins.json` in that same directory:

```json
{
  "plugins": [
    {
      "id": "com.example.hello",
      "enabled": true,
      "isolated": true,
      "grantedCapabilities": [],
      "config": {}
    }
  ]
}
```

Two rules are worth stating plainly, because they are enforced rather than advisory:

- **A plugin is disabled until you enable it.** Copying a folder in is not enough. `enabled` must
  be a literal `true`.
- **Installing is not authorizing.** A package's `requestedCapabilities` is what it *asks* for.
  What it *receives* is `grantedCapabilities`, which only you can set. The Plugins page shows both,
  so you can always see what a plugin wanted and did not get.

The daemon loads enabled plugins at startup. A plugin that fails to load is reported on the
Plugins page and never prevents the harness from starting.

## Writing a plugin

Start from [`examples/hello-plugin/`](./examples/hello-plugin/README.md). It is a complete working
plugin with **no dependencies and no build step** — one JSON file and one JavaScript file.

The manifest:

```json
{
  "manifestVersion": 1,
  "id": "com.example.hello",
  "name": "Hello Example",
  "version": "1.0.0",
  "apiVersion": 1,
  "license": "MIT",
  "entry": "./index.mjs",
  "requestedCapabilities": [],
  "nodes": [{ "type": "example.reverse-text", "version": "1", "title": "Reverse text" }]
}
```

The entry module default-exports an object with a `manifest` and an `activate(context)` function.
`activate` registers nodes, tools or model adapters through the context it is given.

### Rules the loader enforces

| Rule | Why |
|---|---|
| Manifest is read before any of your code is imported | A person can review a package without running it |
| `id` and `version` must match your runtime manifest | A package cannot advertise one identity and register another |
| You may only register node types listed in `nodes` | Otherwise reviewing the manifest would mean nothing |
| `entry` and integrity paths must stay inside the package | A manifest is untrusted input even on your own disk |
| Integrity digests are checked **before** the import | Verifying after execution would verify nothing |

### Signing a package

Add sha256 digests so tampering is detectable. Hosts can refuse unsigned packages entirely.

```json
"integrity": {
  "algorithm": "sha256",
  "files": { "index.mjs": "<digest>" }
}
```

Regenerate after every change to the file:

```bash
node -e "const f=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(f.readFileSync('index.mjs')).digest('hex'))"
```

### Behavior metadata

Each node declares how it behaves. The scheduler uses this to decide whether an interrupted
attempt may be repeated, so state it honestly:

| Field | Safe default | When it differs |
|---|---|---|
| `primitiveFamily` | `pure` | `effect` if you touch anything outside the harness |
| `effect` | `none` | `external-read` or `external-write` |
| `idempotency` | `not-applicable` | `idempotent` only if repeating truly reaches the same state |
| `recovery` | `rerun` | `manual` when a repeat is not safe |
| `requiredCapabilities` | `[]` | e.g. `["fs:read"]`, also listed in the manifest |

A pure node can be rerun freely after a crash. Anything else cannot, and the harness will not
guess on your behalf.

### TypeScript

`@zet-harness/plugin-sdk` provides `definePureNode`, `defineEffectNode`, `definePlugin` and
`describeNodesForManifest`. `definePureNode` fills in behavior metadata because pure nodes are
genuinely safe to rerun; `defineEffectNode` deliberately makes you state effect, idempotency and
recovery yourself.

`describeNodesForManifest(nodes)` generates the manifest's `nodes` array from your definitions, so
the code and the manifest cannot drift apart.

## Using MCP servers

Model Context Protocol servers work without writing a plugin at all. Their tools are translated
into ordinary harness tools and travel the same capability, approval and tracing path as anything
else — there is no separate MCP engine.

Each server gets its own capability, `mcp:<server-id>`, so authorizing a filesystem server does
not authorize an unrelated one.

One thing to know: MCP tool annotations such as `readOnlyHint` are **claims by the server**, not
guarantees. Every MCP tool is therefore treated as an external write that is unsafe to repeat
unless you explicitly opt into trusting a server's hints.

## What a plugin cannot do

- Grant itself a capability. Declarations are demand; your configuration is the only authority.
- Register a node type its manifest does not declare.
- Read outside its own package through manifest paths.
- Ship a different identity than the one reviewed.
- Take down the harness by failing to load.
