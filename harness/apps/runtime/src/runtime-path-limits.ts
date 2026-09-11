import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Legacy Win32 `MAX_PATH`.
 *
 * A path at or below this length is addressable by every Windows API and by
 * child processes that were not built with long-path awareness.
 */
export const LEGACY_WINDOWS_MAX_PATH = 260;

/** Length the probe attempts, comfortably past the legacy limit. */
const PROBE_PATH_LENGTH = 320;

export type PathLimitProbeOutcome = "supported" | "unsupported" | "inconclusive";

export interface RuntimePathLimitReport {
  readonly platform: NodeJS.Platform;
  /**
   * Whether this Node runtime could create and read a path past `MAX_PATH`.
   *
   * Node prefixes long absolute Windows paths for its own syscalls, so this can
   * be true while an external tool spawned by `shell.run` still fails. It is a
   * statement about the daemon's own filesystem access, nothing wider.
   */
  readonly longPathsUsableByRuntime: boolean;
  readonly probe: PathLimitProbeOutcome;
  /**
   * Longest path the runtime should hand to an external process.
   *
   * On Windows this stays at the legacy limit even when the probe succeeds,
   * because a child process does not inherit Node's path handling.
   */
  readonly recommendedExternalPathLimit: number;
  /** Human-readable startup warnings; empty when nothing needs reporting. */
  readonly warnings: readonly string[];
}

function buildLongRelativePath(totalLength: number): string {
  // Several nested components rather than one huge name: individual components
  // are capped at 255 characters on both NTFS and ext4.
  const componentLength = 60;
  const components: string[] = [];
  let built = 0;
  while (built < totalLength) {
    components.push("p".repeat(componentLength));
    built += componentLength + 1;
  }
  return join(...components);
}

export interface ProbeRuntimePathLimitsOptions {
  /** Directory to probe under. Defaults to the OS temp directory. */
  readonly baseDirectory?: string;
}

/**
 * Detect long-path support by exercising it, not by asking the registry.
 *
 * Reading `LongPathsEnabled` would require spawning `reg.exe` at startup and
 * would still not answer the question that matters, which is whether this
 * process can actually address such a path. The probe creates a directory tree
 * past `MAX_PATH`, writes and reads a file in it, then removes it.
 *
 * The probe never fails startup. An environment that refuses temp writes
 * reports `inconclusive` and the conservative limit.
 */
export async function probeRuntimePathLimits(
  options: ProbeRuntimePathLimitsOptions = {},
): Promise<RuntimePathLimitReport> {
  const platform = process.platform;
  const warnings: string[] = [];

  let base: string;
  let probe: PathLimitProbeOutcome = "inconclusive";

  try {
    // Creating the probe root is setup, not the measurement. An ENOENT here
    // means the base directory is unusable, which says nothing about path
    // length, so it must not be mistaken for a long-path refusal below.
    base = await mkdtemp(join(options.baseDirectory ?? tmpdir(), "zet-pathprobe-"));
  } catch {
    return Object.freeze({
      platform,
      longPathsUsableByRuntime: false,
      probe: "inconclusive",
      recommendedExternalPathLimit: platform === "win32" ? LEGACY_WINDOWS_MAX_PATH : 1024,
      warnings: Object.freeze([
        "Path-length probe could not create a temporary directory; assuming the conservative limit.",
      ]),
    });
  }

  try {
    const deepDirectory = join(base, buildLongRelativePath(PROBE_PATH_LENGTH - base.length));
    const probeFile = join(deepDirectory, "probe.txt");

    await mkdir(deepDirectory, { recursive: true });
    await writeFile(probeFile, "ok", "utf8");
    const roundTrip = await readFile(probeFile, "utf8");
    probe = roundTrip === "ok" ? "supported" : "inconclusive";
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    // These two are the genuine "path is too long" answers. Anything else
    // (a read-only temp directory, a full disk) tells us nothing about paths.
    probe = code === "ENAMETOOLONG" || code === "ENOENT" ? "unsupported" : "inconclusive";
    if (probe === "inconclusive") {
      warnings.push("Path-length probe could not complete; assuming the conservative limit.");
    }
  } finally {
    try {
      await rm(base, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Removing a long path can itself fail on Windows. Report it rather
      // than failing startup over a temp directory.
      warnings.push("Path-length probe left a temporary directory behind.");
    }
  }

  const longPathsUsableByRuntime = probe === "supported";

  if (platform === "win32") {
    if (!longPathsUsableByRuntime) {
      warnings.push(
        `Windows long paths are unavailable: paths must stay within ${String(LEGACY_WINDOWS_MAX_PATH)} characters. Enable LongPathsEnabled or use a shorter project root.`,
      );
    } else {
      warnings.push(
        "Windows long paths work for the runtime itself, but external tools started by the runtime may still fail past 260 characters.",
      );
    }
  }

  return Object.freeze({
    platform,
    longPathsUsableByRuntime,
    probe,
    // Windows keeps the conservative external limit either way, because a
    // spawned process does not inherit the runtime's path handling.
    recommendedExternalPathLimit:
      platform === "win32" ? LEGACY_WINDOWS_MAX_PATH : longPathsUsableByRuntime ? 4096 : 1024,
    warnings: Object.freeze(warnings),
  });
}
