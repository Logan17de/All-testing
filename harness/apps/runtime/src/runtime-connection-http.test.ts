import { afterEach, describe, expect, it } from "vitest";
import { SQLITE_MEMORY_PATH, SqliteDatabase, runSqliteMigrations } from "@zet-harness/db";
import { saveModelConfig, saveProviderConnection } from "@zet-harness/db/durable-model-records";
import { RuntimeModels } from "./runtime-models.js";
import { RUNTIME_DATABASE_MIGRATIONS, RuntimeDaemon } from "./runtime-daemon.js";
const daemons: RuntimeDaemon[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
});
interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}
async function startDaemon() {
  const daemon = new RuntimeDaemon({
    api: { port: 0 },
    database: { path: SQLITE_MEMORY_PATH },
    probePathLimits: false,
    plugins: {},
  });
  daemons.push(daemon);
  await daemon.start();
  const base = `http://127.0.0.1:${String(daemon.snapshot().api.port)}`;
  const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
    const writes = method !== "GET";
    const csrf = writes
      ? ((await (await fetch(`${base}/api/session`)).json()) as { readonly csrfToken: string })
          .csrfToken
      : undefined;
    const response = await fetch(`${base}${path}`, {
      method,
      headers: writes ? { "content-type": "application/json", "x-zet-csrf": csrf ?? "" } : {},
      ...(writes ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { send };
}

describe("direct provider integration boundary", () => {
  it("advertises supported auth without reporting a fabricated login", async () => {
    const { send } = await startDaemon();
    const result = await send("GET", "/api/connections");
    expect(result.status).toBe(200);
    expect(result.body["connections"]).toEqual([]);
    expect(result.body["integrations"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "codex", method: "official-cli" }),
        expect.objectContaining({ provider: "anthropic", subscriptionOAuth: false }),
        expect.objectContaining({ provider: "xai", subscriptionOAuth: false }),
      ]),
    );
  });
  it("retires every OpenRouter action without exchanging or creating credentials", async () => {
    const { send } = await startDaemon();
    for (const action of ["start", "complete", "sign-out", "models"]) {
      expect(
        (await send("POST", `/api/connections/openrouter/${action}`, { code: "private-value" }))
          .status,
      ).toBe(410);
    }
    expect(
      (
        await send("POST", "/api/models", {
          modelId: "retired",
          profile: "openrouter",
          credential: "connection",
        })
      ).status,
    ).toBe(400);
  });
  it("retains legacy rows but never registers or calls them after restart", async () => {
    const database = new SqliteDatabase({ path: SQLITE_MEMORY_PATH });
    database.open();
    runSqliteMigrations(database.connection(), RUNTIME_DATABASE_MIGRATIONS);
    const registered: string[] = [];
    const models = new RuntimeModels({
      database,
      register: (adapter) => {
        registered.push(adapter.manifest.id);
        return () => undefined;
      },
    });
    try {
      await database.commit((db) => {
        saveProviderConnection(db, "openrouter", "legacy-test-secret", 1);
        saveModelConfig(db, {
          modelId: "legacy",
          title: "Legacy",
          profile: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
          model: "old",
          credential: "connection",
          connection: "openrouter",
          tools: true,
          streaming: true,
          contextWindowTokens: 1000,
          nowMs: 1,
        });
      });
      expect(models.load()).toEqual([]);
      models.refresh("legacy");
      expect(registered).toEqual([]);
      expect(
        database.connection().prepare("SELECT COUNT(*) AS count FROM provider_connections").get(),
      ).toMatchObject({ count: 1 });
    } finally {
      models.clear();
      database.close();
    }
  });
});
