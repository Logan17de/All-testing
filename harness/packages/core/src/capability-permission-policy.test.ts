import { describe, expect, it } from "vitest";

import { CapabilityPermissionPolicy } from "./capability-permission-policy.js";

describe("CapabilityPermissionPolicy", () => {
  it("defaults to deny when no host grant exists", () => {
    const policy = new CapabilityPermissionPolicy();

    expect(policy.evaluate("fs:read")).toEqual({
      capability: "fs:read",
      decision: "deny",
      denialReason: "not-granted",
    });
    expect(policy.allows("fs:read")).toBe(false);
  });

  it("uses exact case-sensitive capability matching with no implicit hierarchy", () => {
    const policy = new CapabilityPermissionPolicy({ granted: ["fs:read", "network:https"] });

    expect(policy.allows("fs:read")).toBe(true);
    expect(policy.allows("fs:read:metadata")).toBe(false);
    expect(policy.allows("FS:READ")).toBe(false);
    expect(policy.allows("network")).toBe(false);
  });

  it("lets explicit denial override an overlapping grant", () => {
    const policy = new CapabilityPermissionPolicy({
      granted: ["fs:read", "shell:run"],
      denied: ["shell:run"],
    });

    expect(policy.evaluate("shell:run")).toEqual({
      capability: "shell:run",
      decision: "deny",
      denialReason: "explicitly-denied",
    });
    expect(policy.effectiveCapabilities).toEqual(["fs:read"]);
  });

  it("evaluates required capabilities as all-of and separates denial causes", () => {
    const policy = new CapabilityPermissionPolicy({
      granted: ["fs:read", "network:https"],
      denied: ["network:https"],
    });

    expect(policy.evaluateAll(["fs:read", "network:https", "shell:run", "fs:read"])).toEqual({
      allowed: false,
      evaluations: [
        { capability: "fs:read", decision: "allow" },
        {
          capability: "network:https",
          decision: "deny",
          denialReason: "explicitly-denied",
        },
        {
          capability: "shell:run",
          decision: "deny",
          denialReason: "not-granted",
        },
      ],
      allowedCapabilities: ["fs:read"],
      explicitlyDeniedCapabilities: ["network:https"],
      notGrantedCapabilities: ["shell:run"],
    });
  });

  it("copies, deduplicates, and freezes policy snapshots", () => {
    const granted = ["fs:read", "fs:read"];
    const denied = ["shell:run", "shell:run"];
    const policy = new CapabilityPermissionPolicy({ granted, denied });

    granted.push("network:https");
    denied.push("fs:read");

    expect(policy.grantedCapabilities).toEqual(["fs:read"]);
    expect(policy.deniedCapabilities).toEqual(["shell:run"]);
    expect(policy.effectiveCapabilities).toEqual(["fs:read"]);
    expect(policy.allows("network:https")).toBe(false);
    expect(policy.allows("fs:read")).toBe(true);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.grantedCapabilities)).toBe(true);
    expect(Object.isFrozen(policy.deniedCapabilities)).toBe(true);
    expect(Object.isFrozen(policy.effectiveCapabilities)).toBe(true);
  });

  it("rejects empty, whitespace-padded, and whitespace-only capability ids", () => {
    expect(() => new CapabilityPermissionPolicy({ granted: [""] })).toThrow(TypeError);
    expect(() => new CapabilityPermissionPolicy({ granted: [" fs:read"] })).toThrow(TypeError);
    expect(() => new CapabilityPermissionPolicy({ denied: ["   "] })).toThrow(TypeError);

    const policy = new CapabilityPermissionPolicy();
    expect(() => policy.evaluate("fs:read ")).toThrow(TypeError);
    expect(() => policy.evaluateAll(["ok", " "])).toThrow(TypeError);
  });
});
