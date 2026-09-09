import { describe, expect, it } from "vitest";

import { SecretValue } from "@zet-harness/plugin-api/secret-contract";
import { NodeSecretResolutionError, createNodeSecretAccessor } from "./node-secret-accessor.js";

describe("secret error provenance", () => {
  it.each(["provider", "observer"] as const)(
    "does not trust a %s exception merely because it has the public error class",
    async (source) => {
      const forged = new NodeSecretResolutionError(
        "SECRET_REFERENCE_UNAVAILABLE",
        "private-port-detail",
        "private-error-material",
      );
      const accessor = createNodeSecretAccessor(
        [{ port: "key", secretRef: "local:key" }],
        {
          resolve() {
            if (source === "provider") throw forged;
            return new SecretValue("material");
          },
        },
        () => {
          if (source === "observer") throw forged;
        },
      );
      const error: unknown = await accessor.get("key").catch((failure: unknown) => failure);
      expect(error).not.toBe(forged);
      expect(error).toMatchObject({ code: "SECRET_PROVIDER_FAILED", port: "key" });
      expect(String(error)).not.toContain("private-error-material");
      expect(JSON.stringify(error)).not.toContain("private-port-detail");
    },
  );
});
