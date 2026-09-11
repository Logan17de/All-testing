import { describe, expect, it } from "vitest";

import {
  LLAMA_CPP_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_BASE_URL,
  OPENAI_DEFAULT_BASE_URL,
  llamaCppEndpointProfile,
  ollamaEndpointProfile,
  openAIEndpointProfile,
} from "./endpoint-profiles.js";

describe("profile defaults", () => {
  it("points Ollama at its documented loopback port", () => {
    const options = ollamaEndpointProfile({ id: "local", model: "llama3.1:8b" });
    expect(options.baseUrl).toBe(OLLAMA_DEFAULT_BASE_URL);
  });

  it("points llama.cpp at its documented loopback port", () => {
    const options = llamaCppEndpointProfile({ id: "local", model: "any" });
    expect(options.baseUrl).toBe(LLAMA_CPP_DEFAULT_BASE_URL);
  });

  it("points the OpenAI profile at the hosted API over HTTPS", () => {
    const options = openAIEndpointProfile({ id: "cloud", model: "gpt-x" });
    expect(options.baseUrl).toBe(OPENAI_DEFAULT_BASE_URL);
    expect(options.baseUrl.startsWith("https://")).toBe(true);
  });

  it("lets the host override the base URL", () => {
    const options = ollamaEndpointProfile({
      id: "local",
      model: "m",
      baseUrl: "http://127.0.0.1:9999/v1",
    });
    expect(options.baseUrl).toBe("http://127.0.0.1:9999/v1");
  });

  it("carries no credential port unless one is configured", () => {
    expect(ollamaEndpointProfile({ id: "local", model: "m" }).credentialPort).toBeUndefined();
  });

  it("passes a configured credential port through", () => {
    const options = openAIEndpointProfile({ id: "cloud", model: "m", credentialPort: "apiKey" });
    expect(options.credentialPort).toBe("apiKey");
  });

  it("freezes the produced configuration", () => {
    expect(Object.isFrozen(ollamaEndpointProfile({ id: "local", model: "m" }))).toBe(true);
  });
});

describe("the one provider-specific difference", () => {
  it("uses the legacy token field for local OpenAI-compatible servers", () => {
    expect(ollamaEndpointProfile({ id: "l", model: "m" }).tokenLimitField).toBe("max_tokens");
    expect(llamaCppEndpointProfile({ id: "l", model: "m" }).tokenLimitField).toBe("max_tokens");
  });

  it("uses the current field for the hosted OpenAI API", () => {
    expect(openAIEndpointProfile({ id: "c", model: "m" }).tokenLimitField).toBe(
      "max_completion_tokens",
    );
  });
});
