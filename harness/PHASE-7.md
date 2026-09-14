# Phase 7 — Visual graph editor and run inspector

## Delivered scope

The web app now has a graph editor at `/editor`, a run list at `/runs` and a live run inspector at
`/runs/<id>`. The runtime gained the endpoints they need. Together they close the Harness v0.1
loop: draw or load a graph, have the real compiler check it, run it through enabled plugins, pause
for a person, resume, and inspect durable execution afterwards.

This covers TODO items 7.1–7.11. It does not change Graph JSON, Execution IR, compiler identity,
the scheduler, or any database migration.

## Architecture

The UI stays a client. Nothing in the browser compiles, schedules or decides permissions.

```text
browser ──► Next.js route handlers (/api/editor/*) ──► runtime daemon (/api/nodes, /api/graphs,
            loopback + same-origin guard                 /api/runs, /api/approvals)
            CSRF token fetched server-side               real compiler, dispatcher, SQLite
```

### Runtime endpoints

| Route | Purpose |
|---|---|
| `GET /api/nodes` | Node manifests from the plugin host and isolated sandboxes, with plugin id and tier |
| `POST /api/graphs/validate` | Runs the full compiler chain and returns located diagnostics |
| `POST /api/runs` | Compiles, stores source + plan + a pending run in one commit, wakes the dispatcher |
| `GET /api/runs` | Recent runs |
| `GET /api/runs/:id` | Redacted run view: graph, durable frontier, attempts, event types |

Every POST requires the session CSRF token. Bodies are capped at 1 MiB. A graph the compiler
rejects returns `422` with diagnostics; reusing a revision id with different content returns `409`.

The daemon now always registers the built-in **Human approval** node, and `main.ts` always loads
plugins from a directory (`apps/runtime/plugins/`, or `ZET_RUNTIME_PLUGINS_DIR`). Before this, the
`npm start` path never loaded plugins at all.

### Web proxy

Because the proxy obtains the CSRF token on the server, it must not become a way around it. Every
`/api/editor/*` handler therefore:

- accepts only a loopback `Host`, which also defeats DNS rebinding;
- refuses requests the browser marks `cross-site` or `same-site`, and any foreign `Origin`;
- requires `application/json` on mutations, which a cross-site form cannot send without a preflight.

Next.js is bound to `127.0.0.1` (`next dev -H` / `next start -H`), since it otherwise listens on
every interface. Approval decisions request a single-use resume token and spend it within the same
server-side request, so the token never reaches the page.

## Editor (7.1–7.7)

- **React Flow only on the editor side (7.1).** `@xyflow/react` is a web dependency loaded through
  `next/dynamic` with `ssr: false`; no runtime package depends on it.
- **Graph JSON is the state (7.2).** React Flow nodes and edges are derived from the document on
  every render, and every gesture is written back. Autosave, export and run all use plain Graph
  JSON. Layout lives in the document's `editor` metadata, which the compiler strips before hashing,
  so moving a node never changes a graph's semantic identity.
- **Plugin palette (7.3).** Entries come from `GET /api/nodes` and show the node type, plugin id and
  whether it runs isolated.
- **Schema forms (7.4).** Configuration and unfed input literals render from JSON Schema: enum
  select, boolean, number/integer with bounds, string, and a JSON fallback for anything richer.
- **Connections (7.5).** Handles are the manifest's ports. A quick local check refuses obviously
  invalid connections (self-loops, a second source into one port). The compiler is the authority:
  the document is validated 450 ms after its executable content changes, and layout-only edits do
  not trigger a compile.
- **Diagnostics in place (7.6).** Diagnostics with a node or edge id are drawn on that node or edge;
  the rest are listed in the graph panel.
- **Run (7.7).** The editor derives entrypoints (nodes nothing feeds), outputs (ports of nodes
  nothing reads) and an execution bound covering every node, stores a fresh revision and opens the
  run inspector.

Clicked palette items are placed at the centre of the canvas and moved clear of existing nodes, so
adding several in a row never stacks one on top of another.

## Run inspector (7.8–7.11)

- **Live state (7.8).** Node status comes from the runtime's durable frontier, polled every second
  until the run ends. The overlay shows what the runtime would resume from after a restart, not a
  browser-side guess. Edges into a running node animate.
- **Timeline (7.9).** Durable event types in order with relative time; selecting a row selects its
  node.
- **Node inspector (7.10).** Configuration, inputs, permissions, effect/idempotency/recovery, every
  attempt with status, duration, outputs, error and usage, and the node's events.
- **Approval cards (7.11).** Pending approvals for the run are polled while it is active. Approve or
  Reject resumes the run through the durable approval record.

## Known limits

- The inspector shows what the runtime records per node today. Model routes, tool calls, logs,
  checkpoints and artifacts are not recorded per node yet, and the inspector says so rather than
  showing empty sections. Event payloads are not shown; values come from redacted attempt records.
- Control edges are preserved in the document but not drawn.
- The editor does not yet author graph inputs, secret bindings or policies beyond the derived
  execution bound; imported documents that carry them are kept and compiled as they are.
- React Flow keeps a node hidden until its size has been measured, so a canvas in a window the
  operating system is not painting can show no nodes until it is brought forward.

## Verification

- `runtime-graphs.test.ts`: palette composition, compile success and located failures, run creation
  and revision conflicts, redacted run views, and an editor graph dispatched to completion through
  a plugin executor.
- `runtime-graph-http.test.ts`: a daemon loading a real plugin package from disk serves the palette,
  refuses POSTs without the CSRF token, validates, runs a graph end to end, pauses on a Human
  approval node and completes after a fresh resume token is issued and spent.
- `local-request-guard.test.ts`: loopback hosts, rebinding host names, fetch metadata, foreign and
  cross-port origins, JSON-only mutations.
- `graph-document.test.ts`: node placement, literal/edge interaction, node removal, derived
  entrypoints/outputs/bounds, and tolerant parsing of untrusted documents.
- Manual browser check against a daemon with an in-process and an isolated plugin: add nodes,
  connect them, type a literal, see the compiler accept the graph, run it, inspect the `HELLO!`
  output, and approve a paused run from its approval card.

## Try it

From `harness/`:

```sh
npm start
```

Copy [`examples/hello-plugin/`](./examples/hello-plugin/README.md) into `apps/runtime/plugins/`,
enable it in `apps/runtime/plugins/plugins.json`, restart, and open `http://127.0.0.1:3000/editor`.
