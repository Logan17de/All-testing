# Phase 5.17 — Automatic durable dispatch through human approval

## Execution path

A daemon configured with a trusted `execution.execute` adapter scans stored pending/running/waiting
runs at startup. It reconstructs each frontier and uses the existing `PlainDagRun` with the original
operation indexes, dependencies, attempt counters, and shared retry budget. Concurrent wake hints
coalesce per run; global/per-run concurrency still comes from `SchedulerConcurrency`.

The host adapter is an explicit opt-in. A default daemon with no execution adapter remains a
passive health/approval API and does not execute stored code implicitly. There is no new raw run
submission HTTP endpoint. `dispatchRun(runId)` operates only on stored, compiler-admitted runs.

```text
stored compiler output -> restored PlainDagRun
  -> permission checks -> durable attempt start -> host executor
  -> atomic output + completion event + frontier/dependency release
  -> drain active work at human gate -> durable approval + checkpoint + waiting
  -> runtime may terminate
  -> restart -> same waiting frontier
  -> protected HTTP decision commit -> wake hint -> reconstructed PlainDagRun
  -> current permission checks -> downstream execution once
```

## Durable scheduler hooks

`PlainDagRunOptions.restored` accepts a quiescent host-owned readiness snapshot, original attempt
counts, combined budget usage, and remaining retry delays. The scheduler checks exact operation
domains, consistency with predecessor completion, ready-queue membership, and retry accounting.
It does not parse Graph JSON or reimplement the compiler's schema validation.

`durability.beforeAttempt` commits a running attempt before executor entry. The permission check
is repeated after that asynchronous boundary, and cancellation during admission cannot enter the
executor. Admission failure is terminal. `durability.attemptFailed` persists failure/retry budget
and backoff before another attempt is queued. Persistence failure never authorizes a retry.

The existing `completionBarrier` and `commitDurableNodeCompletion` are reused. The driver wraps the
existing completion write with durable frontier events in the *same* serialized SQLite transaction.
An output/terminal event cannot commit while a dependency release rolls back. Parallel completions
read the current frontier inside that transaction rather than overwriting a stale snapshot.

Permission sources remain pinned. Graph-required and node-required capabilities are checked before
every attempt; explicit graph denials still win. Approval completes the human node only and cannot
authorize a downstream write. Denials before admission consume no new durable attempt.

## Human wait, shutdown, and recovery

The scheduler stops at a ready interrupt and drains admitted work and retry waits before calling
`durability.suspend`. The host approval service commits the checkpoint before the scheduler exposes
waiting. The interrupt plugin's executor is never called. No executor, timer, or Promise is retained
for the human wait itself.

A resume notification is emitted only after the approval transaction commits, including an
idempotent duplicate delivery. Notifications are hints, not execution authority. The driver always
reads durable state, and startup scanning covers a crash between decision commit and notification.
A notification failure cannot undo a committed decision or make an identical retry conflict.

`PlainDagRun.pause()` stops dispatch without pretending the user cancelled the run. Already
admitted work drains; pending work and retry budgets remain durable for restart. Daemon shutdown
pauses the driver, closes HTTP ingress, drains executor promises and SQLite writes, then closes the
connection. An in-process executor that ignores its own timeout is not forcibly killed; graceful
shutdown must still await it. Hard process termination remains a distinct recovery event.

Unclassified pre-crash running attempts produce `recovery-required` instead of a blind replay, even
when a node looks pure. The existing recovery classification/reconciliation service remains the
owner of that decision; this batch does not silently apply manual outcomes. A failed completion
commit leaves the uncertain attempt available for recovery and does not repeat an external write.

## Host adapter and supported data

`RuntimeNodeExecution` carries the unchanged scheduler context, run ID, stable logical effect ID,
and ordered input bindings. Repeated ports stay ordered; aggregation is the host adapter's job.
Outputs are bounded JSON objects, checked against the host redaction registry before inline
references are persisted. Arbitrary provider error messages/stacks are not written into failure
events. No external package is added to the daemon: its direct dependencies are now the existing
internal DB and scheduler packages. The scheduler is built to JavaScript for native Node startup.

Supported today:

- Iteration-zero plain DAGs and linear human gates; no router/join/loop/subgraph dispatch.
- Literal inputs, compiled graph-input defaults, and previously committed inline outputs.
- Host-injected execution functions; no generic registry-to-node invocation broker yet.
- Existing effect-aware retries with one persisted outer/internal attempt budget.

Explicit remaining work:

- Generic run creation/submission and supplied invocation graph inputs are not added.
- Secret ports fail closed in this driver until the host secret-aware adapter path is connected;
  they are never exposed as ordinary JSON inputs. Blob-backed input resolution is not added.
- Capability checks protect supported APIs, not hostile code sharing the Node process.
- Approved data is not authenticated human identity or capability authority.
- Model/tool routing, real provider transports, native tools, and the visual editor remain later
  phases. This closes the scoped Phase 5 checkpoint, not the whole Harness v0.1 product.

## Regression coverage

`durable-scheduler-lifecycle.test.ts` covers restore invariants, interrupt admission, commit failure,
revocation during asynchronous admission, cancellation, and pause behavior. The runtime integration
tests use actual plugin registration/compiler lowering, persist a run, suspend, restart the daemon,
and resume through the protected HTTP API. A separate child-process regression kills the waiting
runtime and verifies a fresh process executes the privileged write exactly once. Duplicate resumes,
concurrent wake hints, retry budgets, parallel failures, protected outputs, and injected SQLite
completion failure are also covered. The original compiler identity vectors remain unchanged.
