# Plugins and foundational integrations

Reviewed 2026-10-05. The useful default is the repository's installed native tools, exposed in ordinary chat and graph workflows only within the effective grants and graph tool scope. Catalog availability, plugin activation, credentials, platform capability and permission to execute are distinct states. An enabled catalog item does not authorize filesystem writes, network traffic, desktop input or a new account connection.

## Ranked inventory

| Priority / integration | Existing implementation and reason | Availability / evidence / remaining requirement |
| --- | --- | --- |
| 1. Workspace code/files | Native `runtime-coding-tools.ts`, mutation/file tools: bounded read/list/write, exact-text patch and single mkdir. Fundamental for coding and avoids another filesystem server with broader authority. | Installed native modules; file/approval/security fixtures. Writes need exact consent and workspace scope. Linux confinement limits apply; no general delete/rename. |
| 2. Safe project verification | `runtime-process-sandbox.ts`: fixed diagnostics plus test/build/typecheck/lint scripts in isolated project snapshot. Produces useful evidence without generic shell authority. | Installed native modules; process-boundary fixtures. Required Linux sandbox fails closed; cloud UID-map restrictions block live isolation. No installation/network or host fallback. |
| 3. Local Git | `runtime-coding-git-tools.ts`: status, explicit-source diff, bounded log, approval-gated exact-path add/commit. Essential review/checkpoint workflow. | Installed native modules; ten fixtures with actual temporary repo Git effects via injected TEST runner. No push, external network, hooks, GPG, PR or worktree support; linked metadata refused. |
| 4. Browser verification | Native scoped Playwright browser session/driver/tools, guarded routes and manual `npm run browser` CLI. Useful for actual frontend interaction and inspection. | `playwright-core` 1.63.0 already installed/pinned, separate browser binary must exist. Explicit task/domain/action grants and input consent; no inherited cookies/profiles. Mocked driver tests do not prove live browser execution. |
| 5. Web research | `runtime-codex-search.ts` and native search-tool wrapper use supported public Responses web search only. Keeps research separate from local tools. | Installed optional modules. Requires user's legitimate OpenAI sign-in, account-visible model and applicable policy; no live login/search performed. No subscription/client-identity borrowing. |
| 6. MCP interoperability | `packages/mcp`: bounded stdio tools adapter, configured server trust/capabilities and cancellation notification. Supports user-selected tools without duplicating each integration. | Installed native client, 59 fixtures (32 schema-validation regressions) including actual local subprocess cancellation. Server is separately configured trusted code; no server/account auto-install or OAuth/HTTP/roots/sampling/elicitation parity claim. |
| 7. Desktop inspection/input | Optional native Windows driver/controller, monitor/window inventory, bounded task and exact input consent. Useful where browser automation cannot inspect an OS workflow. | Installed native code/UI; mock OS bridge and synthetic screenshots. Windows required; platform probe separate. Screenshot preview/export does not automatically send an image to inference. |
| 8. GitHub account workflow | Existing `packages/github` plugin (`harness.github-plugin`) for repository/issues/PR-related tools through the configured API service. Useful for review and collaboration beyond local Git. | Repository plugin already exists; adapter fixtures are not a real account connection. `network:https` and actual supported credentials must be configured; mutations require applicable user approval. No token generation or scope expansion here. |
| 9. Core workflow primitives | `harness.agent-plugin`, `harness.boxes-plugin`, `harness.control-flow-plugin`, `harness.human-approval-plugin`: model/tool loop, bounded flow, persistence/approval integration. | Installed first-party graph primitives, not marketplace connectors. Existing catalog/compiler/behavior tests. Graph scope must constrain offered tools and runtime invocation, including resumed/checkpointed calls. |

The first seven choices already have native implementations; installing alternate shell/filesystem/Git/browser MCP servers would add process trust and possibly duplicate broad authority without filling a demonstrated gap. No third-party plugin, account connection, credential or paid service was installed by this inventory.

## Existing registry and loading boundaries

- `packages/plugin-api` defines versioned manifests, tool/model adapters, declared capabilities and JSON-safe contracts. `packages/plugin-sdk` helps authors define graph nodes.
- `packages/core` has node/tool/model catalogs, immutable manifests, plugin host/config and behavioral policies. `apps/runtime/src/runtime-plugins.ts` discovers configured packages and reports installed/activated/isolated/failure states.
- `packages/plugin-loader` discovers `zet-plugin.json`, validates compatibility/integrity metadata, loads configured packages and supports isolated plugin processes. Package installation from npm/Git is a separate host capability; current installer reports newly installed packages disabled. First-party default catalog behavior does not silently change that third-party installation contract.
- `packages/mcp` is a protocol client, not a server marketplace or blanket authorization. A declared tool capability or external server title is not an execution grant.
- `runtime-daemon.ts` assembles the native tool catalog. Ordinary chat and graph execution must apply the same effective-grant filter; graph allowlists must be checked both when advertising tools and when dispatching a requested call. Graph scope cannot add host authority or route around a denied operation.

Current installed-tool dispatch uses `runtime-agent-plugin-tools.ts`: active registered owner/version/adapter and host grants are checked before and after immutable exact-action consent. Read tools need granted capabilities; effects beyond reads require consent. Malformed/accessor/cyclic inputs are rejected and bounded to 128 KiB, and plugin failures become a private-safe generic refusal. This wrapper does not sandbox arbitrary trusted plugin implementation code or grant its network service access.

`runtime-agent-tool-policy.ts` intersects canonical tool IDs with the current registry, recorded owner/version catalog and model/tool node restrictions. Ambiguous provider aliases or competing adapters are omitted. Tool dispatch rechecks the recorded identity; a captured call cannot gain a newly registered replacement's authority. Child reads inherit the effective parent's fixed read scope; missing scope denies all. `runtime-coding-plugin-scopes.ts` persists separate **tool allowlists for the model node and tool execution node** per conversation (migration 24); null keeps already authorized defaults and [] denies all. These lists do not choose inference models or grant capabilities. UI changes apply to the next task; the current task retains its captured restrictions while grants/ownership remain rechecked.

Evidence: `runtime-agent-plugin-tools.test.ts`, `runtime-agent-tool-policy.test.ts`, `runtime-coding-plugin-scopes.test.ts`, and agent-node regression fixtures cover grant revocation, exact consent, registry replacement, malformed input, alias collisions, recorded catalogs, durable reload and rollback. Parent records final combined test results and exact commit. No live third-party plugin service/network call was used.

## Primary sources, provenance and licenses

| Component / option | Primary reference | Provenance / license and decision |
| --- | --- | --- |
| Playwright | [official browser documentation](https://playwright.dev/docs/browsers), [source license](https://github.com/microsoft/playwright/blob/main/LICENSE) | Microsoft project, Apache-2.0. Reuse installed `playwright-core`; do not add a browser marketplace wrapper. Browser binaries/dependencies have their own distribution requirements. |
| Git | [official command/environment reference](https://git-scm.com/docs/git), [source license](https://github.com/git/git/blob/master/COPYING) | Git is an external host executable, GPL-2.0. Safe fixed argv and isolated execution are harness policy; Git installation does not grant push/account access. |
| Bubblewrap | [official source and license](https://github.com/containers/bubblewrap/blob/main/COPYING) | External Linux sandbox utility; preserve upstream license notices if distributing it. Host kernel capability must be measured, never bypassed. |
| Official MCP SDK | [official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), [license transition](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE) | Current stable v2 uses `@modelcontextprotocol/client` / `@modelcontextprotocol/server`; v1 `@modelcontextprotocol/sdk` is maintenance. Apache-2.0 new contributions with MIT legacy code. **Not added**: consider a pinned migration only for a concrete remote transport/OAuth/resource gap, with compatibility and security tests. |
| MCP discovery | [official registry documentation](https://modelcontextprotocol.io/registry/about) | Registry is metadata and publisher-namespace verification, not a guarantee of code security. It points to external package/remote distributions and delegates scanning. No automatic mass install. |
| GitHub authentication | [official REST authentication](https://docs.github.com/en/rest/authentication/authenticating-to-the-rest-api) | Prefer user-selected fine-grained token or appropriately installed GitHub App with minimum repository permissions. Existing user credentials are not copied into plugin config or expanded. No new grant performed. |
| OpenAI research/inference | [supported plan inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | First-party service contract/account policy applies; protocol availability is not an open-source license or entitlement. Native adapter owns local tool execution. |

First-party harness packages do not currently declare a package-level `license` field; this inventory does not assign them a license or grant redistribution rights. Source availability alone is insufficient. Any new dependency proposal should identify the exact package/version, material missing capability, upstream license, required network/accounts/costs, execution grants and validation before installation.

See [capability boundaries](CAPABILITY-MATRIX.md), [provider authorization](standalone-provider-auth.md) and [exact own-code wording](Harness%20msgs%20to%20the%20models.md). No proprietary service feature or third-party subscription flow is implied by plugin availability.

## Plugin authoring and installation reference

The existing authoring reference is preserved below. Its third-party installation defaults remain distinct from the first-party catalog defaults described above.

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

The first time you open the app it goes straight to **Setup**:

1. **Choose the workspace** — the folder your projects live in. Browse to it, or type its path,
   and press **Use this folder**. New projects start there, and anything an agent does with files
   stays inside it. A whole drive is refused. You can change it later from **Setup**.
2. **Connect a model** — see [Connecting a model](#connecting-a-model).
3. **Start** — create a project and open a conversation.

If the ports are already taken, `npm start` says by which process and whether it is a Zet Harness,
and starts nothing. When it is an earlier harness you want to replace, run:

```sh
npm run restart
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

## Working in more than one folder

The overview leads with **New project**, **Models** and **Plugins**, and lists every folder this
harness has worked in below them. One of them is open at a time:

- **Clicking a folder opens it** and shows its projects. A project belongs to the folder it was
  created in, so **Projects** lists that folder's projects and says how many are elsewhere; the
  link beside it shows all of them.
- **Adding a folder** is the same **Setup** screen that asked for the first one. Each folder you
  open is remembered, so coming back is one click.
- **Forget** takes a folder out of the list and touches nothing on disk. The folder being worked
  in cannot be forgotten — open another one first. A folder that has since been moved or deleted
  is shown as **Not found** until you forget it.

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

- **API credentials.** Pick OpenAI, Anthropic (Claude), Gemini or xAI (Grok), set the
  model name and use a provider API key. Prefer an environment variable to avoid storing it.
  Local Ollama/llama.cpp endpoints need no key by default.
- **Codex native coding agent.** Run `npm run codex -- help`. The official CLI owns login,
  approvals, skills, tools and saved sessions. Its history is separate from Zet graph runs.
  Claude and Grok subscription OAuth are not offered. See [capability evidence](./CODEX-CAPABILITIES.md).


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

### Boxes: text in, text out

The first three nodes in the palette are the simplest way to use a model, with no project or
conversation involved:

- **Text box** — type into the box on the canvas. Its `text` output carries what you typed.
- **Model** — sends whatever reaches its `prompt` to a model and puts the answer on its `text`
  output. Leave **Model id** empty to use any connected model, or name one from the Models page;
  **Instructions** are sent ahead of the prompt.
- **Output box** — shows the text that reaches it. Press **Run graph** and the run's page shows the
  answer inside the box.

Every one of these ports carries text, so they connect any way that reads sensibly: a Text box
into a Model, a Model into an Output box, or one Model's `text` into another Model's `prompt` to
chain them. A Model given an empty prompt stops with "A model was given no text".

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
