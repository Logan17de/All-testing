import { describe, expect, it } from "vitest";
import { providerAwaitingDecision } from "./runtime-provider-policy.js";

describe("pending billed provider policy", () => {
  it("blocks provider profiles and official endpoints under any profile", () => {
    expect(providerAwaitingDecision({ profile: "anthropic" })).toBe(true);
    expect(providerAwaitingDecision({ profile: "xai" })).toBe(true);
    expect(providerAwaitingDecision({ profile: "custom", baseUrl: "https://api.x.ai/v1" })).toBe(
      true,
    );
    expect(providerAwaitingDecision({ baseUrl: "https://api.anthropic.com/v1" })).toBe(true);
    expect(providerAwaitingDecision({ baseUrl: "https://api.anthropic.com.example.com/v1" })).toBe(
      false,
    );
    expect(providerAwaitingDecision({ profile: "ollama", baseUrl: "http://localhost:11434" })).toBe(
      false,
    );
  });
});
