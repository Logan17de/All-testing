import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// Diagnostic only: never changes a smoke deadline, baseline, or SQLite durability setting.
const started = performance.now();
const { RuntimeDaemon } = await import("../apps/runtime/dist/runtime-daemon.js");
const imported = performance.now();
const { SqliteDatabase } = await import("@zet-harness/db");
const directory = mkdtempSync(join(tmpdir(), "zet-timing-"));

try {
  const daemon = new RuntimeDaemon({
    api: { host: "127.0.0.1", port: 0 },
    database: { path: join(directory, "startup.sqlite") },
  });
  const constructed = performance.now();
  try {
    await daemon.start();
    console.log(
      "ZET_STARTUP_DIAGNOSTIC",
      JSON.stringify({
        platform: process.platform,
        node: process.version,
        importMs: imported - started,
        setupMs: constructed - imported,
        startMs: performance.now() - constructed,
        totalMs: performance.now() - started,
      }),
    );
  } finally {
    await daemon.stop();
  }

  for (const storage of ["memory", "file"]) {
    const database = new SqliteDatabase({
      path: storage === "memory" ? ":memory:" : join(directory, "commits.sqlite"),
    });
    const beforeOpen = performance.now();
    database.open();
    try {
      const openMs = performance.now() - beforeOpen;
      const connection = database.connection();
      connection.exec("CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      const statement = connection.prepare("INSERT INTO probe(id, value) VALUES (?, 'probe')");
      const commitMs = [];
      for (let index = 0; index < 12; index += 1) {
        const beforeCommit = performance.now();
        await database.commit(() => {
          statement.run(index);
        });
        commitMs.push(performance.now() - beforeCommit);
      }
      console.log(
        "ZET_SQLITE_DIAGNOSTIC",
        JSON.stringify({
          storage,
          openMs,
          journalMode: connection.prepare("PRAGMA journal_mode").get(),
          synchronous: connection.prepare("PRAGMA synchronous").get(),
          commitMs,
        }),
      );
    } finally {
      await database.drainWrites();
      database.close();
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
