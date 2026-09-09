import { describe, expect, it, vi } from "vitest";

import { SecretValue, type SecretProvider } from "@zet-harness/plugin-api/secret-contract";

import { NodeSecretResolutionError, createNodeSecretAccessor } from "./node-secret-accessor.js";

describe("node-scoped secret accessor", () => {
  it("exposes bound ports without exposing provider references or material", async () => {
    const secretRef = "vault://project/api-key";
    const material = "top-secret-api-key";
    const provider: SecretProvider = {
      resolve(reference) {
        expect(reference).toBe(secretRef);
        return new SecretValue(material);
      },
    };

    const accessor = createNodeSecretAccessor([{ port: "apiKey", secretRef }], provider);

    expect(accessor.ports).toEqual(["apiKey"]);
    expect(accessor.has("apiKey")).toBe(true);
    expect(accessor.has("other")).toBe(false);
    expect(JSON.stringify(accessor)).not.toContain(secretRef);
    expect(JSON.stringify(accessor)).not.toContain(material);
    expect((await accessor.get("apiKey")).revealText()).toBe(material);
  });

  it("resolves lazily and caches one provider lookup per opaque reference", async () => {
    const resolve = vi.fn(() => new SecretValue("cached-secret"));
    const accessor = createNodeSecretAccessor(
      [
        { port: "first", secretRef: "vault://shared" },
        { port: "second", secretRef: "vault://shared" },
      ],
      { resolve },
    );

    expect(resolve).not.toHaveBeenCalled();
    expect((await accessor.get("first")).revealText()).toBe("cached-secret");
    expect((await accessor.get("second")).revealText()).toBe("cached-secret");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("supports multiple bindings per port only through getAll", async () => {
    const accessor = createNodeSecretAccessor(
      [
        { port: "tokens", secretRef: "vault://one" },
        { port: "tokens", secretRef: "vault://two" },
      ],
      {
        resolve(reference) {
          return new SecretValue(reference.endsWith("one") ? "first" : "second");
        },
      },
    );

    await expect(accessor.get("tokens")).rejects.toMatchObject({
      code: "SECRET_PORT_CARDINALITY",
      port: "tokens",
    });
    const values = await accessor.getAll("tokens");
    expect(values.map((value) => value.revealText())).toEqual(["first", "second"]);
    expect(Object.isFrozen(values)).toBe(true);
  });

  it("fails closed with safe errors when providers fail or references are unavailable", async () => {
    const providerErrorSecret = "provider-error-must-not-leak";
    const failed = createNodeSecretAccessor([{ port: "apiKey", secretRef: "vault://fail" }], {
      resolve() {
        throw new Error(providerErrorSecret);
      },
    });
    const missing = createNodeSecretAccessor([{ port: "apiKey", secretRef: "vault://missing" }], {
      resolve() {
        return undefined;
      },
    });

    const failedError = await failed.get("apiKey").catch((error: unknown) => error);
    expect(failedError).toBeInstanceOf(NodeSecretResolutionError);
    expect(failedError).toMatchObject({ code: "SECRET_PROVIDER_FAILED", port: "apiKey" });
    expect(String(failedError)).not.toContain(providerErrorSecret);

    await expect(missing.get("apiKey")).rejects.toMatchObject({
      code: "SECRET_REFERENCE_UNAVAILABLE",
      port: "apiKey",
    });
  });

  it("rejects arbitrary unbound access and invalid binding references", async () => {
    const accessor = createNodeSecretAccessor([], { resolve: () => undefined });

    await expect(accessor.get("apiKey")).rejects.toMatchObject({
      code: "SECRET_PORT_UNBOUND",
      port: "apiKey",
    });
    expect(() =>
      createNodeSecretAccessor([{ port: "apiKey", secretRef: " invalid " }], {
        resolve: () => undefined,
      }),
    ).toThrow(TypeError);
  });
});
