import { describe, expect, it } from "vitest";

import { findPluginConfig, pluginCapabilityPolicy, validatePluginConfig } from "./plugin-config.js";

describe("document shape", () => {
  it("treats an absent document as no plugins configured", () => {
    const result = validatePluginConfig(undefined);
    expect(result.valid).toBe(true);
    expect(result.entries).toEqual([]);
  });

  it("treats an empty object as no plugins configured", () => {
    expect(validatePluginConfig({}).entries).toEqual([]);
  });

  it("refuses a non-object document", () => {
    expect(validatePluginConfig("nope").defects[0]?.code).toBe("not-an-object");
  });

  it("refuses a non-array plugins field", () => {
    expect(validatePluginConfig({ plugins: {} }).defects[0]?.code).toBe("invalid-plugins");
  });

  it("refuses an entry that is not an object", () => {
    expect(validatePluginConfig({ plugins: ["x"] }).defects[0]?.code).toBe("invalid-entry");
  });

  it("requires an id on each entry", () => {
    expect(validatePluginConfig({ plugins: [{ enabled: true }] }).defects[0]?.code).toBe(
      "missing-id",
    );
  });

  it("refuses a duplicate id", () => {
    const result = validatePluginConfig({ plugins: [{ id: "a" }, { id: "a" }] });
    expect(result.defects[0]?.code).toBe("duplicate-id");
  });
});

describe("default-off", () => {
  it("leaves a plugin disabled when enabled is omitted", () => {
    const result = validatePluginConfig({ plugins: [{ id: "a" }] });
    expect(result.entries[0]?.enabled).toBe(false);
  });

  it("enables only on an explicit true", () => {
    const result = validatePluginConfig({
      plugins: [
        { id: "a", enabled: true },
        { id: "b", enabled: "yes" },
        { id: "c", enabled: 1 },
      ],
    });
    expect(result.entries.map((entry) => entry.enabled)).toEqual([true, false, false]);
  });

  it("reports an unconfigured plugin as absent, which means not enabled", () => {
    const result = validatePluginConfig({ plugins: [{ id: "a", enabled: true }] });
    expect(findPluginConfig(result.entries, "b")).toBeUndefined();
  });
});

describe("capability grants", () => {
  it("defaults to no granted capabilities", () => {
    const result = validatePluginConfig({ plugins: [{ id: "a", enabled: true }] });
    expect(result.entries[0]?.grantedCapabilities).toEqual([]);
  });

  it("keeps granted capabilities in order without duplicates", () => {
    const result = validatePluginConfig({
      plugins: [{ id: "a", grantedCapabilities: ["fs:read", "fs:read", "fs:write"] }],
    });
    expect(result.entries[0]?.grantedCapabilities).toEqual(["fs:read", "fs:write"]);
  });

  it("refuses a non-string capability", () => {
    const result = validatePluginConfig({ plugins: [{ id: "a", grantedCapabilities: [3] }] });
    expect(result.defects[0]?.code).toBe("invalid-capability");
  });

  it("builds a policy that allows exactly what was granted", () => {
    const result = validatePluginConfig({
      plugins: [{ id: "a", enabled: true, grantedCapabilities: ["fs:read"] }],
    });
    const entry = result.entries[0];
    if (entry === undefined) throw new Error("missing entry");
    const policy = pluginCapabilityPolicy(entry);
    expect(policy.allows("fs:read")).toBe(true);
    expect(policy.allows("fs:write")).toBe(false);
  });

  it("lets an explicit denial override a grant", () => {
    const result = validatePluginConfig({
      plugins: [{ id: "a", grantedCapabilities: ["fs:read"], deniedCapabilities: ["fs:read"] }],
    });
    const entry = result.entries[0];
    if (entry === undefined) throw new Error("missing entry");
    expect(pluginCapabilityPolicy(entry).allows("fs:read")).toBe(false);
  });

  it("produces a default-deny policy for a plugin with no grants", () => {
    const result = validatePluginConfig({ plugins: [{ id: "a", enabled: true }] });
    const entry = result.entries[0];
    if (entry === undefined) throw new Error("missing entry");
    expect(pluginCapabilityPolicy(entry).allows("anything")).toBe(false);
  });
});

describe("plugin config data", () => {
  it("passes opaque configuration through untouched", () => {
    const result = validatePluginConfig({
      plugins: [{ id: "a", config: { endpoint: "http://127.0.0.1:1234", retries: 3 } }],
    });
    expect(result.entries[0]?.config).toEqual({ endpoint: "http://127.0.0.1:1234", retries: 3 });
  });

  it("leaves config undefined when omitted", () => {
    const result = validatePluginConfig({ plugins: [{ id: "a" }] });
    expect(result.entries[0]?.config).toBeUndefined();
  });

  it("does not read permission from plugin config data", () => {
    // A plugin cannot grant itself anything by putting capabilities in config.
    const result = validatePluginConfig({
      plugins: [{ id: "a", enabled: true, config: { grantedCapabilities: ["fs:write"] } }],
    });
    const entry = result.entries[0];
    if (entry === undefined) throw new Error("missing entry");
    expect(entry.grantedCapabilities).toEqual([]);
    expect(pluginCapabilityPolicy(entry).allows("fs:write")).toBe(false);
  });
});

describe("lookup", () => {
  it("finds a configured plugin by id", () => {
    const result = validatePluginConfig({ plugins: [{ id: "a" }, { id: "b", enabled: true }] });
    expect(findPluginConfig(result.entries, "b")?.enabled).toBe(true);
  });

  it("freezes resolved entries", () => {
    const result = validatePluginConfig({ plugins: [{ id: "a" }] });
    expect(Object.isFrozen(result.entries[0])).toBe(true);
  });
});
