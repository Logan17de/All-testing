/**
 * What the plugins page sends when someone adds a plugin.
 *
 * The runtime checks every one of these rules again before it runs a package
 * manager — this is not the guard, the loader is. It exists so a person is told
 * what is wrong with what they typed before a network call, in the same words.
 */

export type PluginInstallKind = "npm" | "git";

export interface PluginInstallDraft {
  readonly kind: PluginInstallKind;
  /** An npm package name, optionally with a version or range. */
  readonly spec: string;
  /** The https URL of a Git repository. */
  readonly url: string;
  /** A branch, tag or commit; empty means the repository's default. */
  readonly ref: string;
}

export const EMPTY_INSTALL_DRAFT: PluginInstallDraft = { kind: "npm", spec: "", url: "", ref: "" };

export type PluginInstallRequest =
  | { readonly kind: "npm"; readonly spec: string }
  | { readonly kind: "git"; readonly url: string; readonly ref?: string };

export type PluginInstallCheck =
  | { readonly ok: true; readonly request: PluginInstallRequest }
  | { readonly ok: false; readonly reason: string };

const NPM_NAME = /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/u;
const GIT_REF = /^[A-Za-z0-9._\-/]{1,200}$/u;

/** The request to send, or the reason this draft is not one. */
export function checkInstallDraft(draft: PluginInstallDraft): PluginInstallCheck {
  if (draft.kind === "npm") {
    const spec = draft.spec.trim();
    if (spec.length === 0) return { ok: false, reason: "Name the npm package to install." };
    if (spec.length > 214) {
      return { ok: false, reason: "An npm package name is between 1 and 214 characters." };
    }
    if (spec.startsWith("-")) return { ok: false, reason: "A package name cannot start with '-'." };
    const separator = spec.lastIndexOf("@");
    const name = separator > 0 ? spec.slice(0, separator) : spec;
    if (!NPM_NAME.test(name)) return { ok: false, reason: `'${name}' is not an npm package name.` };
    return { ok: true, request: { kind: "npm", spec } };
  }

  const url = draft.url.trim();
  const ref = draft.ref.trim();
  if (url.length === 0) return { ok: false, reason: "Give the https URL of the repository." };
  if (ref.length > 0 && !GIT_REF.test(ref)) {
    return { ok: false, reason: `'${ref}' is not a branch, tag or commit.` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "A repository URL must be a URL." };
  }
  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "Only https repository URLs are installed, so no ssh key or agent is involved.",
    };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, reason: "A repository URL must not carry credentials." };
  }
  return {
    ok: true,
    request: { kind: "git", url, ...(ref.length > 0 ? { ref } : {}) },
  };
}

export interface InstalledPluginSummary {
  readonly id: string;
  readonly name: string;
  readonly version: string;
}

/** The package named in a successful install, when the runtime named one. */
export function installedFrom(body: unknown): InstalledPluginSummary | null {
  if (typeof body !== "object" || body === null) return null;
  const plugin = (body as { readonly plugin?: unknown }).plugin;
  if (typeof plugin !== "object" || plugin === null) return null;
  const record = plugin as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string") return null;
  return {
    id,
    name: typeof record["name"] === "string" ? record["name"] : id,
    version: typeof record["version"] === "string" ? record["version"] : "",
  };
}
