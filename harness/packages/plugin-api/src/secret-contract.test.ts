import { describe, expect, it } from "vitest";

import {
  SECRET_REDACTED_TEXT,
  SecretValue,
  assertSecretReference,
} from "./secret-contract.js";

describe("secret contract", () => {
  it("reveals material only through the explicit accessor", () => {
    const material = "super-secret-material";
    const secret = new SecretValue(material);

    expect(secret.revealText()).toBe(material);
    expect(String(secret)).toBe(SECRET_REDACTED_TEXT);
    expect(`${secret}`).toBe(SECRET_REDACTED_TEXT);
    expect(JSON.stringify(secret)).toBe(JSON.stringify(SECRET_REDACTED_TEXT));
    expect(Reflect.ownKeys(secret)).toEqual([]);
  });

  it("does not carry private material through structured cloning", () => {
    const material = "must-not-survive-clone";
    const clone = structuredClone(new SecretValue(material));

    expect(JSON.stringify(clone)).not.toContain(material);
    expect(Reflect.ownKeys(clone)).toEqual([]);
  });

  it("requires non-empty trimmed opaque references without interpreting their scheme", () => {
    expect(assertSecretReference("vault://project/api-key")).toBe("vault://project/api-key");
    expect(assertSecretReference("local-key-name")).toBe("local-key-name");
    expect(() => assertSecretReference("")).toThrow(TypeError);
    expect(() => assertSecretReference(" key ")).toThrow(TypeError);
  });
});
