import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, bench, describe } from "vitest";

import { SqliteDatabase } from "@zet-harness/db";
import {
  GRAPH_JSON_VERSION,
  canonicalizeGraphJsonV1Semantics,
  checkGraphJsonV1Diagnostics,
  lowerCanonicalGraphJsonV1ToExecutionIr,
  normalizeGraphJsonV1,
  recordGraphCompilerIdentityV1,
  stripGraphJsonV1UiMetadata,
  type ExecutionIrV1,
  type GraphJsonV1,
  type NodeResolutionResolver,
} from "@zet-harness/graph";
import type { NodeManifest } from "@zet-harness/plugin-api";
import { PlainDagRun, SchedulerConcurrency } from "@zet-harness/scheduler";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeSampleScript = resolve(root, "scripts/runtime-baseline-child.mjs");
const runtimePackagePath = resolve(root, "apps/runtime/package.json");
const runtimeSampleCount = 5;
const benchmarkNodeCount = 64;
const temporaryDirectories: string[] = [];

const manifest: NodeManifest = {
  type: "baseline.pass",
  version: "1",
  title: "Baseline pass-through",
  inputs: { input: { schema: true } },
  outputs: { output: { schema: true } },
  configSchema: { type: "object", additionalProperties: false },
  behavior: {
    primitiveFamily: "pure",
    determinism: "deterministic",
    effect: "none",
    idempotency: "not-applicable",
    recovery: "rerun",
    executionMode: "in-process",
    requiredCapabilities: [],
  },
};

const resolver: NodeResolutionResolver = {
  getManifest(type, version) {
    return type === manifest.type && version === manifest.version ? manifest : undefined;
  },
  getResolution(type, version) {
    if (type !== manifest.type || version !== manifest.version) {
      return undefined;
    }
    return {
      manifest,
      plugin: { id: "baseline.plugin", version: "1" },
    };
  },
};

function createCompilerFixture(nodeCount: number): GraphJsonV1 {
  const nodes = Array.from({ length: nodeCount }, (_unused, index) => ({
    id: `node-${String(index).padStart(3, "0")}`,
    type: manifest.type,
    version: manifest.version,
    config: {},
  }));
  const edges = Array.from({ length: Math.max(0, nodeCount - 1) }, (_unused, index) => ({
    id: `edge-${String(index).padStart(3, "0")}`,
    kind: "data" as const,
    from: { nodeId: nodes[index]?.id ?? "", port: "output" },
    to: { nodeId: nodes[index + 1]?.id ?? "", port: "input" },
  }));

  return {
    schemaVersion: GRAPH_JSON_VERSION,
    graphId: "baseline-graph",
    revisionId: "baseline-revision",
    inputs: [],
    outputs: [
      {
        id: "result",
        schema: true,
        source: { nodeId: nodes[nodeCount - 1]?.id ?? "", port: "output" },
      },
    ],
    nodes,
    edges,
    entrypoints: [{ id: "main", nodeId: nodes[0]?.id ?? "" }],
    policies: {
      maxNodeExecutions: nodeCount,
      maxParallelism: 8,
      capabilities: { required: [], optional: [], deny: [] },
    },
    options: { defaultEntrypoint: "main" },
  };
}

const compilerFixture = createCompilerFixture(benchmarkNodeCount);

async function compileFixture(): Promise<ExecutionIrV1> {
  const diagnostics = checkGraphJsonV1Diagnostics(compilerFixture, {
    resolver,
    capabilityAuthority: { granted: [] },
  });
  if (!diagnostics.valid) {
    throw new Error(`Baseline compiler fixture failed validation: ${JSON.stringify(diagnostics)}`);
  }

  const normalizedResult = normalizeGraphJsonV1(compilerFixture, resolver);
  if (!normalizedResult.valid || normalizedResult.normalized === undefined) {
    throw new Error(
      `Baseline compiler fixture failed normalization: ${JSON.stringify(normalizedResult.diagnostics)}`,
    );
  }

  const normalized = normalizedResult.normalized;
  const canonical = canonicalizeGraphJsonV1Semantics(stripGraphJsonV1UiMetadata(normalized));
  const ir = lowerCanonicalGraphJsonV1ToExecutionIr(canonical, resolver);
  await recordGraphCompilerIdentityV1({ normalized, canonical, ir });
  return ir;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) {
    throw new RangeError("Cannot compute a percentile from zero samples.");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
}

function summarize(values: readonly number[]) {
  return {
    samples: values.length,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

async function collectRuntimeSamples(): Promise<void> {
  const packageJson = JSON.parse(readFileSync(runtimePackagePath, "utf8")) as {
    dependencies?: Readonly<Record<string, string>>;
  };
  const dependencies = Object.keys(packageJson.dependencies ?? {});
  const workspaceDependencies = dependencies.filter((name) => name.startsWith("@zet-harness/"));
  const externalDependencies = dependencies.filter((name) => !name.startsWith("@zet-harness/"));

  const startupMs: number[] = [];
  const idleRssBytes: number[] = [];

  for (let index = 0; index < runtimeSampleCount; index += 1) {
    const directory = mkdtempSync(join(tmpdir(), "zet-harness-baseline-runtime-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, `runtime-${String(index)}.sqlite`);
    const { stdout } = await execFileAsync(process.execPath, [runtimeSampleScript, databasePath], {
      cwd: root,
      timeout: 10_000,
    });
    const line = stdout
      .split(/\r?\n/u)
      .find((candidate) => candidate.startsWith("ZET_RUNTIME_BASELINE_SAMPLE "));
    if (line === undefined) {
      throw new Error(`Runtime baseline child did not emit a sample. Output: ${stdout}`);
    }
    const sample = JSON.parse(line.slice("ZET_RUNTIME_BASELINE_SAMPLE ".length)) as {
      startupMs: number;
      idleRssBytes: number;
    };
    startupMs.push(sample.startupMs);
    idleRssBytes.push(sample.idleRssBytes);
  }

  console.log(
    `ZET_BASELINE_RUNTIME ${JSON.stringify({
      startupMs: summarize(startupMs),
      idleRssBytes: summarize(idleRssBytes),
      directRuntimeDependencies: {
        total: dependencies.length,
        workspace: workspaceDependencies.length,
        external: externalDependencies.length,
        names: dependencies.sort(),
      },
    })}`,
  );
}

let compiledIr: ExecutionIrV1;
const databaseDirectory = mkdtempSync(join(tmpdir(), "zet-harness-baseline-sqlite-"));
temporaryDirectories.push(databaseDirectory);
const database = new SqliteDatabase({ path: join(databaseDirectory, "baseline.sqlite") });
let insertSequence = 0;
let insertStatement: ReturnType<ReturnType<SqliteDatabase["connection"]>["prepare"]>;

beforeAll(async () => {
  await collectRuntimeSamples();
  compiledIr = await compileFixture();

  database.open();
  database
    .connection()
    .exec("CREATE TABLE baseline_commits (sequence INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
  insertStatement = database
    .connection()
    .prepare("INSERT INTO baseline_commits(sequence, payload) VALUES (?, 'baseline')");
});

afterAll(async () => {
  await database.drainWrites();
  database.close();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe("Zet Harness lightweight baseline", () => {
  bench(
    "compiler: validate + normalize + canonicalize + lower + identity (64-op chain)",
    async () => {
      await compileFixture();
    },
    { time: 300, warmupTime: 50 },
  );

  bench(
    "scheduler: execute no-op 64-op chain",
    async () => {
      const concurrency = new SchedulerConcurrency(8);
      const run = new PlainDagRun(compiledIr, concurrency.createRun(compiledIr), () => undefined);
      await run.execute();
    },
    { time: 300, warmupTime: 50 },
  );

  bench(
    "sqlite: serialized BEGIN IMMEDIATE commit + prepared insert",
    async () => {
      insertSequence += 1;
      await database.commit(() => {
        insertStatement.run(insertSequence);
      });
    },
    { time: 300, warmupTime: 50 },
  );
});
