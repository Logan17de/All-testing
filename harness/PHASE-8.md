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

## Remaining slices before 8.1 is complete

1. **Loop regions in the compiler.** Identify the region between a loop's `body` output and its
   `continue` input, allow exactly that back edge through cycle rejection, and lower the loop
   descriptor with its region membership.
2. **Iterations in the scheduler.** Re-arm region ops with `iteration + 1` until the loop exits or
   `maxIterations` is reached, keeping attempts and outputs keyed by iteration.
3. **Iterations in durable dispatch.** Key invocations, attempts, outputs and frontier events by
   iteration, and restore mid-loop.

Items 8.2–8.17 follow in the TODO order once loops run durably.
