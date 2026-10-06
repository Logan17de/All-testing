import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { afterEach, vi } from "vitest";
import { DURABLE_ASSISTANT_ACCESS_MIGRATION } from "./runtime-assistant-access.js";
import { createRuntimeAssistantService } from "./runtime-assistant-service.js";
let database: DatabaseSync;
afterEach(() => database.close());
function assistantFixture() {
  const db = (database = new DatabaseSync(":memory:"));
  db.exec(
    "CREATE TABLE conversations(conversation_id TEXT PRIMARY KEY);INSERT INTO conversations VALUES('root'),('existing');",
  );
  db.exec(DURABLE_ASSISTANT_ACCESS_MIGRATION.sql);
  const authority = {};
  const host = {
    read: vi.fn(() => Promise.resolve({ text: "private" })),
    status: vi.fn(() => Promise.resolve({})),
    create: vi.fn(() => Promise.resolve("unused")),
    delegate: vi.fn(() => Promise.resolve({})),
    control: vi.fn(() => Promise.resolve({})),
    revoke: vi.fn(),
    invalidateMemory: vi.fn(),
  };
  const service = createRuntimeAssistantService(db, host, authority);
  service.createRoot(authority, "root");
  return { service, authority, host, signal: new AbortController().signal };
}
import { createRuntimeAssistantTools } from "./runtime-assistant-tools.js";
import type { AdapterInvocationContext } from "@zet-harness/plugin-api";
it("model catalog excludes grant/reconnect and stale immutable binding denies before host retrieval", async () => {
  const f = assistantFixture();
  const b = f.service.connect(f.authority, "root", "existing", ["read"]);
  const tools = createRuntimeAssistantTools(f.service, b);
  expect(tools.map((t) => t.manifest.id)).toEqual([
    "harness.assistant.list",
    "harness.assistant.read",
    "harness.assistant.status",
    "harness.assistant.create",
    "harness.assistant.delegate",
    "harness.assistant.control",
    "harness.assistant.tools_request",
    "harness.assistant.tools_requests",
    "harness.assistant.tools_decide",
  ]);
  f.service.disconnect(f.authority, "root", "existing");
  await expect(
    tools[1]!.invoke({ chatId: "existing" }, { signal: f.signal } as AdapterInvocationContext),
  ).rejects.toThrow();
  expect(f.host.read).not.toHaveBeenCalled();
});
