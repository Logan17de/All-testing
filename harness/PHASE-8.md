# Phase 8 — Structured loops, projects and agent mode (in progress)

## Why routers and joins come first

8.1 asks for explicit bounded loop regions. The frozen loop contract (`entry`, `continue`, `body`,
`exit` control ports) describes a region inside the graph whose back edge the scheduler re-arms on
every iteration. That builds on control flow the runtime could not yet execute:

- `RunRouterActivation`, `RunJoinActivation` and `RunControlEdges` existed from Phase 3 as tested
  building blocks, but `PlainDagRun` refused every op with a control descriptor.
- The durable dispatcher refuses control ops and any iteration other than zero.
- The durable frontier already records control-edge states and router selections keyed by
  iteration, so the storage side anticipated this work.

Loops are therefore delivered in slices, each committed on its own.

## Slice 1 — routers and joins execute inside a run (done)

`PlainDagRun` now executes plans containing routers and activation-aware joins.

- **Branch decisions are host-owned.** `PlainDagRunOptions.control.selectRouterBranch` receives the
  router op, its declared branches and the run's abort signal. A plan with a router and no hook is
  refused at construction; branches are never all activated as ordinary fan-out. An undeclared
  answer, or a failing decision, fails the run.
- **Control ops are scheduler-owned.** Routers and joins take no concurrency permit and run no
  executor.
- **Completion drives the control state.** A completed ordinary op completes its outgoing control
  edges. Dependencies into a join's control lanes are released by join reconciliation, not directly.
- **Skips cascade.** An op is skipped when every control edge from one of its sources was skipped,
  or when a source that feeds it data was skipped, since it can never receive that input. This
  repeats with join reconciliation until nothing changes, and skipped ops count as finished when
  the run settles.
- **The snapshot shows control truth.** Runs with control ops report `controlEdges` and
  `routerSelections`.
- **Loops and subgraphs are still refused.**

Covered by `packages/scheduler/src/structured-control-run.test.ts`.

## Slice 2 — durable, restart-safe routers and joins (done)

Graphs with routers and joins now run through the durable dispatcher and survive a restart.

- **One implementation of the rules.** `RunStructuredControl` in `@zet-harness/scheduler` holds the
  router, join and skip logic. The live run uses it, and so does `reduceStructuredControlFrontier`,
  which applies one completion, branch choice or join completion to a committed frontier. Durable
  commits therefore record exactly the consequences the live scheduler computes.
- **Atomic control commits.** A branch choice commits the router-selection event, the router's
  completion, every edge that finished or was skipped, and every op that became ready or was
  skipped, in one transaction, before the run acts on it. The same happens for a join's completion,
  and for the consequences of an ordinary op or an approved human gate completing.
- **Restores rebuild released dependencies.** In a plain DAG a dependency is released when its
  source completes. With routers and joins that no longer holds, so `deriveReleasedDependencies`
  reconstructs the released set from op statuses, edge states and branch choices, and restore
  refuses a frontier those facts contradict.
- **Branch choice comes from the graph.** A router follows the branch named by the string on its
  `branch` input; a missing or undeclared name fails the run.
- **Checkpoints keep branch choices.** Approval checkpoints now store router selections. Before
  this, a branch chosen before an approval checkpoint would have been lost on replay.
- **Human gates inside branches.** Approvals accept graphs with routers and joins, and approving a
  gate releases and skips downstream work through the shared reducer.
- **Visible in the run inspector.** Skipped (and cancelled) nodes are drawn dashed and dimmed.

Covered by `structured-control-restore.test.ts` (every committed point of a routed run resumes to
the same outcome as an uninterrupted run) and `apps/runtime/src/runtime-structured-dispatch.test.ts`
(both branches, an undeclared branch, and a restart while the chosen branch waits for approval).

## Slice 3 — built-in control nodes and control edges in the editor (done)

Routing is now usable without writing a plugin.

- **First-party control flow.** `createControlFlowPlugin()` in `@zet-harness/core` registers, through
  the public plugin path, a **Condition** node (`equals`, `not-equals`, `contains`, `truthy`,
  `falsy`; outputs `branch` as `yes` or `no`, plus `matched`), a **Route** router with `yes` and
  `no` branches, and **Wait for all** / **Wait for any** joins with lanes `a` and `b`. The daemon
  always registers it. Route and the joins declare no executor.
- **Control edges on the canvas.** Nodes show control handles above (in) and below (out) and data
  handles on the sides. Structured control nodes expose exactly their contract's named ports, which
  the compiler requires; other nodes get one unnamed ordering port on each side. Control edges are
  drawn dashed. A control handle can only connect to a control handle, and a data handle only to a
  data handle.
- **The run inspector draws them too**, alongside skipped nodes.
- **Placement** leaves room for the taller control-flow nodes.

Covered by `packages/core/src/control-flow-plugin.test.ts`, the control-port tests in
`apps/web/lib/graph-document.test.ts`, and an HTTP test that routes an editor graph through
Condition, Route and Wait for all on a running daemon.

## Slice 4 — loop regions in the compiler (8.1, compile side; done)

Graphs with a structured loop now compile. Running them is the next slice, so until then the
runtime refuses to store a run for a graph containing a loop (`422 GRAPH_INVALID`), instead of
accepting one that could never progress.

- **A loop's body.** `findGraphJsonV1LoopRegions` defines the body of a loop node as everything
  reachable from control edges leaving its `body` port, without passing back through the loop and
  without entering work that follows its `exit` port. Per-iteration side work that does not feed
  back is part of the body.
- **Back edges.** Edges from the body into the loop node close the cycle. Only the `continue`
  control port and the loop's data inputs may be re-entered this way.
- **Acyclicity keeps its meaning.** Given a resolver, 2.10 leaves out exactly those validated back
  edges and still rejects every other cycle. Without a resolver it behaves as before, so the
  boundary stays explicit.
- **Rules, each with its own diagnostic:** `GRAPH_LOOP_REGION_INCOMPLETE` (no body or no way back),
  `GRAPH_LOOP_BACK_EDGE_INVALID` (re-entering through another port, or reaching `continue` from
  outside the body), `GRAPH_LOOP_REGION_ESCAPE` (body work ordering work after the loop; a data
  edge that reads the last iteration's value after the loop exits is allowed),
  `GRAPH_LOOP_REGION_NESTED` (nested loops are refused for now) and
  `GRAPH_LOOP_REGION_ENTRYPOINT` (no entrypoint inside a body).
- **Lowering.** The Execution IR loop descriptor, reserved since 2.20 and never produced before, now
  carries the body `region` (op indexes) and `maxIterations`. Back edges stay control edges and
  data inputs but add no scheduler dependency, so the loop never waits on its own body.
  `createExecutionIrV1` checks the region is strictly increasing and excludes the loop op. Because
  no loop could compile before, no existing plan or compiler identity changes.

Covered by `packages/graph/src/graph-json-v1-loop-regions.test.ts` (regions, every diagnostic, the
full diagnostics stack, lowering and the IR invariant) and a runtime test that compiles a loop
graph and confirms no run is stored.

## Slice 5 — iterations in the scheduler (8.1, in-memory; done)

`PlainDagRun` now iterates loop bodies.

- **The loop op holds its place.** A dequeued loop op starts running without an executor or a
  concurrency permit, releases its body, and stays running while the body iterates, so nothing
  after the loop can start early.
- **Iterations.** When every body op has finished an iteration, the host's `continueLoop` hook
  decides whether to run another, unless `maxIterations` is reached, which always exits without
  asking. A plan with a loop and no hook is refused. A durable host's `loopAdvanced` hook records
  each `continue` or `exit` decision before the run acts on it.
- **Re-arming.** A new iteration returns the body ops to pending, waiting only on each other
  (`RunReadiness.rearmOp`, the one sanctioned way out of a terminal state), with a fresh attempt
  count and retry budget. Executors, completion barriers and durability hooks now receive the
  `iteration` an attempt belongs to.
- **Leaving.** Body ops never release work outside the body per iteration. When the loop exits,
  it completes and releases the work after it, including readers of the last iteration's values.
- **With routers and joins.** Control edges inside a body are reset for every iteration, and a
  loop's exit edges finish when it completes, so a loop can sit on a router's branch.
- **Not yet:** routers, joins, loops or human gates inside a loop body, and restoring a run that
  contains a loop. Both are refused explicitly.

Covered by `packages/scheduler/src/loop-run.test.ts`.

## Slice 6 — durable loops (8.1 complete, and 8.3)

Loops now run through the durable dispatcher, survive a restart in the middle of a loop, and can be
built in the editor.

- **Iteration identity (8.3).** Frontier events, invocations and attempts are keyed by iteration,
  so every iteration of a body op has its own logical effect id and attempt history. Recovery keeps
  every iteration's state, and the dispatcher schedules from the latest one.
- **Committed loop steps.** Entering a loop commits the loop op as running and releases the start of
  its body. Each decision commits either the next iteration of every body op, or the loop's
  completion together with the work after it, before the run acts on it. A body op's completion
  releases only the rest of its body.
- **Values across iterations.** Inside a body, an op reads outputs from the same iteration.
  Everywhere else, including the loop's own `again` input and work after the loop, a value is the
  source's latest completed one.
- **Deciding.** A loop continues while its `again` input is `true`; without an `again` input it runs
  to `maxIterations`. Any other value fails the run.
- **Restart.** The scheduler restores a running loop op and its iteration numbers, rebuilds which
  dependencies are released under loop rules, and takes any decision a restart interrupted.
- **Built-in Loop node.** `harness.loop` has control ports `in`, `repeat`, `body` and `done`, an
  optional boolean `again` input, and `maxIterations` from 1 to 1000. The editor raises a graph's
  execution bound to cover its largest loop.
- **Run inspector.** Nodes carry their current iteration, and attempts are labeled by iteration.
- **Still refused:** loops together with routers or joins in one graph (`422` when the run is
  created), and routers, joins, loops or human gates inside a loop body.

Covered by `packages/scheduler/src/loop-restore.test.ts` and the durable loop tests in
`apps/runtime/src/runtime-structured-dispatch.test.ts`: running to the bound, leaving on
`again: false`, and resuming in a fresh runtime after pausing between iterations.

## Slice 7 — hard limits for runs and loops (8.2, partly done)

The limits a graph already declares are now enforced, and loops gain a time bound of their own.

- **Node executions.** A graph's `maxNodeExecutions` counts every attempt across all ops, retries and
  loop iterations. The attempt that would pass the limit is refused before it starts, and the run
  fails with `RUNTIME_BUDGET_EXCEEDED`. A `harness.run.budget-exceeded` event records which limit.
- **Run wall time.** A graph's `maxWallTimeMs` is checked the same way before each attempt, counted
  from the moment the run started, including time spent waiting for a person. Node code that is
  already running is not interrupted; node timeouts cover that.
- **Loop wall time.** A loop node may set `maxWallTimeMs`. 2.12 validates it, lowering carries it on
  the loop descriptor, and once it has passed since the loop was entered the loop exits at its next
  decision instead of starting another iteration. Routers, joins and loop decisions start no
  attempt, so they are never charged.
- **Why a loop ended.** Every loop decision event now records its reason: `max-iterations`,
  `max-wall-time` or `again-false`.
- **Not yet: model calls, tool calls, tokens and cost.** No graph node calls a model or a tool yet;
  adapters are registered in their catalogs but nothing in a graph invokes them, so there is
  nothing to count. Those bounds arrive with the model and tool nodes the agent loop (8.12) needs,
  and TODO 8.2 stays open until then.

Covered by the wall-time cases in `graph-json-v1-loop-bounds.test.ts`, lowering in
`graph-json-v1-loop-regions.test.ts`, and runtime tests for the node-execution limit, the run
wall-time limit, a loop leaving on its own wall-time bound, and recorded decision reasons.

## Slice 8 — subgraphs (8.4)

A graph can run another saved graph in place, and the compiler flattens it before anything runs.

- **The node.** `harness.subgraph` is a built-in control node with an `in` entry and a `done` exit.
  Its config pins a saved graph with `graphId` and `revisionId`. A plugin can declare its own node
  with a `{ kind: "subgraph", entry, exits }` contract; it behaves the same way.
- **Compile-time expansion.** `expandGraphJsonV1Subgraphs(graph, resolver, sources)` runs right
  after the shape check, before every other stage. It replaces each subgraph node with the saved graph's nodes and edges under the
  subgraph node's id (`call/a`, `call/b`), so every later stage validates, lowers and hashes one flat
  graph, and the scheduler, durability and run inspector need nothing new.
- **Wiring.** Data edges and values set on the subgraph node feed the saved graph's inputs by name,
  falling back to each input's default. Edges reading the subgraph node's ports read the saved
  graph's outputs. Work before the subgraph node runs before the saved graph's start nodes, and work
  after it waits for every one of the saved graph's final nodes. An entrypoint on the subgraph node
  moves to the saved graph's start.
- **Budgets and capabilities.** The saved graph's `maxNodeExecutions` is added to the parent's, and
  its capability requirements and denials are merged with the parent's, so nothing inside a subgraph
  escapes the policy check.
- **No uncontrolled recursion.** A subgraph that runs a graph already on its own chain fails with
  `GRAPH_SUBGRAPH_RECURSION`, and nesting stops at 8 levels (`GRAPH_SUBGRAPH_TOO_DEEP`). Missing
  revisions, malformed references, unknown ports and required inputs left unset each have their own
  diagnostic.
- **Pinned and immutable.** The runtime resolves references against `graph_sources`, where a graph
  id and revision id pair can never change once stored. Any graph that has been run can be used as a
  subgraph. Diagnostics from inside an expanded subgraph point at the subgraph node the author placed.

Covered by `graph-json-v1-subgraphs.test.ts` (splicing, ports, defaults, final nodes, entrypoints,
nesting, recursion, missing graphs, budgets) and runtime tests that run a stored graph through a
subgraph node end to end and report a missing revision on the subgraph node.

Still to come for subgraphs: choosing a saved graph from a library in the editor, and showing the
saved graph's inputs and outputs as handles on the subgraph node.

## Slice 9 — projects (8.5)

Projects are the durable home that conversations, goals, todos and agent runs attach to next.

- **Storage.** Migration 8 adds a `projects` table: a sortable id, a name (1–200 characters), a
  description (up to 4000), an optional absolute workspace folder, a status of `active` or
  `archived`, and UTC epoch-millisecond creation, update and archive times. SQLite checks every
  bound itself, requires the status and archive time to agree, and refuses deletes and changes to a
  project's id or creation time through triggers.
- **Archive, never delete.** A project is archived and restored instead of deleted, so later
  conversations and runs never lose the project they belong to. An archived project refuses changes
  until it is restored, and archiving or restoring twice changes nothing.
- **Records API.** `@zet-harness/db/durable-project-records` provides `createProject`,
  `readProject`, `listProjects` (most recently changed first, by status), `updateProject`,
  `archiveProject` and `restoreProject`. Input is validated before SQL with field-level
  `PROJECT_INVALID` errors. A clock that steps backwards never moves a project back in the list.
- **HTTP.** The runtime serves `GET /api/projects?status=active|archived|all`,
  `POST /api/projects`, `GET /api/projects/:id`, `POST /api/projects/:id`, and
  `POST /api/projects/:id/archive` and `/restore`. Every POST passes the same CSRF check as the
  editor and approval endpoints, unknown fields are refused, and each write is one serialized SQLite
  commit. Errors are `PROJECT_INVALID` (400), `PROJECT_NOT_FOUND` (404) and `PROJECT_ARCHIVED` (409).
- **Sortable ids (start of 8.8).** `@zet-harness/db/sortable-id` generates RFC 9562 UUIDv7 ids: the
  first 48 bits are the creation time, so ids sort by creation time as text, and a per-generator
  counter keeps ids in order within one millisecond and across a clock that steps backwards.
  Projects use them now; conversations, messages, goals and todos will too.

Covered by `sortable-id.test.ts`, `durable-project-records.test.ts` (validation, ordering, archive
and restore transitions, clock steps, and the table's own triggers and checks) and
`runtime-project-http.test.ts`, which drives a real daemon through the full lifecycle, the CSRF and
validation refusals, and a restart that keeps the project.

## Slice 10 — conversations and messages (8.6)

A project now holds conversations, and a conversation holds an append-only tree of messages.

- **Conversations.** Migration 9 adds `conversations`: a sortable id, the project it belongs to, an
  optional title (up to 200 characters), `active` or `archived`, and epoch-millisecond times. Like
  projects they are archived and restored, never deleted, and keep their id, project and creation
  time. Conversations and messages only change while their project is active.
- **Structured message parts.** A message's `content_json` is an array of parts that mirror the
  model adapter contract (`text`, `image`, `tool-call`, `tool-result`) plus `reasoning`, which is
  stored as its own part and never folded into text. Parts must fit the role: only assistant
  messages carry reasoning or call tools, only tool messages carry tool results and nothing else,
  and system and developer messages carry text. Unknown kinds and fields are refused, tool
  arguments must be JSON objects, and one message's parts are capped at 1 MiB.
- **Branches, not edits.** Messages are append-only. `parent_message_id` is nullable and must name a
  message in the same conversation (a composite foreign key enforces it). Omitting the parent
  continues from the latest message; naming an earlier message branches from it, which is how an
  edit or a retry is stored; `null` starts a new root. `readMessagePath` returns one branch from
  its root, oldest first.
- **Usage captured at write time.** Messages carry the model name, the run that produced them, and
  input, output, cached-input and reasoning token counts plus a cost as a decimal string with an ISO
  4217 currency, because these exist only in the provider response.
- **HTTP.** `GET`/`POST /api/projects/:id/conversations`, `GET /api/conversations/:id` (the
  conversation and every message), `POST /api/conversations/:id` (retitle), `.../archive`,
  `.../restore`, `POST /api/conversations/:id/messages` (`role`, `parts`, optional
  `parentMessageId`) and `GET /api/conversations/:id/messages/:messageId/path`. Every POST passes the
  shared CSRF check and is one serialized commit. Clients cannot set a message's run, model or usage;
  the agent loop (8.12) records those.

Covered by `durable-conversation-records.test.ts` (project rules, archive and restore, default and
explicit parents, branch paths, part and role validation, usage, append-only triggers, and the run
foreign key) and `runtime-conversation-http.test.ts`, which drives a daemon through a conversation
with a retry branch and every refusal.

## Slice 11 — goals and todos (8.7)

A project now holds goals, and a goal holds ordered todos that can depend on each other.

- **Goals.** Migration 10 adds `goals`: a sortable id, the project, an optional conversation of that
  same project it came from, a title, a description, a priority from 0 (most urgent) to 1000
  (default 100), and a status of `open`, `blocked`, `completed` or `cancelled`. A blocked goal
  carries a reason, a completed or cancelled goal carries a close time, and SQLite checks both.
- **Todos.** `todos` belong to one goal and carry a title, description, priority, a position within
  the goal (new todos go last), and a status of `pending`, `in_progress`, `blocked`, `done` or
  `cancelled`, with a blocked reason, the time work first started and the time it finished. Todos
  list by priority, then position, then age.
- **Valid transitions.** `GOAL_STATUS_TRANSITIONS` and `TODO_STATUS_TRANSITIONS` list every allowed
  change, and anything else fails with `GOAL_TRANSITION_INVALID` or `TODO_TRANSITION_INVALID`.
  Blocked work is unblocked before it can complete, and finished work is reopened before it can
  change. A goal completes only when none of its todos are pending, in progress or blocked
  (`GOAL_HAS_OPEN_TODOS`), and a closed goal refuses changes to itself and its todos
  (`GOAL_CLOSED`).
- **Dependencies.** `todo_dependencies` links todos of the same goal (composite foreign keys enforce
  it). Dependency cycles are refused (`TODO_DEPENDENCY_CYCLE`). A todo starts or is done only once
  every dependency is done (`TODO_DEPENDENCIES_UNFINISHED`), and a done todo reopens only while
  nothing depending on it has started (`TODO_HAS_STARTED_DEPENDENTS`). This is what next-runnable
  selection (8.9) builds on.
- **Never deleted.** Goals and todos are closed or cancelled, never deleted, and keep their ids,
  owners and creation times. Every change moves the goal's update time forward.
- **HTTP.** `GET`/`POST /api/projects/:id/goals`, `GET /api/goals/:id` (the goal and its todos in
  order), `POST /api/goals/:id`, `POST /api/goals/:id/status`, `POST /api/goals/:id/todos`,
  `GET /api/todos/:id`, `POST /api/todos/:id` and `POST /api/todos/:id/status`. Every POST passes the
  shared CSRF check and is one serialized commit.

Covered by `durable-goal-records.test.ts` (creation rules, both transition tables, completion with
open todos, closed goals, ordering, dependency scope, cycles, dependency-gated starts and reopens,
and the tables' own checks and triggers) and `runtime-goal-http.test.ts`, which plans and completes
a goal with dependent todos over HTTP and checks every refusal.

## Slice 12 — one id and time format (8.8)

Every id a person, an agent or an external adapter can hold is now a time-ordered UUIDv7, and every
stored time is UTC epoch milliseconds.

- **Sortable ids everywhere they are exposed.** Projects, conversations, messages, goals and todos
  already used `@zet-harness/db/sortable-id`. Run ids (`run-…`), approval ids (`approval-v1:…`) and
  logical effect ids (`zet-effect-v1:…`) now use it too, behind their existing prefixes, so nothing
  that stores or parses them changes shape. Within one process the generator is strictly increasing,
  so ids of the same kind sort in creation order as plain text.
- **Integer sequences stay where they are cursors.** Event ids, checkpoint ids, file-change ids and
  compiled-plan ids remain SQLite integer sequences. They never leave one database, they are the
  cheap ordered cursor that event replay and checkpoints rely on, and renumbering them would be a
  data migration with no benefit to anyone outside the runtime.
- **Epoch milliseconds only.** Every stored time column is an `_ms` integer with a non-negative
  check; there are no local times and no date strings in the schema or the runtime code.

Covered by the UUIDv7 and ordering assertions for logical effect ids in
`durable-node-invocation.test.ts`, for run ids in `runtime-structured-dispatch.test.ts`, and for
approval ids in `runtime-human-approvals.test.ts`, alongside the generator's own tests.

## Next

Deterministic next-runnable-todo selection (8.9). After that, the context builder and agent loop
(8.10–8.13) bring the model and tool nodes that complete 8.2.
