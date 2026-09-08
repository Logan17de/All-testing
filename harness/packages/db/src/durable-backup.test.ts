import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { FileContentAddressedBlobStore } from "./content-addressed-blob-store.js";
import {
  DURABLE_BACKUP_BLOB_DIRECTORY,
  DURABLE_BACKUP_DATABASE_FILE,
  DURABLE_BACKUP_FORMAT,
  DURABLE_BACKUP_MANIFEST_FILE,
  createDurableBackup,
  restoreDurableBackup,
} from "./durable-backup.js";
import { SQLITE_MEMORY_PATH, SqliteDatabase } from "./index.js";

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zet-harness-backup-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function openDatabase(path: string): SqliteDatabase {
  const database = new SqliteDatabase({ path });
  database.open();
  return database;
}

function readValue(path: string, key: string): string | undefined {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
  });
  try {
    const row = database.prepare("SELECT value FROM durable_test WHERE key = ?").get(key);
    return typeof row?.value === "string" ? row.value : undefined;
  } finally {
    database.close();
  }
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("durable backup + restore", () => {
  it("backs up WAL-backed SQLite state and immutable blobs, then restores both", async () => {
    await withWorkspace(async (root) => {
      const sourceDatabasePath = join(root, "live", "runtime.sqlite");
      const sourceBlobRoot = join(root, "live", "blobs");
      const backupPath = join(root, "backup");
      const restoredDatabasePath = join(root, "restored", "runtime.sqlite");
      const restoredBlobRoot = join(root, "restored", "blobs");
      const database = openDatabase(sourceDatabasePath);
      const blobStore = new FileContentAddressedBlobStore({ rootPath: sourceBlobRoot });

      try {
        database
          .connection()
          .exec("CREATE TABLE durable_test (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        database.connection().prepare("INSERT INTO durable_test VALUES (?, ?)").run("one", "first");

        const pendingWrite = database.commit((connection) => {
          connection
            .prepare("INSERT INTO durable_test VALUES (?, ?)")
            .run("two", "queued-before-backup");
        });
        const firstBlob = await blobStore.putBytes(Buffer.from("first blob"));
        const secondBlob = await blobStore.putBytes(Buffer.from("second blob"));

        const result = await createDurableBackup({
          database,
          blobStore,
          destinationPath: backupPath,
          createdAtMs: 1234,
        });
        await pendingWrite;

        expect(result.path).toBe(backupPath);
        expect(result.databasePages).toBeGreaterThan(0);
        expect(result.manifest).toMatchObject({
          format: DURABLE_BACKUP_FORMAT,
          createdAtMs: 1234,
          database: {
            file: DURABLE_BACKUP_DATABASE_FILE,
          },
          blobs: {
            directory: DURABLE_BACKUP_BLOB_DIRECTORY,
            algorithm: "sha256",
            count: 2,
          },
        });
        expect(result.manifest.database.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(result.manifest.database.sizeBytes).toBeGreaterThan(0);
        expect(Object.isFrozen(result.manifest)).toBe(true);
        expect(readValue(join(backupPath, DURABLE_BACKUP_DATABASE_FILE), "one")).toBe("first");
        expect(readValue(join(backupPath, DURABLE_BACKUP_DATABASE_FILE), "two")).toBe(
          "queued-before-backup",
        );

        const manifestJson = JSON.parse(
          await readFile(join(backupPath, DURABLE_BACKUP_MANIFEST_FILE), "utf8"),
        ) as unknown;
        expect(manifestJson).toEqual(result.manifest);

        const backupBlobStore = new FileContentAddressedBlobStore({
          rootPath: join(backupPath, DURABLE_BACKUP_BLOB_DIRECTORY),
        });
        expect(await backupBlobStore.readBytes(firstBlob)).toEqual(Buffer.from("first blob"));
        expect(await backupBlobStore.readBytes(secondBlob)).toEqual(Buffer.from("second blob"));

        const restored = await restoreDurableBackup({
          backupPath,
          databasePath: restoredDatabasePath,
          blobRootPath: restoredBlobRoot,
        });
        expect(restored.databasePath).toBe(restoredDatabasePath);
        expect(restored.blobRootPath).toBe(restoredBlobRoot);
        expect(restored.manifest).toEqual(result.manifest);
        expect(readValue(restoredDatabasePath, "two")).toBe("queued-before-backup");

        const restoredBlobStore = new FileContentAddressedBlobStore({
          rootPath: restoredBlobRoot,
        });
        expect(await restoredBlobStore.readBytes(firstBlob)).toEqual(Buffer.from("first blob"));
        expect(await restoredBlobStore.readBytes(secondBlob)).toEqual(Buffer.from("second blob"));
      } finally {
        await database.drainWrites();
        database.close();
      }
    });
  });

  it("supports an empty blob store without inventing blob records", async () => {
    await withWorkspace(async (root) => {
      const database = openDatabase(join(root, "runtime.sqlite"));
      const blobStore = new FileContentAddressedBlobStore({ rootPath: join(root, "blobs") });

      try {
        database.connection().exec("CREATE TABLE durable_test (key TEXT, value TEXT)");
        const result = await createDurableBackup({
          database,
          blobStore,
          destinationPath: join(root, "backup"),
          createdAtMs: 5,
        });

        expect(result.manifest.blobs.count).toBe(0);
        expect(
          new FileContentAddressedBlobStore({
            rootPath: join(root, "backup", DURABLE_BACKUP_BLOB_DIRECTORY),
          }).snapshot(),
        ).toEqual({
          rootPath: join(root, "backup", DURABLE_BACKUP_BLOB_DIRECTORY),
          algorithm: "sha256",
        });
      } finally {
        database.close();
      }
    });
  });

  it("rejects closed/in-memory sources and refuses to overwrite an existing backup", async () => {
    await withWorkspace(async (root) => {
      const closedDatabase = new SqliteDatabase({ path: join(root, "closed.sqlite") });
      const blobStore = new FileContentAddressedBlobStore({ rootPath: join(root, "blobs") });

      await expect(
        createDurableBackup({
          database: closedDatabase,
          blobStore,
          destinationPath: join(root, "closed-backup"),
        }),
      ).rejects.toThrow(/requires an open SQLite database/u);

      const memoryDatabase = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
      memoryDatabase.open();
      try {
        await expect(
          createDurableBackup({
            database: memoryDatabase,
            blobStore,
            destinationPath: join(root, "memory-backup"),
          }),
        ).rejects.toThrow(/requires a file-backed SQLite database/u);
      } finally {
        memoryDatabase.close();
      }

      const database = openDatabase(join(root, "runtime.sqlite"));
      const existingBackup = join(root, "existing-backup");
      await mkdir(existingBackup);
      try {
        await expect(
          createDurableBackup({
            database,
            blobStore,
            destinationPath: existingBackup,
          }),
        ).rejects.toThrow(/already exists/u);
      } finally {
        database.close();
      }
    });
  });

  it("rejects a corrupted blob backup before publishing restore destinations", async () => {
    await withWorkspace(async (root) => {
      const database = openDatabase(join(root, "runtime.sqlite"));
      const blobStore = new FileContentAddressedBlobStore({ rootPath: join(root, "blobs") });
      const backupPath = join(root, "backup");

      try {
        database.connection().exec("CREATE TABLE durable_test (key TEXT, value TEXT)");
        const ref = await blobStore.putBytes(Buffer.from("original"));
        await createDurableBackup({ database, blobStore, destinationPath: backupPath });

        const digest = ref.blobId.slice("sha256:".length);
        const backupBlobPath = join(
          backupPath,
          DURABLE_BACKUP_BLOB_DIRECTORY,
          "sha256",
          digest.slice(0, 2),
          digest.slice(2),
        );
        await writeFile(backupBlobPath, Buffer.from("tampered"));

        const databasePath = join(root, "restore", "runtime.sqlite");
        const blobRootPath = join(root, "restore", "blobs");
        await expect(
          restoreDurableBackup({ backupPath, databasePath, blobRootPath }),
        ).rejects.toThrow();

        await expectMissing(databasePath);
        await expectMissing(blobRootPath);
      } finally {
        database.close();
      }
    });
  });

  it("rejects a corrupted database backup by manifest digest before restore publication", async () => {
    await withWorkspace(async (root) => {
      const database = openDatabase(join(root, "runtime.sqlite"));
      const blobStore = new FileContentAddressedBlobStore({ rootPath: join(root, "blobs") });
      const backupPath = join(root, "backup");

      try {
        database.connection().exec("CREATE TABLE durable_test (key TEXT, value TEXT)");
        await createDurableBackup({ database, blobStore, destinationPath: backupPath });
        await writeFile(join(backupPath, DURABLE_BACKUP_DATABASE_FILE), Buffer.from("not sqlite"));

        const databasePath = join(root, "restore", "runtime.sqlite");
        const blobRootPath = join(root, "restore", "blobs");
        await expect(
          restoreDurableBackup({ backupPath, databasePath, blobRootPath }),
        ).rejects.toThrow(/does not match its manifest/u);

        await expectMissing(databasePath);
        await expectMissing(blobRootPath);
      } finally {
        database.close();
      }
    });
  });

  it("never merges restore data into existing database or blob destinations", async () => {
    await withWorkspace(async (root) => {
      const database = openDatabase(join(root, "runtime.sqlite"));
      const blobStore = new FileContentAddressedBlobStore({ rootPath: join(root, "blobs") });
      const backupPath = join(root, "backup");

      try {
        database.connection().exec("CREATE TABLE durable_test (key TEXT, value TEXT)");
        await createDurableBackup({ database, blobStore, destinationPath: backupPath });

        const existingDatabasePath = join(root, "existing", "runtime.sqlite");
        await mkdir(dirname(existingDatabasePath), { recursive: true });
        await writeFile(existingDatabasePath, Buffer.from("keep me"));

        await expect(
          restoreDurableBackup({
            backupPath,
            databasePath: existingDatabasePath,
            blobRootPath: join(root, "restore-blobs"),
          }),
        ).rejects.toThrow(/already exists/u);
        expect(await readFile(existingDatabasePath)).toEqual(Buffer.from("keep me"));

        const existingBlobRoot = join(root, "existing-blobs");
        await mkdir(existingBlobRoot);
        await expect(
          restoreDurableBackup({
            backupPath,
            databasePath: join(root, "restore.sqlite"),
            blobRootPath: existingBlobRoot,
          }),
        ).rejects.toThrow(/already exists/u);
      } finally {
        database.close();
      }
    });
  });

  it("fails backup on non-canonical blob-tree content instead of silently skipping it", async () => {
    await withWorkspace(async (root) => {
      const database = openDatabase(join(root, "runtime.sqlite"));
      const blobRoot = join(root, "blobs");
      const blobStore = new FileContentAddressedBlobStore({ rootPath: blobRoot });
      const backupPath = join(root, "backup");

      try {
        database.connection().exec("CREATE TABLE durable_test (key TEXT, value TEXT)");
        await blobStore.putBytes(Buffer.from("valid"));
        await mkdir(join(blobRoot, "sha256", "zz"));

        await expect(
          createDurableBackup({ database, blobStore, destinationPath: backupPath }),
        ).rejects.toThrow(/non-canonical shard entry/u);
        await expectMissing(backupPath);
      } finally {
        database.close();
      }
    });
  });
});
