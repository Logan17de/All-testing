import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  DURABLE_WORKSPACES_MIGRATION,
  forgetWorkspace,
  listWorkspaces,
  rememberWorkspace,
} from "./durable-workspace-records.js";
import { runSqliteMigrations } from "./index.js";

function database(): DatabaseSync {
  const connection = new DatabaseSync(":memory:");
  runSqliteMigrations(connection, [DURABLE_WORKSPACES_MIGRATION]);
  return connection;
}

describe("the folders this harness works in", () => {
  it("leads with the one opened most recently", () => {
    const connection = database();
    rememberWorkspace(connection, "D:/work/alpha", 1_000);
    rememberWorkspace(connection, "D:/work/beta", 2_000);
    expect(listWorkspaces(connection).map((entry) => entry.path)).toEqual([
      "D:/work/beta",
      "D:/work/alpha",
    ]);

    // Opening the older one again moves it to the front, keeping when it was added.
    expect(rememberWorkspace(connection, "D:/work/alpha", 3_000)).toEqual({
      path: "D:/work/alpha",
      addedAtMs: 1_000,
      openedAtMs: 3_000,
    });
    expect(listWorkspaces(connection).map((entry) => entry.path)).toEqual([
      "D:/work/alpha",
      "D:/work/beta",
    ]);
  });

  it("forgets one without touching the others", () => {
    const connection = database();
    rememberWorkspace(connection, "D:/work/alpha", 1_000);
    rememberWorkspace(connection, "D:/work/beta", 2_000);
    expect(forgetWorkspace(connection, "D:/work/beta")).toBe(true);
    expect(forgetWorkspace(connection, "D:/work/beta")).toBe(false);
    expect(listWorkspaces(connection).map((entry) => entry.path)).toEqual(["D:/work/alpha"]);
  });

  it("refuses a path or a time it cannot store", () => {
    const connection = database();
    expect(() => rememberWorkspace(connection, "", 1_000)).toThrow(TypeError);
    expect(() => rememberWorkspace(connection, "D:/work", -1)).toThrow(TypeError);
  });
});
