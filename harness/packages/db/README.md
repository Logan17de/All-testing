# @zet-harness/db

Lightweight persistence primitives for Zet Harness.

- SQLite owns durable structured records: graph/plan identity, runs, attempts, events, and sparse checkpoints.
- Runtime durability writes use `SqliteDatabase.commit(...)`: callers queue FIFO, each callback runs synchronously inside one short `BEGIN IMMEDIATE` transaction, and failures roll back without blocking later queued writes.
- `drainWrites()` is the explicit shutdown boundary; `close()` refuses to discard pending serialized writes.
- Startup migrations are the deliberate exception because they run before runtime readiness and concurrency begins.
- `FileContentAddressedBlobStore` owns large immutable byte values addressed as canonical `sha256:<digest>` references.
- Blob bytes are published atomically and verified on reuse; node-completion/output/event atomicity remains Phase 4.14.
- The package intentionally uses Node.js built-ins and `node:sqlite` rather than an ORM or external storage service.
