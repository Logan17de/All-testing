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

## Slice 13 — the next runnable todo (8.9)

Given a project, the runtime can now say exactly which todo should be taken next, and the answer
never depends on timing or insertion luck.

- **What is runnable.** A todo is runnable when it is `pending`, every todo it depends on is `done`,
  its goal is `open` (not blocked, completed or cancelled) and its project is active. A todo already
  `in_progress` is claimed and is not offered again.
- **One total order.** Runnable todos are ordered by goal priority, then the older goal, then todo
  priority, then position, then the older todo. Every key is a stored value and the last two are
  unique sortable ids, so the order has no ties and the same data always gives the same answer. Goal
  priority comes first: work on the most urgent goal is finished before a less urgent goal's urgent
  todo starts.
- **Records API.** `listRunnableTodos(connection, projectId, { goalId?, limit? })` returns
  `{ todo, goal }` pairs in that order, and `selectNextRunnableTodo` returns the first or
  `undefined`. Selection is a read: an agent claims a todo by moving it to `in_progress`, which
  already refuses a todo whose dependencies are unfinished.
- **HTTP.** `GET /api/projects/:id/todos/next` returns `{ todo, goal }` or both as `null`, and
  `GET /api/projects/:id/todos/runnable` returns the ordered list. Both accept `goalId`, and the list
  accepts `limit`.

Covered by `durable-next-todo.test.ts` (the full ordering, dependency release, claimed todos,
priority changes, goal scope, limits, blocked and closed goals, blocked todos and archived projects)
and `runtime-next-todo-http.test.ts`, which walks a project's todos to completion over HTTP.

## Slice 14 — the context builder (8.10)

Before the agent loop can call a model, it needs to decide what the model sees without ever silently
exceeding what the model can take. `@zet-harness/core` now has a pure, deterministic context builder
for that.

- **Sections.** Context is a list of sections emitted in order, each a list of `ModelMessage`s.
  Required sections, such as the system policy and the active goal, are never cut. Optional sections,
  such as the conversation branch, lose their oldest messages first.
- **Hard token budget.** `buildModelContext` keeps the context within `budget.maxTokens`. Each
  provider can pass a `countTokens` hook. When there is none, or it returns nothing, a non-integer, a
  negative number or throws, that text is counted with a conservative estimate of one token per three
  UTF-8 bytes, and the report says fallback counting was used. Every message adds a fixed framing cost
  and images a fixed, deliberately high cost.
- **Hard byte caps.** A section may carry its own `maxBytes`, and the budget may carry a total
  `maxBytes`. Byte caps hold even when token counting is wrong or unavailable, so a tokenizer
  failure can never let an oversized request through.
- **Safe truncation.** Section caps apply first, then the total budget. While the context is over
  either limit, the earliest optional section that still has messages loses its oldest message, and a
  tool result left without the call that asked for it goes too. If required sections alone do not
  fit, the build fails with `CONTEXT_REQUIRED_OVER_BUDGET` (or `CONTEXT_SECTION_OVER_CAP` for one
  section) instead of sending a model a policy or goal it cannot see in full.
- **Budgets from models.** `contextBudgetForModel` derives `maxTokens` from a model's declared
  `contextWindowTokens` minus the tokens reserved for its reply. An undeclared window fails with
  `CONTEXT_WINDOW_UNKNOWN`, the same rule model routing already applies.
- **A report, not just messages.** The result carries total tokens and bytes, the budget, and for
  every section what was kept and dropped. It is JSON-safe, so the agent loop can record it in the
  run trace.

Covered by `context-builder.test.ts`: fitting context, oldest-first truncation that never touches
required sections, identical results on repeated builds, every fallback-counting case, section and
total byte caps under a counter that underestimates, tool-result pairing, every refusal, and budgets
derived from model manifests. Turning stored projects, goals, todos and conversation branches into
these sections is part of the agent loop (8.12).

## Slice 15 — goal and todo actions a model can call (8.11)

A model can now plan and track its own work through tools, within one project and without being
able to damage anything a retry or a mistake would otherwise repeat.

- **Eight actions.** `createGoalActionTools({ database, projectId })` returns tool adapters for
  `harness.goals.list`, `harness.goals.get`, `harness.goals.create`, `harness.goals.set-status`,
  `harness.todos.create`, `harness.todos.update`, `harness.todos.set-status` and
  `harness.todos.next`. Each has a strict JSON input schema (`additionalProperties: false`) and a
  description written for the model. `goalActionToolSpecifications` turns them into the
  `ModelToolSpecification`s a model request carries, with provider-safe names such as
  `harness_goals_create`.
- **Confined to one project.** The tools are bound to a project when they are created. A goal or
  todo id from another project is reported as not found, and nothing about it is revealed.
- **Refusals the model can act on.** Invalid input, an unknown id, an invalid status transition or
  a goal with open todos comes back as `{ ok: false, error: { code, reason, field? } }`, the same
  codes the HTTP API uses, so the model can correct itself. Only infrastructure failures throw.
  A refused write rolls back to a savepoint, so it changes nothing.
- **Applied once, even when retried.** Write actions declare `external-write` with
  `idempotency-key`. Each write runs in one serialized commit that first looks up the invocation's
  logical effect id, the action and a SHA-256 of the canonical input in `goal_action_effects`
  (migration 11, append-only). A retried attempt gets the recorded result back instead of acting a
  second time; a different input under the same effect id is a different action. Reads declare
  `external-read` and are answered from current records.
- **Valid tool metadata.** Every action's behavior passes the same node-behavior policy the tool
  catalog enforces.

Covered by `runtime-goal-actions.test.ts`: the model-facing names, schemas and behavior policy, a
goal planned and completed through the actions in dependency order, refusals for every kind of
mistake with nothing changed, project confinement, and retried writes, including a retried
refusal, returning the recorded result.

## Slice 16 — the bounded agent loop (8.12)

A model can now work on a project autonomously, one bounded step at a time, through the same
structured loop, scheduler, durability and budgets as every other graph.

- **Two steps, one loop.** `createAgentPlugin` registers `harness.agent-model` and
  `harness.agent-tools`. An agent graph is an ordinary Loop: its `body` runs the model step, then
  the tools step, which returns to `repeat`, and the model step's `again` output (true when the model
  asked for tools) feeds the loop's `again` input. The loop's `maxIterations` is the hard bound on
  model turns, the run's `maxNodeExecutions` and wall time still apply, and a `stop` reply ends the
  loop early. The daemon activates the plugin next to control flow, so the steps appear in the
  editor palette.
- **Model step.** It reads the conversation's latest branch, drops stored reasoning, and builds
  context with the 8.10 builder inside the chosen model's declared window: the system prompt and a
  bounded summary of open goals and the next runnable todo are required, and the oldest
  conversation goes first. It routes a model that supports tools (or the pinned `modelId`), offers
  the 8.11 goal and todo actions plus any plugin tools whose capabilities are granted, and appends
  the reply with its model, run and provider usage. The node's usage records the chosen model, the
  routing rule and the context report.
- **Tools step.** It runs the tool calls in the latest assistant message and appends one tool
  message with every result. An unknown tool or a tool that throws becomes an error result the model
  sees on its next turn, not a failed run. `allowedTools` can narrow what is offered.
- **Durable and applied once.** Each step commits its message together with a record in
  `agent_steps` (migration 12, append-only), keyed by the op invocation's logical effect id. A
  retried attempt of a step that already completed answers from the record without calling the
  model or appending again, and every tool call runs under its own effect id derived from the
  step's, so goal actions apply once even when the tools step is retried.
- **Host-only execution.** The steps' manifests compile like any node, but their `execute` refuses
  to run; only the runtime's agent executor, which has the run's identity, conversation and retry
  budget, can take a step. Every other node still goes to the plugin executor.
- **What 8.2 still needs.** Model turns are now bounded by the loop and each request by the token
  budget and `maxOutputTokens`, but run-wide model-call, tool-call, token and cost budgets are not yet
  enforced, so TODO 8.2 stays open.

Covered by `agent-plugin.test.ts` and `runtime-agent-loop.test.ts`: a full model→tool→model run that
creates a goal through a tool call and ends on a text reply, with messages linked to the run and the
second model request seeing the tool result and the new goal; a model that never stops, halted at the
loop's hard bound; and a retried model step answered from its record without a second model call or
message.

## Slice 17 — blocked goals and goal completion (8.13)

Goals now follow their todos: they complete when the work is done, block when the work cannot
move, and reopen when it can, without ever overriding a person.

- **Who blocked a goal.** Migration 13 adds `blocked_by` to goals: `person` when someone blocked it
  through the API or a goal action, `todos` when its own todos did. Triggers keep it set exactly while
  a goal is blocked, and goals blocked before the migration count as blocked by a person.
- **`reconcileGoalProgress`.** An open goal whose todos are all finished, at least one of them done,
  completes. An open goal with unfinished todos where none is in progress and none can start (every
  remaining todo is blocked or waits on one that is) is blocked by its todos, with a reason naming the
  blocked todos. A goal its todos blocked reopens as soon as a todo is in progress or can start, and
  completes directly if everything is finished. Goals a person blocked, completed or cancelled, and
  every goal of an archived project, are left alone. The call reports what changed.
- **Applied where todos change.** The todo endpoints (create, change, status) and the model-visible
  todo actions reconcile the todo's goal in the same commit as the todo change. The actions return
  the goal and `goalChange`, so a model sees at once that it finished or blocked a goal. A person
  can still reopen a completed goal.
- **Blocked agents.** The agent model step has a new `blocked` output that is true when the project
  has unfinished goals and every one of them is blocked. A graph can route on it, for example to a
  human approval, instead of spending model turns on work that cannot move.

Covered by `durable-goal-progress.test.ts` (completion rules, blocking with named todos, reopening
from blocked and pending todos, dependency-gated blocking, a person's block left alone, archived
projects, and the new triggers), `runtime-goal-progress-http.test.ts`, which blocks, reopens and
completes a goal through todo endpoints, and an agent loop test where every goal is blocked and the
model step reports it.

## Slice 18 — projects, conversations, goals and todos in the web app (8.14)

Everything slices 9–17 stored is now usable from the browser.

- **Projects.** `/projects` lists every project with its status and last change, and a form creates
  one. The overview links to it.
- **Project workspace.** `/projects/:id` shows the project's conversations, with a form to start one,
  and its goals, each with its todos in the order they should be done. The todo the runtime would
  take next is marked. Todos have one-click status changes (start, done, pause, cancel, unblock,
  reopen), and blocking asks for a reason inline. Goals can be cancelled, unblocked when a person
  blocked them, and reopened. A goal its todos blocked shows that, and it reopens on its own when a
  todo moves. Every change goes through the runtime, so the transition tables, dependency checks
  and automatic completion from 8.7 and 8.13 apply exactly as they do to the agent. An archived
  project is read-only.
- **Conversation.** `/conversations/:id` shows the branch that ends at the newest message: text,
  collapsible reasoning, tool calls and tool results, with the model that wrote each reply. It says
  how many messages sit on other branches, and a composer appends the next user message.
- **One guarded proxy.** The browser reaches the runtime only through
  `/api/editor/workspace/[...path]`, which applies the same loopback, same-origin and JSON checks as
  the editor routes and attaches the runtime's CSRF token on the server. It forwards only an
  allowlist of project, conversation, goal and todo paths with sortable ids, and only the `status`,
  `goalId` and `limit` query parameters, so it cannot be used to reach runs, approvals or anything
  else in the daemon.

Covered by `workspace-routes.test.ts` (allowed paths, filtered query parameters, and refusals for
other endpoints, bad ids, traversal and embedded separators), `workspace-types.test.ts` (latest
branch and error reasons), and the web build, which type-checks every page and route.

Not yet in the UI: editing or retrying a message as a new branch, starting an agent run from a
conversation, and reordering todos or editing dependencies.

## Slice 19 — a multi-step coding run on the scripted provider (8.15)

`scripts/agent-coding-integration.test.ts` runs a real coding task end to end. Only the model is
scripted; everything else is the production path.

- **Setup.** A project with a temporary workspace folder, a conversation, a goal and two todos, the
  second depending on the first, and a user request. The scripted provider gets a declared context
  window, and the native file-system tools are rooted at the workspace with `fs:read` and `fs:write`
  granted.
- **The run.** The agent graph (start → Loop → agent model step → agent tools step → finish) is
  compiled, stored and dispatched by the durable dispatcher. Over six model turns the agent starts
  the first todo and writes `src/greet.ts`, reads it back, rewrites it with `overwrite`, finishes the
  todo, starts the dependent todo and writes `src/greet.check.ts`, finishes it, and replies in text,
  which ends the loop.
- **What it proves.** The files on disk hold exactly the final contents. Both todos are done, and the
  goal completed on its own through the 8.13 reconcile inside the todo action. The conversation holds
  the user message, five assistant/tool pairs and the final reply, all linked to the run. None of the
  eight tool results is an error. The third model request had the first draft's contents in its
  context, so each turn really sees the previous turn's results. The model was offered the file and
  goal tools under their provider-safe names.

- **A bug it found.** The first run showed every file write failing on Windows. The write tool named its
  temp file after the logical effect id, and effect ids contain `:`, which Windows does not allow in
  file names; the failed open was reported as "does not exist". The temp name now comes from a hash of
  the effect id, which stays deterministic and is valid on every filesystem. The test also resolves its
  temporary workspace to its real path, because a Windows 8.3 short path would fail the tools'
  containment check.

It runs in `npm test` with every other integration script.

## Next

A golden trace assertion for a complete deterministic goal run (8.16) and the per-project run lock
(8.17).
