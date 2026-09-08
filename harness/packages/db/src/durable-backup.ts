import { createHash, randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

import {
  CONTENT_ADDRESSED_BLOB_ALGORITHM,
  CONTENT_ADDRESSED_BLOB_ID_PREFIX,
  FileContentAddressedBlobStore,
  type ContentAddressedBlobId,
} from "./content-addressed-blob-store.js";

export const DURABLE_BACKUP_FORMAT = "zet-harness.backup/v1" as const;
export const DURABLE_BACKUP_MANIFEST_FILE = "manifest.json" as const;
export const DURABLE_BACKUP_DATABASE_FILE = "database.sqlite" as const;
export const DURABLE_BACKUP_BLOB_DIRECTORY = "blobs" as const;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BLOB_SHARD_PATTERN = /^[0-9a-f]{2}$/;
const BLOB_LEAF_PATTERN = /^[0-9a-f]{62}$/;
const HASH_BUFFER_BYTES = 64 * 1024;

export interface DurableBackupSqliteSource {
  snapshot(): {
    readonly state: "closed" | "open";
    readonly path: string;
    readonly inMemory: boolean;
  };
  connection(): DatabaseSync;
  drainWrites(): Promise<void>;
}

export interface DurableBackupManifest {
  readonly format: typeof DURABLE_BACKUP_FORMAT;
  readonly createdAtMs: number;
  readonly database: {
    readonly file: typeof DURABLE_BACKUP_DATABASE_FILE;
    readonly sha256: string;
    readonly sizeBytes: number;
  };
  readonly blobs: {
    readonly directory: typeof DURABLE_BACKUP_BLOB_DIRECTORY;
    readonly algorithm: typeof CONTENT_ADDRESSED_BLOB_ALGORITHM;
    readonly count: number;
  };
}

export interface CreateDurableBackupOptions {
  readonly database: DurableBackupSqliteSource;
  readonly blobStore: FileContentAddressedBlobStore;
  readonly destinationPath: string;
  readonly createdAtMs?: number;
}

export interface DurableBackupResult {
  readonly path: string;
  readonly databasePages: number;
  readonly manifest: DurableBackupManifest;
}

export interface RestoreDurableBackupOptions {
  readonly backupPath: string;
  readonly databasePath: string;
  readonly blobRootPath: string;
}

export interface DurableRestoreResult {
  readonly databasePath: string;
  readonly blobRootPath: string;
  readonly manifest: DurableBackupManifest;
}

interface FileDigest {
  readonly sha256: string;
  readonly sizeBytes: number;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function assertPathAbsent(path: string, label: string): Promise<void> {
  if (await pathExists(path)) {
    throw new TypeError(`${label} already exists at '${path}'.`);
  }
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isFile()) {
    throw new TypeError(`${label} must be a regular file.`);
  }
}

async function digestFile(path: string): Promise<FileDigest> {
  await assertRegularFile(path, `Backup file '${path}'`);
  const handle = await open(path, "r");
  const hash = createHash(CONTENT_ADDRESSED_BLOB_ALGORITHM);
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let sizeBytes = 0;

  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        break;
      }
      if (sizeBytes > Number.MAX_SAFE_INTEGER - bytesRead) {
        throw new RangeError(`File '${path}' exceeded the safe integer size range.`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally {
    await handle.close();
  }

  return Object.freeze({ sha256: hash.digest("hex"), sizeBytes });
}

async function listCanonicalBlobIds(rootPath: string): Promise<readonly ContentAddressedBlobId[]> {
  const algorithmPath = join(rootPath, CONTENT_ADDRESSED_BLOB_ALGORITHM);
  try {
    const stats = await lstat(algorithmPath);
    if (!stats.isDirectory()) {
      throw new TypeError(`Blob algorithm path '${algorithmPath}' must be a directory.`);
    }
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return Object.freeze([]);
    }
    throw error;
  }

  const shards = await readdir(algorithmPath, { withFileTypes: true });
  shards.sort((left, right) => left.name.localeCompare(right.name));
  const blobIds: ContentAddressedBlobId[] = [];

  for (const shard of shards) {
    if (!BLOB_SHARD_PATTERN.test(shard.name) || !shard.isDirectory()) {
      throw new TypeError(`Blob store contains non-canonical shard entry '${shard.name}'.`);
    }

    const leaves = await readdir(join(algorithmPath, shard.name), { withFileTypes: true });
    leaves.sort((left, right) => left.name.localeCompare(right.name));

    for (const leaf of leaves) {
      if (!BLOB_LEAF_PATTERN.test(leaf.name) || !leaf.isFile()) {
        throw new TypeError(
          `Blob store contains non-canonical blob entry '${shard.name}/${leaf.name}'.`,
        );
      }
      blobIds.push(
        `${CONTENT_ADDRESSED_BLOB_ID_PREFIX}${shard.name}${leaf.name}` as ContentAddressedBlobId,
      );
    }
  }

  return Object.freeze(blobIds);
}

async function copyBlobTree(sourceRootPath: string, destinationRootPath: string): Promise<void> {
  await mkdir(destinationRootPath, { recursive: true });
  const sourceAlgorithmPath = join(sourceRootPath, CONTENT_ADDRESSED_BLOB_ALGORITHM);
  const destinationAlgorithmPath = join(destinationRootPath, CONTENT_ADDRESSED_BLOB_ALGORITHM);

  if (!(await pathExists(sourceAlgorithmPath))) {
    return;
  }

  await cp(sourceAlgorithmPath, destinationAlgorithmPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
}

async function verifyBlobTree(
  rootPath: string,
  expectedCount?: number,
): Promise<readonly ContentAddressedBlobId[]> {
  const blobIds = await listCanonicalBlobIds(rootPath);
  if (expectedCount !== undefined && blobIds.length !== expectedCount) {
    throw new TypeError(
      `Backup blob count ${String(blobIds.length)} does not match manifest count ${String(expectedCount)}.`,
    );
  }

  const store = new FileContentAddressedBlobStore({ rootPath });
  for (const blobId of blobIds) {
    await store.verify(blobId);
  }
  return blobIds;
}

function assertSqliteIntegrity(path: string): void {
  const database = new DatabaseSync(path, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    readOnly: true,
  });

  try {
    const rows = database.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
    const value = rows[0] === undefined ? undefined : Object.values(rows[0])[0];
    if (rows.length !== 1 || value !== "ok") {
      throw new TypeError(`SQLite backup '${path}' failed PRAGMA quick_check.`);
    }
  } finally {
    database.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(raw: string): DurableBackupManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new TypeError("Durable backup manifest is not valid JSON.", { cause: error });
  }

  if (!isRecord(value) || value.format !== DURABLE_BACKUP_FORMAT) {
    throw new TypeError("Durable backup manifest has an unsupported format.");
  }
  if (typeof value.createdAtMs !== "number") {
    throw new TypeError("Durable backup manifest createdAtMs must be a number.");
  }
  assertNonNegativeSafeInteger(value.createdAtMs, "Durable backup manifest createdAtMs");

  const database = value.database;
  if (
    !isRecord(database) ||
    database.file !== DURABLE_BACKUP_DATABASE_FILE ||
    typeof database.sha256 !== "string" ||
    !SHA256_PATTERN.test(database.sha256) ||
    typeof database.sizeBytes !== "number"
  ) {
    throw new TypeError("Durable backup manifest has invalid database metadata.");
  }
  assertNonNegativeSafeInteger(database.sizeBytes, "Durable backup database sizeBytes");

  const blobs = value.blobs;
  if (
    !isRecord(blobs) ||
    blobs.directory !== DURABLE_BACKUP_BLOB_DIRECTORY ||
    blobs.algorithm !== CONTENT_ADDRESSED_BLOB_ALGORITHM ||
    typeof blobs.count !== "number"
  ) {
    throw new TypeError("Durable backup manifest has invalid blob metadata.");
  }
  assertNonNegativeSafeInteger(blobs.count, "Durable backup blob count");

  return Object.freeze({
    format: DURABLE_BACKUP_FORMAT,
    createdAtMs: value.createdAtMs,
    database: Object.freeze({
      file: DURABLE_BACKUP_DATABASE_FILE,
      sha256: database.sha256,
      sizeBytes: database.sizeBytes,
    }),
    blobs: Object.freeze({
      directory: DURABLE_BACKUP_BLOB_DIRECTORY,
      algorithm: CONTENT_ADDRESSED_BLOB_ALGORITHM,
      count: blobs.count,
    }),
  });
}

async function readManifest(backupPath: string): Promise<DurableBackupManifest> {
  const manifestPath = join(backupPath, DURABLE_BACKUP_MANIFEST_FILE);
  await assertRegularFile(manifestPath, "Durable backup manifest");
  return parseManifest(await readFile(manifestPath, "utf8"));
}

async function verifyDatabase(
  databasePath: string,
  manifest: DurableBackupManifest,
): Promise<void> {
  const digest = await digestFile(databasePath);
  if (
    digest.sha256 !== manifest.database.sha256 ||
    digest.sizeBytes !== manifest.database.sizeBytes
  ) {
    throw new TypeError("Durable backup database does not match its manifest digest/size.");
  }
  assertSqliteIntegrity(databasePath);
}

function stagingPath(destinationPath: string, label: string): string {
  return join(dirname(destinationPath), `.${basename(destinationPath)}.${label}-${randomUUID()}`);
}

/**
 * Create one immutable directory backup containing a SQLite snapshot and the
 * filesystem content-addressed blob store.
 *
 * SQLite owns database consistency through its online backup API. Current blob
 * semantics publish immutable bytes before SQLite output references and do not
 * delete blobs, so copying the blob tree after the database snapshot preserves
 * every blob the snapshot can reference without pausing normal runtime writes.
 */
export async function createDurableBackup(
  options: CreateDurableBackupOptions,
): Promise<DurableBackupResult> {
  if (options.destinationPath.trim().length === 0) {
    throw new TypeError("Durable backup destinationPath must not be empty.");
  }

  const source = options.database.snapshot();
  if (source.state !== "open") {
    throw new TypeError("Durable backup requires an open SQLite database.");
  }
  if (source.inMemory) {
    throw new TypeError("Durable backup requires a file-backed SQLite database.");
  }

  const createdAtMs = options.createdAtMs ?? Date.now();
  assertNonNegativeSafeInteger(createdAtMs, "Durable backup createdAtMs");

  const destinationPath = resolve(options.destinationPath);
  await assertPathAbsent(destinationPath, "Durable backup destination");
  await mkdir(dirname(destinationPath), { recursive: true });

  const workPath = stagingPath(destinationPath, "backup");
  await mkdir(workPath);

  try {
    await options.database.drainWrites();

    const databasePath = join(workPath, DURABLE_BACKUP_DATABASE_FILE);
    const databasePages = await backup(options.database.connection(), databasePath);
    assertSqliteIntegrity(databasePath);
    const databaseDigest = await digestFile(databasePath);

    const backupBlobRoot = join(workPath, DURABLE_BACKUP_BLOB_DIRECTORY);
    await copyBlobTree(options.blobStore.snapshot().rootPath, backupBlobRoot);
    const blobIds = await verifyBlobTree(backupBlobRoot);

    const manifest: DurableBackupManifest = Object.freeze({
      format: DURABLE_BACKUP_FORMAT,
      createdAtMs,
      database: Object.freeze({
        file: DURABLE_BACKUP_DATABASE_FILE,
        sha256: databaseDigest.sha256,
        sizeBytes: databaseDigest.sizeBytes,
      }),
      blobs: Object.freeze({
        directory: DURABLE_BACKUP_BLOB_DIRECTORY,
        algorithm: CONTENT_ADDRESSED_BLOB_ALGORITHM,
        count: blobIds.length,
      }),
    });

    await writeFile(
      join(workPath, DURABLE_BACKUP_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await rename(workPath, destinationPath);

    return Object.freeze({ path: destinationPath, databasePages, manifest });
  } catch (error) {
    await rm(workPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Restore a backup into clean offline destinations.
 *
 * Restore never overwrites or merges existing state. Blobs are staged and
 * published before the database file, so a failed restore cannot expose a
 * database that references missing restored blob bytes.
 */
export async function restoreDurableBackup(
  options: RestoreDurableBackupOptions,
): Promise<DurableRestoreResult> {
  if (
    options.backupPath.trim().length === 0 ||
    options.databasePath.trim().length === 0 ||
    options.blobRootPath.trim().length === 0
  ) {
    throw new TypeError("Restore backupPath, databasePath, and blobRootPath must not be empty.");
  }

  const backupPath = resolve(options.backupPath);
  const databasePath = resolve(options.databasePath);
  const blobRootPath = resolve(options.blobRootPath);
  const manifest = await readManifest(backupPath);
  const backupDatabasePath = join(backupPath, manifest.database.file);
  const backupBlobRoot = join(backupPath, manifest.blobs.directory);

  await verifyDatabase(backupDatabasePath, manifest);
  await verifyBlobTree(backupBlobRoot, manifest.blobs.count);
  await assertPathAbsent(databasePath, "Restore database destination");
  await assertPathAbsent(blobRootPath, "Restore blob destination");
  await mkdir(dirname(databasePath), { recursive: true });
  await mkdir(dirname(blobRootPath), { recursive: true });

  const workDatabasePath = stagingPath(databasePath, "restore");
  const workBlobRoot = stagingPath(blobRootPath, "restore");
  let blobsPublished = false;

  try {
    await copyFile(backupDatabasePath, workDatabasePath);
    await verifyDatabase(workDatabasePath, manifest);
    await copyBlobTree(backupBlobRoot, workBlobRoot);
    await verifyBlobTree(workBlobRoot, manifest.blobs.count);

    await rename(workBlobRoot, blobRootPath);
    blobsPublished = true;
    await rename(workDatabasePath, databasePath);

    return Object.freeze({ databasePath, blobRootPath, manifest });
  } catch (error) {
    if (blobsPublished && !(await pathExists(databasePath))) {
      await rm(blobRootPath, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  } finally {
    await rm(workDatabasePath, { force: true }).catch(() => undefined);
    await rm(workBlobRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
