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

## Next

8.2 (independent hard bounds on model calls, tool calls, tokens, cost and wall time), then 8.4
(subgraphs) and the project, goal and agent-loop items in TODO order.
