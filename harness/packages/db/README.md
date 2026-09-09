# @zet-harness/db

Lightweight persistence primitives for Zet Harness.

- SQLite owns durable structured records: graph/plan identity, runs, attempts, events, and sparse checkpoints.
- Runtime durability writes use `SqliteDatabase.commit(...)`: callers queue FIFO, each callback runs synchronously inside one short `BEGIN IMMEDIATE` transaction, and failures roll back without blocking later queued writes.
- `drainWrites()` is the explicit shutdown boundary; `close()` refuses to discard pending serialized writes.
- Startup migrations are the deliberate exception because they run before runtime readiness and concurrency begins.
- `FileContentAddressedBlobStore` owns large immutable byte values addressed as canonical `sha256:<digest>` references.
- Blob bytes are published atomically and verified on reuse; `commitDurableNodeCompletion(...)` atomically wires output refs, completed attempt state, and its terminal durable event using the existing attempt/event schemas, so Phase 4.14 requires no new migration. Phase 4.15 gates scheduler downstream release on successful completion durability.
- Phase 4.16 keeps interpretation outside this storage package: the runtime reconstructs scheduler frontier state from stored Execution IR, sparse checkpoints, recognized versioned frontier events, and durable attempts while generic event payloads remain opaque here. Pre-crash attempts still recorded as `running` are surfaced without being made runnable.
- Phase 4.17 also stays outside the storage layer: runtime recovery classification consumes the frozen IR recovery policy and returns rerun/hold outcomes without mutating SQLite or re-deriving effect/idempotency safety.
- Phase 4.18 adds a dependency-free durable backup bundle: SQLite's native online backup produces `database.sqlite`, the canonical immutable `sha256/` blob tree is copied and content-verified, and a versioned manifest records the database SHA-256/size plus blob count. Backup publication is staged before rename; restore verifies the manifest, database integrity, and every blob, refuses overwrite/merge destinations, and publishes restored blobs before the database file. Restore is an explicit clean-destination/offline operation; no migration, archive framework, or cloud dependency is added. Runtime/database health exposure is intentionally left to Phase 4.19.
- The logical `node_invocations` row owns one Harness-generated effect/idempotency identity for each `(run, op, iteration)`. `ensureDurableNodeInvocation(...)` creates the opaque `zet-effect-v1:<uuid>` once through the serialized commit path and returns the persisted row thereafter, so retry attempts, concurrent callers, and process restarts reuse the same identity. Attempt number is intentionally excluded; effect-aware retry permission remains a separate Phase 5 policy concern.
- The package intentionally uses Node.js built-ins and `node:sqlite` rather than an ORM or external storage service.
