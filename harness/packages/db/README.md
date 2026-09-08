# @zet-harness/db

Lightweight persistence primitives for Zet Harness.

- SQLite owns durable structured records: graph/plan identity, runs, attempts, events, and sparse checkpoints.
- Runtime durability writes use `SqliteDatabase.commit(...)`: callers queue FIFO, each callback runs synchronously inside one short `BEGIN IMMEDIATE` transaction, and failures roll back without blocking later queued writes.
- `drainWrites()` is the explicit shutdown boundary; `close()` refuses to discard pending serialized writes.
- Startup migrations are the deliberate exception because they run before runtime readiness and concurrency begins.
- `FileContentAddressedBlobStore` owns large immutable byte values addressed as canonical `sha256:<digest>` references.
- Blob bytes are published atomically and verified on reuse; `commitDurableNodeCompletion(...)` atomically wires output refs, completed attempt state, and its terminal durable event using the existing attempt/event schemas, so Phase 4.14 requires no new migration. Phase 4.15 gates scheduler downstream release on successful completion durability.
- Phase 4.16 keeps interpretation outside this storage package: the runtime reconstructs scheduler frontier state from stored Execution IR, sparse checkpoints, recognized versioned frontier events, and durable attempts while generic event payloads remain opaque here. Pre-crash attempts still recorded as `running` are surfaced without being made runnable; Phase 4.17 owns recovery-policy classification.
- The package intentionally uses Node.js built-ins and `node:sqlite` rather than an ORM or external storage service.
