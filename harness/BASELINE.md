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

Vitest benchmark output supplies timing statistics for compiler, scheduler, and SQLite measurements. Runtime startup/RSS samples are emitted as one machine-readable line beginning with `ZET_BASELINE_RUNTIME` and include sample count, median, p95, minimum, and maximum; the same structured runtime report is written directly to `tmp/baseline/runtime.json`. Vitest writes its benchmark report directly to `tmp/baseline/bench.json` under the same ignored directory.

The command is verified on hosted Ubuntu and Windows runners. Observed measurements are samples from the machine that executed the command, not portable performance guarantees or fixed acceptance thresholds.

## CI regression guard

Phase 4.22 adds:

```text
npm run baseline:ci
```

CI runs this command independently on `ubuntu-latest` and `windows-latest`. The baseline command produces `runtime.json` and Vitest 4's `bench.json` directly on disk; the checker consumes both reports, compares their medians with the checked-in per-OS reference in `baselines/lightweight-baseline-v1.json`, and writes `tmp/baseline/check.json` before returning success or failure. No console-output scraping sits in the CI path.

The CI policy deliberately avoids cross-OS comparisons and brittle exact timing thresholds. For each numeric metric the upper guard is:

```text
max(reference × multiplier, reference + additive slack)
```

Current guards:

| Metric | Multiplier | Additive slack |
| --- | ---: | ---: |
| Runtime startup median | 3× | 100 ms |
| Idle runtime RSS median | 1.5× | 32 MiB |
| Compiler median | 2× | 2 ms |
| Scheduler median | 3× | 1 ms |
| File-backed WAL SQLite commit median | 4× | 5 ms |

Medians are used for CI comparisons because hosted runners can produce large one-off timing spikes, especially for filesystem-backed SQLite. Faster measurements always pass. Direct runtime dependency identity is checked exactly instead of through a timing envelope, so adding a runtime package requires an intentional baseline update.

Every CI matrix job uploads the generated runtime, benchmark, and check JSON as a short-lived artifact, including on a failed guard when the reports were produced. Updating the checked-in reference is therefore an explicit reviewable change rather than an automatic moving average that could silently normalize a regression.

The original 4.21 item records **measurement methodology**; 4.22 adds only a deliberately coarse regression tripwire. Hosted runners, developer machines, antivirus, filesystem implementation, CPU frequency scaling, and concurrent system load can all move raw values materially, so these guards are meant to catch large changes rather than rank machines or certify absolute performance.
