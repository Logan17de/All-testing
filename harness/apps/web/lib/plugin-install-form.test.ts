import { describe, expect, it } from "vitest";

import {
  EMPTY_INSTALL_DRAFT,
  checkInstallDraft,
  installedFrom,
  type PluginInstallDraft,
} from "./plugin-install-form";

const draft = (partial: Partial<PluginInstallDraft>): PluginInstallDraft => ({
  ...EMPTY_INSTALL_DRAFT,
  ...partial,
});

describe("what the plugins page sends", () => {
  it("sends an npm package, with a version when one was typed", () => {
    expect(checkInstallDraft(draft({ spec: "  zet-plugin-hello  " }))).toEqual({
      ok: true,
      request: { kind: "npm", spec: "zet-plugin-hello" },
    });
    expect(checkInstallDraft(draft({ spec: "@acme/zet-nodes@1.2.3" }))).toEqual({
      ok: true,
      request: { kind: "npm", spec: "@acme/zet-nodes@1.2.3" },
    });
  });

  it("sends an https repository, with a ref only when one was typed", () => {
    expect(
      checkInstallDraft(draft({ kind: "git", url: "https://example.com/acme/nodes.git" })),
    ).toEqual({
      ok: true,
      request: { kind: "git", url: "https://example.com/acme/nodes.git" },
    });
    expect(
      checkInstallDraft(
        draft({ kind: "git", url: "https://example.com/acme/nodes.git", ref: "v2" }),
      ),
    ).toEqual({
      ok: true,
      request: { kind: "git", url: "https://example.com/acme/nodes.git", ref: "v2" },
    });
  });

  it("says what is wrong before anything is fetched", () => {
    expect(checkInstallDraft(draft({ spec: "   " }))).toEqual({
      ok: false,
      reason: "Name the npm package to install.",
    });
    expect(checkInstallDraft(draft({ spec: "-rf" })).ok).toBe(false);
    expect(checkInstallDraft(draft({ spec: "Not A Package" }))).toEqual({
      ok: false,
      reason: "'Not A Package' is not an npm package name.",
    });
    expect(
      checkInstallDraft(draft({ kind: "git", url: "git@example.com:acme/nodes.git" })),
    ).toEqual({ ok: false, reason: "A repository URL must be a URL." });
    expect(checkInstallDraft(draft({ kind: "git", url: "http://example.com/acme.git" }))).toEqual({
      ok: false,
      reason: "Only https repository URLs are installed, so no ssh key or agent is involved.",
    });
    expect(
      checkInstallDraft(draft({ kind: "git", url: "https://user:secret@example.com/acme.git" })),
    ).toEqual({ ok: false, reason: "A repository URL must not carry credentials." });
    expect(
      checkInstallDraft(draft({ kind: "git", url: "https://example.com/acme.git", ref: "a b" })),
    ).toEqual({ ok: false, reason: "'a b' is not a branch, tag or commit." });
  });

  it("ignores a ref left over from a git attempt when npm is chosen", () => {
    expect(checkInstallDraft(draft({ spec: "zet-plugin-hello", ref: "not a ref" })).ok).toBe(true);
  });
});

describe("what the runtime answered", () => {
  it("names the package that was installed", () => {
    expect(
      installedFrom({
        plugin: { id: "com.example.nodes", name: "Example nodes", version: "1.0.0" },
      }),
    ).toEqual({ id: "com.example.nodes", name: "Example nodes", version: "1.0.0" });
    // A daemon that answers without a name still identifies the package.
    expect(installedFrom({ plugin: { id: "com.example.nodes" } })).toEqual({
      id: "com.example.nodes",
      name: "com.example.nodes",
      version: "",
    });
    expect(installedFrom({ plugin: {} })).toBeNull();
    expect(installedFrom({})).toBeNull();
    expect(installedFrom(null)).toBeNull();
  });
});
