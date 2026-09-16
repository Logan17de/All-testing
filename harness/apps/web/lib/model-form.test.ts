import { describe, expect, it } from "vitest";

import {
  checkModelDraft,
  describeCheck,
  draftFor,
  draftFromModel,
  suggestModelId,
  type ModelDraft,
} from "./model-form";

const draft = (partial: Partial<ModelDraft>): ModelDraft => ({
  ...draftFor("ollama"),
  modelId: "local-llama",
  model: "llama3.1:8b",
  ...partial,
});

describe("starting a model from a preset", () => {
  it("fills in where each kind of endpoint usually lives, and whether it wants a key", () => {
    expect(draftFor("ollama")).toMatchObject({
      baseUrl: "http://127.0.0.1:11434/v1",
      credential: "none",
    });
    expect(draftFor("openai")).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      credential: "stored",
      credentialEnv: "OPENAI_API_KEY",
    });
  });

  it("suggests an id a graph can pin from the model name", () => {
    expect(suggestModelId("llama3.1:8b")).toBe("llama3.1-8b");
    expect(suggestModelId("  GPT-4o Mini ")).toBe("gpt-4o-mini");
    expect(suggestModelId("--")).toBe("");
  });
});

describe("what the Models page sends", () => {
  it("sends a local model with no key", () => {
    expect(checkModelDraft(draft({}), false)).toEqual({
      ok: true,
      request: {
        modelId: "local-llama",
        title: "llama3.1:8b",
        profile: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "llama3.1:8b",
        credential: "none",
        tools: true,
        contextWindowTokens: 8_192,
      },
    });
  });

  it("sends a hosted model with its key, or the variable that holds it", () => {
    const hosted = { ...draftFor("openai"), modelId: "gpt", model: "gpt-4o-mini" };
    expect(checkModelDraft({ ...hosted, apiKey: " sk-test " }, false)).toMatchObject({
      ok: true,
      request: { credential: "stored", apiKey: "sk-test" },
    });
    const fromEnv = checkModelDraft({ ...hosted, credential: "environment" }, false);
    expect(fromEnv).toMatchObject({
      ok: true,
      request: { credential: "environment", credentialEnv: "OPENAI_API_KEY" },
    });
    expect(fromEnv.ok && "apiKey" in fromEnv.request).toBe(false);
  });

  it("keeps the stored key when an edit leaves the key field empty", () => {
    const hosted = { ...draftFor("openai"), modelId: "gpt", model: "gpt-4o-mini" };
    expect(checkModelDraft(hosted, false)).toEqual({
      ok: false,
      reason: "Paste the API key for this endpoint.",
    });
    const edited = checkModelDraft(hosted, true);
    expect(edited.ok).toBe(true);
    expect(edited.ok && "apiKey" in edited.request).toBe(false);
  });

  it("says what is wrong before anything is sent", () => {
    const reason = (partial: Partial<ModelDraft>): string => {
      const result = checkModelDraft(draft(partial), false);
      return result.ok ? "" : result.reason;
    };
    expect(reason({ modelId: "Local Llama" })).toContain("Give the model an id");
    expect(reason({ model: "  " })).toBe("Name the model the endpoint serves.");
    expect(reason({ baseUrl: "localhost:11434" })).toContain("must be http or https");
    expect(reason({ baseUrl: "not a url" })).toContain("must be a URL");
    expect(reason({ baseUrl: "https://me:pw@example.com/v1" })).toBe(
      "Put the key in the key field, not in the URL.",
    );
    expect(
      reason({ baseUrl: "http://models.example.com/v1", credential: "stored", apiKey: "k" }),
    ).toBe("A key is only sent over https, or to a server on this machine.");
    expect(reason({ contextWindowTokens: "lots" })).toBe(
      "The context window is a whole number of tokens.",
    );
    expect(reason({ credential: "environment", credentialEnv: "" })).toBe(
      "Name the environment variable that holds the key.",
    );
  });

  it("starts an edit from what is configured, without the key", () => {
    expect(
      draftFromModel({
        modelId: "gpt",
        title: "GPT",
        profile: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        credential: "stored",
        credentialEnv: null,
        tools: false,
        streaming: false,
        contextWindowTokens: 128_000,
        createdAtMs: 1,
        updatedAtMs: 2,
      }),
    ).toMatchObject({ apiKey: "", credentialEnv: "", tools: false, contextWindowTokens: "128000" });
  });
});

describe("what a check found", () => {
  it("puts the runtime's answer in words a person can act on", () => {
    expect(describeCheck({ ok: true, latencyMs: 42 })).toEqual({
      ok: true,
      text: "It answered in 42 ms.",
    });
    expect(describeCheck({ ok: false, code: "MODEL_HTTP_ERROR", status: 401 }).text).toContain(
      "refused the key",
    );
    expect(describeCheck({ ok: false, code: "MODEL_HTTP_ERROR", status: 404 }).text).toContain(
      "404",
    );
    expect(describeCheck({ ok: false, code: "MODEL_NETWORK_ERROR" }).text).toContain(
      "could not be reached",
    );
    expect(describeCheck({ ok: false, code: "SOMETHING_NEW" }).text).toBe(
      "It did not answer (SOMETHING_NEW).",
    );
    expect(describeCheck(null).ok).toBe(false);
  });
});
