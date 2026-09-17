import { describe, expect, it } from "vitest";

import { runtimeWorkspacePath } from "./workspace-routes";

const ID = "01890a5d-ac96-774b-bcce-b302099a8057";

describe("workspace proxy paths", () => {
  it("maps workspace paths to runtime endpoints and keeps only known query parameters", () => {
    expect(runtimeWorkspacePath(["projects"], new URLSearchParams("status=all&debug=1"))).toBe(
      "/api/projects?status=all",
    );
    expect(
      runtimeWorkspacePath(["projects", ID, "todos", "next"], new URLSearchParams(`goalId=${ID}`)),
    ).toBe(`/api/projects/${ID}/todos/next?goalId=${ID}`);
    expect(
      runtimeWorkspacePath(["conversations", ID, "messages", ID, "path"], new URLSearchParams()),
    ).toBe(`/api/conversations/${ID}/messages/${ID}/path`);
    expect(runtimeWorkspacePath(["todos", ID, "status"], new URLSearchParams())).toBe(
      `/api/todos/${ID}/status`,
    );
    expect(runtimeWorkspacePath(["conversations", ID, "reply"], new URLSearchParams())).toBe(
      `/api/conversations/${ID}/reply`,
    );
    expect(runtimeWorkspacePath(["workflows"], new URLSearchParams())).toBe("/api/workflows");
    expect(runtimeWorkspacePath(["setup"], new URLSearchParams())).toBe("/api/setup");
    expect(runtimeWorkspacePath(["setup", "workspace"], new URLSearchParams())).toBe(
      "/api/setup/workspace",
    );
    expect(
      runtimeWorkspacePath(["setup", "folders"], new URLSearchParams({ path: "D:\\Code", x: "1" })),
    ).toBe("/api/setup/folders?path=D%3A%5CCode");
    expect(
      runtimeWorkspacePath(
        ["workflows", "chat-github"],
        new URLSearchParams(`conversationId=${ID}`),
      ),
    ).toBe(`/api/workflows/chat-github?conversationId=${ID}`);
    expect(runtimeWorkspacePath(["setup", "workspaces"], new URLSearchParams())).toBe(
      "/api/setup/workspaces",
    );
    expect(runtimeWorkspacePath(["setup", "workspaces", "forget"], new URLSearchParams())).toBe(
      "/api/setup/workspaces/forget",
    );
    expect(runtimeWorkspacePath(["connections"], new URLSearchParams())).toBe("/api/connections");
    for (const action of ["start", "complete", "sign-out", "models"]) {
      expect(
        runtimeWorkspacePath(["connections", "openrouter", action], new URLSearchParams()),
      ).toBe(`/api/connections/openrouter/${action}`);
    }
    expect(runtimeWorkspacePath(["connections", "openai", "start"], new URLSearchParams())).toBe(
      undefined,
    );
  });

  it("refuses anything outside the workspace allowlist", () => {
    const refused: readonly (readonly string[])[] = [
      [],
      ["runs"],
      ["session"],
      ["projects", "..", "runs"],
      ["projects", "not-an-id"],
      ["projects", ID, "delete"],
      ["projects", `${ID}/archive`],
      ["goals", ID, "todos", "extra"],
      ["approvals", ID],
      ["workflows", "anything"],
      ["setup", "delete"],
      ["workflows", "chat", "run"],
    ];
    for (const segments of refused) {
      expect(runtimeWorkspacePath(segments, new URLSearchParams())).toBeUndefined();
    }
  });
});
