# Runtime health contract

`GET /api/health` is a cheap local readiness probe owned by the runtime daemon. This contract was established in Phase 4.19.

A healthy response uses HTTP `200` and reports:

- runtime lifecycle state is `running`;
- the owned SQLite connection is open;
- a read-only `SELECT 1` probe succeeds;
- `schema_migrations` exactly matches the code-owned runtime migration catalog by ordered version and name.

An unhealthy response uses HTTP `503`. Health-provider exceptions are converted to a stable sanitized response rather than exposing raw database or internal error details.

The request path deliberately does **not** run `PRAGMA quick_check`, `PRAGMA integrity_check`, scan the content-addressed blob tree, mutate SQLite, or perform network/provider checks. Deep SQLite/blob integrity belongs to backup/restore and explicit diagnostics, not a frequent health request.

The HTTP server only owns transport and status-code mapping. SQLite interpretation remains in the runtime health provider wired by `RuntimeDaemon`.
