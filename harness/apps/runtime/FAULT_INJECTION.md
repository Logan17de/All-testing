# Runtime crash/fault-injection contract

Phase 4.20 hardens the existing durability boundary with restart tests over a real file-backed SQLite database.

The suite uses deterministic seeded crash cuts rather than wall-clock races so every failure is reproducible. It exercises three durable boundaries:

1. **Before node completion commit** — a durable attempt remains `running`; restart reconstruction must surface exactly one pre-crash running attempt and recovery-policy classification decides the next action.
2. **Inside the atomic completion transaction** — injected terminal-event failure must roll back the attempt update; after close/reopen there is no output ref and no terminal event.
3. **After completion commit, before frontier publication** — the completed attempt/output/event survive restart, but downstream work must remain blocked. A terminal completion event is not silently reinterpreted as scheduler frontier state.
4. **After explicit frontier publication** — restart replay may reconstruct the completed upstream op and ready downstream op from recognized `harness.frontier.*` events.

The randomized portion is intentionally seeded and deterministic. Seeds select among those crash boundaries, then the database is closed and reopened before assertions. The tests do not use timing sleeps, process signals, or probabilistic expectations.

This item does not add new recovery semantics, background checkpointing, effect reconciliation, or a filesystem/SQLite distributed transaction. It verifies the Phase 4 contracts already established by serialized commits, atomic completion, downstream durability gating, frontier reconstruction, and pre-crash recovery classification.

Roadmap status: **4.20 complete; 4.21 lightweight baseline is current.**
