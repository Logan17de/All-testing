import { describe, expect, it } from "vitest";

import { TypedRegistry } from "./typed-registry.js";

describe("TypedRegistry", () => {
  it("registers and resolves typed values", () => {
    const registry = new TypedRegistry<{ label: string }>();
    const value = { label: "alpha" };

    registry.register("example.alpha", value);

    expect(registry.size).toBe(1);
    expect(registry.has("example.alpha")).toBe(true);
    expect(registry.get("example.alpha")).toBe(value);
    expect(registry.require("example.alpha")).toBe(value);
    expect(registry.ids()).toEqual(["example.alpha"]);
    expect(registry.list()).toEqual([{ id: "example.alpha", value }]);
  });

  it("rejects blank and duplicate ids", () => {
    const registry = new TypedRegistry<number>();

    expect(() => registry.register("   ", 1)).toThrow("non-empty");

    registry.register("example.one", 1);
    expect(() => registry.register("example.one", 2)).toThrow("already registered");
  });

  it("returns an idempotent disposer", () => {
    const registry = new TypedRegistry<number>();
    const dispose = registry.register("example.one", 1);

    dispose();
    dispose();

    expect(registry.size).toBe(0);
    expect(registry.has("example.one")).toBe(false);
  });

  it("does not let a stale disposer remove a newer registration", () => {
    const registry = new TypedRegistry<number>();
    const disposeFirst = registry.register("example.one", 1);

    disposeFirst();
    const disposeSecond = registry.register("example.one", 2);
    disposeFirst();

    expect(registry.require("example.one")).toBe(2);

    disposeSecond();
    expect(registry.size).toBe(0);
  });

  it("throws when a required id is missing", () => {
    const registry = new TypedRegistry<number>();

    expect(() => registry.require("missing")).toThrow('Registry entry "missing" was not found.');
  });
});
