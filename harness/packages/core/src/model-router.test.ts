import type { ModelAdapterManifest } from "@zet-harness/plugin-api";
import { describe, expect, it } from "vitest";

import { CapabilityPermissionPolicy } from "./capability-permission-policy.js";
import { routeModel } from "./model-router.js";

function manifest(
  id: string,
  overrides: {
    readonly version?: string;
    readonly tools?: boolean;
    readonly vision?: boolean;
    readonly structuredOutput?: boolean;
    readonly streaming?: boolean;
    readonly contextWindowTokens?: number;
    readonly requiredCapabilities?: readonly string[];
  } = {},
): ModelAdapterManifest {
  return Object.freeze({
    id,
    version: overrides.version ?? "1",
    title: id,
    requiredCapabilities: Object.freeze(overrides.requiredCapabilities ?? ["network:https"]),
    features: Object.freeze({
      streaming: overrides.streaming ?? true,
      tools: overrides.tools ?? false,
      vision: overrides.vision ?? false,
      structuredOutput: overrides.structuredOutput ?? false,
      ...(overrides.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: overrides.contextWindowTokens }),
    }),
  });
}

const allowNetwork = new CapabilityPermissionPolicy({ granted: ["network:https"] });

describe("basic selection", () => {
  it("reports an empty catalog distinctly from no match", () => {
    const decision = routeModel({ manifests: [] });
    expect(decision.outcome).toBe("empty-catalog");
    expect(decision.selectedId).toBeNull();
  });

  it("selects the only eligible model", () => {
    const decision = routeModel({ manifests: [manifest("alpha")] });
    expect(decision.outcome).toBe("selected");
    expect(decision.selectedId).toBe("alpha");
  });

  it("does not require a feature the caller did not ask for", () => {
    const decision = routeModel({ manifests: [manifest("alpha", { tools: true })] });
    expect(decision.outcome).toBe("selected");
  });

  it("reports no eligible model when nothing matches", () => {
    const decision = routeModel({
      manifests: [manifest("alpha")],
      requirements: { vision: true },
    });
    expect(decision.outcome).toBe("no-eligible-model");
    expect(decision.selectedId).toBeNull();
  });
});

describe("capability requirements", () => {
  it("requires tool support when asked", () => {
    const decision = routeModel({
      manifests: [manifest("plain"), manifest("tooled", { tools: true })],
      requirements: { tools: true },
    });
    expect(decision.selectedId).toBe("tooled");
  });

  it("requires vision when asked", () => {
    const decision = routeModel({
      manifests: [manifest("plain"), manifest("seeing", { vision: true })],
      requirements: { vision: true },
    });
    expect(decision.selectedId).toBe("seeing");
  });

  it("requires structured output when asked", () => {
    const decision = routeModel({
      manifests: [manifest("plain"), manifest("schema", { structuredOutput: true })],
      requirements: { structuredOutput: true },
    });
    expect(decision.selectedId).toBe("schema");
  });

  it("requires streaming when asked", () => {
    const decision = routeModel({
      manifests: [manifest("batch", { streaming: false }), manifest("live")],
      requirements: { streaming: true },
    });
    expect(decision.selectedId).toBe("live");
  });

  it("records why each candidate was rejected", () => {
    const decision = routeModel({
      manifests: [manifest("plain")],
      requirements: { tools: true, vision: true },
    });
    const candidate = decision.candidates[0];
    expect(candidate?.rejections).toEqual(["missing-tools", "missing-vision"]);
  });
});

describe("context window", () => {
  it("rejects a window that is too small", () => {
    const decision = routeModel({
      manifests: [manifest("small", { contextWindowTokens: 8_000 })],
      requirements: { minContextWindowTokens: 100_000 },
    });
    expect(decision.candidates[0]?.rejections).toEqual(["context-window-too-small"]);
  });

  it("accepts a window that is exactly large enough", () => {
    const decision = routeModel({
      manifests: [manifest("exact", { contextWindowTokens: 100_000 })],
      requirements: { minContextWindowTokens: 100_000 },
    });
    expect(decision.outcome).toBe("selected");
  });

  it("does not treat an undeclared window as unlimited", () => {
    const decision = routeModel({
      manifests: [manifest("unknown")],
      requirements: { minContextWindowTokens: 1_000 },
    });
    expect(decision.candidates[0]?.rejections).toEqual(["unknown-context-window"]);
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("ignores the window when no minimum is requested", () => {
    const decision = routeModel({ manifests: [manifest("unknown")] });
    expect(decision.outcome).toBe("selected");
  });
});

describe("capability policy", () => {
  it("does not select a model whose capabilities are not granted", () => {
    const decision = routeModel({
      manifests: [manifest("remote", { requiredCapabilities: ["network:https"] })],
      policy: new CapabilityPermissionPolicy({ granted: [] }),
    });
    expect(decision.candidates[0]?.rejections).toEqual(["capability-denied"]);
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("selects a model whose capabilities are granted", () => {
    const decision = routeModel({
      manifests: [manifest("remote")],
      policy: allowNetwork,
    });
    expect(decision.selectedId).toBe("remote");
  });

  it("prefers a permitted model over a denied one", () => {
    const decision = routeModel({
      manifests: [
        manifest("aaa-denied", { requiredCapabilities: ["network:http"] }),
        manifest("zzz-allowed", { requiredCapabilities: ["network:https"] }),
      ],
      policy: allowNetwork,
    });
    expect(decision.selectedId).toBe("zzz-allowed");
  });

  it("respects an explicit denial that overrides a grant", () => {
    const decision = routeModel({
      manifests: [manifest("remote")],
      policy: new CapabilityPermissionPolicy({
        granted: ["network:https"],
        denied: ["network:https"],
      }),
    });
    expect(decision.outcome).toBe("no-eligible-model");
  });
});

describe("explicit pins", () => {
  it("selects the pinned model", () => {
    const decision = routeModel({
      manifests: [manifest("alpha"), manifest("beta")],
      requirements: { modelId: "beta" },
    });
    expect(decision.selectedId).toBe("beta");
    expect(decision.selectionRule).toBe("explicit-pin");
  });

  it("selects the pinned version", () => {
    const decision = routeModel({
      manifests: [manifest("alpha", { version: "1" }), manifest("alpha", { version: "2" })],
      requirements: { modelId: "alpha", modelVersion: "2" },
    });
    expect(decision.selectedVersion).toBe("2");
  });

  it("does not fall back when a pin cannot be honoured", () => {
    const decision = routeModel({
      manifests: [manifest("alpha")],
      requirements: { modelId: "missing" },
    });
    expect(decision.outcome).toBe("no-eligible-model");
  });

  it("still enforces requirements on a pinned model", () => {
    const decision = routeModel({
      manifests: [manifest("alpha")],
      requirements: { modelId: "alpha", vision: true },
    });
    expect(decision.outcome).toBe("no-eligible-model");
  });
});

describe("determinism", () => {
  it("does not depend on catalog order", () => {
    const models = [manifest("charlie"), manifest("alpha"), manifest("bravo")];
    const forward = routeModel({ manifests: models });
    const reversed = routeModel({ manifests: [...models].reverse() });
    expect(forward.selectedId).toBe(reversed.selectedId);
  });

  it("breaks ties lexicographically", () => {
    const decision = routeModel({ manifests: [manifest("zulu"), manifest("alpha")] });
    expect(decision.selectedId).toBe("alpha");
    expect(decision.selectionRule).toBe("lexicographic");
  });

  it("orders candidates deterministically in the record", () => {
    const decision = routeModel({ manifests: [manifest("zulu"), manifest("alpha")] });
    expect(decision.candidates.map((candidate) => candidate.id)).toEqual(["alpha", "zulu"]);
  });

  it("honours host preference order over lexicographic order", () => {
    const decision = routeModel({
      manifests: [manifest("alpha"), manifest("zulu")],
      preferenceOrder: ["zulu"],
    });
    expect(decision.selectedId).toBe("zulu");
    expect(decision.selectionRule).toBe("preference-order");
  });

  it("honours a version-qualified preference", () => {
    const decision = routeModel({
      manifests: [manifest("alpha", { version: "1" }), manifest("alpha", { version: "2" })],
      preferenceOrder: ["alpha@2"],
    });
    expect(decision.selectedVersion).toBe("2");
  });

  it("falls back to lexicographic order for unlisted models", () => {
    const decision = routeModel({
      manifests: [manifest("yankee"), manifest("xray")],
      preferenceOrder: ["not-present"],
    });
    expect(decision.selectedId).toBe("xray");
  });
});

describe("trace record", () => {
  it("is JSON-serializable", () => {
    const decision = routeModel({
      manifests: [manifest("alpha", { tools: true })],
      requirements: { tools: true },
    });
    expect(() => JSON.stringify(decision)).not.toThrow();
    expect(JSON.parse(JSON.stringify(decision))).toMatchObject({ selectedId: "alpha" });
  });

  it("records the requirements that produced the decision", () => {
    const decision = routeModel({
      manifests: [manifest("alpha", { tools: true })],
      requirements: { tools: true },
    });
    expect(decision.requirements).toEqual({ tools: true });
  });

  it("lists every candidate considered, including rejected ones", () => {
    const decision = routeModel({
      manifests: [manifest("alpha"), manifest("beta", { tools: true })],
      requirements: { tools: true },
    });
    expect(decision.candidates).toHaveLength(2);
    expect(decision.candidates.filter((candidate) => candidate.eligible)).toHaveLength(1);
  });

  it("is frozen", () => {
    const decision = routeModel({ manifests: [manifest("alpha")] });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(Object.isFrozen(decision.candidates)).toBe(true);
  });
});
