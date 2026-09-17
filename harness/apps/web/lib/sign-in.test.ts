import { describe, expect, it } from "vitest";

import {
  codeFromReturn,
  filterModels,
  isConnectionView,
  modelIdFromOpenRouter,
  releaseYear,
  signInReturnUrl,
  type OpenRouterModel,
} from "./sign-in";

const model = (id: string, name: string, releasedAtMs = 0): OpenRouterModel => ({
  id,
  name,
  contextLength: 128_000,
  releasedAtMs,
});

const MODELS: readonly OpenRouterModel[] = [
  model("anthropic/claude-sonnet-4", "Anthropic: Claude Sonnet 4"),
  model("google/gemini-2.5-flash", "Google: Gemini 2.5 Flash"),
  model("openai/gpt-4o-mini", "OpenAI: GPT-4o-mini"),
  model("x-ai/grok-4", "xAI: Grok 4"),
];

describe("signing in to OpenRouter", () => {
  it("returns to this app on localhost, on the port it is served from", () => {
    expect(signInReturnUrl("http://127.0.0.1:3000")).toBe(
      "http://localhost:3000/models/openrouter",
    );
    expect(signInReturnUrl("http://localhost:4123/models?x=1#top")).toBe(
      "http://localhost:4123/models/openrouter",
    );
  });

  it("reads the code OpenRouter sent back, or says why there is none", () => {
    expect(codeFromReturn(new URLSearchParams("code=abc"))).toEqual({ code: "abc" });
    expect(codeFromReturn(new URLSearchParams(""))).toEqual({
      reason: "OpenRouter sent no sign-in code back.",
    });
    expect(codeFromReturn(new URLSearchParams("error=access_denied&code=abc"))).toEqual({
      reason: "The sign-in was cancelled on OpenRouter.",
    });
  });

  it("finds models by maker and by words in their id or name", () => {
    expect(filterModels(MODELS, "", "x-ai/").map((model) => model.id)).toEqual(["x-ai/grok-4"]);
    expect(filterModels(MODELS, "GEMINI flash", "").map((model) => model.id)).toEqual([
      "google/gemini-2.5-flash",
    ]);
    expect(filterModels(MODELS, "", "")).toHaveLength(4);
    expect(filterModels(MODELS, "grok", "openai/")).toEqual([]);
  });

  it("names a picked model after its OpenRouter id, without the maker", () => {
    expect(modelIdFromOpenRouter("anthropic/claude-sonnet-4")).toBe("claude-sonnet-4");
    expect(modelIdFromOpenRouter("openai/gpt-4o:free")).toBe("gpt-4o-free");
  });

  it("keeps the order it was given, so the newest models stay on top", () => {
    const newest = model("openai/gpt-5.5", "OpenAI: GPT-5.5", Date.parse("2026-09-01T00:00:00Z"));
    const listed = [newest, ...MODELS.filter((entry) => entry.id.startsWith("openai/"))];
    expect(filterModels(listed, "", "openai/").map((entry) => entry.id)).toEqual([
      "openai/gpt-5.5",
      "openai/gpt-4o-mini",
    ]);
    expect(releaseYear(newest)).toBe("2026-09");
    expect(releaseYear(model("openai/gpt-4o-mini", "OpenAI: GPT-4o-mini"))).toBe("");
  });

  it("accepts only a sign-in status it understands", () => {
    expect(
      isConnectionView({
        provider: "openrouter",
        title: "OpenRouter",
        connected: true,
        connectedAtMs: 1,
        models: 0,
        apiBaseUrl: "https://openrouter.ai/api/v1",
      }),
    ).toBe(true);
    expect(isConnectionView({ provider: "other", connected: true })).toBe(false);
    expect(isConnectionView(null)).toBe(false);
  });
});
