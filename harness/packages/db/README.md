# @zet-harness/db

Lightweight persistence primitives for Zet Harness.

- SQLite owns durable structured records: graph/plan identity, runs, attempts, events, and sparse checkpoints.
- `FileContentAddressedBlobStore` owns large immutable byte values addressed as canonical `sha256:<digest>` references.
- Blob bytes are published atomically and verified on reuse; SQLite reference wiring and node-completion transactions remain later Phase 4 work.
- The package intentionally uses Node.js built-ins and `node:sqlite` rather than an ORM or external storage service.
