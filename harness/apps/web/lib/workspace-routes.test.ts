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
    ];
    for (const segments of refused) {
      expect(runtimeWorkspacePath(segments, new URLSearchParams())).toBeUndefined();
    }
  });
});
