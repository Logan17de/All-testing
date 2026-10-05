# Lightweight baseline provenance

The baseline is a regression guard for the measured runtime, not a minimal-runtime promise.
Keep its numeric multipliers/additive allowances and exact dependency comparison intact.
A structural change requires reviewed source measurements and explicit provenance; a failed
check alone is not justification to raise a limit.

The original numeric references were recorded by workflow run 34294622045 with Node24.20.0
and Vitest4.1.11. They include a two-dependency runtime (`db`, `scheduler`). Before this harness
completion task, runtime dependencies grew to eight workspace packages: plugin loading/core
(b93d0fd), plugin API (56434f8), graph UI/runtime (d64c989), models (5461c5c), and GitHub (f7007c7).
The original task starting commit 6a15c7c already has exactly the current eight dependencies.
The Codex completion checkpoints did not change `apps/runtime/package.json` dependencies.

Runtime import/startup now includes this larger graph and migrations. Current CI observed:

| Platform | Measurement source | Startup median | Exact dependencies |
| --- | --- | ---: | --- |
| Ubuntu | [run37323221544](https://github.com/Logan17de/All-testing/actions/runs/37323221544), commit c0040de | 238.541ms | 8 workspace,0 external |
| Windows | [run37316460475](https://github.com/Logan17de/All-testing/actions/runs/37316460475), commit455482b | 420.417ms | 8 workspace,0 external |

Those jobs passed typecheck, lint, formatting, tests, plugin/startup smoke and build before
failing the stale startup/dependency reference. Ubuntu's startup is consistent with the
previous checkpoint (234.923ms); its other four numeric checks passed. Windows's other four
numeric checks passed. Only startup and the dependency snapshot were refreshed. RSS,
compiler, scheduler, SQLite references and all guard policy numbers remain unchanged.
`recordedFrom.runtimeRefresh` records the source SHA/run for each changed platform metric.
Linux cloud workspace timings are diagnostics, not substitutes for Windows/Ubuntu CI sources.

The dependency comparison still fails for any additional/removed dependency, and the same
startup multiplier still detects future regressions relative to the current implementation.
Do not regenerate this reference automatically on every build or use CI failures as approval
to bypass a guard. Benchmark artifacts retain five startup samples and measurement reports.

## Standalone executor dependency

The standalone architecture directly imports `@zet-harness/tools` in the runtime for
workspace paths, file tools and bounded processes. It is now declared explicitly in
`apps/runtime/package.json` and built before runtime compilation. The exact dependency
snapshot is therefore nine workspace packages, zero external packages. The provider
CLI dependency at the harness root is removed. This structural dependency update does
not change any numeric reference or guard threshold.

The scoped native browser adapter adds pinned `playwright-core` 1.63.0 as one external runtime dependency. The exact dependency snapshot is now 10 total (9 workspace, 1 external); measured numeric baselines and regression thresholds are unchanged. Chromium installation and OS sandbox availability remain host prerequisites.
