import { describe, expect, it } from "vitest";

import {
  reconcilePluginGrants,
  validatePluginPackageManifest,
  type PluginPackageManifest,
} from "./plugin-package-manifest.js";

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: "com.example.plugin",
    name: "Example",
    version: "1.0.0",
    apiVersion: 1,
    license: "MIT",
    entry: "./index.js",
    requestedCapabilities: [],
    nodes: [],
    ...overrides,
  };
}

function codes(overrides: Record<string, unknown>): readonly string[] {
  return validatePluginPackageManifest(document(overrides)).defects.map((defect) => defect.code);
}

function accept(overrides: Record<string, unknown> = {}): PluginPackageManifest {
  const result = validatePluginPackageManifest(document(overrides));
  if (!result.valid || result.manifest === undefined) {
    throw new Error(`expected valid manifest, got ${JSON.stringify(result.defects)}`);
  }
  return result.manifest;
}

describe("shape", () => {
  it("accepts a minimal valid manifest", () => {
    expect(accept().id).toBe("com.example.plugin");
  });

  it("refuses a non-object document", () => {
    expect(validatePluginPackageManifest("not an object").defects[0]?.code).toBe("not-an-object");
  });

  it("refuses an array", () => {
    expect(validatePluginPackageManifest([]).defects[0]?.code).toBe("not-an-object");
  });

  it("refuses an unsupported manifest version", () => {
    expect(codes({ manifestVersion: 2 })).toContain("unsupported-manifest-version");
  });

  it("refuses an unsupported plugin API version", () => {
    expect(codes({ apiVersion: 99 })).toContain("unsupported-api-version");
  });

  it("collects every defect rather than stopping at the first", () => {
    const result = validatePluginPackageManifest({ manifestVersion: 1 });
    expect(result.defects.length).toBeGreaterThan(2);
  });

  it("freezes the accepted manifest", () => {
    expect(Object.isFrozen(accept())).toBe(true);
  });
});

describe("required fields", () => {
  it.each(["id", "name", "version", "license", "entry"])("requires %s", (field) => {
    expect(codes({ [field]: undefined })).toContain("missing-field");
  });

  it("requires a license, because an installable package must state its terms", () => {
    expect(codes({ license: undefined })).toContain("missing-field");
  });

  it("requires requestedCapabilities even when empty", () => {
    expect(codes({ requestedCapabilities: undefined })).toContain("missing-field");
  });

  it("requires nodes even when empty", () => {
    expect(codes({ nodes: undefined })).toContain("missing-field");
  });
});

describe("identity", () => {
  it.each(["com.example.plugin", "example", "a-b.c-d"])("accepts id %s", (id) => {
    expect(accept({ id }).id).toBe(id);
  });

  it.each(["../escape", "Com.Example", "with space", "a//b", "a\\b"])("refuses id %s", (id) => {
    expect(codes({ id })).toContain("invalid-id");
  });

  it.each(["1.0.0", "0.1.2", "2.3.4-beta.1"])("accepts version %s", (version) => {
    expect(accept({ version }).version).toBe(version);
  });

  it.each(["1", "1.0", "v1.0.0", "latest"])("refuses version %s", (version) => {
    expect(codes({ version })).toContain("invalid-version");
  });
});

describe("entry path containment", () => {
  it.each(["../outside.js", "/etc/passwd", "C:\\Windows\\x.js", "a/../../b.js"])(
    "refuses entry %s",
    (entry) => {
      expect(codes({ entry })).toContain("invalid-entry");
    },
  );

  it("accepts a nested relative entry", () => {
    expect(accept({ entry: "./dist/index.js" }).entry).toBe("./dist/index.js");
  });
});

describe("harness version floor", () => {
  it("refuses a package needing a newer harness", () => {
    const result = validatePluginPackageManifest(document({ minHarnessVersion: "2.0.0" }), {
      harnessVersion: "1.0.0",
    });
    expect(result.defects.map((defect) => defect.code)).toContain("harness-too-old");
  });

  it("accepts an equal harness version", () => {
    const result = validatePluginPackageManifest(document({ minHarnessVersion: "1.0.0" }), {
      harnessVersion: "1.0.0",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts a newer harness version", () => {
    const result = validatePluginPackageManifest(document({ minHarnessVersion: "1.0.0" }), {
      harnessVersion: "1.4.0",
    });
    expect(result.valid).toBe(true);
  });

  it("does not compare when the host version is unknown", () => {
    expect(validatePluginPackageManifest(document({ minHarnessVersion: "9.9.9" })).valid).toBe(
      true,
    );
  });
});

describe("capabilities", () => {
  it("keeps requested capabilities in order", () => {
    expect(
      accept({ requestedCapabilities: ["fs:read", "network:https"] }).requestedCapabilities,
    ).toEqual(["fs:read", "network:https"]);
  });

  it("refuses duplicates", () => {
    expect(codes({ requestedCapabilities: ["fs:read", "fs:read"] })).toContain(
      "duplicate-capability",
    );
  });

  it("refuses a non-string capability", () => {
    expect(codes({ requestedCapabilities: [7] })).toContain("invalid-field");
  });
});

describe("declared nodes", () => {
  it("accepts a namespaced node type", () => {
    const manifest = accept({
      nodes: [{ type: "vendor.thing", version: "1", title: "Thing" }],
    });
    expect(manifest.nodes[0]?.type).toBe("vendor.thing");
  });

  it("refuses an un-namespaced node type", () => {
    expect(codes({ nodes: [{ type: "thing", version: "1", title: "T" }] })).toContain(
      "invalid-field",
    );
  });

  it("refuses duplicate node declarations", () => {
    expect(
      codes({
        nodes: [
          { type: "vendor.thing", version: "1", title: "A" },
          { type: "vendor.thing", version: "1", title: "B" },
        ],
      }),
    ).toContain("duplicate-node");
  });

  it("allows the same type at different versions", () => {
    const manifest = accept({
      nodes: [
        { type: "vendor.thing", version: "1", title: "A" },
        { type: "vendor.thing", version: "2", title: "B" },
      ],
    });
    expect(manifest.nodes).toHaveLength(2);
  });
});

describe("integrity block", () => {
  it("accepts sha256 digests", () => {
    const manifest = accept({
      integrity: { algorithm: "sha256", files: { "index.js": "a".repeat(64) } },
    });
    expect(manifest.integrity?.files["index.js"]).toBe("a".repeat(64));
  });

  it("refuses a non-sha256 algorithm", () => {
    expect(codes({ integrity: { algorithm: "md5", files: {} } })).toContain("invalid-integrity");
  });

  it("refuses a malformed digest", () => {
    expect(codes({ integrity: { algorithm: "sha256", files: { "index.js": "nope" } } })).toContain(
      "invalid-integrity",
    );
  });

  it("refuses a digest path that escapes the package", () => {
    expect(
      codes({ integrity: { algorithm: "sha256", files: { "../x.js": "a".repeat(64) } } }),
    ).toContain("invalid-integrity");
  });

  it("treats an absent integrity block as valid but unsigned", () => {
    expect(accept().integrity).toBeUndefined();
  });
});

describe("grants are separate from requests", () => {
  it("grants nothing when the host granted nothing", () => {
    const record = reconcilePluginGrants(accept({ requestedCapabilities: ["fs:read"] }), [], true);
    expect(record.grantedCapabilities).toEqual([]);
    expect(record.withheldCapabilities).toEqual(["fs:read"]);
  });

  it("grants only the intersection of request and host grant", () => {
    const record = reconcilePluginGrants(
      accept({ requestedCapabilities: ["fs:read", "fs:write"] }),
      ["fs:read", "git:commit"],
      true,
    );
    expect(record.grantedCapabilities).toEqual(["fs:read"]);
    expect(record.withheldCapabilities).toEqual(["fs:write"]);
  });

  it("never turns a request into a grant on its own", () => {
    const manifest = accept({ requestedCapabilities: ["fs:write", "process:exec"] });
    const record = reconcilePluginGrants(manifest, [], false);
    expect(record.grantedCapabilities).toHaveLength(0);
  });

  it("records the enabled flag the host supplied", () => {
    expect(reconcilePluginGrants(accept(), [], false).enabled).toBe(false);
    expect(reconcilePluginGrants(accept(), [], true).enabled).toBe(true);
  });
});
