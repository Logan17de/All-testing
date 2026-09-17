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

That starts the runtime daemon and the web UI together. The UI is at `http://127.0.0.1:3000`; the
daemon listens on `http://127.0.0.1:3211`. Both bind to loopback only. **Ctrl+C** stops both, and
closing the terminal does too.

If the ports are already taken, `npm start` says by which process and whether it is a Zet Harness,
and starts nothing. When it is an earlier harness you want to replace, run:

```sh
npm start -- --restart
```

which stops that harness first. It only ever stops a process that answers as this harness;
anything else on those ports is reported, and left alone.

To run them separately:

```sh
npm run start --workspace @zet-harness/runtime
npm run dev --workspace @zet-harness/web
```

Set `HARNESS_RUNTIME_URL` if the daemon listens somewhere other than the default.

The daemon reads plugins from `apps/runtime/plugins/`. Set `ZET_RUNTIME_PLUGINS_DIR` to use another
folder; the Plugins page shows which directory was read. A missing folder simply means no plugins
are enabled.

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
the harness plugins directory — or, if this harness is allowed to fetch one, use **Add a plugin** on
the Plugins page to install it from npm or an https Git repository. Either way, enable it in
`plugins.json` in that same directory:

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

### Installing from npm or Git

Fetching a package runs a package manager, so a harness does none of it until you say so:

```json
{ "plugins": { "install": { "npm": true, "git": true } } }
```

in `harness.config.json`, or `ZET_RUNTIME_ALLOW_NPM_INSTALL=1` and `ZET_RUNTIME_ALLOW_GIT_INSTALL=1`
in the environment. With one of them on, the Plugins page offers **Add a plugin**: an npm package
name (optionally `@version`), or an https repository URL with an optional branch, tag or commit.
Only https is used, so no ssh key or agent is involved, and a URL carrying credentials is refused.

The install runs with no shell and with `--ignore-scripts`, so nothing in a package name is
interpreted and no install hook of the package runs. What arrives is then read by the same checks
the loader uses at startup — manifests only, no plugin code imported — and removed again if it is
not a plugin. The package lands **disabled**, with nothing granted, and runs from the next start of
the runtime: installing is still not enabling, and enabling is still a file you edit.

## Connecting a model

Agent steps need a model to call. Open **Models** (`http://127.0.0.1:3000/models`) and add one:

- **Ollama** or **llama.cpp** running on this machine: pick it, type the model name exactly as the
  server knows it (for example `llama3.1:8b`), and keep **No key**. The endpoint is filled in with
  the server's usual local address.
- **OpenAI**, or any other API that speaks the OpenAI Chat Completions format: pick it, type the
  model name and the endpoint, and either paste the API key or name the environment variable that
  holds it.

Saving checks the model straight away with a one-token request, and says what went wrong in plain
words — a refused key, a wrong URL, a server that is not running. **Check** repeats it at any time.

- **Where a key lives.** A pasted key is kept in this harness's own database on this machine and is
  never returned by the API or shown again; editing a model with the key field left empty keeps it.
  Anyone who can read the database file can read the key, exactly as with a `.env` file. If you
  would rather it never touch the database, choose the environment variable instead — the key is
  read at the moment a request is made — and set the variable before starting the runtime.
- **Where a key goes.** Only to that model's endpoint, only over https or to an address on this
  machine, and it is removed from everything the harness records.
- **Which model a step uses.** An **Agent model step** uses the model named in its **Model id**
  setting, or otherwise any available model that can call tools. A model you add is available
  immediately, without restarting the runtime.

Signing in to a provider with an account (OAuth) is not offered: the providers above give API access
through keys.

## Chatting

Open **Projects**, create a project, and start a conversation in it. Under the message box,
**Answered by** says what replies:

- **Chat** — a normal conversation. The model answers each message, and can use the project's
  goals, todos and memory when that helps.
- **Chat with GitHub** — the same conversation with a GitHub component wired in, so the model can
  read repositories, issues, pull requests and files.
- **Nobody** — messages are only saved.

Pressing **Send** saves your message and starts the chosen workflow; the page shows "Thinking…"
until the reply is in, with a link to watch the run. If no model is connected yet, the page says so
and links to **Models**. **Open this workflow in the editor** shows the exact graph that answers the
conversation — a Loop around an **Agent model step** and an **Agent tools step**, plus the
**GitHub** component when it is used — so you can change it and run your own version.

### The GitHub component

GitHub is a first-party plugin. It only reads: repository details, issues, pull requests and text
files. Public repositories work with no setup. For private repositories, or GitHub's higher request
limit, set `GITHUB_TOKEN` before starting the harness; the token is read when a request is made,
never stored, and removed from anything the harness records. `GITHUB_API_URL` points it at a GitHub
Enterprise server instead.

The component does no work of its own. Its **Tools** output names the GitHub tools, and connecting
it to an agent step's **Tools** input is what lets that step use them. A step offers a plugin's
tools only when a component hands them over this way, so a workflow uses exactly what its graph
shows. One component can feed each step for now.

## Building and running a graph

Open `http://127.0.0.1:3000/editor`. The palette lists every node your enabled plugins registered,
plus the built-in **Human approval** node, which any graph can use to pause for a person.

- Drag a node onto the canvas, or click it to add it. Connect an output handle to an input handle.
  An input nothing feeds can take a typed value in the inspector.
- The compiler checks the graph in the background while you build, and the status line says
  whether it is ready to run. Nothing is marked wrong while you are still wiring it: press **Run
  graph** and, if something is missing, the problems appear on the node or connection they concern
  and in the list, and the run is not started. They clear as soon as the graph can run.
- Handles on a node's sides carry data. Handles above and below a node are control flow: a
  control edge makes its target run only after its source finishes on that path.
- To branch, connect a **Condition** node's `branch` output to a **Route** node's `branch` input,
  then draw control edges from the Route's `yes` and `no` handles to the steps on each path. The
  path not taken is skipped, and so is anything that depends on it. **Wait for all** and **Wait for
  any** bring paths back together through their `a` and `b` lanes.
- To repeat steps, add a **Loop** node. Connect its `body` handle to the first step, the last step
  back to its `repeat` handle, and its `done` handle to what follows. Set `maxIterations`, and feed
  a boolean into its `again` input to stop early, or set `maxWallTimeMs` to cap how long it keeps
  repeating. Work after the loop can read the last iteration's values.
- A run fails with `RUNTIME_BUDGET_EXCEEDED` when it would start more node attempts than its
  `maxNodeExecutions`, or starts one after its `maxWallTimeMs`. The editor sets
  `maxNodeExecutions` high enough to cover every node and its largest loop.
- To reuse a graph, add a **Subgraph** node and set its `graphId` and `revisionId` to a graph
  revision that has already run. The saved graph runs in its place, its steps show up in the run
  inspector as `<subgraph node>/<step>`, and a graph that ends up running itself is refused.
- To let a model work on a project, put an **Agent model step** and an **Agent tools step** inside
  a **Loop**: connect the loop's `body` to the model step, the model step to the tools step, the
  tools step back to `repeat`, and the model step's `again` output to the loop's `again` input.
  Both steps take the conversation id, and the model step takes a system prompt. The loop's
  `maxIterations` bounds how many turns the model gets. Models and tools your plugins register
  are offered to the agent when the capabilities they need are granted, beside the built-in goal
  and todo actions.
- **Run graph** stores a new revision, starts a run and opens the run inspector.

The run inspector (`/runs/<id>`) shows each node's durable state on the graph, the event timeline,
and for a selected node its configuration, inputs, attempts, outputs, errors and permissions. When
a run reaches a Human approval node an approval card appears, and approving or rejecting resumes
the run. The single-use token that authorizes a decision is issued and spent by the web server, so
the page never holds it.

The editor saves your draft in the browser. **Export JSON** gives you the plain Graph JSON document,
which is exactly what the runtime stores and runs; there is no separate editor format.

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

### Giving agent steps new tools

A plugin can give agent steps new abilities the same way GitHub does: register tool adapters with
`context.tools.register`, and a component node whose `tools` output lists their ids. Declare that
output with exactly `{ "type": "array", "items": { "type": "string" } }` — the schema of an agent
step's **Tools** input — so the two connect. The tools still need the capabilities they declare
granted in `plugins.json`.

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

### Control-flow nodes

A plugin can declare its own routers and joins. Give the manifest a `control` contract and the
behavior `primitiveFamily: "control"` with `executionMode: "none"`, and omit `execute`: the scheduler
resolves these nodes itself, so they never run plugin code.

```js
{
  type: "support.triage",
  version: "1",
  title: "Triage",
  inputs: { branch: { schema: { type: "string" }, required: true } },
  outputs: {},
  configSchema: { type: "object", additionalProperties: false },
  behavior: {
    primitiveFamily: "control",
    determinism: "deterministic",
    effect: "none",
    idempotency: "not-applicable",
    recovery: "not-applicable",
    executionMode: "none",
    requiredCapabilities: [],
  },
  control: { kind: "router", entry: "in", branches: ["billing", "technical", "other"] },
}
```

A router follows the branch named by the string on its `branch` input; an undeclared name fails
the run. A join declares `{ kind: "join", inputs: [...lanes], output: "out", mode }` where `mode`
is `all-active`, `any`, or `quorum` with a `quorum` count. A loop declares
`{ kind: "loop", entry, continue, body, exit }`, needs a `maxIterations` config, and continues
while its `again` input is true. A subgraph declares `{ kind: "subgraph", entry, exits }` and
needs `graphId` and `revisionId` config naming a saved graph revision, which the compiler expands
in place. All of them survive a runtime restart.

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
