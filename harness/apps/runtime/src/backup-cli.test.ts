import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileContentAddressedBlobStore,
  SqliteDatabase,
  runSqliteMigrations,
} from "@zet-harness/db";

import { BACKUP_CLI_USAGE, parseBackupCliArguments, runBackupCliCommand } from "./backup-cli.js";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zet-backup-"));
  roots.push(root);
  return root;
}

/** A harness with something in it: a migrated database and one stored blob. */
async function harnessState(root: string): Promise<{
  readonly databasePath: string;
  readonly blobRootPath: string;
}> {
  const databasePath = join(root, "data", "zet-harness.sqlite");
  const blobRootPath = join(root, "data", "blobs");
  const database = new SqliteDatabase({ path: databasePath });
  database.open();
  runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
  database.close();
  await new FileContentAddressedBlobStore({ rootPath: blobRootPath }).putBytes(
    new TextEncoder().encode("a stored file"),
  );
  return { databasePath, blobRootPath };
}

describe("reading the backup command line (11.3)", () => {
  it("reads a backup command, with defaults for what is not given", () => {
    const command = parseBackupCliArguments(["backup", "--to", "out"]);
    expect(command).toMatchObject({ kind: "backup", json: false });
    expect(command.kind === "backup" && command.databasePath).toContain("zet-harness.sqlite");
    expect(parseBackupCliArguments(["backup", "--to", "out", "--json"])).toMatchObject({
      json: true,
    });
  });

  it("reads a restore command, and insists on being told where to put it", () => {
    expect(
      parseBackupCliArguments([
        "restore",
        "--from",
        "out",
        "--database",
        "new.sqlite",
        "--blobs",
        "new-blobs",
      ]),
    ).toMatchObject({ kind: "restore" });
    // Restoring over the defaults would quietly overwrite a live harness.
    expect(parseBackupCliArguments(["restore", "--from", "out"])).toMatchObject({ kind: "help" });
    expect(parseBackupCliArguments(["restore"])).toMatchObject({ kind: "help" });
  });

  it("explains itself when asked, and when given something it does not know", async () => {
    expect(parseBackupCliArguments([])).toEqual({ kind: "help" });
    expect(parseBackupCliArguments(["sideways"])).toMatchObject({
      kind: "help",
      reason: "'sideways' is not a command.",
    });
    const help = await runBackupCliCommand({ kind: "help" });
    expect(help.text).toBe(BACKUP_CLI_USAGE);
    expect(help.data["ok"]).toBe(true);
    const unknown = await runBackupCliCommand({ kind: "help", reason: "'x' is not a command." });
    expect(unknown.data["ok"]).toBe(false);
  });
});

describe("backing up and restoring (11.3)", () => {
  it("copies the database and the blobs, then puts them back somewhere new", async () => {
    const root = await workspace();
    const { databasePath, blobRootPath } = await harnessState(root);
    const destination = join(root, "backups", "first");

    const backup = await runBackupCliCommand({
      kind: "backup",
      destination,
      databasePath,
      blobRootPath,
      json: false,
    });
    expect(backup.data["ok"]).toBe(true);
    expect(backup.text).toContain("Backed up to");
    const manifest = JSON.parse(
      await readFile(join(destination, "manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest["format"]).toBe("zet-harness.backup/v1");
    expect(manifest["blobs"]).toMatchObject({ count: 1 });

    const restored = await runBackupCliCommand({
      kind: "restore",
      backupPath: destination,
      databasePath: join(root, "restored", "zet-harness.sqlite"),
      blobRootPath: join(root, "restored", "blobs"),
      json: false,
    });
    expect(restored.data["ok"]).toBe(true);

    // The restored database is a working harness database, with the same schema.
    const database = new SqliteDatabase({ path: join(root, "restored", "zet-harness.sqlite") });
    database.open();
    const version = database
      .connection()
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { readonly version: number };
    database.close();
    expect(version.version).toBe(
      RUNTIME_DATABASE_MIGRATIONS[RUNTIME_DATABASE_MIGRATIONS.length - 1]?.version,
    );
  });

  it("refuses to write over a backup or a harness that is already there", async () => {
    const root = await workspace();
    const { databasePath, blobRootPath } = await harnessState(root);
    const destination = join(root, "backups", "first");
    const backup = {
      kind: "backup" as const,
      destination,
      databasePath,
      blobRootPath,
      json: false,
    };
    await runBackupCliCommand(backup);

    // A backup directory is written once, so a second one cannot quietly replace it.
    await expect(runBackupCliCommand(backup)).rejects.toThrow();

    // Restoring onto an existing database would merge two histories.
    await expect(
      runBackupCliCommand({
        kind: "restore",
        backupPath: destination,
        databasePath,
        blobRootPath: join(root, "restored", "blobs"),
        json: false,
      }),
    ).rejects.toThrow();
  });

  it("refuses a backup directory that is not one", async () => {
    const root = await workspace();
    const pretend = join(root, "not-a-backup");
    await rm(pretend, { recursive: true, force: true });
    await writeFile(join(root, "stray.txt"), "nothing", "utf8");

    await expect(
      runBackupCliCommand({
        kind: "restore",
        backupPath: pretend,
        databasePath: join(root, "restored.sqlite"),
        blobRootPath: join(root, "restored-blobs"),
        json: false,
      }),
    ).rejects.toThrow();
  });
});
