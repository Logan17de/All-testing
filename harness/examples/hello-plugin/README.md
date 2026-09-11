# Hello Example Plugin

A complete, working Zet Harness plugin. Copy this directory to start your own.

It has **no dependencies and no build step**. The floor for writing a plugin is one JSON file and
one JavaScript file.

## Files

| File | Purpose |
|---|---|
| `zet-plugin.json` | The package manifest. Read before any of your code runs. |
| `index.mjs` | The plugin itself: a manifest plus an `activate` function. |

## Try it

Put the directory inside your harness plugins folder, then enable it in your plugin configuration:

```json
{
  "plugins": [{ "id": "com.example.hello", "enabled": true }]
}
```

A plugin is **disabled until you enable it**. Dropping a folder into the plugins directory is not
enough to make it run.

## The manifest

```json
{
  "manifestVersion": 1,
  "id": "com.example.hello",
  "name": "Hello Example",
  "version": "1.0.0",
  "apiVersion": 1,
  "license": "MIT",
  "entry": "./index.mjs",
  "minHarnessVersion": "0.1.0",
  "requestedCapabilities": [],
  "nodes": [{ "type": "example.reverse-text", "version": "1", "title": "Reverse text" }],
  "integrity": { "algorithm": "sha256", "files": { "index.mjs": "..." } }
}
```

Every field earns its place:

- **`id`** is lowercase dot-separated. Use a namespace you control so your node types cannot
  collide with someone else's.
- **`license`** is required. An installable package has to say what its terms are.
- **`requestedCapabilities`** is a **request, not a grant**. The host decides separately what to
  allow, and your plugin can see exactly what it asked for and did not get.
- **`nodes`** must list every node you register. The loader refuses a plugin that registers an
  undeclared node — otherwise reviewing a manifest before enabling would mean nothing.
- **`integrity`** is optional but recommended. Digests are checked *before* your entry file is
  imported, so a tampered package never executes. A host may refuse unsigned packages entirely.

Regenerate the digest whenever you change `index.mjs`:

```bash
node -e "const f=require('fs'),c=require('crypto');console.log(c.createHash('sha256').update(f.readFileSync('index.mjs')).digest('hex'))"
```

## Node behavior metadata

The `behavior` block is how the scheduler decides whether an interrupted attempt may be repeated.
Getting it wrong is how duplicate side effects happen, so state it honestly:

| Field | This example | When yours differs |
|---|---|---|
| `primitiveFamily` | `pure` | `effect` if you touch anything outside the harness |
| `effect` | `none` | `external-read` or `external-write` |
| `idempotency` | `not-applicable` | `idempotent` only if repeating truly reaches the same state |
| `recovery` | `rerun` | `manual` when a repeat is not safe |
| `requiredCapabilities` | `[]` | e.g. `["fs:read"]` — and list them in the manifest too |

A pure node can be rerun freely. Anything else cannot, and the harness will not guess for you.

## TypeScript

If you prefer types, install `@zet-harness/plugin-sdk` and use its helpers:

```ts
import { definePlugin, definePureNode, describeNodesForManifest } from "@zet-harness/plugin-sdk";

const reverseText = definePureNode({
  type: "example.reverse-text",
  title: "Reverse text",
  inputs: { text: { schema: { type: "string" }, required: true } },
  outputs: { text: { schema: { type: "string" }, required: true } },
  execute: ({ inputs }) => ({ outputs: { text: [...String(inputs.text)].reverse().join("") } }),
});

export default definePlugin({
  id: "com.example.hello",
  name: "Hello Example",
  version: "1.0.0",
  nodes: [reverseText],
});
```

`definePureNode` fills in the safe behavior metadata for you. `defineEffectNode` deliberately does
not: it makes you state effect, idempotency and recovery yourself. `describeNodesForManifest(nodes)`
generates the manifest's `nodes` array from your definitions, so the two cannot drift apart.

The SDK is built only on the public plugin contracts. It gives you nothing a hand-written plugin
could not do, which is the point: there is no privileged authoring path.

## What a plugin cannot do

- **Grant itself a capability.** Declarations are demand; the host's policy is the only authority.
- **Register an undeclared node type.**
- **Read outside its package** through manifest paths — entry and integrity paths that escape the
  package directory are refused.
- **Escape review by shipping a different identity.** The loaded plugin's `id` and `version` must
  match the package manifest.
