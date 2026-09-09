import { describe, expect, it, vi } from "vitest";
import { RuntimeRedactionRegistry, canonicalRuntimeJson } from "./runtime-redaction.js";

describe("runtime redaction registry", () => {
  it("redacts configured fields, known secrets, nested arrays and secret-bearing keys", () => {
    const registry = new RuntimeRedactionRegistry();
    registry.registerSecret("hidden");
    const value = registry.redact({
      api_key: "private",
      data: ["has hidden", { "hidden-key": "ok" }],
    });
    expect(value).toEqual({
      api_key: "[REDACTED]",
      data: ["has [REDACTED]", { "[REDACTED]-key": "ok" }],
    });
  });

  it("reference-counts duplicate rules and makes disposal idempotent", () => {
    const registry = new RuntimeRedactionRegistry();
    const a = registry.registerSecret("duplicate");
    const b = registry.registerSecret("duplicate");
    a();
    a();
    expect(registry.redact("duplicate")).toBe("[REDACTED]");
    b();
    expect(registry.redact("duplicate")).toBe("duplicate");
    const remove = registry.registerField("custom-field");
    expect(registry.redact({ custom_field: "value" })).toEqual({ custom_field: "[REDACTED]" });
    remove();
    expect(registry.redact({ custom_field: "value" })).toEqual({ custom_field: "value" });
  });

  it("does not execute getters or serialization hooks on rejected objects", () => {
    const registry = new RuntimeRedactionRegistry();
    const getter = vi.fn(() => "leak");
    const object = Object.defineProperty({}, "value", { get: getter, enumerable: true });
    expect(registry.redact(object)).toBe("[REDACTED]");
    expect(getter).not.toHaveBeenCalled();
    const toJSON = vi.fn(() => "leak");
    expect(registry.redact({ toJSON })).toBe("[REDACTED]");
    expect(toJSON).not.toHaveBeenCalled();
  });

  it("canonicalizes object order without changing array order or accepting unsafe JSON", () => {
    expect(canonicalRuntimeJson({ b: 2, a: [2, 1] })).toBe('{"a":[2,1],"b":2}');
    expect(() => canonicalRuntimeJson({ n: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalRuntimeJson({ n: undefined })).toThrow(TypeError);
    expect(() => canonicalRuntimeJson("x".repeat(70_000))).toThrow(TypeError);
    const cycle: { child?: unknown } = {};
    cycle.child = cycle;
    expect(() => canonicalRuntimeJson(cycle)).toThrow(TypeError);
  });

  it("rejects rather than silently redacting durable output payloads", () => {
    const registry = new RuntimeRedactionRegistry();
    registry.registerSecret("raw-key");
    expect(() => registry.assertSafe({ result: "raw-key" })).toThrow("protected material");
    expect(registry.assertSafe({ result: "safe" })).toBe('{"result":"safe"}');
  });
});
