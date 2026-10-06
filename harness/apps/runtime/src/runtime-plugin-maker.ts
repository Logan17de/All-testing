import { createHash } from "node:crypto";
import { validatePluginPackageManifest } from "@zet-harness/core";
export interface MakerFile {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
}
export interface MakerArtifact {
  readonly hash: string;
  readonly files: readonly MakerFile[];
  readonly requestedCapabilities: readonly string[];
  readonly quarantined: true;
  readonly enabled: false;
}
export interface MakerHost {
  /** Must use confined native filesystem approval, rechecking exact files/hash before each write. No imports/install/activation. */ write(
    artifact: MakerArtifact,
  ): Promise<void>;
}
const denied = () => new Error("Plugin maker request refused.");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
function file(path: string, content: string): MakerFile {
  if (
    !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:json|mjs|md|ts)$/u.test(path) ||
    path.split("/").some((p) => ["node_modules", "dist", "plugins"].includes(p)) ||
    Buffer.byteLength(content) > 65536 ||
    content.includes("\0")
  )
    throw denied();
  return Object.freeze({ path, content, sha256: hash(content) });
}
function artifact(files: readonly MakerFile[]): MakerArtifact {
  if (
    files.length > 20 ||
    new Set(files.map((f) => f.path.toLowerCase())).size !== files.length ||
    files.reduce((sum, f) => sum + Buffer.byteLength(f.content), 0) > 262144
  )
    throw denied();
  const ordered = Object.freeze(
    [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  );
  const manifest = ordered.find((f) => f.path === "zet-plugin.json");
  let capabilities: readonly string[] = [];
  if (manifest) {
    try {
      const validation = validatePluginPackageManifest(JSON.parse(manifest.content));
      capabilities = validation.manifest?.requestedCapabilities ?? [];
    } catch {
      /* invalid inert JSON is reported by validation, never executed */
    }
  }
  return Object.freeze({
    hash: hash(JSON.stringify(ordered.map((f) => [f.path, f.sha256]))),
    files: ordered,
    requestedCapabilities: Object.freeze([...capabilities]),
    quarantined: true,
    enabled: false,
  });
}
export function createRuntimePluginMaker(host: MakerHost, userAuthority: object) {
  const artifacts = new Map<string, MakerArtifact>();
  const reviewed = new Set<string>();
  const remember = (value: MakerArtifact) => {
    if (artifacts.size >= 100 && !artifacts.has(value.hash)) throw denied();
    artifacts.set(value.hash, value);
    return value;
  };
  const get = (digest: string) => {
    const value = artifacts.get(digest);
    if (!value) throw denied();
    return value;
  };
  const user = (authority: object) => {
    if (authority !== userAuthority) throw denied();
  };
  return Object.freeze({
    scaffold(input: { id: string; name: string; description?: string; license?: string }) {
      if (
        !/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u.test(input.id) ||
        input.id.length > 120 ||
        typeof input.name !== "string" ||
        !input.name.trim() ||
        input.name.length > 120 ||
        typeof (input.description ?? "") !== "string" ||
        (input.description ?? "").length > 2000 ||
        !["UNLICENSED", "MIT", "Apache-2.0"].includes(input.license ?? "UNLICENSED")
      )
        throw denied();
      const manifest = {
        manifestVersion: 1,
        id: input.id,
        name: input.name,
        version: "0.1.0",
        apiVersion: 1,
        license: input.license ?? "UNLICENSED",
        description:
          input.description || "Generated native harness plugin; review before activation.",
        entry: "index.mjs",
        requestedCapabilities: [],
        nodes: [{ type: `${input.id}.echo`, version: "1", title: "Echo" }],
      };
      const nodeType = `${input.id}.echo`;
      const source = `// Native public SDK contracts; zero dependencies or build step.
const echo = { manifest: { type: ${JSON.stringify(nodeType)}, version: "1", title: "Echo", inputs: { value: { schema: {}, required: true } }, outputs: { value: { schema: {}, required: true } }, configSchema: { type: "object", additionalProperties: false }, behavior: { primitiveFamily: "pure", determinism: "deterministic", effect: "none", idempotency: "not-applicable", recovery: "rerun", executionMode: "in-process", requiredCapabilities: [] } }, execute: ({ inputs }) => ({ outputs: { value: inputs.value ?? null } }) };
export default { manifest: { id: ${JSON.stringify(input.id)}, name: ${JSON.stringify(input.name)}, version: "0.1.0", apiVersion: 1, capabilities: [] }, activate(context) { context.nodes.register(echo); } };
`;
      const testSource = `import test from "node:test";
import assert from "node:assert/strict";
import plugin from "./index.mjs";
test("native pure node has no grants and echoes JSON", () => { const nodes = []; plugin.activate({ nodes: { register(node) { nodes.push(node); } } }); assert.equal(nodes.length, 1); assert.deepEqual(plugin.manifest.capabilities, []); assert.equal(nodes[0].manifest.behavior.effect, "none"); assert.deepEqual(nodes[0].execute({ inputs: { value: "fixture" }, config: {} }), { outputs: { value: "fixture" } }); });
`;
      return remember(
        artifact([
          file("zet-plugin.json", JSON.stringify(manifest, null, 2) + "\n"),
          file("index.mjs", source),
          file("test.mjs", testSource),
          file(
            "README.md",
            "Generated native Zet Harness plugin. Quarantined and disabled. Review every file and requested capability before installation or activation. No code has been executed.\n",
          ),
          file(
            "package.json",
            JSON.stringify(
              {
                name: input.id,
                version: "0.1.0",
                private: true,
                type: "module",
                license: manifest.license,
                scripts: { test: "node --test test.mjs" },
              },
              null,
              2,
            ) + "\n",
          ),
        ]),
      );
    },
    inspect: get,
    edit(digest: string, path: string, content: string) {
      const before = get(digest);
      if (!before.files.some((f) => f.path === path)) throw denied();
      return remember(
        artifact(before.files.map((f) => (f.path === path ? file(path, content) : f))),
      );
    },
    validate(digest: string) {
      const value = get(digest);
      try {
        const manifest = value.files.find((f) => f.path === "zet-plugin.json");
        if (!manifest) throw denied();
        const result = validatePluginPackageManifest(JSON.parse(manifest.content));
        const missing =
          result.manifest &&
          !value.files.some((f) => f.path === result.manifest!.entry.replace(/^\.\//u, ""));
        return Object.freeze({
          hash: digest,
          valid: result.valid && !missing,
          defects: Object.freeze([
            ...result.defects,
            ...(missing
              ? [
                  {
                    code: "entry-missing",
                    field: "entry",
                    message: "Entry must exist in this exact artifact.",
                  },
                ]
              : []),
          ]),
          mode: "offline-static" as const,
          executed: false as const,
          notice:
            "Manifest validation only; JavaScript syntax, behavior and safety are not proven.",
        });
      } catch {
        return Object.freeze({
          hash: digest,
          valid: false,
          defects: [
            {
              code: "manifest-invalid",
              field: "manifest",
              message: "Invalid bounded manifest JSON.",
            },
          ],
          mode: "offline-static" as const,
          executed: false as const,
          notice: "No generated code executed.",
        });
      }
    },
    async materialize(authority: object, digest: string) {
      user(authority);
      const value = get(digest);
      await host.write(value);
      return { hash: digest, quarantined: true, enabled: false };
    },
    review(authority: object, digest: string, scopes: readonly string[]) {
      user(authority);
      const value = get(digest);
      if (
        JSON.stringify([...scopes].sort()) !==
          JSON.stringify([...value.requestedCapabilities].sort()) ||
        !this.validate(digest).valid
      )
        throw denied();
      reviewed.add(digest);
      return {
        hash: digest,
        reviewed: true,
        enabled: false,
        notice:
          "Review is not execution consent or a capability grant. Activation requires the separate trusted plugin host.",
      };
    },
    isReviewed(digest: string) {
      get(digest);
      return reviewed.has(digest);
    },
    test(digest: string) {
      get(digest);
      return {
        ...this.validate(digest),
        notice:
          "Offline static check only. Executing generated plugin tests requires exact human approval and the required OS sandbox; no host fallback is provided.",
      };
    },
  });
}
export type RuntimePluginMaker = ReturnType<typeof createRuntimePluginMaker>;
