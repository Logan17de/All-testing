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
- **Not yet restorable.** Restoring a run that contains routers or joins is refused, because the
  restore snapshot does not carry control-edge state or branch choices. Loops and subgraphs are
  still refused.

Covered by `packages/scheduler/src/structured-control-run.test.ts`.

## Remaining slices before 8.1 is complete

1. **Durable routers and joins.** Emit control-edge and router-selection frontier events from the
   dispatcher, restore them, and let graphs choose branches from a data input.
2. **Loop regions in the compiler.** Identify the region between a loop's `body` output and its
   `continue` input, allow exactly that back edge through cycle rejection, and lower the loop
   descriptor with its region membership.
3. **Iterations in the scheduler.** Re-arm region ops with `iteration + 1` until the loop exits or
   `maxIterations` is reached, keeping attempts and outputs keyed by iteration.
4. **Iterations in durable dispatch.** Key invocations, attempts, outputs and frontier events by
   iteration, and restore mid-loop.

Items 8.2–8.17 follow in the TODO order once loops run durably.
