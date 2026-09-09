import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const runtimeReportPath = resolve(root, "tmp/baseline/runtime.json");
const benchmarkReportPath = resolve(root, "tmp/baseline/bench.json");
const referencePath = resolve(root, "baselines/lightweight-baseline-v1.json");
const checkReportPath = resolve(root, "tmp/baseline/check.json");

const COMPILER_BENCHMARK =
  "compiler: validate + normalize + canonicalize + lower + identity (64-op chain)";
const SCHEDULER_BENCHMARK = "scheduler: execute no-op 64-op chain";
const SQLITE_BENCHMARK = "sqlite: serialized BEGIN IMMEDIATE commit + prepared insert";

export interface DependencySummary {
  total: number;
  workspace: number;
  external: number;
  names: string[];
}

export interface NumericGuard {
  multiplier: number;
  additive: number;
}

export interface BaselineSnapshot {
  startupMedianMs: number;
  idleRssMedianBytes: number;
  compilerMedianMs: number;
  schedulerMedianMs: number;
  sqliteMedianMs: number;
  directRuntimeDependencies: DependencySummary;
}

export interface BaselinePolicy {
  startupMedianMs: NumericGuard;
  idleRssMedianBytes: NumericGuard;
  compilerMedianMs: NumericGuard;
  schedulerMedianMs: NumericGuard;
  sqliteMedianMs: NumericGuard;
}

interface BaselineReferenceFile {
  schemaVersion: number;
  recordedFrom: {
    workflowRunId: number;
    nodeVersion: string;
    vitestVersion: string;
  };
  policy: BaselinePolicy;
  platforms: Record<string, BaselineSnapshot>;
}

interface RuntimeReport {
  startupMs: { median: number };
  idleRssBytes: { median: number };
  directRuntimeDependencies: DependencySummary;
}

interface BenchmarkRecord {
  name: string;
  median: number;
}

interface BenchmarkReport {
  files: Array<{
    groups: Array<{
      benchmarks: BenchmarkRecord[];
    }>;
  }>;
}

export interface BaselineCheck {
  metric: string;
  kind: "upper-bound" | "exact";
  pass: boolean;
  observed: number | DependencySummary;
  reference: number | DependencySummary;
  limit?: number;
}

export interface BaselineCheckResult {
  schemaVersion: 1;
  platform: string;
  status: "pass" | "fail";
  checks: BaselineCheck[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function computeUpperBound(reference: number, guard: NumericGuard): number {
  return Math.max(reference * guard.multiplier, reference + guard.additive);
}

function numericCheck(
  metric: string,
  observed: number,
  reference: number,
  guard: NumericGuard,
): BaselineCheck {
  const limit = computeUpperBound(reference, guard);
  return {
    metric,
    kind: "upper-bound",
    pass: observed <= limit,
    observed,
    reference,
    limit,
  };
}

function dependenciesEqual(left: DependencySummary, right: DependencySummary): boolean {
  return (
    left.total === right.total &&
    left.workspace === right.workspace &&
    left.external === right.external &&
    left.names.length === right.names.length &&
    left.names.every((name, index) => name === right.names[index])
  );
}

export function evaluateBaselineSnapshot(
  platform: string,
  observed: BaselineSnapshot,
  reference: BaselineSnapshot,
  policy: BaselinePolicy,
): BaselineCheckResult {
  const checks: BaselineCheck[] = [
    numericCheck(
      "runtime startup median ms",
      observed.startupMedianMs,
      reference.startupMedianMs,
      policy.startupMedianMs,
    ),
    numericCheck(
      "idle runtime RSS median bytes",
      observed.idleRssMedianBytes,
      reference.idleRssMedianBytes,
      policy.idleRssMedianBytes,
    ),
    numericCheck(
      "compiler median ms",
      observed.compilerMedianMs,
      reference.compilerMedianMs,
      policy.compilerMedianMs,
    ),
    numericCheck(
      "scheduler median ms",
      observed.schedulerMedianMs,
      reference.schedulerMedianMs,
      policy.schedulerMedianMs,
    ),
    numericCheck(
      "SQLite commit median ms",
      observed.sqliteMedianMs,
      reference.sqliteMedianMs,
      policy.sqliteMedianMs,
    ),
    {
      metric: "direct runtime dependencies",
      kind: "exact",
      pass: dependenciesEqual(
        observed.directRuntimeDependencies,
        reference.directRuntimeDependencies,
      ),
      observed: observed.directRuntimeDependencies,
      reference: reference.directRuntimeDependencies,
    },
  ];

  return {
    schemaVersion: 1,
    platform,
    status: checks.every((check) => check.pass) ? "pass" : "fail",
    checks,
  };
}

function benchmarkMedian(report: BenchmarkReport, name: string): number {
  const matches = report.files
    .flatMap((file) => file.groups)
    .flatMap((group) => group.benchmarks)
    .filter((benchmark) => benchmark.name === name);

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one benchmark named ${JSON.stringify(name)}; found ${matches.length}.`);
  }

  const median = matches[0]?.median;
  if (median === undefined || !Number.isFinite(median)) {
    throw new Error(`Benchmark ${JSON.stringify(name)} did not contain a finite median.`);
  }
  return median;
}

function resolvePlatform(): string {
  const configured = process.env.ZET_BASELINE_PLATFORM;
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }
  if (process.platform === "win32") {
    return "windows-latest";
  }
  if (process.platform === "linux") {
    return "ubuntu-latest";
  }
  return process.platform;
}

function observedSnapshot(runtime: RuntimeReport, benchmark: BenchmarkReport): BaselineSnapshot {
  return {
    startupMedianMs: runtime.startupMs.median,
    idleRssMedianBytes: runtime.idleRssBytes.median,
    compilerMedianMs: benchmarkMedian(benchmark, COMPILER_BENCHMARK),
    schedulerMedianMs: benchmarkMedian(benchmark, SCHEDULER_BENCHMARK),
    sqliteMedianMs: benchmarkMedian(benchmark, SQLITE_BENCHMARK),
    directRuntimeDependencies: runtime.directRuntimeDependencies,
  };
}

function formatValue(value: number | DependencySummary): string {
  return typeof value === "number" ? value.toFixed(3) : JSON.stringify(value);
}

function main(): void {
  const references = readJson<BaselineReferenceFile>(referencePath);
  if (references.schemaVersion !== 1) {
    throw new Error(`Unsupported baseline reference schema version ${references.schemaVersion}.`);
  }

  const platform = resolvePlatform();
  const reference = references.platforms[platform];
  if (reference === undefined) {
    throw new Error(`No lightweight baseline reference exists for platform ${JSON.stringify(platform)}.`);
  }

  const runtime = readJson<RuntimeReport>(runtimeReportPath);
  const benchmark = readJson<BenchmarkReport>(benchmarkReportPath);
  const observed = observedSnapshot(runtime, benchmark);
  const result = evaluateBaselineSnapshot(platform, observed, reference, references.policy);

  mkdirSync(dirname(checkReportPath), { recursive: true });
  writeFileSync(
    checkReportPath,
    `${JSON.stringify(
      {
        ...result,
        referenceSource: references.recordedFrom,
        observed,
        reference,
      },
      null,
      2,
    )}\n`,
  );

  for (const check of result.checks) {
    if (check.kind === "upper-bound") {
      console.log(
        `[baseline] ${check.pass ? "PASS" : "FAIL"} ${check.metric}: observed=${formatValue(check.observed)} reference=${formatValue(check.reference)} limit=${check.limit?.toFixed(3)}`,
      );
    } else {
      console.log(
        `[baseline] ${check.pass ? "PASS" : "FAIL"} ${check.metric}: observed=${formatValue(check.observed)} reference=${formatValue(check.reference)}`,
      );
    }
  }

  if (result.status === "fail") {
    const failures = result.checks.filter((check) => !check.pass).map((check) => check.metric);
    throw new Error(`Lightweight baseline regression guard failed: ${failures.join(", ")}.`);
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main();
}
