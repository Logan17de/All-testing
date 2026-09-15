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

## Next

9.2: fork a new run from a checkpoint while the historical run stays immutable, then record the
parent run and fork checkpoint (9.3) and refuse to resume a run against an edited graph (9.4).
