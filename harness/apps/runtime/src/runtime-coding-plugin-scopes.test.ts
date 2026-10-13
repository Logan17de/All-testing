import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { runSqliteMigrations } from "@zet-harness/db";
import { RUNTIME_DATABASE_MIGRATIONS } from "./runtime-daemon.js";
import {
  DURABLE_NATIVE_CHAT_SCOPES_MIGRATION,
  readNativeChatToolScopes,
  saveNativeChatToolScopes,
} from "./runtime-coding-plugin-scopes.js";
let directory: string;
let connection: DatabaseSync;
const first = "00000000-0000-7000-8000-000000000002";
const second = "00000000-0000-7000-8000-000000000003";
const base = RUNTIME_DATABASE_MIGRATIONS.filter((migration) => migration.version < 24);
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "zet-chat-scopes-"));
  connection = new DatabaseSync(join(directory, "state.sqlite"));
  connection.exec("PRAGMA foreign_keys = ON");
  runSqliteMigrations(connection, base);
  connection
    .prepare(
      "INSERT INTO projects(project_id,name,description,status,created_at_ms,updated_at_ms) VALUES (?, 'Project', '', 'active', 1, 1)",
    )
    .run("00000000-0000-7000-8000-000000000001");
  for (const id of [first, second])
    connection
      .prepare(
        "INSERT INTO conversations(conversation_id,project_id,title,status,created_at_ms,updated_at_ms) VALUES (?, ?, 'Chat', 'active', 1, 1)",
      )
      .run(id, "00000000-0000-7000-8000-000000000001");
});
afterEach(async () => {
  connection.close();
  await rm(directory, { recursive: true, force: true });
});
function migrate() {
  runSqliteMigrations(connection, [...base, DURABLE_NATIVE_CHAT_SCOPES_MIGRATION]);
}
it("appends migration 24 without changing existing conversations", () => {
  const before = connection.prepare("SELECT * FROM conversations ORDER BY conversation_id").all();
  migrate();
  expect(connection.prepare("SELECT * FROM conversations ORDER BY conversation_id").all()).toEqual(
    before,
  );
  expect(readNativeChatToolScopes(connection, first)).toEqual({ model: null, tools: null });
  expect(
    runSqliteMigrations(connection, [...base, DURABLE_NATIVE_CHAT_SCOPES_MIGRATION])
      .appliedVersions,
  ).toEqual([]);
});
it("persists separate chat associations and null versus empty restrictions through reload", () => {
  migrate();
  saveNativeChatToolScopes(
    connection,
    first,
    { model: ["provider.model"], tools: ["harness.fs.read"] },
    2,
  );
  saveNativeChatToolScopes(connection, second, { model: null, tools: [] }, 3);
  connection.close();
  connection = new DatabaseSync(join(directory, "state.sqlite"));
  connection.exec("PRAGMA foreign_keys = ON");
  expect(readNativeChatToolScopes(connection, first)).toEqual({
    model: ["provider.model"],
    tools: ["harness.fs.read"],
  });
  expect(readNativeChatToolScopes(connection, second)).toEqual({ model: null, tools: [] });
  expect(
    connection
      .prepare("SELECT updated_at_ms FROM native_chat_tool_scopes WHERE conversation_id = ?")
      .get(second)?.updated_at_ms,
  ).toBe(3);
});
it("rejects malformed lists and unknown fields without replacing stored restrictions", () => {
  migrate();
  saveNativeChatToolScopes(connection, first, { model: [], tools: ["read"] }, 2);
  for (const input of [
    { model: null, tools: null, grants: ["write"] },
    { model: null },
    { model: ["duplicate", "duplicate"], tools: null },
    { model: null, tools: [""] },
    { model: null, tools: [" padded "] },
    { model: null, tools: ["line\n"] },
    { model: null, tools: ["nul\0"] },
    { model: null, tools: ["x".repeat(201)] },
    { model: null, tools: Array.from({ length: 201 }, (_, index) => `tool.${index}`) },
    { model: null, tools: "all" },
  ])
    expect(() => saveNativeChatToolScopes(connection, first, input, 3)).toThrow(
      "Invalid native chat",
    );
  expect(readNativeChatToolScopes(connection, first)).toEqual({ model: [], tools: ["read"] });
  expect(
    connection
      .prepare("SELECT updated_at_ms FROM native_chat_tool_scopes WHERE conversation_id = ?")
      .get(first)?.updated_at_ms,
  ).toBe(2);
});
it("requires an existing conversation and joins caller transaction rollback", () => {
  migrate();
  expect(() =>
    saveNativeChatToolScopes(
      connection,
      "00000000-0000-7000-8000-000000000099",
      { model: null, tools: null },
      2,
    ),
  ).toThrow();
  connection.exec("BEGIN IMMEDIATE");
  saveNativeChatToolScopes(connection, first, { model: [], tools: [] }, 2);
  connection.exec("ROLLBACK");
  expect(readNativeChatToolScopes(connection, first)).toEqual({ model: null, tools: null });
});
it("fails closed on corrupted stored IDs and SQL rejects non-array JSON", () => {
  migrate();
  expect(() =>
    connection
      .prepare("INSERT INTO native_chat_tool_scopes VALUES (?, ?, NULL, 1)")
      .run(first, '{"grant":"write"}'),
  ).toThrow();
  connection
    .prepare("INSERT INTO native_chat_tool_scopes VALUES (?, ?, NULL, 1)")
    .run(first, '[" bad"]');
  expect(() => readNativeChatToolScopes(connection, first)).toThrow("Invalid native chat");
});
it("rejects invalid identifiers and timestamps before writing", () => {
  migrate();
  for (const id of ["", " chat", "chat\0", "x".repeat(201)])
    expect(() =>
      saveNativeChatToolScopes(connection, id, { model: null, tools: null }, 1),
    ).toThrow();
  for (const timestamp of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      saveNativeChatToolScopes(connection, first, { model: null, tools: null }, timestamp),
    ).toThrow();
  expect(
    connection.prepare("SELECT COUNT(*) AS count FROM native_chat_tool_scopes").get()?.count,
  ).toBe(0);
});
