# Zet Harness — Runtime Ownership Decision

## Decision

The authoritative harness runtime is a **long-lived lightweight Node process**. The web UI is a client.

This resolves the open runtime-ownership question before persistent data and agent runs make it expensive to change.

## Responsibilities

### Runtime daemon owns

- SQLite connection and migrations
- plugin host and registries
- model/provider calls
- tool execution
- permission/approval engine
- run scheduler
- goal/todo state transitions
- durable event log
- recovery/resume
- local API + SSE event stream

### Web UI owns

- rendering
- user input
- graph editing
- approval controls
- run inspection
- settings forms

The web process does not own durable state or long-running agent loops.

## Lightweight implementation target

The daemon should initially use Node built-ins where practical:

- `node:http` for the local control API
- `node:sqlite` for persistence
- `AbortController` for cancellation boundaries
- async iterators/events for internal streaming

Do not add Express/Fastify, Redis, a queue, worker framework or service mesh unless a real requirement appears.

## Process model

Development may run two processes:

```text
Next.js UI  ──HTTP/SSE──>  Zet Runtime daemon
```

The runtime remains headless-capable.

For packaged/local production we can later serve static web assets from the daemon or wrap both behind one launcher, keeping user-visible startup simple without moving runtime ownership into Next.js.

## Why not run the loop inside Next.js

Long-running runs need an owner that survives individual HTTP requests. Pause/resume/recovery and external clients also become much cleaner when they address one durable runtime process.

Keeping the loop outside Next.js also prevents dev HMR or UI rebuilds from silently replacing the process that owns an active run.

## Concurrency

v1 remains single-user and local-first.

Start with:

- one runtime process
- one SQLite database
- one active mutating run per project
- bounded parallelism inside a graph/run only when nodes are explicitly safe to execute concurrently

No distributed scheduler is required.

## Scheduler state contract

The framework-free in-memory scheduler lives in its own `@zet-harness/scheduler` workspace. Item 3.1 freezes only the run-local op state machine; it does not yet implement a queue or executor loop. Each op is identified by its zero-based Execution IR index and begins `pending`.

```text
pending → ready → running
   │         │       ├→ completed
   │         │       ├→ skipped
   │         │       ├→ waiting → ready
   │         │       ├→ retry-wait → ready
   │         │       ├→ failed
   │         │       └→ cancelled
   │         ├→ skipped
   │         └→ cancelled
   ├→ skipped
   └→ cancelled
```

`completed`, `skipped`, `failed`, and `cancelled` are terminal. Self-transitions and phase-skipping transitions are rejected. The exported status arrays, transition tables, and produced state objects are runtime-frozen so plugin/consumer code cannot mutate scheduler invariants.

Item 3.2 adds run-local readiness bookkeeping directly over immutable Execution IR predecessor indexes. Ops with zero predecessors become `ready` immediately in ascending op-index order and enter a deterministic FIFO queue. Every other op starts with a remaining-dependency counter equal to its IR predecessor count, plus a reverse-dependent index used for targeted release. A dependency is released as one exact `(sourceOp, targetOp)` relation; duplicate or non-existent pair releases are rejected before counters can underflow. When a release moves a target counter to zero, that target transitions `pending → ready` and is appended to the FIFO queue. This pair-specific boundary is intentional for upcoming router semantics: a router can eventually release only selected branch targets rather than waking every dependent. Dequeue removes one FIFO-ready reservation but leaves its state `ready`; 3.3 owns concurrency admission and the later `ready → running` dispatch transition. 3.2 does not decide which completion/skip/control outcomes satisfy dependencies, and it adds no concurrency, executor calls, retry timers, cancellation signals, or persistence.

## Plugin relationship

The daemon is also the plugin host.

Built-in and third-party plugins register through the same public plugin API. Disabled plugins are not activated. In-process plugins are trusted code; untrusted/community plugin isolation is a separate future execution mode, not a claim made by the v1 host.
