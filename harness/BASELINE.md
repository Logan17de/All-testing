# Lightweight performance baseline

Phase 4.21 adds a deliberately small, machine-local baseline command:

```text
npm run baseline
```

The command builds the runtime, then measures the current lightweight core without adding a benchmark framework or production dependency.

Measured surfaces:

- **runtime startup latency** — five fresh Node child processes measure from process-side baseline start through runtime module load, SQLite open/migrations, and HTTP readiness;
- **idle runtime RSS** — each fresh runtime child reports `process.memoryUsage().rss` after readiness and a short 50 ms idle settle;
- **direct runtime dependency count** — reads `apps/runtime/package.json` and reports total direct dependencies, split into Harness workspace dependencies and external packages;
- **compiler overhead** — real Graph JSON v1 validation, normalization, UI stripping, canonicalization, Execution IR lowering, and compiler identity hashing for one deterministic 64-op chain;
- **scheduler overhead** — executes the same 64-op no-op chain through `PlainDagRun` with the normal concurrency coordinator;
- **SQLite commit latency** — uses a temporary file-backed WAL database and `SqliteDatabase.commit()` with its serialized `BEGIN IMMEDIATE` transaction path and one prepared insert.

Vitest benchmark output supplies timing statistics for compiler, scheduler, and SQLite measurements. Runtime startup/RSS samples are emitted as one machine-readable line beginning with `ZET_BASELINE_RUNTIME` and include sample count, median, p95, minimum, and maximum.

The command is verified on hosted Ubuntu and Windows runners. Observed measurements are samples from the machine that executed the command, not portable performance guarantees or fixed acceptance thresholds.

This item records **measurement methodology only**. It intentionally does not fail CI based on absolute timing or memory thresholds. Hosted runners, developer machines, antivirus, filesystem implementation, CPU frequency scaling, and concurrent system load can all move these values materially. Phase 4.22 owns recording/checking the baseline in CI with comparison rules that avoid brittle machine-specific limits.
