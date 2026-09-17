import type { SqliteMigration } from "./migrations.js";

export const APP_SETTINGS_TABLE = "app_settings" as const;

/** The settings a person chooses in the app, by key. */
export const SETTING_KEYS = ["workspace.root"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/**
 * Choices a person makes in the app rather than in a config file.
 *
 * A config file and the environment still win where both exist, because they are
 * how a harness is run unattended; these are what the first-run setup and the
 * settings pages write, and they take effect without a restart.
 */
export interface DurableSettingRecord {
  readonly key: SettingKey;
  readonly value: unknown;
  readonly updatedAtMs: number;
}

/** Append new migrations; never edit the already-shipped schemas. */
export const DURABLE_APP_SETTINGS_MIGRATION: SqliteMigration = Object.freeze({
  version: 21,
  name: "durable_app_settings",
  sql: `
CREATE TABLE ${APP_SETTINGS_TABLE} (
  key TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 100),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) STRICT;
`,
});

/** Minimal statement surface, so this module does not depend on a driver type. */
export interface SettingStatementRunner {
  prepare(sql: string): {
    run(...parameters: readonly unknown[]): unknown;
    get(...parameters: readonly unknown[]): Record<string, unknown> | undefined;
  };
}

function checkKey(key: string): SettingKey {
  if (!(SETTING_KEYS as readonly string[]).includes(key)) {
    throw new TypeError(`'${key}' is not a setting.`);
  }
  return key as SettingKey;
}

export function readSetting(
  connection: SettingStatementRunner,
  key: SettingKey,
): DurableSettingRecord | undefined {
  const row = connection
    .prepare(`SELECT key, value_json, updated_at_ms FROM ${APP_SETTINGS_TABLE} WHERE key = ?`)
    .get(checkKey(key));
  if (row === undefined) return undefined;
  return Object.freeze({
    key,
    value: JSON.parse(row["value_json"] as string) as unknown,
    updatedAtMs: row["updated_at_ms"] as number,
  });
}

/** Set one setting, replacing what was there. */
export function writeSetting(
  connection: SettingStatementRunner,
  key: SettingKey,
  value: unknown,
  nowMs: number,
): DurableSettingRecord {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("Setting times are UTC epoch milliseconds.");
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new TypeError("A setting's value must be JSON.");
  connection
    .prepare(
      `INSERT INTO ${APP_SETTINGS_TABLE} (key, value_json, updated_at_ms) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
         updated_at_ms = excluded.updated_at_ms`,
    )
    .run(checkKey(key), text, nowMs);
  return Object.freeze({ key, value: JSON.parse(text) as unknown, updatedAtMs: nowMs });
}
