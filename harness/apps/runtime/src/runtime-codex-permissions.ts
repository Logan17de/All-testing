import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isBlockedCodexPathSegment } from "./runtime-codex-dynamic-tools.js";

export interface CodexWorkspacePermissionGrant {
  fileSystem?: { read: string[] | null; write: string[] | null };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
const denied = () =>
  new Error("Requested permission is outside the supported workspace-only subset.");
interface PermissionPathOperations {
  resolve(path: string): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}
/** Ordinal canonical containment: Windows drive letters are aliases; directory casing is preserved. */
export function codexPermissionCanonicalSuffix(
  root: string,
  target: string,
  separator = sep,
): string | undefined {
  const drive = (value: string) =>
    separator === "\\" ? value.replace(/^[a-z]:/iu, (part) => part.toUpperCase()) : value;
  const base = drive(root),
    candidate = drive(target);
  if (candidate === base) return "";
  const prefix = base.endsWith(separator) ? base : `${base}${separator}`;
  return candidate.startsWith(prefix) ? candidate.slice(prefix.length) : undefined;
}
/** Both roots must already refer to the same realpath. Keeps Windows 8.3 aliases lexical. */
export function codexPermissionLexicalPath(
  selectedRoot: string,
  canonicalRoot: string,
  target: string,
  paths: PermissionPathOperations = { resolve, relative, isAbsolute, sep },
): { root: string; components: string[] } | undefined {
  for (const root of [paths.resolve(selectedRoot), canonicalRoot]) {
    const suffix = paths.relative(root, target);
    if (suffix === ".." || suffix.startsWith(`..${paths.sep}`) || paths.isAbsolute(suffix))
      continue;
    return { root, components: suffix.split(paths.sep).filter(Boolean) };
  }
  return undefined;
}

/** Narrow native permission subset: existing canonical workspace files, no network or session grants. */
export async function buildCodexWorkspacePermissionGrant(
  root: string,
  request: unknown,
): Promise<CodexWorkspacePermissionGrant> {
  if (
    !object(request) ||
    !exactKeys(request, [
      "threadId",
      "turnId",
      "itemId",
      "environmentId",
      "startedAtMs",
      "cwd",
      "reason",
      "permissions",
    ]) ||
    [request.threadId, request.turnId, request.itemId].some(
      (value) => typeof value !== "string" || !value || value.length > 512 || value.includes("\0"),
    ) ||
    typeof request.startedAtMs !== "number" ||
    !Number.isSafeInteger(request.startedAtMs) ||
    request.startedAtMs < 0 ||
    (request.reason !== null &&
      (typeof request.reason !== "string" || request.reason.length > 16_384)) ||
    request.environmentId !== null ||
    typeof request.cwd !== "string" ||
    request.cwd.length > 4096 ||
    request.cwd.includes("\0") ||
    !isAbsolute(request.cwd) ||
    !object(request.permissions)
  )
    throw denied();
  const canonicalRoot = await realpath(root);
  if (canonicalRoot.split(sep).some(isBlockedCodexPathSegment)) throw denied();
  if ((await realpath(request.cwd)) !== canonicalRoot) throw denied();
  const profile = request.permissions;
  if (
    !exactKeys(profile, ["network", "fileSystem"]) ||
    !Object.hasOwn(profile, "network") ||
    !Object.hasOwn(profile, "fileSystem")
  )
    throw denied();
  if (profile.network !== null && profile.network !== undefined) {
    if (
      !object(profile.network) ||
      !exactKeys(profile.network, ["enabled"]) ||
      profile.network.enabled !== false
    )
      throw denied();
  }
  if (profile.fileSystem === null || profile.fileSystem === undefined) return {};
  const fileSystem = profile.fileSystem;
  if (
    !object(fileSystem) ||
    !exactKeys(fileSystem, ["read", "write"]) ||
    !Object.hasOwn(fileSystem, "read") ||
    !Object.hasOwn(fileSystem, "write")
  )
    throw denied();
  const paths = async (value: unknown): Promise<string[] | null> => {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value) || value.length > 64) throw denied();
    const results: string[] = [];
    for (const path of value) {
      if (
        typeof path !== "string" ||
        !isAbsolute(path) ||
        path.length > 4096 ||
        path.includes("\0")
      )
        throw denied();
      const normalized = resolve(path);
      // Canonical output can differ from lexical input on Windows (including drive-letter casing).
      // Validate both paths against the root and keep lstat checks on every lexical component.
      const canonicalTarget = await realpath(normalized);
      const canonicalSuffix = codexPermissionCanonicalSuffix(canonicalRoot, canonicalTarget);
      if (canonicalSuffix === undefined) throw denied();
      // Windows temporary paths can use 8.3 names while realpath expands them.
      // Both anchors were verified as this workspace; canonical containment is mandatory above.
      const lexical = codexPermissionLexicalPath(root, canonicalRoot, normalized);
      if (!lexical) throw denied();
      const components = lexical.components;
      if (
        components.some(isBlockedCodexPathSegment) ||
        (process.platform === "win32" && components.some((component) => component.includes(":")))
      )
        throw denied();
      let current = lexical.root;
      for (const component of components) {
        current = resolve(current, component);
        if ((await lstat(current)).isSymbolicLink()) throw denied();
      }
      const metadata = await lstat(normalized);
      if (
        (await realpath(normalized)) !== canonicalTarget ||
        !metadata.isFile() ||
        metadata.nlink > 1
      )
        throw denied();
      if (canonicalSuffix.split(sep).some(isBlockedCodexPathSegment)) throw denied();
      results.push(resolve(canonicalRoot, canonicalSuffix));
    }
    return [...new Set(results)];
  };
  return {
    fileSystem: { read: await paths(fileSystem.read), write: await paths(fileSystem.write) },
  };
}
