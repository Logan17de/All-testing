/**
 * Back up and restore a harness.
 *
 * Everything a harness knows lives in two places: the SQLite database and the
 * content-addressed blob store beside it. This copies both into one directory, and
 * puts one back into empty destinations.
 *
 * Restoring never overwrites or merges: it refuses a destination that already
 * exists. Merging two histories would mean deciding which run really happened, and
 * that is not a decision a restore should make quietly.
 */
import { resolve } from "node:path";

import {
  FileContentAddressedBlobStore,
  SqliteDatabase,
  createDurableBackup,
  restoreDurableBackup,
} from "@zet-harness/db";

export const DEFAULT_DATABASE_PATH = resolve("data", "zet-harness.sqlite");
export const DEFAULT_BLOB_ROOT = resolve("data", "blobs");

export interface BackupCommand {
  readonly kind: "backup";
  readonly destination: string;
  readonly databasePath: string;
  readonly blobRootPath: string;
  readonly json: boolean;
}

export interface RestoreCommand {
  readonly kind: "restore";
  readonly backupPath: string;
  readonly databasePath: string;
  readonly blobRootPath: string;
  readonly json: boolean;
}

export interface HelpCommand {
  readonly kind: "help";
  readonly reason?: string;
}

export type BackupCliCommand = BackupCommand | RestoreCommand | HelpCommand;

export const BACKUP_CLI_USAGE = `Back up or restore a harness.

  backup  --to <directory> [--database <file>] [--blobs <directory>] [--json]
  restore --from <directory> --database <file> --blobs <directory> [--json]

A backup holds the database and the blob store as they were at that moment.
Restoring writes into destinations that do not exist yet; it never merges.

Defaults: --database ${DEFAULT_DATABASE_PATH}
          --blobs    ${DEFAULT_BLOB_ROOT}
`;

function optionOf(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

/** Read the command line, or say what is missing. Nothing here touches the disk. */
export function parseBackupCliArguments(argv: readonly string[]): BackupCliCommand {
  const [command, ...args] = argv;
  if (command === undefined || command === "help" || args.includes("--help")) {
    return { kind: "help" };
  }
  const json = args.includes("--json");
  const databasePath = resolve(optionOf(args, "database") ?? DEFAULT_DATABASE_PATH);
  const blobRootPath = resolve(optionOf(args, "blobs") ?? DEFAULT_BLOB_ROOT);

  if (command === "backup") {
    const destination = optionOf(args, "to");
    if (destination === undefined) {
      return { kind: "help", reason: "backup needs --to <directory>." };
    }
    return { kind: "backup", destination: resolve(destination), databasePath, blobRootPath, json };
  }
  if (command === "restore") {
    const backupPath = optionOf(args, "from");
    if (backupPath === undefined) {
      return { kind: "help", reason: "restore needs --from <directory>." };
    }
    if (optionOf(args, "database") === undefined || optionOf(args, "blobs") === undefined) {
      return {
        kind: "help",
        reason: "restore needs --database <file> and --blobs <directory>, and both must be new.",
      };
    }
    return { kind: "restore", backupPath: resolve(backupPath), databasePath, blobRootPath, json };
  }
  return { kind: "help", reason: `'${command}' is not a command.` };
}

/** Run one parsed command and describe what happened. */
export async function runBackupCliCommand(
  command: BackupCliCommand,
): Promise<{ readonly text: string; readonly data: Record<string, unknown> }> {
  if (command.kind === "help") {
    const reason = command.reason === undefined ? "" : `${command.reason}\n\n`;
    return { text: `${reason}${BACKUP_CLI_USAGE}`, data: { ok: command.reason === undefined } };
  }

  if (command.kind === "backup") {
    const database = new SqliteDatabase({ path: command.databasePath });
    database.open();
    try {
      const result = await createDurableBackup({
        database,
        blobStore: new FileContentAddressedBlobStore({ rootPath: command.blobRootPath }),
        destinationPath: command.destination,
      });
      return {
        text: [
          `Backed up to ${result.path}`,
          `  database: ${String(result.manifest.database.sizeBytes)} bytes in ${String(result.databasePages)} pages`,
          `  blobs:    ${String(result.manifest.blobs.count)}`,
        ].join("\n"),
        data: {
          ok: true,
          path: result.path,
          databasePages: result.databasePages,
          manifest: result.manifest,
        },
      };
    } finally {
      database.close();
    }
  }

  const restored = await restoreDurableBackup({
    backupPath: command.backupPath,
    databasePath: command.databasePath,
    blobRootPath: command.blobRootPath,
  });
  return {
    text: [
      `Restored ${command.backupPath}`,
      `  database: ${restored.databasePath}`,
      `  blobs:    ${restored.blobRootPath} (${String(restored.manifest.blobs.count)})`,
      "",
      "Start the harness against these paths with ZET_RUNTIME_DB_PATH.",
    ].join("\n"),
    data: { ok: true, ...restored },
  };
}

/** The command line itself: parse, run, print, and set an exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const command = parseBackupCliArguments(argv);
  try {
    const result = await runBackupCliCommand(command);
    const wanted = command.kind !== "help";
    const json = command.kind === "help" ? false : command.json;
    console.log(json ? JSON.stringify(result.data, null, 2) : result.text);
    return wanted || result.data["ok"] === true ? 0 : 2;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    return 1;
  }
}
