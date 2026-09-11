import { realpath } from "node:fs/promises";
import { isAbsolute, parse, resolve, sep } from "node:path";

/**
 * Closed reason a requested path was refused.
 *
 * Codes are part of the tool error surface, so they must stay descriptive
 * without echoing host layout. A denial never reports what exists outside the
 * workspace root.
 */
export type WorkspacePathDenialCode =
  | "invalid-input"
  | "empty-path"
  | "embedded-nul"
  | "path-too-long"
  | "unc-path"
  | "device-namespace"
  | "drive-relative"
  | "alternate-data-stream"
  | "reserved-device-name"
  | "trailing-dot-or-space"
  | "short-name"
  | "escapes-root"
  | "symlink-escapes-root";

const DENIAL_MARKER: unique symbol = Symbol("zet-harness.workspace-path-error");

/**
 * Typed containment failure.
 *
 * Provenance uses a private symbol rather than `instanceof`, matching the
 * transport error convention: a forged prototype chain must not be able to
 * impersonate a host authority decision.
 */
export class WorkspacePathError extends Error {
  readonly code: WorkspacePathDenialCode;
  /** The caller-supplied path, never the resolved host path. */
  readonly requestedPath: string;

  constructor(code: WorkspacePathDenialCode, message: string, requestedPath: string) {
    super(message);
    this.name = "WorkspacePathError";
    this.code = code;
    this.requestedPath = requestedPath;
    Object.defineProperty(this, DENIAL_MARKER, { value: true, enumerable: false });
  }
}

export function isWorkspacePathError(value: unknown): value is WorkspacePathError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[DENIAL_MARKER] === true
  );
}

/**
 * Windows device names reserved at every directory level.
 *
 * A reserved name is still reserved when it carries an extension: `CON.txt`
 * resolves to the console device, not to a file.
 */
const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "COM0",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT0",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

/** `PROGRA~1` style 8.3 aliases address a different name than the one written. */
const SHORT_NAME_PATTERN = /~\d/u;

const DRIVE_PREFIX_PATTERN = /^[A-Za-z]:/u;

/**
 * Conservative cap applied on every platform.
 *
 * Windows without long-path support fails past 260 characters; this bound is
 * checked before touching the filesystem so a refusal is deterministic rather
 * than dependent on the host that happens to run the graph.
 */
const DEFAULT_MAX_PATH_LENGTH = 32_000;

export interface WorkspacePathResolverOptions {
  /** Absolute project root. Every accepted path stays inside it. */
  readonly root: string;
  /**
   * Compare containment without case sensitivity.
   *
   * Defaults to the host platform: Windows and macOS resolve `Foo` and `foo`
   * to one file, and a case-sensitive prefix test would then accept a path the
   * filesystem later reads from a different directory.
   */
  readonly caseInsensitive?: boolean;
  readonly maxPathLength?: number;
}

export interface ResolvedWorkspacePath {
  /** Absolute host path, symlinks already resolved where the path exists. */
  readonly absolutePath: string;
  /** Root-relative POSIX-style path, suitable for traces and file-change records. */
  readonly relativePath: string;
  /** True when every component existed at resolution time. */
  readonly exists: boolean;
}

function fold(value: string, caseInsensitive: boolean): string {
  return caseInsensitive ? value.toLowerCase() : value;
}

/**
 * Reject a segment that is unsafe to address on Windows.
 *
 * These rules are enforced on every platform on purpose. A graph authored on
 * Linux must not be able to produce a path that means something different when
 * the same graph runs on Windows, and portability is worth more here than the
 * ability to address a POSIX file literally named `CON` or `a:b`.
 */
function assertSafeSegment(segment: string, requestedPath: string): void {
  if (segment.includes(":")) {
    throw new WorkspacePathError(
      "alternate-data-stream",
      "Path segments must not contain ':'.",
      requestedPath,
    );
  }

  const basename = segment.split(".")[0] ?? segment;
  if (RESERVED_DEVICE_NAMES.has(basename.toUpperCase())) {
    throw new WorkspacePathError(
      "reserved-device-name",
      `Path segment '${segment}' is a reserved device name.`,
      requestedPath,
    );
  }

  if (segment.endsWith(".") || segment.endsWith(" ")) {
    // Windows silently strips these, so `secret. ` and `secret` are one file.
    throw new WorkspacePathError(
      "trailing-dot-or-space",
      "Path segments must not end with '.' or ' '.",
      requestedPath,
    );
  }

  if (SHORT_NAME_PATTERN.test(segment)) {
    throw new WorkspacePathError(
      "short-name",
      `Path segment '${segment}' looks like an 8.3 short name.`,
      requestedPath,
    );
  }
}

/** Split on both separators so `a\b` and `a/b` are analysed identically. */
function splitSegments(value: string): string[] {
  return value.split(/[\\/]+/u).filter((segment) => segment.length > 0 && segment !== ".");
}

/**
 * Resolve caller-supplied paths against one project root.
 *
 * The resolver is the only place that turns untrusted text into a host path.
 * It performs lexical containment first so an obviously hostile path never
 * reaches the filesystem, then re-checks containment against real paths so a
 * symlink or Windows junction cannot redirect an accepted path outside the
 * root after the fact.
 */
export class WorkspacePathResolver {
  readonly #root: string;
  readonly #caseInsensitive: boolean;
  readonly #maxPathLength: number;
  #realRoot: string | undefined;

  constructor(options: WorkspacePathResolverOptions) {
    const { root } = options;
    if (typeof root !== "string" || root.length === 0) {
      throw new TypeError("Workspace root must be a non-empty string.");
    }
    if (!isAbsolute(root)) {
      throw new TypeError("Workspace root must be an absolute path.");
    }

    this.#root = resolve(root);
    this.#caseInsensitive = options.caseInsensitive ?? process.platform !== "linux";
    this.#maxPathLength = options.maxPathLength ?? DEFAULT_MAX_PATH_LENGTH;

    if (!Number.isSafeInteger(this.#maxPathLength) || this.#maxPathLength <= 0) {
      throw new TypeError("maxPathLength must be a positive safe integer.");
    }

    Object.freeze(this);
  }

  get root(): string {
    return this.#root;
  }

  /** Containment test shared by the lexical and real-path passes. */
  #contains(candidate: string, root: string): boolean {
    const foldedCandidate = fold(candidate, this.#caseInsensitive);
    const foldedRoot = fold(root, this.#caseInsensitive);
    if (foldedCandidate === foldedRoot) return true;
    const prefix = foldedRoot.endsWith(sep) ? foldedRoot : `${foldedRoot}${sep}`;
    return foldedCandidate.startsWith(prefix);
  }

  #toRelative(absolutePath: string, root: string): string {
    if (fold(absolutePath, this.#caseInsensitive) === fold(root, this.#caseInsensitive)) {
      return ".";
    }
    const prefixLength = root.endsWith(sep) ? root.length : root.length + 1;
    return absolutePath.slice(prefixLength).split(sep).join("/");
  }

  /**
   * Lexical pass.
   *
   * Runs without touching the filesystem so a hostile path is refused before
   * any syscall, and so the rules are testable without creating fixtures.
   */
  resolveLexical(requestedPath: string): string {
    if (typeof requestedPath !== "string") {
      throw new WorkspacePathError(
        "invalid-input",
        "Path must be a string.",
        String(requestedPath),
      );
    }
    if (requestedPath.length === 0) {
      throw new WorkspacePathError("empty-path", "Path must not be empty.", requestedPath);
    }
    if (requestedPath.includes("\0")) {
      throw new WorkspacePathError(
        "embedded-nul",
        "Path must not contain a NUL byte.",
        requestedPath,
      );
    }
    if (requestedPath.length > this.#maxPathLength) {
      throw new WorkspacePathError(
        "path-too-long",
        "Path exceeds the length limit.",
        requestedPath,
      );
    }

    // `\\?\` and `\\.\` reach the object manager and bypass normalization.
    if (/^[\\/]{2}[?.][\\/]/u.test(requestedPath)) {
      throw new WorkspacePathError(
        "device-namespace",
        "Device-namespace paths are not addressable.",
        requestedPath,
      );
    }
    if (/^[\\/]{2}/u.test(requestedPath)) {
      throw new WorkspacePathError("unc-path", "UNC paths are not addressable.", requestedPath);
    }

    const hasDrivePrefix = DRIVE_PREFIX_PATTERN.test(requestedPath);
    if (hasDrivePrefix) {
      const afterDrive = requestedPath.slice(2);
      // `C:work` is relative to the current directory of drive C, not to `C:\`.
      if (afterDrive.length > 0 && !/^[\\/]/u.test(afterDrive)) {
        throw new WorkspacePathError(
          "drive-relative",
          "Drive-relative paths are not addressable.",
          requestedPath,
        );
      }
    }

    // The drive prefix is the one legitimate colon in a path; strip it before
    // segment analysis so `C:\src` is not read as an alternate data stream.
    const segments = splitSegments(hasDrivePrefix ? requestedPath.slice(2) : requestedPath);
    for (const segment of segments) {
      if (segment === "..") continue;
      assertSafeSegment(segment, requestedPath);
    }

    // `path.resolve` collapses `..` before containment is tested, so a path
    // that climbs out and back in is judged on where it actually lands.
    const candidate = DRIVE_PREFIX_PATTERN.test(requestedPath)
      ? resolve(requestedPath)
      : resolve(this.#root, requestedPath);

    if (!this.#contains(candidate, this.#root)) {
      throw new WorkspacePathError(
        "escapes-root",
        "Path resolves outside the workspace root.",
        requestedPath,
      );
    }

    if (candidate.length > this.#maxPathLength) {
      throw new WorkspacePathError(
        "path-too-long",
        "Resolved path exceeds the length limit.",
        requestedPath,
      );
    }

    return candidate;
  }

  /** Real path of the root, resolved once; the root itself may sit behind a link. */
  async #resolvedRoot(): Promise<string> {
    const cached = this.#realRoot;
    if (cached !== undefined) return cached;

    let resolved: string;
    try {
      resolved = await realpath(this.#root);
    } catch {
      // A root that does not exist yet cannot host a redirecting link.
      resolved = this.#root;
    }
    this.#realRoot = resolved;
    return resolved;
  }

  /**
   * Full resolution: lexical rules, then real-path containment.
   *
   * A path is accepted when it does not exist yet — `fs.write` must be able to
   * create a file — but the deepest component that *does* exist is resolved and
   * re-checked, so a junction placed partway down the path cannot redirect the
   * write outside the root.
   */
  async resolve(requestedPath: string): Promise<ResolvedWorkspacePath> {
    const lexical = this.resolveLexical(requestedPath);
    const realRoot = await this.#resolvedRoot();

    let existingPath = lexical;
    const trailing: string[] = [];

    for (;;) {
      try {
        const real = await realpath(existingPath);
        if (!this.#contains(real, realRoot)) {
          throw new WorkspacePathError(
            "symlink-escapes-root",
            "Path resolves outside the workspace root through a link.",
            requestedPath,
          );
        }
        const absolutePath = trailing.length === 0 ? real : resolve(real, ...trailing);
        // Re-test after rejoining: the trailing part is lexically clean, but
        // the real prefix it is joined onto was only known at this point.
        if (!this.#contains(absolutePath, realRoot)) {
          throw new WorkspacePathError(
            "symlink-escapes-root",
            "Path resolves outside the workspace root through a link.",
            requestedPath,
          );
        }
        return Object.freeze({
          absolutePath,
          relativePath: this.#toRelative(absolutePath, realRoot),
          exists: trailing.length === 0,
        });
      } catch (error: unknown) {
        if (isWorkspacePathError(error)) throw error;

        const parent = parse(existingPath).dir;
        if (parent === existingPath || parent.length === 0) {
          // Walked past the filesystem root without finding an existing
          // component. The lexical pass already proved containment.
          return Object.freeze({
            absolutePath: lexical,
            relativePath: this.#toRelative(lexical, this.#root),
            exists: false,
          });
        }

        trailing.unshift(parse(existingPath).base);
        existingPath = parent;
      }
    }
  }
}

export function createWorkspacePathResolver(
  options: WorkspacePathResolverOptions,
): WorkspacePathResolver {
  return new WorkspacePathResolver(options);
}
