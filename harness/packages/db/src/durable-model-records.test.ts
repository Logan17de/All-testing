import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import {
  DURABLE_MODEL_CONFIGS_MIGRATION,
  DURABLE_MODEL_CONNECTIONS_MIGRATION,
  DurableModelError,
  MODEL_CONFIGS_TABLE,
  deleteModelConfig,
  deleteProviderConnection,
  listModelConfigs,
  readModelApiKey,
  readModelConfig,
  readProviderConnection,
  replaceModelConfig,
  saveModelConfig,
  saveProviderConnection,
  type SaveModelInput,
} from "./durable-model-records.js";
import { runSqliteMigrations } from "./index.js";

function database(): DatabaseSync {
  const connection = new DatabaseSync(":memory:");
  runSqliteMigrations(connection, [
    DURABLE_MODEL_CONFIGS_MIGRATION,
    DURABLE_MODEL_CONNECTIONS_MIGRATION,
  ]);
  return connection;
}

const OLLAMA: SaveModelInput = {
  modelId: "local-llama",
  title: "Local llama",
  profile: "ollama",
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "llama3.1:8b",
  contextWindowTokens: 32_000,
  nowMs: 1_000,
};

function refusal(action: () => unknown): DurableModelError {
  try {
    action();
  } catch (error) {
    if (error instanceof DurableModelError) return error;
    throw error;
  }
  throw new Error("Expected the model configuration to be refused.");
}

describe("configured models", () => {
  it("stores a local model with no key, and defaults to offering tools", () => {
    const connection = database();
    const saved = saveModelConfig(connection, OLLAMA);

    expect(saved).toMatchObject({
      modelId: "local-llama",
      credential: "none",
      credentialEnv: null,
      tools: true,
      streaming: false,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    });
    expect(readModelApiKey(connection, "local-llama")).toBeUndefined();
    expect(listModelConfigs(connection)).toEqual([saved]);
  });

  it("keeps a stored key out of every record it returns", () => {
    const connection = database();
    const saved = saveModelConfig(connection, {
      ...OLLAMA,
      modelId: "hosted",
      profile: "openai",
      baseUrl: "https://api.example.com/v1",
      credential: "stored",
      apiKey: "  sk-secret  ",
    });

    expect(JSON.stringify(saved)).not.toContain("sk-secret");
    expect(JSON.stringify(listModelConfigs(connection))).not.toContain("sk-secret");
    expect(readModelApiKey(connection, "hosted")).toBe("sk-secret");
  });

  it("remembers which environment variable holds a key, and never the key", () => {
    const connection = database();
    saveModelConfig(connection, {
      ...OLLAMA,
      modelId: "from-env",
      profile: "openai",
      baseUrl: "https://api.example.com/v1",
      credential: "environment",
      credentialEnv: "OPENAI_API_KEY",
    });

    expect(readModelConfig(connection, "from-env")).toMatchObject({
      credential: "environment",
      credentialEnv: "OPENAI_API_KEY",
    });
    const row = connection
      .prepare(`SELECT api_key FROM ${MODEL_CONFIGS_TABLE} WHERE model_id = ?`)
      .get("from-env");
    expect(row).toEqual({ api_key: null });
  });

  it("refuses what it could not honour", () => {
    const connection = database();

    expect(
      refusal(() => saveModelConfig(connection, { ...OLLAMA, modelId: "Has Spaces" })).field,
    ).toBe("modelId");
    expect(
      refusal(() => saveModelConfig(connection, { ...OLLAMA, baseUrl: "ftp://example.com" })).field,
    ).toBe("baseUrl");
    expect(
      refusal(() =>
        saveModelConfig(connection, { ...OLLAMA, baseUrl: "https://user:pw@example.com/v1" }),
      ).field,
    ).toBe("baseUrl");
    // A key never travels in the clear to another machine, but may go to this one.
    expect(
      refusal(() =>
        saveModelConfig(connection, {
          ...OLLAMA,
          baseUrl: "http://models.example.com/v1",
          credential: "stored",
          apiKey: "sk-secret",
        }),
      ).field,
    ).toBe("baseUrl");
    expect(
      saveModelConfig(connection, {
        ...OLLAMA,
        modelId: "loopback-with-key",
        credential: "stored",
        apiKey: "sk-secret",
      }).credential,
    ).toBe("stored");
    expect(
      refusal(() => saveModelConfig(connection, { ...OLLAMA, credential: "stored" })).field,
    ).toBe("apiKey");
    expect(
      refusal(() =>
        saveModelConfig(connection, { ...OLLAMA, credential: "stored", apiKey: "one\ntwo" }),
      ).field,
    ).toBe("apiKey");
    expect(
      refusal(() => saveModelConfig(connection, { ...OLLAMA, apiKey: "sk-without-stored" })).field,
    ).toBe("apiKey");
    expect(
      refusal(() =>
        saveModelConfig(connection, { ...OLLAMA, credential: "environment", credentialEnv: "1X" }),
      ).field,
    ).toBe("credentialEnv");
    expect(
      refusal(() => saveModelConfig(connection, { ...OLLAMA, contextWindowTokens: 0 })).field,
    ).toBe("contextWindowTokens");

    saveModelConfig(connection, OLLAMA);
    expect(refusal(() => saveModelConfig(connection, OLLAMA)).code).toBe("MODEL_CONFIG_EXISTS");
  });

  it("keeps a stored key when a change names none, and drops it when the model stops using one", () => {
    const connection = database();
    saveModelConfig(connection, {
      ...OLLAMA,
      profile: "openai",
      baseUrl: "https://api.example.com/v1",
      credential: "stored",
      apiKey: "sk-first",
    });

    const moved = replaceModelConfig(connection, {
      ...OLLAMA,
      profile: "openai",
      baseUrl: "https://api.example.com/v2",
      credential: "stored",
      nowMs: 2_000,
    });
    expect(moved).toMatchObject({ baseUrl: "https://api.example.com/v2", createdAtMs: 1_000 });
    expect(moved.updatedAtMs).toBe(2_000);
    expect(readModelApiKey(connection, "local-llama")).toBe("sk-first");

    replaceModelConfig(connection, {
      ...OLLAMA,
      profile: "openai",
      baseUrl: "https://api.example.com/v2",
      credential: "stored",
      apiKey: "sk-second",
      nowMs: 3_000,
    });
    expect(readModelApiKey(connection, "local-llama")).toBe("sk-second");

    replaceModelConfig(connection, { ...OLLAMA, nowMs: 4_000 });
    expect(readModelApiKey(connection, "local-llama")).toBeUndefined();

    // Switching to a stored key needs a key to store.
    expect(
      refusal(() =>
        replaceModelConfig(connection, { ...OLLAMA, credential: "stored", nowMs: 5_000 }),
      ).field,
    ).toBe("apiKey");
  });

  it("forgets a model and reports whether there was one", () => {
    const connection = database();
    saveModelConfig(connection, OLLAMA);
    expect(deleteModelConfig(connection, "local-llama")).toBe(true);
    expect(deleteModelConfig(connection, "local-llama")).toBe(false);
    expect(refusal(() => replaceModelConfig(connection, { ...OLLAMA, nowMs: 2_000 })).code).toBe(
      "MODEL_CONFIG_NOT_FOUND",
    );
  });

  it("reads a model's key from a provider sign-in, and loses it when the person signs out", () => {
    const connection = database();
    const saved = saveModelConfig(connection, {
      ...OLLAMA,
      modelId: "claude-via-openrouter",
      profile: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "anthropic/claude-sonnet-4",
      credential: "connection",
      connection: "openrouter",
    });
    expect(saved).toMatchObject({ credential: "connection", connection: "openrouter" });
    // Not signed in yet: the model is configured but has no key.
    expect(readModelApiKey(connection, "claude-via-openrouter")).toBeUndefined();

    expect(saveProviderConnection(connection, "openrouter", "sk-or-first", 2_000)).toEqual({
      provider: "openrouter",
      method: "oauth",
      connectedAtMs: 2_000,
    });
    expect(readModelApiKey(connection, "claude-via-openrouter")).toBe("sk-or-first");
    // Signing in again replaces the key for every model that uses the sign-in.
    saveProviderConnection(connection, "openrouter", "sk-or-second", 3_000);
    expect(readModelApiKey(connection, "claude-via-openrouter")).toBe("sk-or-second");
    expect(JSON.stringify(readProviderConnection(connection, "openrouter"))).not.toContain("sk-or");

    expect(deleteProviderConnection(connection, "openrouter")).toBe(true);
    expect(deleteProviderConnection(connection, "openrouter")).toBe(false);
    expect(readModelApiKey(connection, "claude-via-openrouter")).toBeUndefined();
    expect(readModelConfig(connection, "claude-via-openrouter")).toMatchObject({
      credential: "connection",
    });
  });

  it("refuses a sign-in credential that names no provider it knows", () => {
    const connection = database();
    expect(
      refusal(() =>
        saveModelConfig(connection, {
          ...OLLAMA,
          baseUrl: "https://openrouter.ai/api/v1",
          credential: "connection",
        }),
      ).field,
    ).toBe("connection");
    expect(
      refusal(() => saveModelConfig(connection, { ...OLLAMA, connection: "openrouter" })).field,
    ).toBe("connection");
    expect(() => saveProviderConnection(connection, "openrouter", "  ", 1)).toThrow(
      DurableModelError,
    );
  });

  it("keeps every model configured before sign-ins existed", () => {
    const connection = new DatabaseSync(":memory:");
    runSqliteMigrations(connection, [DURABLE_MODEL_CONFIGS_MIGRATION]);
    connection
      .prepare(
        `INSERT INTO model_configs (
          model_id, title, profile, base_url, model, credential, credential_env, api_key,
          tools, streaming, context_window_tokens, created_at_ms, updated_at_ms
        ) VALUES ('hosted', 'Hosted', 'openai', 'https://api.example.com/v1', 'gpt', 'stored',
          NULL, 'sk-kept', 1, 0, 128000, 5, 6)`,
      )
      .run();

    runSqliteMigrations(connection, [
      DURABLE_MODEL_CONFIGS_MIGRATION,
      DURABLE_MODEL_CONNECTIONS_MIGRATION,
    ]);

    expect(readModelConfig(connection, "hosted")).toMatchObject({
      credential: "stored",
      connection: null,
      createdAtMs: 5,
      updatedAtMs: 6,
    });
    expect(readModelApiKey(connection, "hosted")).toBe("sk-kept");
    // The rebuilt table still keeps a model's identity.
    expect(() =>
      connection
        .prepare("UPDATE model_configs SET created_at_ms = 1 WHERE model_id = 'hosted'")
        .run(),
    ).toThrow(/keeps its id/u);
  });
});
