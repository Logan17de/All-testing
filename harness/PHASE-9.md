# Phase 9 — Replay, fork, memory, triggers and external clients

Phase 9 builds on the durable journal from Phase 4 and the agent work from Phase 8. `PLAN.md` keeps
three ideas apart, and this phase follows that split:

1. **Resume** continues unfinished work from committed outputs. The runtime has done this since
   Phase 4.
2. **Recorded replay** reads a run back from its records and runs nothing.
3. **Fork** starts a new run from a checkpoint and executes the downstream work again.

## Slice 1 — read-only recorded replay (9.1)

Any run, finished or not, can now be replayed from its records alone.

- **What it returns.** `replayRecordedRun(connection, runId)` walks the run's durable journal in
  order and returns one step per recorded thing that happened. Each attempt carries its node,
  iteration, attempt number, the inputs it received, and its recorded outputs and usage or its
  error. Router branches, loop entries and decisions (including why a loop ended), approval
  requests and resolutions (with the approved response), recovery outcomes and the run's end each
  become a step.
- **Inputs are re-derived, not guessed.** The journal does not store inputs, so replay resolves them
  the way the dispatcher does: literals, compiled graph input defaults, and the outputs recorded
  upstream at that point in the journal, using the same iteration's value inside a loop body and the
  latest value everywhere else. Secret bindings appear only as their reference, never as material.
- **Nothing runs and nothing is written.** No node executor, model, tool or person is called, and
  the journal and attempt tables are untouched, so replaying is safe on any run at any time and
  gives the same result every time.
- **It checks the records agree.** Every finished attempt must be journaled, every journaled attempt
  must be stored with the same status, every input must have had a recorded value, and the journal
  must end the run with the status the run has. Disagreements come back as `issues` with a
  `consistent: false` flag instead of an exception, so a damaged run can still be inspected. Stored
  values pass through the runtime's redaction before they leave the daemon.
- **HTTP.** `GET /api/runs/:id/replay` returns the replay; an unknown run is `RUN_NOT_FOUND` (404).

Covered by `runtime-replay.test.ts` (a data chain with derived inputs, proof that replay runs no node
and writes no row, identical repeated replays, three loop iterations with each decision and the
`max-iterations` exit reason, a failed attempt and failed run, and an unknown run) and
`runtime-replay-http.test.ts`, which replays a run of the built-in condition node through the API.

Not yet: showing a replay step by step in the run inspector.

## Slice 2 — fork a run from a point in its history (9.2)

A new run can now start from any point in another run's history. The run it came from is never
written.

- **Where to fork.** `forkRun(database, runId, { throughEventId })` cuts the parent's journal after
  one of its events, such as the event of a step in its replay, or after its latest event when none
  is given. A commit journals its own event before the frontier changes it caused, so the cut moves
  to the end of the commit it fell in. A fork never starts with an upstream node finished and its
  downstream not yet released.
- **The frontier at that point.** Recovery can now rebuild a run's frontier as it stood after any
  event: the latest checkpoint at or before the cut, then the frontier events up to it, without
  overlaying today's attempt rows.
- **What the fork keeps.** Work that had finished by the cut keeps its recorded attempts, results,
  logical effect ids and journal events, including branch choices and loop decisions. A replay of
  the fork shows that history, and downstream nodes read the same upstream values. Reused attempts
  are part of the fork's record, so they count toward its node-execution budget. A
  `harness.run.forked` event marks where the fork's own history begins.
- **What runs again.** Everything else starts again with a fresh attempt budget: a node that was
  running or waiting to retry, a node that failed (so forking a failed run retries it), and a human
  approval that was waiting, which is asked again with a new request while the parent's request
  stays pending. A loop that was running carries on from its next iteration with a fresh wall-time
  window. A loop that failed or was cancelled cannot be forked yet (`FORK_UNSUPPORTED`).
- **Lineage.** The fork is an ordinary `pending` run on the same compiled plan, admitted by the
  dispatcher like any other. Its `parent_run_id` names the parent, and its fork metadata records the
  cut event, the parent checkpoint the cut was rebuilt from, and the fork's own starting checkpoint.
- **Refusals.** An unknown run is `RUN_NOT_FOUND` (404). An event of a different run, a point that
  is not a positive whole number, or a point inside the history a fork copied from its parent is
  `FORK_POINT_INVALID` (422); fork the original run to go further back.
- **HTTP.** `POST /api/runs/:id/fork` with `{}` or `{ "throughEventId": 12 }` returns `201` with the
  fork and starts it.

Covered by `runtime-fork.test.ts` (forking a finished run after its first node, where only the
second node runs and every row of the parent is unchanged; retrying a failed run; carrying a running
loop over to finish its iterations; asking a waiting approval again in the fork; and the refusals)
and `runtime-fork-http.test.ts`, which forks a run through the API and replays the fork.

Not yet: a fork button and a parent link in the run inspector, which come with 9.3.

## Next

9.3: show a run's parent, fork point and forks in the run view and the run inspector, then refuse
to resume a run against an edited graph (9.4).
