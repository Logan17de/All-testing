import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DURABLE_EVENTS_TABLE,
  NODE_ATTEMPTS_TABLE,
  NODE_INVOCATIONS_TABLE,
  RUN_CHECKPOINTS_TABLE,
  SCHEMA_MIGRATIONS_TABLE,
  SQLITE_MEMORY_PATH,
  SqliteDatabase,
  type SqliteMigration,
} from "@zet-harness/db";
import { describe, expect, it } from "vitest";

import { RUNTIME_DATABASE_MIGRATIONS, RuntimeDaemon } from "./runtime-daemon.js";

const createDaemon = (migrations?: readonly SqliteMigration[]): RuntimeDaemon =>
  new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    ...(migrations === undefined ? {} : { migrations }),
  });

describe("RuntimeDaemon", () => {
  it("keeps the default runtime migration catalog complete and ordered", () => {
    expect(RUNTIME_DATABASE_MIGRATIONS.map(({ version, name }) => ({ version, name }))).toEqual([
      { version: 1, name: "durable_graph_and_compiled_plan_identity" },
      { version: 2, name: "durable_runs_and_fork_lineage" },
      { version: 3, name: "durable_node_attempts_and_effect_identity" },
      { version: 4, name: "append_only_versioned_durable_events" },
      { version: 5, name: "sparse_checkpoint_frontier_state" },
    ]);
  });

  it("becomes running only after SQLite migrations and the loopback API are ready", async () => {
    const daemon = createDaemon();

    expect(daemon.snapshot()).toEqual({
      state: "idle",
      api: { state: "idle", host: "127.0.0.1", port: null, eventClients: 0 },
      database: { state: "closed", path: SQLITE_MEMORY_PATH, inMemory: true },
    });

    expect(await daemon.start()).toBe(true);
    expect(await daemon.start()).toBe(false);

    const snapshot = daemon.snapshot();
    expect(snapshot.state).toBe("running");
    expect(snapshot.api.state).toBe("listening");
    expect(snapshot.api.host).toBe("127.0.0.1");
    expect(snapshot.api.port).toEqual(expect.any(Number));
    expect(snapshot.api.port).toBeGreaterThan(0);
    expect(snapshot.api.eventClients).toBe(0);
    expect(snapshot.database).toEqual({
      state: "open",
      path: SQLITE_MEMORY_PATH,
      inMemory: true,
    });

    expect(daemon.publishEvent("runtime.test", { ok: true })).toEqual({
      id: 1,
      type: "runtime.test",
      data: '{"ok":true}',
    });

    await daemon.stop();
  });

  it("installs the full default durable schema before runtime readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "zet-harness-runtime-default-schema-"));
    const path = join(root, "runtime.sqlite");
    const daemon = new RuntimeDaemon({ api: { port: 0 }, database: { path } });

    try {
      expect(await daemon.start()).toBe(true);
      await daemon.stop();

      const database = new SqliteDatabase({ path });
      database.open();
      try {
        expect(
          database
            .connection()
            .prepare(`SELECT version, name FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY version`)
            .all(),
        ).toEqual(RUNTIME_DATABASE_MIGRATIONS.map(({ version, name }) => ({ version, name })));
        expect(
          database
            .connection()
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?) ORDER BY name",
            )
            .all(
              DURABLE_EVENTS_TABLE,
              NODE_ATTEMPTS_TABLE,
              NODE_INVOCATIONS_TABLE,
              RUN_CHECKPOINTS_TABLE,
            ),
        ).toEqual([
          { name: DURABLE_EVENTS_TABLE },
          { name: NODE_ATTEMPTS_TABLE },
          { name: NODE_INVOCATIONS_TABLE },
          { name: RUN_CHECKPOINTS_TABLE },
        ]);
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("persists ordered migration history before announcing runtime readiness", async () => {
    const root = mkdtempSync(join(tmpdir(), "zet-harness-runtime-migration-"));
    const path = join(root, "runtime.sqlite");
    const migrations: readonly SqliteMigration[] = [
      {
        version: 1,
        name: "runtime_probe",
        sql: "CREATE TABLE runtime_probe(value TEXT NOT NULL)",
      },
    ];
    const daemon = new RuntimeDaemon({
      api: { port: 0 },
      database: { path },
      migrations,
    });

    try {
      expect(await daemon.start()).toBe(true);
      expect(daemon.snapshot().state).toBe("running");
      expect(existsSync(path)).toBe(true);
      await daemon.stop();

      const database = new SqliteDatabase({ path });
      database.open();
      try {
        expect(
          database
            .connection()
            .prepare(`SELECT version, name FROM ${SCHEMA_MIGRATIONS_TABLE} ORDER BY version`)
            .all(),
        ).toEqual([{ version: 1, name: "runtime_probe" }]);
        expect(
          database
            .connection()
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_probe'",
            )
            .get(),
        ).toEqual({ name: "runtime_probe" });
      } finally {
        database.close();
      }
    } finally {
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("closes SQLite and leaves HTTP unbound when migration startup fails", async () => {
    const daemon = createDaemon([
      {
        version: 1,
        name: "broken",
        sql: "CREATE TABLE broken(value TEXT); INSERT INTO missing_table(value) VALUES ('x')",
      },
    ]);

    await expect(daemon.start()).rejects.toThrow();
    expect(daemon.snapshot()).toEqual({
      state: "idle",
      api: { state: "idle", host: "127.0.0.1", port: null, eventClients: 0 },
      database: { state: "closed", path: SQLITE_MEMORY_PATH, inMemory: true },
    });

    await daemon.stop();
  });

  it("closes SQLite again when the HTTP listener cannot bind", async () => {
    const blocker = createServer();
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");

    const address = blocker.address();
    if (address === null || typeof address === "string") {
      blocker.close();
      throw new TypeError("Test blocker did not expose a TCP address.");
    }

    const daemon = new RuntimeDaemon({
      api: { port: address.port },
      database: { path: SQLITE_MEMORY_PATH },
    });

    try {
      await expect(daemon.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(daemon.snapshot()).toEqual({
        state: "idle",
        api: { state: "idle", host: "127.0.0.1", port: null, eventClients: 0 },
        database: { state: "closed", path: SQLITE_MEMORY_PATH, inMemory: true },
      });
    } finally {
      await daemon.stop();
      blocker.close();
      await once(blocker, "close");
    }
  });

  it("rejects stream publication outside the running lifecycle", async () => {
    const daemon = createDaemon();

    expect(() => daemon.publishEvent("runtime.test", null)).toThrow(
      "Runtime daemon must be running before publishing stream events.",
    );

    await daemon.stop();

    expect(() => daemon.publishEvent("runtime.test", null)).toThrow(TypeError);
  });

  it("stops once, closes SQLite, releases waiters, and cannot restart", async () => {
    const daemon = createDaemon();
    await daemon.start();

    const stopped = daemon.waitUntilStopped();
    expect(await daemon.stop()).toBe(true);
    await stopped;

    expect(await daemon.stop()).toBe(false);
    expect(daemon.snapshot()).toEqual({
      state: "stopped",
      api: { state: "stopped", host: "127.0.0.1", port: null, eventClients: 0 },
      database: { state: "closed", path: SQLITE_MEMORY_PATH, inMemory: true },
    });
    await expect(daemon.start()).rejects.toThrow(
      "Runtime daemon cannot restart after it has stopped.",
    );
  });

  it("coalesces concurrent stop requests", async () => {
    const daemon = createDaemon();
    await daemon.start();

    const [first, second] = await Promise.all([daemon.stop(), daemon.stop()]);

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(daemon.snapshot().state).toBe("stopped");
    expect(daemon.snapshot().database.state).toBe("closed");
  });

  it("may be stopped before start without leaving live runtime resources", async () => {
    const daemon = createDaemon();

    expect(await daemon.stop()).toBe(true);
    await daemon.waitUntilStopped();

    expect(daemon.snapshot().state).toBe("stopped");
    expect(daemon.snapshot().database.state).toBe("closed");
    await expect(daemon.start()).rejects.toThrow(TypeError);
  });
});
