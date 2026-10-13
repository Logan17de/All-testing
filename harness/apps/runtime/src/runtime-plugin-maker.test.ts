import { describe, expect, it, vi } from "vitest";
import { createRuntimePluginMaker } from "./runtime-plugin-maker.js";
describe("native plugin maker inert artifacts", () => {
  it("scaffolds SDK artifact, validates static manifest and never executes or writes", () => {
    const write = vi.fn(() => Promise.resolve());
    const maker = createRuntimePluginMaker({ write }, {});
    const artifact = maker.scaffold({ id: "example.echo", name: "Echo" });
    expect(artifact.enabled).toBe(false);
    expect(artifact.quarantined).toBe(true);
    expect(artifact.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(artifact.files.every((f) => /^[a-f0-9]{64}$/u.test(f.sha256))).toBe(true);
    expect(artifact.requestedCapabilities).toEqual([]);
    expect(maker.validate(artifact.hash)).toMatchObject({
      valid: true,
      mode: "offline-static",
      executed: false,
    });
    expect(maker.test(artifact.hash).executed).toBe(false);
    expect(write).not.toHaveBeenCalled();
  });
  it("edits reset exacthash review and human materialize does not enable", async () => {
    const authority = {};
    const write = vi.fn(() => Promise.resolve());
    const maker = createRuntimePluginMaker({ write }, authority);
    const a = maker.scaffold({ id: "example.echo", name: "Echo" });
    expect(() => maker.review({}, a.hash, [])).toThrow();
    maker.review(authority, a.hash, []);
    const edited = maker.edit(a.hash, "index.mjs", "throw new Error('inert-code-not-executed');\n");
    expect(edited.hash).not.toBe(a.hash);
    expect(maker.isReviewed(edited.hash)).toBe(false);
    await expect(maker.materialize({}, edited.hash)).rejects.toThrow();
    await expect(maker.materialize(authority, edited.hash)).resolves.toMatchObject({
      enabled: false,
      quarantined: true,
    });
    expect(write).toHaveBeenCalledWith(edited);
  });
  it("rejects path traversal oversize malformedmanifest and hidden declared grants", () => {
    const authority = {};
    const maker = createRuntimePluginMaker({ write: () => Promise.resolve() }, authority);
    const a = maker.scaffold({ id: "example.echo", name: "Echo" });
    expect(() => maker.edit(a.hash, "../index.mjs", "bad")).toThrow();
    expect(() => maker.edit(a.hash, "index.mjs", "x".repeat(65537))).toThrow();
    const malformed = maker.edit(a.hash, "zet-plugin.json", "{}");
    expect(maker.validate(malformed.hash).valid).toBe(false);
    expect(() => maker.review(authority, malformed.hash, [])).toThrow();
    const manifest = JSON.parse(
      a.files.find((f) => f.path === "zet-plugin.json")!.content,
    ) as Record<string, unknown>;
    manifest.requestedCapabilities = ["network:http"];
    const requested = maker.edit(a.hash, "zet-plugin.json", JSON.stringify(manifest));
    expect(requested.requestedCapabilities).toEqual(["network:http"]);
    expect(() => maker.review(authority, requested.hash, [])).toThrow();
    expect(maker.review(authority, requested.hash, ["network:http"]).enabled).toBe(false);
  });
});
